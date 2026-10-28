import fs from "fs";
import path from "path";
import type { Readable } from "stream";
import { htmlToPlainText } from "../mails/plain-text";
import { parseAddressHeader, ParsedAddress } from "./address";
import { decodeBodyBytes } from "./charset";
import {
  decodeWords,
  ensureMessageIdFormat,
  parseHeaderValue,
  rawOctetsAsUtf8,
  splitHeaderLine
} from "./header";
import {
  EmbeddedHeaders,
  embeddedHeadersAsHtml,
  embeddedHeadersAsText,
  textToHtml
} from "./text";
import { createTransferDecoder, TransferDecoder } from "./transfer-decoder";

export interface ParsedAttachment {
  /** Where the decoded content was written. The caller owns the file. */
  path: string;
  filename?: string;
  contentType: string;
  size: number;
  /** Content-ID without its angle brackets, when the part has one. */
  cid?: string;
}

export interface ParsedMessage {
  messageId?: string;
  from?: ParsedAddress;
  to?: ParsedAddress | ParsedAddress[];
  cc?: ParsedAddress | ParsedAddress[];
  bcc?: ParsedAddress | ParsedAddress[];
  replyTo?: ParsedAddress;
  subject?: string;
  date?: Date;
  html?: string;
  text?: string;
  attachments: ParsedAttachment[];
}

export interface ParseOptions {
  /** Directory attachment files are written into; created on first use. */
  attachmentDir: string;
}

/** Largest header block of a single MIME part. */
export const MAX_PART_HEADER_BYTES = 1024 * 1024;

/** Most MIME parts one message may hold. */
export const MAX_PARTS = 1000;

/**
 * Decoded text and HTML body parts held in memory, summed over the message. A
 * part that would cross it is stored as an attachment instead, so a hostile
 * multi-megabyte body costs disk rather than heap.
 */
export const TEXT_BODY_BUDGET_BYTES = 2 * 1024 * 1024;

/**
 * Most HTML the plain-text rendering of an HTML-only message is computed from.
 * The renderer's working set is tens of times its input, so a longer body is
 * rendered from its first part.
 */
export const HTML_TO_TEXT_INPUT_LIMIT = 256 * 1024;

/**
 * Most image bytes inlined into the HTML as `data:` URLs in place of `cid:`
 * references. Past it the reference is left as written and the image stays an
 * attachment.
 */
export const INLINE_IMAGE_BUDGET_BYTES = 4 * 1024 * 1024;

const TEXT_TYPES = new Set(["text/plain", "text/html", "message/delivery-status"]);

const LF = 0x0a;
const CR = 0x0d;
const DASH = 0x2d;

const EMPTY = Buffer.alloc(0);

/** Header lines of one part, unfolded keys kept with their raw (folded) line. */
type HeaderLines = { key: string; line: string }[];

const withoutTrailingBreaks = (text: string): string => {
  let end = text.length;
  while (end > 0 && (text[end - 1] === "\r" || text[end - 1] === "\n")) end--;
  return text.slice(0, end);
};

/** Removes everything from the first `(` to the last `)`, as an RFC 5322 comment. */
const withoutComment = (value: string): string => {
  const open = value.indexOf("(");
  const close = value.lastIndexOf(")");
  return open !== -1 && close > open ? value.slice(0, open) + value.slice(close + 1) : value;
};

const splitHeaderBlock = (block: Buffer): HeaderLines => {
  const lines: string[] = [];
  for (const line of withoutTrailingBreaks(block.toString("latin1")).split(/\r?\n/)) {
    const first = line.charAt(0);
    if (lines.length && (first === " " || first === "\t")) lines[lines.length - 1] += "\r\n" + line;
    else lines.push(line);
  }
  if (lines.length && /^From /i.test(lines[0])) lines.shift();
  return lines
    .filter((line) => line.length)
    .map((line) => ({
      key: line.slice(0, Math.max(line.indexOf(":"), 0)).trim().toLowerCase(),
      line
    }));
};

const firstHeader = (lines: HeaderLines, key: string): string => {
  const found = lines.find((line) => line.key === key);
  return found ? splitHeaderLine(found.line).value : "";
};

/** A header value as text: the raw octets read as UTF-8. */
const headerText = (line: string): string =>
  Buffer.from(splitHeaderLine(line).value, "latin1").toString("utf8");

