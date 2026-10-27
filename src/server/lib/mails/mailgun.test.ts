import { describe, it, expect, beforeAll, beforeEach, afterAll, spyOn } from "bun:test";
import fs from "fs";
import os from "os";
import path from "path";
import { MailDataToSend } from "common";
import { logger } from "../logger";
import type { UploadedFile } from "../http/upload";
import { encodeMailgunMessage, sendMailgunMail } from "./mailgun";

// The host domain is the sender's own domain, as it is for an admin in
// production, so the visible-To assertions run against the shape that ships.
// It also has to differ from the module's own "mydomain" default, or an
// assertion about it passes just as well against a build that never reads it.
const ORIGINAL_ENV = {
  EMAIL_DOMAIN: process.env.EMAIL_DOMAIN,
  MAILGUN_URL: process.env.MAILGUN_URL,
};

interface Received {
  method: string;
  path: string;
  headers: Headers;
  raw: Uint8Array;
  form: FormData;
}

const accepted = (id: string) => Response.json({ id, message: "Queued. Thank you." });

let received: Received[] = [];
let respond: (form: FormData) => Response | Promise<Response>;
let stub: ReturnType<typeof Bun.serve>;
let stubUrl: string;
let tempDir: string;

const loggerError = spyOn(logger, "error").mockImplementation(() => {});
const loggerInfo = spyOn(logger, "info").mockImplementation(() => {});

beforeAll(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "mailgun-test-"));
  stub = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(req) {
      const raw = new Uint8Array(await req.arrayBuffer());
      const contentType = req.headers.get("content-type") ?? "";
      const form = await new Response(raw, { headers: { "Content-Type": contentType } }).formData();
      received.push({
        method: req.method,
        path: new URL(req.url).pathname,
        headers: req.headers,
        raw,
        form,
      });
      return respond(form);
    },
  });
  stubUrl = `http://127.0.0.1:${stub.port}`;
});

afterAll(() => {
  stub.stop(true);
  fs.rmSync(tempDir, { recursive: true, force: true });
  loggerError.mockRestore();
  loggerInfo.mockRestore();
  // An `EMAIL_DOMAIN` left at "example.com" makes every later file's
  // `addressToUsername("victim@example.com")` answer "admin".
  for (const [name, value] of Object.entries(ORIGINAL_ENV)) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
});

beforeEach(() => {
  received = [];
  respond = () => accepted("msg-id-123");
  loggerError.mockClear();
  process.env.EMAIL_DOMAIN = "example.com";
  process.env.MAILGUN_URL = stubUrl;
});

const writeFile = (name: string, content: string | Uint8Array): string => {
  const filePath = path.join(tempDir, name);
  fs.writeFileSync(filePath, content);
  return filePath;
};

const upload = (name: string, mimetype: string, content: string | Uint8Array): UploadedFile => {
  const tempFilePath = writeFile(`upload-${crypto.randomUUID()}`, content);
  return { name, mimetype, size: fs.statSync(tempFilePath).size, tempFilePath };
};

const only = (): FormData => {
  expect(received).toHaveLength(1);
  return received[0]!.form;
};

const recipientsOf = (form: FormData) => form.getAll("to");

const baseMail = new MailDataToSend({
  sender: "admin",
  senderFullName: "",
  to: "recipient@external.com",
  cc: undefined,
  bcc: undefined,
  subject: "Test Subject",
  html: "<p>Hello</p>",
  inReplyTo: undefined,
});

