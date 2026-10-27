import { MailDataToSend } from "common";
import { getText, getUserDomain } from "server";
import { UploadedFileDynamicArray } from "./send";
import type { UploadedFile } from "../http/upload";
import { logger } from "../logger";
import { sendAlarm } from "../alarm";

const { MAILGUN_KEY = "mailgun_key" } = process.env;

const DEFAULT_MAILGUN_URL = "https://api.mailgun.net";
const REQUEST_TIMEOUT_MS = 30000;
const MAX_BODY_BYTES = 50 * 1024 * 1024;

/** A file part of a Mailgun message, streamed from disk while the request uploads. */
export interface MailgunAttachment {
  path: string;
  filename: string;
  contentType: string;
}

/** The `POST /v3/{domain}/messages` parameters this module sends, in wire order. */
export interface MailgunMessage {
  from: string;
  to: string[];
  cc?: string;
  bcc?: string;
  subject?: string;
  html?: string;
  text?: string;
  attachment: MailgunAttachment[];
  "h:In-Reply-To"?: string;
}

/** Mailgun's answer to an accepted message: the queued message's id and a status line. */
export interface MailgunResponse {
  status: number;
  id?: string;
  message?: string;
}

/**
 * A failed Mailgun request. `status` is the HTTP status, or 400 when no response
 * arrived; `message` is the response's error or status text, `details` its message.
 */
export class MailgunAPIError extends Error {
  status: number;
  details: string;
  type = "MailgunAPIError";

  constructor(status: number, statusText: string, body: unknown) {
    const fields = typeof body === "object" && body ? (body as Record<string, unknown>) : {};
    super();
    this.message = String(fields.error || "") || statusText;
    this.status = status;
    this.details = typeof body === "string" ? body : String(fields.message || "");
  }
}

const getAttachments = (files?: UploadedFileDynamicArray): MailgunAttachment[] => {
  const parseFile = (file: UploadedFile): MailgunAttachment => ({
    path: file.tempFilePath,
    filename: file.name,
    contentType: file.mimetype
  });

  if (Array.isArray(files)) return files.map(parseFile);
  else if (files) return [parseFile(files)];
  else return [];
};

const encoder = new TextEncoder();
const CRLF = encoder.encode("\r\n");