interface MessageHeaders extends EmbeddedHeaders {
  messageId?: string;
  replyTo?: ParsedAddress;
  contentId?: string;
}

const ADDRESS_HEADERS = new Set(["from", "to", "cc", "bcc", "reply-to"]);
const LAST_WINS = new Set(["from", "reply-to", "subject", "date", "message-id", "content-id"]);

/**
 * The headers this parser reports, decoded: a repeated single-valued header
 * keeps its last occurrence, and repeated `To`/`Cc`/`Bcc` become a list.
 */
const readMessageHeaders = (lines: HeaderLines): MessageHeaders => {
  const collected = new Map<string, unknown[]>();
  for (const { key, line } of lines) {
    let value: unknown;
    const text = headerText(line);
    if (ADDRESS_HEADERS.has(key)) value = parseAddressHeader(text);
    else if (key === "subject") value = text ? decodeWords(text) : undefined;
    else if (key === "date") {
      const date = new Date(text);
      value = isNaN(date.getTime()) ? new Date() : date;
    } else if (key === "message-id") value = ensureMessageIdFormat(decodeWords(text));
    else if (key === "content-id") value = text || undefined;
    else continue;
    if (!value) continue;
    const list = collected.get(key) ?? [];
    list.push(value);
    collected.set(key, list);
  }
  const pick = <T>(key: string): T | T[] | undefined => {
    const list = collected.get(key) as T[] | undefined;
    if (!list?.length) return undefined;
    if (LAST_WINS.has(key)) return list[list.length - 1];
    return list.length === 1 ? list[0] : list;
  };
  return {
    from: pick<ParsedAddress>("from") as ParsedAddress | undefined,
    to: pick<ParsedAddress>("to"),
    cc: pick<ParsedAddress>("cc"),
    bcc: pick<ParsedAddress>("bcc"),
    replyTo: pick<ParsedAddress>("reply-to") as ParsedAddress | undefined,
    subject: pick<string>("subject") as string | undefined,
    date: pick<Date>("date") as Date | undefined,
    messageId: pick<string>("message-id") as string | undefined,
    contentId: pick<string>("content-id") as string | undefined
  };
};

const mimeTypeFromFilename = (filename: string): string => {
  const extension = filename.toLowerCase().replace(/\s/g, "").split(".").pop() ?? "";
  if (!extension) return "application/octet-stream";
  const type = Bun.file(`x.${extension}`).type.split(";")[0];
  return type || "application/octet-stream";
};

interface Part {
  parent: Part | null;
  children: Part[];
  headerChunks: Buffer[];
  headerLength: number;
  headerLines?: HeaderLines;
  contentType: string | false;
  charset?: string;
  encoding: string;
  disposition: string | false;
  filename?: string;
  boundary: Buffer | false;
  parentBoundary: Buffer | false;
  multipart: boolean;
  flowed: boolean;
  delSp: boolean;
  isRfc822: boolean;
  messageNode: boolean;
  showMeta: boolean;
  metaHeaders?: EmbeddedHeaders;
  body?: PartBody;
  textContent?: string;
}

const newPart = (parent: Part | null): Part => ({
  parent,
  children: [],
  headerChunks: [],
  headerLength: 0,
  contentType: false,
  encoding: "",
  disposition: false,
  boundary: false,
  parentBoundary: parent ? parent.boundary : false,
  multipart: false,
  flowed: false,
  delSp: false,
  isRfc822: false,
  messageNode: false,
  showMeta: false
});

