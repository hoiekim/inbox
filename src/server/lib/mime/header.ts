import { decodeHeaderBytes } from "./charset";

const canonicalCharset = (label: string): string => {
  try {
    return new TextDecoder(label.trim()).encoding;
  } catch {
    return label.trim().toLowerCase();
  }
};

const isHex = (byte: number | undefined): boolean =>
  byte !== undefined &&
  ((byte >= 0x30 && byte <= 0x39) ||
    (byte >= 0x41 && byte <= 0x46) ||
    (byte >= 0x61 && byte <= 0x66));

const decodeQ = (text: string): Uint8Array => {
  const source = Buffer.from(text.replace(/=\s+([0-9a-fA-F])/g, "=$1").replace(/[_\s]/g, " "));
  const bytes: number[] = [];
  for (let i = 0; i < source.length; i++) {
    const byte = source[i];
    if (byte === 0x3d && isHex(source[i + 1]) && isHex(source[i + 2])) {
      bytes.push(parseInt(String.fromCharCode(source[i + 1], source[i + 2]), 16));
      i += 2;
      continue;
    }
    bytes.push(byte);
  }
  return Uint8Array.from(bytes);
};

const decodeB = (text: string): Uint8Array =>
  Buffer.concat(
    text
      .split("=")
      .filter((part) => part !== "")
      .map((part) => Buffer.from(part, "base64"))
  );

const decodeWord = (charset: string, encoding: string, text: string): string => {
  const languageAt = charset.indexOf("*");
  const label = languageAt >= 0 ? charset.slice(0, languageAt) : charset;
  const mode = encoding.toUpperCase();
  const bytes = mode === "Q" ? decodeQ(text) : mode === "B" ? decodeB(text) : Buffer.from(text);
  return decodeHeaderBytes(bytes, label);
};

const JOIN = "__\x00JOIN\x00__";

const markJoinable = (pattern: RegExp) => (value: string) =>
  value.replace(pattern, (match, left: string, leftCharset: string, rightCharset: string) =>
    canonicalCharset(leftCharset ?? "") === canonicalCharset(rightCharset ?? "")
      ? left + JOIN
      : match
  );

const markJoinableB = markJoinable(
  /(=\?([^?]+)\?[Bb]\?[^?]*\?=)\s*(?==\?([^?]+)\?[Bb]\?[^?]*\?=)/g
);
const markJoinableQ = markJoinable(
  /(=\?([^?]+)\?[Qq]\?[^?]*\?=)\s*(?==\?([^?]+)\?[Qq]\?[^?]*\?=)/g
);

/**
 * Decodes RFC 2047 encoded words anywhere in `value`. Adjacent words in the
 * same charset are joined before decoding, so a multi-byte character split
 * across two words comes out whole; whitespace between encoded words is
 * dropped as the RFC requires.
 */
export const decodeWords = (value: string): string =>
  markJoinableQ(markJoinableB(value))
    .replace(/(\?=)?__\x00JOIN\x00__(=\?([^?]+)\?[QqBb]\?)?/g, "")
    .replace(/(=\?[^?]+\?[QqBb]\?[^?]*\?=)\s+(?==\?[^?]+\?[QqBb]\?[^?]*\?=)/g, "$1")
    .replace(/=\?([\w_\-*]+)\?([QqBb])\?([^?]*)\?=/g, (_match, charset, encoding, text) =>
      decodeWord(charset, encoding, text)
    );

/** Re-reads a string of raw octets as UTF-8, when those octets are valid UTF-8. */
export const rawOctetsAsUtf8 = (value: string): string => {
  if (!/[\x80-\xff]/.test(value) || /[^\x00-\xff]/.test(value)) return value;
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(Buffer.from(value, "latin1"));
  } catch {
    return value;
  }
};

/** Splits one raw (possibly folded) header line into its lowercased key and unfolded value. */
export const splitHeaderLine = (line: string): { key: string; value: string } => {
  const unfolded = line.replace(/(?:\r?\n|\r)[ \t]*/g, " ").trim();
  const match = unfolded.match(/^\s*([^:]+):(.*)$/);
  return {
    key: (match?.[1] ?? "").trim().toLowerCase(),
    value: (match?.[2] ?? "").trim()
  };
};

export interface StructuredHeaderValue {
  value: string;
  params: Record<string, string>;
}

/**
 * Parses `value; key=value; key="quoted value"` as used by Content-Type and
 * Content-Disposition, including RFC 2231 continuations (`name*0=`, `name*1=`)
 * and charset-tagged values (`name*=utf-8''%ED%95%9C`).
 */
export const parseHeaderValue = (input: string): StructuredHeaderValue => {
  const params: Record<string, string> = {};
  let main = "";
  let key: string | false = false;
  let value = "";
  let inKey = false;
  let quote: string | false = false;
  let escaped = false;

  for (const chr of input) {
    if (inKey) {
      if (chr === "=") {
        key = value.trim().toLowerCase();
        inKey = false;
        value = "";
      } else {
        value += chr;
      }
      continue;
    }
    if (escaped) {
      value += chr;
    } else if (chr === "\\") {
      escaped = true;
      continue;
    } else if (quote && chr === quote) {
      quote = false;
    } else if (!quote && chr === '"') {
      quote = chr;
    } else if (!quote && chr === ";") {
      if (key === false) main = value.trim();
      else params[key] = value.trim();
      inKey = true;
      value = "";
    } else {
      value += chr;
    }
    escaped = false;
  }

  value = value.trim();
  if (!inKey) {
    if (key === false) main = value;
    else params[key] = value;
  } else if (value) {
    params[value.toLowerCase()] = "";
  }

  type Continuation = { charset: string | false; parts: { nr: number; value: string }[] };
  const continued = new Map<string, Continuation>();
  for (const name of Object.keys(params)) {
    const match = name.match(/\*((\d+)\*?)?$/);
    if (!match) continue;
    const actual = name.slice(0, match.index).toLowerCase();
    const nr = Number(match[2]) || 0;
    const entry = continued.get(actual) ?? { charset: false, parts: [] };
    continued.set(actual, entry);
    let part = params[name];
    const tagged = nr === 0 && match[0].endsWith("*") && part.match(/^([^']*)'[^']*'(.*)$/);
    if (tagged) {
      entry.charset = tagged[1] || "utf-8";
      part = tagged[2];
    }
    entry.parts.push({ nr, value: part });
    delete params[name];
  }

  for (const [name, entry] of continued) {
    const joined = entry.parts
      .sort((a, b) => a.nr - b.nr)
      .map((part) => part.value || "")
      .join("");
    params[name] = entry.charset
      ? decodeWords(
          `=?${entry.charset}?Q?` +
            joined
              .replace(/[=?_\s]/g, (s) =>
                s === " " ? "_" : `%${s.charCodeAt(0).toString(16).padStart(2, "0")}`
              )
              .replace(/%/g, "=") +
            "?="
        )
      : decodeWords(joined);
  }

  return { value: main, params };
};

/** Wraps a message id in angle brackets, or answers `undefined` for an empty one. */
export const ensureMessageIdFormat = (value: string): string | undefined => {
  if (!value.length) return undefined;
  let id = value;
  if (!id.startsWith("<")) id = "<" + id;
  if (!id.endsWith(">")) id += ">";
  return id;
};