// A filename is the one client-supplied string inside a part header; escaping
// it the way browsers do keeps a quote or line break from ending that header.
const quoteFilename = (name: string) =>
  name.replace(/"/g, "%22").replace(/\r/g, "%0D").replace(/\n/g, "%0A");

/**
 * Encodes a message as multipart/form-data. Empty fields are left out, an array
 * repeats its field once per item, and attachments are read from disk only as the
 * request body is pulled, so no attachment is ever held in memory whole.
 */
export const encodeMailgunMessage = (message: MailgunMessage) => {
  const boundary = `--------------------------${crypto.randomUUID().replace(/-/g, "")}`;
  const partHead = (disposition: string, contentType?: string) =>
    encoder.encode(
      `--${boundary}\r\nContent-Disposition: form-data; ${disposition}\r\n` +
        (contentType ? `Content-Type: ${contentType}\r\n` : "") +
        "\r\n"
    );

  const parts: (Uint8Array | Blob)[] = [];
  for (const [name, value] of Object.entries(message)) {
    if (!value) continue;
    if (name === "attachment") {
      for (const file of value as MailgunAttachment[]) {
        const disposition = `name="attachment"; filename="${quoteFilename(file.filename)}"`;
        parts.push(partHead(disposition, file.contentType), Bun.file(file.path), CRLF);
      }
      continue;
    }
    for (const item of [value].flat() as string[]) {
      parts.push(partHead(`name="${name}"`), encoder.encode(item), CRLF);
    }
  }
  parts.push(encoder.encode(`--${boundary}--\r\n`));

  const length = parts.reduce(
    (total, part) => total + (part instanceof Blob ? part.size : part.byteLength),
    0
  );
  let index = 0;
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  const body = new ReadableStream<Uint8Array>({
    async pull(controller) {
      while (index < parts.length) {
        const part = parts[index]!;
        if (!(part instanceof Blob)) {
          index += 1;
          controller.enqueue(part);
          return;
        }
        reader ??= part.stream().getReader();
        const { done, value } = await reader.read();
        if (!done) {
          controller.enqueue(value);
          return;
        }
        reader = undefined;
        index += 1;
      }
      controller.close();
    },
    cancel: (reason) => reader?.cancel(reason)
  });

  return { body, length, contentType: `multipart/form-data; boundary=${boundary}` };
};

const parseBody = (text: string): unknown => {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
};

/** Why a request got no response, in the terms a caller's error mapping reads. */
const networkFailure = (error: unknown): MailgunAPIError => {
  const { name, code, message } = (error ?? {}) as {
    name?: string;
    code?: string;
    message?: string;
  };
  if (name === "TimeoutError") {
    return new MailgunAPIError(400, "ECONNABORTED", `timeout of ${REQUEST_TIMEOUT_MS}ms exceeded`);
  }
  return new MailgunAPIError(400, code || name || "", message || String(error));
};

/**
 * Sends one message through Mailgun's HTTP API, failing after 30 seconds or without
 * a request when the body would pass 50 MiB. The API root is `MAILGUN_URL` when set,
 * read per call like `EMAIL_DOMAIN`.
 */
export const createMailgunMessage = async (
  domain: string,
  message: MailgunMessage
): Promise<MailgunResponse> => {
  const { MAILGUN_URL = DEFAULT_MAILGUN_URL } = process.env;
  const url = `${MAILGUN_URL.replace(/\/+$/, "")}/v3/${domain}/messages`;
  const { body, length, contentType } = encodeMailgunMessage(message);
  if (length > MAX_BODY_BYTES) {
    throw new MailgunAPIError(
      400,
      "ERR_FR_MAX_BODY_LENGTH_EXCEEDED",
      "Request body larger than maxBodyLength limit"
    );
  }

  let status: number;
  let statusText: string;
  let data: unknown;
  try {
    const response = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Basic ${btoa(`api:${MAILGUN_KEY}`)}`,
        "Content-Type": contentType,
        "Content-Length": String(length)
      },
      body,
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)
    });
    ({ status, statusText } = response);
    data = parseBody(await response.text());
  } catch (error) {
    throw networkFailure(error);
  }

  if (status < 200 || status >= 300) {
    const body = data || `Request failed with status code ${status}`;
    throw new MailgunAPIError(status, statusText, body);
  }
  if (data === "Mailgun Magnificent API") throw new MailgunAPIError(400, "Incorrect url", data);
  return { status, ...(typeof data === "string" ? { message: data } : (data as object)) };
};

// One multipart upload per address against a 30s-timeout client, so an
// unbounded Bcc list would otherwise put every upload in flight in one tick.
const MAX_CONCURRENT_SENDS = 5;

const sendBatched = async <T>(
  addresses: string[],
  send: (address: string) => Promise<T>
): Promise<PromiseSettledResult<T>[]> => {
  const results: PromiseSettledResult<T>[] = [];
  for (let i = 0; i < addresses.length; i += MAX_CONCURRENT_SENDS) {
    const batch = addresses.slice(i, i + MAX_CONCURRENT_SENDS);
    results.push(...(await Promise.allSettled(batch.map(send))));
  }
  return results;
};

export const sendMailgunMail = async (
  username: string,
  mail: MailDataToSend,
  files?: UploadedFileDynamicArray
) => {
  const { sender, senderFullName, to, cc, bcc, subject, html, inReplyTo } =
    mail;

  // Read at call time: the filter below is only meaningful against the domain
  // the process is actually serving.
  const { EMAIL_DOMAIN = "mydomain" } = process.env;

  const addresses = (list?: string) =>
    (list ?? "")
      .split(",")
      .map((addr) => addr.trim())
      .filter(Boolean);
  const isExternal = (address: string) => !address.endsWith(`@${EMAIL_DOMAIN}`);

  const recipients = [...addresses(to), ...addresses(cc), ...addresses(bcc)];
  if (recipients.length && !recipients.some(isExternal)) {
    logger.info("All recipients are to myself, skipping Mailgun sending.");
    return;
  }

  const externalTo = addresses(to).filter(isExternal);
  const externalCc = addresses(cc).filter(isExternal);
  const externalBcc = addresses(bcc).filter(isExternal);

  const text = getText(html);
  const userDomain = getUserDomain(username);
  const fromAddress = `${sender}@${userDomain}`;
  const from = senderFullName
    ? `${senderFullName} <${fromAddress}>`
    : fromAddress;

  // Mailgun renders the visible `To:` header from the `to` parameter and
  // rejects a message that carries none, so the address put there has to be
  // both deliverable off this host and already disclosed to everyone on the
  // message. An external addressee qualifies, and so does an external Cc,
  // which every recipient already sees. A Bcc address is disclosed to nobody but
  // itself, so a send whose only external recipients are Bcc goes out as one
  // message per recipient. Naming the sender instead hands Mailgun a
  // host-domain recipient, which routes the copy back at our own MX.
  const visibleTo = externalTo.length ? externalTo : externalCc;

  const attachment = getAttachments(files);
  const message = (
    to: string[],
    hidden?: { cc?: string; bcc?: string }
  ): MailgunMessage => ({
    from,
    to,
    cc: hidden?.cc,
    bcc: hidden?.bcc,
    subject,
    html,
    text,
    attachment,
    "h:In-Reply-To": inReplyTo
  });

  // Only external addresses go to Mailgun: a host-domain Cc or Bcc handed to
  // the relay comes back at our own MX on an unauthenticated leg, which is
  // refused with a 450 and retried for Mailgun's full window.
  if (visibleTo.length) {
    const data = await createMailgunMessage(
      EMAIL_DOMAIN,
      message(visibleTo, {
        // A promoted Cc already IS the visible To; repeating it here renders
        // the same address in both the `To:` and `Cc:` header lines.
        cc: (externalTo.length ? externalCc.join(",") : "") || undefined,
        bcc: externalBcc.join(",") || undefined
      })
    );
    logger.info("Email sending request succeeded");
    return data;
  }

  const results = await sendBatched(externalBcc, (address) =>
    createMailgunMessage(EMAIL_DOMAIN, message([address]))
  );
  const delivered = results.find((result) => result.status === "fulfilled");
  const failed = externalBcc.filter((_, i) => results[i].status === "rejected");

  if (!delivered) {
    const [firstRejection] = results.filter(
      (result) => result.status === "rejected"
    );
    throw firstRejection
      ? firstRejection.reason
      : new Error("No deliverable recipient");
  }

  // Some recipients already hold the message, so rejecting the whole send
  // would leave the user resending to everyone and no Sent record for the
  // copies that landed. Keep the send successful and alarm the gap instead.
  if (failed.length) {
    logger.error("Some Bcc recipients were not delivered", { failed });
    sendAlarm(
      "Mail Send Partially Failed",
      `**Undelivered Bcc recipients:** ${failed.join(", ")}`
    ).catch(() => undefined);
  }

  logger.info("Email sending request succeeded");

  return delivered.value;
};