describe("sendMailgunMail", () => {
  it("should send when recipients include external addresses", async () => {
    const mail = new MailDataToSend({ ...baseMail, to: "external@outside.test" });
    await sendMailgunMail("admin", mail);
    expect(received).toHaveLength(1);
  });

  it("should pass the envelope to as one field per trimmed address", async () => {
    const mail = new MailDataToSend({ ...baseMail, to: "a@outside.test, b@elsewhere.test" });
    await sendMailgunMail("admin", mail);
    expect(recipientsOf(only())).toEqual(["a@outside.test", "b@elsewhere.test"]);
  });

  // Mailgun renders a `To:` header from the `to:` parameter on its own.
  // Passing `h:To` as well appends a SECOND `To:` header to the RFC 5322
  // message, which Gmail rejects with `5.7.1 … multiple To headers`. Keep
  // the envelope-only shape.
  it("should not set the h:To custom header (would duplicate the To: header)", async () => {
    const mail = new MailDataToSend({ ...baseMail, to: "a@outside.test, b@elsewhere.test" });
    await sendMailgunMail("admin", mail);
    expect(only().has("h:To")).toBe(false);
  });

  it("should format from address with senderFullName when provided", async () => {
    const mail = new MailDataToSend({ ...baseMail, senderFullName: "Admin User" });
    await sendMailgunMail("admin", mail);
    expect(only().get("from")).toBe("Admin User <admin@example.com>");
  });

  it("should format from address without senderFullName when not provided", async () => {
    const mail = new MailDataToSend({ ...baseMail, senderFullName: "" });
    await sendMailgunMail("admin", mail);
    expect(only().get("from")).toBe("admin@example.com");
  });

  it("should include subject, html, and text in message", async () => {
    const mail = new MailDataToSend({
      ...baseMail,
      subject: "My Test Subject",
      html: "<p>Hello World</p>",
    });
    await sendMailgunMail("admin", mail);
    const form = only();
    expect(form.get("subject")).toBe("My Test Subject");
    expect(form.get("html")).toBe("<p>Hello World</p>");
    expect(form.get("text")).toContain("Hello World");
  });

  it("should include cc and bcc as one comma-joined field each", async () => {
    const mail = new MailDataToSend({
      ...baseMail,
      cc: "cc@external.com, cc2@external.com",
      bcc: "bcc@external.com",
    });
    await sendMailgunMail("admin", mail);
    const form = only();
    expect(form.getAll("cc")).toEqual(["cc@external.com,cc2@external.com"]);
    expect(form.getAll("bcc")).toEqual(["bcc@external.com"]);
  });

  it("should send a Bcc-only submission one message per recipient", async () => {
    const mail = new MailDataToSend({
      ...baseMail,
      to: "",
      bcc: "hidden@external.com, other@external.com",
    });
    await sendMailgunMail("admin", mail);
    expect(received.map(({ form }) => recipientsOf(form)).sort()).toEqual([
      ["hidden@external.com"],
      ["other@external.com"],
    ]);
  });

  it("should never disclose one bcc recipient to another", async () => {
    const mail = new MailDataToSend({
      ...baseMail,
      to: "",
      bcc: "hidden@external.com, other@external.com",
    });
    await sendMailgunMail("admin", mail);
    expect(received).toHaveLength(2);
    for (const { form } of received) {
      expect(recipientsOf(form)).toHaveLength(1);
      expect(form.has("bcc")).toBe(false);
      expect(form.has("cc")).toBe(false);
    }
  });

  it("should never hand Mailgun a host-domain recipient on a Bcc-only send", async () => {
    const mail = new MailDataToSend({
      ...baseMail,
      to: "",
      bcc: "inside@example.com, outside@outside.test",
    });
    await sendMailgunMail("admin", mail);
    const form = only();
    expect(form.get("from")).toBe("admin@example.com");
    expect(recipientsOf(form)).toEqual(["outside@outside.test"]);
  });

  it("should keep a non-admin sender's own subdomain address out of the To", async () => {
    const mail = new MailDataToSend({
      ...baseMail,
      sender: "bob",
      to: "",
      bcc: "outside@outside.test",
    });
    await sendMailgunMail("bob", mail);
    const form = only();
    expect(form.get("from")).toBe("bob@bob.example.com");
    expect(recipientsOf(form)).toEqual(["outside@outside.test"]);
  });

  it("should carry every attachment whole to each recipient of a bcc fan-out", async () => {
    const mail = new MailDataToSend({
      ...baseMail,
      to: "",
      bcc: "one@external.com, two@external.com, three@external.com",
    });
    await sendMailgunMail("admin", mail, upload("test.pdf", "application/pdf", "file-content"));
    expect(received).toHaveLength(3);
    for (const { form } of received) {
      const file = form.get("attachment") as File;
      expect(await file.text()).toBe("file-content");
    }
  });

  it("should skip Mailgun only when every recipient across to/cc/bcc is host-domain", async () => {
    const mail = new MailDataToSend({
      ...baseMail,
      to: "inside@example.com",
      cc: "colleague@example.com",
      bcc: "another@example.com",
    });
    await sendMailgunMail("admin", mail);
    expect(received).toHaveLength(0);
  });

  it("should still send when the only external recipient sits in bcc", async () => {
    const mail = new MailDataToSend({
      ...baseMail,
      to: "inside@example.com",
      bcc: "outside@outside.test",
    });
    await sendMailgunMail("admin", mail);
    expect(recipientsOf(only())).toEqual(["outside@outside.test"]);
  });

  // The egress guard reads the union of all three lists, and a cc-only send is
  // the one shape where cc is the member holding it open — every other fixture
  // with an external cc carries a second external recipient elsewhere.
  it("should send when the only external recipient sits in cc", async () => {
    const mail = new MailDataToSend({
      ...baseMail,
      to: "inside@example.com",
      cc: "outside@outside.test",
    });
    await sendMailgunMail("admin", mail);
    expect(recipientsOf(only())).toEqual(["outside@outside.test"]);
  });

  // The promoted list is the only carrier those recipients have — dropping the
  // cc parameter for them means a short `to` is silent non-delivery, so more
  // than one address has to be driven here to tell a complete one from a
  // truncated one.
  it("should address the visible To to every external cc when no addressee is external", async () => {
    const mail = new MailDataToSend({
      ...baseMail,
      to: "inside@example.com",
      cc: "outside@outside.test, second@elsewhere.test",
      bcc: "hidden@external.com",
    });
    await sendMailgunMail("admin", mail);
    const form = only();
    expect(recipientsOf(form)).toEqual(["outside@outside.test", "second@elsewhere.test"]);
    expect(form.has("cc")).toBe(false);
    expect(form.get("bcc")).toBe("hidden@external.com");
  });

  it("should prefer an external addressee over an external cc for the visible To", async () => {
    const mail = new MailDataToSend({
      ...baseMail,
      to: "addressee@outside.test",
      cc: "outside@elsewhere.test",
    });
    await sendMailgunMail("admin", mail);
    expect(recipientsOf(only())).toEqual(["addressee@outside.test"]);
  });

  it("should keep host-domain addresses out of the rendered To header", async () => {
    const mail = new MailDataToSend({
      ...baseMail,
      to: "inside@example.com, outside@outside.test",
    });
    await sendMailgunMail("admin", mail);
    expect(recipientsOf(only())).toEqual(["outside@outside.test"]);
  });

  it("should include inReplyTo header when provided", async () => {
    const mail = new MailDataToSend({ ...baseMail, inReplyTo: "<original-msg@example.com>" });
    await sendMailgunMail("admin", mail);
    expect(only().get("h:In-Reply-To")).toBe("<original-msg@example.com>");
  });

  it("should return Mailgun's response with its HTTP status on success", async () => {
    respond = () => accepted("msg-id-999");
    const result = await sendMailgunMail("admin", baseMail);
    expect(result).toEqual({ status: 200, id: "msg-id-999", message: "Queued. Thank you." });
  });

  it("should attach an uploaded file with its name and content type", async () => {
    const file = upload("test.pdf", "application/pdf", "pdf-bytes");
    await sendMailgunMail("admin", baseMail, file);
    const attachments = only().getAll("attachment") as File[];
    expect(attachments.map(({ name, type }) => ({ name, type }))).toEqual([
      { name: "test.pdf", type: "application/pdf" },
    ]);
    expect(await attachments[0]!.text()).toBe("pdf-bytes");
  });

  it("should handle array of file attachments", async () => {
    const files = [
      upload("a.pdf", "application/pdf", "first"),
      upload("b.png", "image/png", "second"),
    ];
    await sendMailgunMail("admin", baseMail, files);
    const attachments = only().getAll("attachment") as File[];
    expect(attachments.map(({ name, type }) => ({ name, type }))).toEqual([
      { name: "a.pdf", type: "application/pdf" },
      { name: "b.png", type: "image/png" },
    ]);
    expect(await Promise.all(attachments.map((file) => file.text()))).toEqual(["first", "second"]);
  });

  it("should propagate an error response as its status, status text and message", async () => {
    respond = () => Response.json({ message: "'to' parameter is missing" }, { status: 400 });
    await expect(sendMailgunMail("admin", baseMail)).rejects.toMatchObject({
      status: 400,
      message: "Bad Request",
      details: "'to' parameter is missing",
    });
  });

  // A host-domain address handed to the relay is delivered back at our own MX
  // on an unauthenticated leg, which answers 450 and buys a full retry window.
  it("should keep host-domain cc and bcc out of the forwarded message", async () => {
    const mail = new MailDataToSend({
      ...baseMail,
      to: "outside@outside.test",
      cc: "inside@example.com, seen@outside.test",
      bcc: "admin@example.com, hidden@outside.test",
    });
    await sendMailgunMail("admin", mail);
    const form = only();
    expect(form.getAll("cc")).toEqual(["seen@outside.test"]);
    expect(form.getAll("bcc")).toEqual(["hidden@outside.test"]);
  });

  it("should omit cc and bcc entirely when every one of them is host-domain", async () => {
    const mail = new MailDataToSend({
      ...baseMail,
      to: "outside@outside.test",
      cc: "inside@example.com",
      bcc: "admin@example.com",
    });
    await sendMailgunMail("admin", mail);
    const form = only();
    expect(form.has("cc")).toBe(false);
    expect(form.has("bcc")).toBe(false);
  });

  const failingFor = (address: string) => (form: FormData) =>
    form.get("to") === address
      ? Response.json({ message: "Too many requests" }, { status: 429 })
      : accepted(`msg-${form.get("to")}`);

  // The copies that landed cannot be recalled, so failing the whole send would
  // have the user resend to everyone with no Sent record for those copies.
  it("should report success when part of a bcc fan-out fails", async () => {
    respond = failingFor("two@external.com");
    const mail = new MailDataToSend({
      ...baseMail,
      to: "",
      bcc: "one@external.com, two@external.com, three@external.com",
    });
    const result = await sendMailgunMail("admin", mail);
    expect(received).toHaveLength(3);
    expect(result).toEqual({
      status: 200,
      id: "msg-one@external.com",
      message: "Queued. Thank you.",
    });
    expect(loggerError).toHaveBeenCalledWith("Some Bcc recipients were not delivered", {
      failed: ["two@external.com"],
    });
  });

  // The alarm names addresses the send was actually attempted against, so a
  // host-domain bcc that never reached the relay must not appear in it.
  it("should report only external recipients as undelivered", async () => {
    respond = failingFor("two@external.com");
    const mail = new MailDataToSend({
      ...baseMail,
      to: "",
      bcc: "inside@example.com, one@external.com, two@external.com",
    });
    await sendMailgunMail("admin", mail);
    expect(received).toHaveLength(2);
    expect(loggerError).toHaveBeenCalledWith("Some Bcc recipients were not delivered", {
      failed: ["two@external.com"],
    });
  });

  it("should not report undelivered recipients when the whole fan-out lands", async () => {
    const mail = new MailDataToSend({
      ...baseMail,
      to: "",
      bcc: "one@external.com, two@external.com",
    });
    await sendMailgunMail("admin", mail);
    expect(received).toHaveLength(2);
    expect(loggerError).not.toHaveBeenCalled();
  });

  it("should throw when every recipient of a bcc fan-out fails", async () => {
    respond = () => Response.json({ message: "Too many requests" }, { status: 429 });
    const mail = new MailDataToSend({
      ...baseMail,
      to: "",
      bcc: "one@external.com, two@external.com",
    });
    await expect(sendMailgunMail("admin", mail)).rejects.toMatchObject({
      status: 429,
      details: "Too many requests",
    });
  });

  it("should cap how many bcc uploads are in flight at once", async () => {
    let inFlight = 0;
    let peak = 0;
    respond = async () => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await Bun.sleep(20);
      inFlight -= 1;
      return accepted("msg-id-123");
    };
    const bcc = Array.from({ length: 12 }, (_, i) => `b${i}@external.com`).join(",");
    const mail = new MailDataToSend({ ...baseMail, to: "", bcc });
    await sendMailgunMail("admin", mail);
    expect(received).toHaveLength(12);
    expect(peak).toBeLessThanOrEqual(5);
  });
});