const readPartStructure = (part: Part): void => {
  const lines = splitHeaderBlock(Buffer.concat(part.headerChunks, part.headerLength));
  part.headerChunks = [];
  part.headerLines = lines;

  const disposition = parseHeaderValue(firstHeader(lines, "content-disposition"));
  let contentTypeHeader = firstHeader(lines, "content-type");
  if (!lines.some((line) => line.key === "content-type")) {
    const extension = path.parse(disposition.params.filename ?? "").ext.replace(/^\./, "");
    contentTypeHeader = extension
      ? mimeTypeFromFilename(extension)
      : /^attachment$/i.test(disposition.value)
        ? "application/octet-stream"
        : "text/plain";
  }
  const contentType = parseHeaderValue(contentTypeHeader);

  part.encoding = withoutComment(firstHeader(lines, "content-transfer-encoding"))
    .toLowerCase()
    .trim();
  part.contentType = contentType.value.toLowerCase().trim() || false;
  part.charset = contentType.params.charset || undefined;
  const dispositionValue = disposition.value.toLowerCase().trim();
  part.disposition = dispositionValue ? decodeWords(dispositionValue) : false;

  const rawFilename = disposition.params.filename || contentType.params.name;
  if (rawFilename) part.filename = decodeWords(rawOctetsAsUtf8(rawFilename));

  if (contentType.params.format?.toLowerCase().trim() === "flowed") {
    part.flowed = true;
    part.delSp = contentType.params.delsp?.toLowerCase().trim() === "yes";
  }

  part.multipart = !!part.contentType && part.contentType.startsWith("multipart/");
  part.boundary = contentType.params.boundary
    ? Buffer.from(contentType.params.boundary, "latin1")
    : false;
  part.isRfc822 = part.contentType === "message/rfc822";
};

/** Where a leaf part's decoded body goes. */
interface PartBody {
  decoder: TransferDecoder;
  write(bytes: Buffer): Promise<void> | void;
  finish(): Promise<void>;
  abort(): Promise<void>;
}

/** Bytes staged before an attachment file write is issued. */
const WRITE_BATCH_BYTES = 256 * 1024;

class FileBody implements PartBody {
  decoder: TransferDecoder;
  private handle?: fs.promises.FileHandle;
  private staging = Buffer.allocUnsafe(WRITE_BATCH_BYTES);
  private staged = 0;
  size = 0;

  constructor(
    readonly filePath: string,
    encoding: string,
    private readonly ensureDir: () => Promise<void>
  ) {
    this.decoder = createTransferDecoder(encoding);
  }

  async open(): Promise<void> {
    await this.ensureDir();
    this.handle = await fs.promises.open(this.filePath, "w");
  }

  /** Copies `bytes` into the staging buffer, writing it out whenever it fills. */
  async write(bytes: Buffer): Promise<void> {
    let offset = 0;
    while (offset < bytes.length) {
      const copied = bytes.copy(this.staging, this.staged, offset);
      this.staged += copied;
      offset += copied;
      if (this.staged === this.staging.length) await this.flush();
    }
    this.size += bytes.length;
  }

  private async flush(): Promise<void> {
    if (!this.staged) return;
    const length = this.staged;
    this.staged = 0;
    await this.handle!.write(this.staging, 0, length);
  }

  async finish(): Promise<void> {
    await this.write(this.decoder.end());
    await this.flush();
    await this.handle?.close();
    this.handle = undefined;
  }

  async abort(): Promise<void> {
    this.staged = 0;
    await this.handle?.close().catch(() => undefined);
    this.handle = undefined;
  }
}

class TextBody implements PartBody {
  decoder: TransferDecoder;
  chunks: Buffer[] = [];
  size = 0;

  constructor(encoding: string) {
    this.decoder = createTransferDecoder(encoding);
  }

  write(bytes: Buffer): void {
    if (!bytes.length) return;
    this.chunks.push(Buffer.from(bytes));
    this.size += bytes.length;
  }

  async finish(): Promise<void> {
    this.write(this.decoder.end());
  }

  async abort(): Promise<void> {
    this.chunks = [];
  }
}

/**
 * Undoes RFC 3676 format=flowed soft breaks and space-stuffing. Each joined
 * line is kept as pieces and concatenated once, so a long run of soft breaks
 * costs linear time.
 */
const decodeFlowed = (text: string, delSp: boolean): string => {
  const result: string[] = [];
  let pieces: string[] | null = null;
  let length = 0;
  const endsInSoftBreak = () => {
    const last = pieces?.[pieces.length - 1];
    if (!last?.endsWith(" ")) return false;
    // RFC 3676 §4.3: the "-- " signature separator is never a soft break.
    return !(length === 3 && pieces!.join("") === "-- ");
  };
  for (const line of text.split(/\r?\n/)) {
    if (endsInSoftBreak()) {
      if (delSp) {
        const last = pieces!.pop()!.slice(0, -1);
        length--;
        if (last) pieces!.push(last);
      }
      if (line) pieces!.push(line);
      length += line.length;
    } else {
      if (pieces !== null) result.push(pieces.join(""));
      pieces = line ? [line] : [];
      length = line.length;
    }
  }
  if (length) result.push(pieces!.join(""));
  return result.join("\n").replace(/^ /gm, "");
};