describe("Mailgun request", () => {
  it("should post to the messages endpoint under MAILGUN_URL with basic auth", async () => {
    process.env.MAILGUN_URL = `${stubUrl}/region/`;
    await sendMailgunMail("admin", baseMail);
    expect(received).toHaveLength(1);
    const [{ method, path: requestPath, headers, raw }] = received as [Received];
    expect(method).toBe("POST");
    expect(requestPath).toBe("/region/v3/example.com/messages");
    const [scheme, credentials] = (headers.get("authorization") ?? "").split(" ");
    expect(scheme).toBe("Basic");
    expect(atob(credentials ?? "")).toStartWith("api:");
    expect(headers.get("content-type")).toMatch(/^multipart\/form-data; boundary=-+[0-9a-f]+$/);
    expect(headers.get("content-length")).toBe(String(raw.byteLength));
  });

  it("should send a Mailgun banner answer as a failure, not a queued message", async () => {
    respond = () => new Response("Mailgun Magnificent API");
    await expect(sendMailgunMail("admin", baseMail)).rejects.toMatchObject({
      status: 400,
      message: "Incorrect url",
    });
  });

  it("should carry a plain-text error body as the error's details", async () => {
    respond = () => new Response("Forbidden", { status: 401 });
    await expect(sendMailgunMail("admin", baseMail)).rejects.toMatchObject({
      status: 401,
      message: "Unauthorized",
      details: "Forbidden",
    });
  });

  it("should describe an empty error body by its status code", async () => {
    respond = () => new Response("", { status: 500 });
    await expect(sendMailgunMail("admin", baseMail)).rejects.toMatchObject({
      status: 500,
      message: "Internal Server Error",
      details: "Request failed with status code 500",
    });
  });

  it("should report an unreachable API as a 400 named by the socket error", async () => {
    const closed = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response() });
    const closedUrl = `http://127.0.0.1:${closed.port}`;
    closed.stop(true);
    process.env.MAILGUN_URL = closedUrl;
    await expect(sendMailgunMail("admin", baseMail)).rejects.toMatchObject({
      status: 400,
      message: "ECONNREFUSED",
    });
  });

  it("should refuse a body over 50 MiB without opening a request", async () => {
    const filePath = writeFile("oversized.bin", "");
    fs.truncateSync(filePath, 50 * 1024 * 1024 + 1);
    const file = { name: "big.bin", mimetype: "application/octet-stream", size: 0, tempFilePath: filePath };
    await expect(sendMailgunMail("admin", baseMail, file)).rejects.toMatchObject({
      status: 400,
      message: "ERR_FR_MAX_BODY_LENGTH_EXCEEDED",
    });
    expect(received).toHaveLength(0);
  });
});