const spillFilename = (contentType: string): string =>
  contentType === "text/html" ? "body.html" : contentType === "text/plain" ? "body.txt" : "body";

class MimeParseError extends Error {}

/**
 * Streaming MIME parser. Bytes are split into parts as they arrive; attachment
 * parts are transfer-decoded straight into files under the attachment
 * directory, and only text bodies (within {@link TEXT_BODY_BUDGET_BYTES}) and
 * headers are held in memory.
 */
class MimeParser {
  private root: Part = newPart(null);
  private part: Part = this.root;
  private stack: Part[] = [this.root];
  private inHeader = true;
  private partCount = 1;

  private partial: Buffer = EMPTY;
  private continuingLine = false;
  private pendingBreak: Buffer = EMPTY;

  private messageHeaders: MessageHeaders = {};
  private hasText = false;
  private hasHtml = false;
  private textBudget = TEXT_BODY_BUDGET_BYTES;
  private attachments: { part: Part; attachment: ParsedAttachment }[] = [];
  private openBodies = new Set<PartBody>();
  private dirReady?: Promise<void>;
  private fileCounter = 0;

  constructor(private readonly options: ParseOptions) {}

  private ensureDir = (): Promise<void> => {
    this.dirReady ??= fs.promises
      .mkdir(this.options.attachmentDir, { recursive: true })
      .then(() => undefined);
    return this.dirReady;
  };

  private nextFilePath(): string {
    return path.join(this.options.attachmentDir, String(this.fileCounter++));
  }

  /** Longest line that could still be a boundary delimiter of the current part. */
  private boundaryLineLimit(): number {
    const own = this.part.boundary ? this.part.boundary.length : 0;
    const parent = this.part.parentBoundary ? this.part.parentBoundary.length : 0;
    return Math.max(own, parent) + 8;
  }

  async write(chunk: Buffer): Promise<void> {
    if (!this.partial.length) return this.processLines(chunk);
    const lf = chunk.indexOf(LF);
    if (lf === -1) return this.processLines(Buffer.concat([this.partial, chunk]));
    // Only the carried-over line is joined; the rest of the chunk is read in place.
    await this.processLines(Buffer.concat([this.partial, chunk.subarray(0, lf + 1)]));
    await this.processLines(chunk.subarray(lf + 1));
  }

  private async processLines(data: Buffer): Promise<void> {
    this.partial = EMPTY;
    let lineStart = 0;
    let groupStart = -1;
    let groupEnd = -1;

    const flushGroup = async () => {
      if (groupStart < 0) return;
      await this.bodyBytes(data.subarray(groupStart, groupEnd));
      groupStart = -1;
    };

    while (lineStart < data.length) {
      const lf = data.indexOf(LF, lineStart);
      if (lf === -1) break;
      const line = data.subarray(lineStart, lf + 1);
      const continuation = this.continuingLine;
      this.continuingLine = false;

      const boundary = continuation ? 0 : this.checkBoundary(line);
      if (!boundary && !this.inHeader && !this.part.multipart) {
        if (groupStart < 0) groupStart = lineStart;
        groupEnd = lf + 1;
        lineStart = lf + 1;
        continue;
      }
      await flushGroup();
      if (boundary) await this.onBoundary(boundary);
      else if (this.inHeader) await this.headerLine(line, false);
      lineStart = lf + 1;
    }

    let rest = data.subarray(lineStart);
    const cannotBeBoundary = this.continuingLine || rest.length > this.boundaryLineLimit();
    if (rest.length && !this.inHeader && cannotBeBoundary) {
      // A trailing CR may be the first half of this line's CRLF, so it waits.
      const held = rest[rest.length - 1] === CR ? 1 : 0;
      if (!this.part.multipart && rest.length > held) {
        if (groupStart < 0) groupStart = lineStart;
        groupEnd = data.length - held;
      }
      this.continuingLine = true;
      rest = rest.subarray(rest.length - held);
    }
    await flushGroup();
    if (rest.length) {
      if (this.inHeader && this.part.headerLength + rest.length > MAX_PART_HEADER_BYTES) {
        throw new MimeParseError("Max header size for a MIME node exceeded");
      }
      this.partial = Buffer.from(rest);
    }
  }

  async end(): Promise<ParsedMessage> {
    const rest = this.partial;
    this.partial = EMPTY;
    const boundary = this.continuingLine ? 0 : this.checkBoundary(rest);
    if (boundary) await this.onBoundary(boundary);
    else if (this.inHeader) await this.headerLine(rest, true);
    else if (!this.part.multipart) await this.bodyBytes(rest, true);
    if (!this.inHeader && !this.part.multipart) await this.bodyBytes(EMPTY, true);
    await this.finishPart(this.part);
    return this.result();
  }

  async abort(): Promise<void> {
    await Promise.all([...this.openBodies].map((body) => body.abort()));
    this.openBodies.clear();
  }

  private compareBoundary(line: Buffer, start: number, boundary: Buffer): 0 | 1 | 2 {
    if (line.length < boundary.length + 3 + start || line.length > boundary.length + 6 + start) {
      return 0;
    }
    for (let i = 0; i < boundary.length; i++) {
      if (line[i + 2 + start] !== boundary[i]) return 0;
    }
    let pos = 0;
    for (let i = boundary.length + 2 + start; i < line.length; i++) {
      const c = line[i];
      if (pos === 0 && (c === CR || c === LF)) return 1;
      if ((pos === 0 || pos === 1) && c !== DASH) return 0;
      if (pos === 2 && c !== CR && c !== LF) return 0;
      if (pos === 3 && c !== LF) return 0;
      pos++;
    }
    return 2;
  }

  /** 1 next child, 2 own multipart end, 3 next sibling, 4 parent multipart end. */
  private checkBoundary(line: Buffer): number {
    let start = 0;
    if (line.length >= 1 && (line[0] === CR || line[0] === LF)) {
      start++;
      if (line.length >= 2 && (line[0] === CR || line[1] === LF)) start++;
    }
    if (line.length < 4 || line[start] !== DASH || line[start + 1] !== DASH) return 0;
    if (this.part.boundary) {
      const own = this.compareBoundary(line, start, this.part.boundary);
      if (own) return own;
    }
    if (this.part.parentBoundary) {
      const parent = this.compareBoundary(line, start, this.part.parentBoundary);
      if (parent) return parent + 2;
    }
    return 0;
  }

  private async onBoundary(kind: number): Promise<void> {
    this.pendingBreak = EMPTY;
    await this.finishPart(this.part);
    switch (kind) {
      case 1:
        this.startPart(this.part);
        break;
      case 3: {
        let parent = this.part.parent;
        if (parent?.isRfc822) parent = parent.parent;
        this.startPart(parent);
        break;
      }
      case 4:
        if (this.inHeader && this.part.headerLength && !this.part.headerLines) {
          await this.completeHeader();
        }
        if (this.stack.length) this.part = this.stack.pop()!;
        this.inHeader = false;
        break;
    }
  }

  private startPart(parent: Part | null): void {
    this.partCount++;
    if (this.partCount > MAX_PARTS) throw new MimeParseError("Max allowed child nodes exceeded");
    this.part = newPart(parent);
    this.inHeader = true;
  }

  private async headerLine(line: Buffer, final: boolean): Promise<void> {
    if (line.length) {
      this.part.headerChunks.push(Buffer.from(line));
      this.part.headerLength += line.length;
    }
    if (this.part.headerLength > MAX_PART_HEADER_BYTES) {
      throw new MimeParseError("Max header size for a MIME node exceeded");
    }
    const blank =
      (line.length === 1 && line[0] === LF) ||
      (line.length === 2 && line[0] === CR && line[1] === LF);
    if (final || blank) await this.completeHeader();
  }

  private async completeHeader(): Promise<void> {
    const part = this.part;
    readPartStructure(part);
    if (part.parent) part.parent.children.push(part);
    this.continuingLine = false;

    const embedsMessage =
      part.isRfc822 &&
      (!part.encoding || ["7bit", "8bit", "binary"].includes(part.encoding)) &&
      part.disposition === "inline";

    if (embedsMessage) {
      part.messageNode = true;
      this.startPart(part);
      this.part.parentBoundary = part.parent ? part.parent.boundary : false;
    } else {
      this.inHeader = false;
      if (part.multipart && part.boundary) this.stack.push(part);
    }

    await this.openBody(part);
  }