describe("encodeMailgunMessage", () => {
  const encode = async (message: Parameters<typeof encodeMailgunMessage>[0]) => {
    const { body, length, contentType } = encodeMailgunMessage(message);
    const raw = new Uint8Array(await new Response(body).arrayBuffer());
    expect(raw.byteLength).toBe(length);
    const form = await new Response(raw, { headers: { "Content-Type": contentType } }).formData();
    return { text: new TextDecoder().decode(raw), form };
  };

  it("should leave empty fields out and keep the rest in order", async () => {
    const { form } = await encode({
      from: "admin@example.com",
      to: ["a@external.com", "b@external.com"],
      cc: undefined,
      subject: "",
      html: "<p>x</p>",
      text: "",
      attachment: [],
      "h:In-Reply-To": "<id@example.com>",
    });
    expect([...form.keys()]).toEqual(["from", "to", "to", "html", "h:In-Reply-To"]);
  });

  it("should send field values byte for byte, line breaks included", async () => {
    const html = "<p>Grüße 你好</p>\n<p>two</p>\rthree";
    const { text } = await encode({ from: "a@example.com", to: ["b@external.com"], html, attachment: [] });
    expect(text).toContain(`name="html"\r\n\r\n${html}\r\n--`);
  });

  it("should stream attachment bytes unchanged under a UTF-8 filename", async () => {
    const bytes = Uint8Array.from({ length: 256 }, (_, i) => i);
    const filePath = writeFile("binary.bin", bytes);
    const { text, form } = await encode({
      from: "a@example.com",
      to: ["b@external.com"],
      attachment: [{ path: filePath, filename: "résumé 履歴書.pdf", contentType: "application/pdf" }],
    });
    expect(text).toContain(
      'Content-Disposition: form-data; name="attachment"; filename="résumé 履歴書.pdf"\r\n' +
        "Content-Type: application/pdf\r\n\r\n"
    );
    const file = form.get("attachment") as File;
    expect(new Uint8Array(await file.arrayBuffer())).toEqual(bytes);
  });

  it("should escape a quote or line break in an attachment filename", async () => {
    const filePath = writeFile("plain.txt", "x");
    const { text } = await encode({
      from: "a@example.com",
      to: ["b@external.com"],
      attachment: [{ path: filePath, filename: 'a"b\r\nc.txt', contentType: "text/plain" }],
    });
    expect(text).toContain('filename="a%22b%0D%0Ac.txt"');
  });
});