  private async openBody(part: Part): Promise<void> {
    const lines = part.headerLines!;
    if (part === this.root) this.messageHeaders = readMessageHeaders(lines);
    if (part.parent?.isRfc822) {
      part.showMeta = true;
      part.metaHeaders = readMessageHeaders(lines);
    }
    if (part.multipart || part.messageNode) return;

    const contentType = part.contentType || (part === this.root ? "text/plain" : "");
    part.contentType = contentType || false;

    let disposition = part.disposition;
    if (disposition && disposition !== "attachment" && disposition !== "inline") {
      disposition = "attachment";
    }
    disposition = disposition || (TEXT_TYPES.has(contentType) ? "inline" : "attachment");
    const isAttachment = !TEXT_TYPES.has(contentType) || disposition !== "inline";
    const encoding =
      part.encoding === "quoted-printable" || part.encoding === "base64" ? part.encoding : "binary";

    if (isAttachment) {
      let attachmentType = contentType;
      if (contentType === "application/octet-stream" && part.filename) {
        attachmentType = mimeTypeFromFilename(part.filename);
      }
      const contentId = readMessageHeaders(lines).contentId;
      const body = new FileBody(this.nextFilePath(), encoding, this.ensureDir);
      this.openBodies.add(body);
      await body.open();
      part.body = body;
      this.attachments.push({
        part,
        attachment: {
          path: body.filePath,
          filename: part.filename,
          contentType: attachmentType,
          size: 0,
          cid: contentId?.trim().replace(/^<|>$/g, "").trim()
        }
      });
      return;
    }

    if (contentType === "text/html") this.hasHtml = true;
    else this.hasText = true;
    part.body = new TextBody(encoding);
  }

  private async bodyBytes(bytes: Buffer, final = false): Promise<void> {
    const part = this.part;
    if (!part.body) return;
    let content = bytes;
    let held: Buffer = EMPTY;
    if (!final && part.parent) {
      // The line break before a boundary belongs to the boundary, so the last
      // one is held until the next line shows it is not followed by one.
      const breakLength = this.continuingLine ? 0 : trailingBreakLength(bytes);
      content = bytes.subarray(0, bytes.length - breakLength);
      held = bytes.subarray(bytes.length - breakLength);
    }
    if (this.pendingBreak.length && (bytes.length || final)) {
      const pending = this.pendingBreak;
      this.pendingBreak = EMPTY;
      await this.deliver(part, part.body.decoder.write(pending));
    }
    if (content.length) await this.deliver(part, part.body!.decoder.write(content));
    if (held.length) this.pendingBreak = Buffer.from(held);
  }

  private async deliver(part: Part, decoded: Buffer): Promise<void> {
    const body = part.body!;
    if (body instanceof TextBody && decoded.length) {
      if (body.size + decoded.length > this.textBudget) {
        await this.spillToFile(part, body);
        await this.deliver(part, decoded);
        return;
      }
    }
    await body.write(decoded);
  }

  private async spillToFile(part: Part, text: TextBody): Promise<void> {
    const file = new FileBody(this.nextFilePath(), "binary", this.ensureDir);
    file.decoder = text.decoder;
    this.openBodies.add(file);
    await file.open();
    for (const chunk of text.chunks) await file.write(chunk);
    part.body = file;
    const contentType = part.contentType || "text/plain";
    this.attachments.push({
      part,
      attachment: {
        path: file.filePath,
        filename: part.filename ?? spillFilename(contentType),
        contentType,
        size: 0
      }
    });
  }

  private async finishPart(part: Part): Promise<void> {
    const body = part.body;
    if (!body) return;
    part.body = undefined;
    if (body instanceof TextBody) {
      await body.finish();
      if (body.size > this.textBudget) {
        await this.spillToFile(part, body);
        await this.finishPart(part);
        return;
      }
      this.textBudget -= body.size;
      let bytes = Buffer.concat(body.chunks, body.size);
      if (part.flowed) {
        bytes = Buffer.from(decodeFlowed(bytes.toString("latin1"), part.delSp), "latin1");
      }
      part.textContent = decodeBodyBytes(bytes, part.charset).replace(/\r?\n/g, "\n");
      return;
    }
    if (body instanceof FileBody) {
      await body.finish();
      this.openBodies.delete(body);
      const entry = this.attachments.find((candidate) => candidate.part === part);
      if (entry) entry.attachment.size = body.size;
    }
  }

  private result(): ParsedMessage {
    const headers = this.messageHeaders;
    const { text, html } = this.textContent();
    return {
      messageId: headers.messageId,
      from: headers.from,
      to: headers.to,
      cc: headers.cc,
      bcc: headers.bcc,
      replyTo: headers.replyTo,
      subject: headers.subject,
      date: headers.date,
      text,
      html,
      attachments: this.attachments.map(({ attachment }) => attachment)
    };
  }

  private textContent(): { text?: string; html?: string } {
    const text: string[] = [];
    const html: string[] = [];
    const visit = (part: Part, alternative: boolean) => {
      if (part.showMeta && part.metaHeaders) {
        if (this.hasHtml) html.push(embeddedHeadersAsHtml(part.metaHeaders));
        if (this.hasText) text.push(embeddedHeadersAsText(part.metaHeaders));
      }
      const content = part.textContent;
      if (content) {
        if (part.contentType === "text/plain" || part.contentType === "message/delivery-status") {
          text.push(content);
          if (!alternative && this.hasHtml) html.push(textToHtml(content));
        } else if (part.contentType === "text/html") {
          if ((!alternative && this.hasText) || (part === this.root && !this.hasText)) {
            text.push(htmlToPlainText(content.slice(0, HTML_TO_TEXT_INPUT_LIMIT)));
          }
          html.push(content);
        }
      }
      const childAlternative = alternative || part.contentType === "multipart/alternative";
      part.children.forEach((child) => visit(child, childAlternative));
    };
    visit(this.root, false);
    return {
      text: text.length ? text.join("\n") : undefined,
      html: html.length ? html.join("<br/>\n") : undefined
    };
  }
}

const trailingBreakLength = (bytes: Buffer): number => {
  const n = bytes.length;
  if (n && bytes[n - 1] === LF) return n > 1 && bytes[n - 2] === CR ? 2 : 1;
  return 0;
};

/**
 * Replaces `cid:` references in `html` with `data:` URLs of the image
 * attachments they name, within {@link INLINE_IMAGE_BUDGET_BYTES}.
 */
const inlineImages = async (html: string, attachments: ParsedAttachment[]): Promise<string> => {
  const pattern = /\bcid:([^'"\s]{1,256})/g;
  const wanted = new Map<string, ParsedAttachment>();
  for (const [, cid] of html.matchAll(pattern)) {
    if (wanted.has(cid)) continue;
    const image = attachments.find(
      (attachment) => attachment.cid === cid && /^image\/[\w]+$/i.test(attachment.contentType)
    );
    if (image) wanted.set(cid, image);
  }
  if (!wanted.size) return html;

  const urls = new Map<string, string>();
  let budget = INLINE_IMAGE_BUDGET_BYTES;
  for (const [cid, image] of wanted) {
    if (image.size > budget) continue;
    budget -= image.size;
    const content = await fs.promises.readFile(image.path);
    urls.set(cid, `data:${image.contentType};base64,${content.toString("base64")}`);
  }
  return html.replace(pattern, (match, cid: string) => urls.get(cid) ?? match);
};

/**
 * Parses an RFC 5322 message read from `source`.
 *
 * Attachments are decoded into files under `options.attachmentDir`, which the
 * caller removes once it is done with them — on failure as well, since a
 * partly written file may already be there when this rejects.
 *
 * @example
 * try {
 *   await store(await parseMessage(stream, { attachmentDir }));
 * } finally {
 *   await fs.promises.rm(attachmentDir, { recursive: true, force: true });
 * }
 */
export const parseMessage = async (
  source: Readable | AsyncIterable<Buffer | string>,
  options: ParseOptions
): Promise<ParsedMessage> => {
  const parser = new MimeParser(options);
  try {
    for await (const chunk of source) {
      await parser.write(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
    }
    const parsed = await parser.end();
    if (parsed.html) parsed.html = await inlineImages(parsed.html, parsed.attachments);
    return parsed;
  } catch (error) {
    await parser.abort();
    throw error;
  }
};
