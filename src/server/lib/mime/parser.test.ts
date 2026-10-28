import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { createHash } from "crypto";
import fs from "fs";
import os from "os";
import path from "path";
import { PassThrough, Readable } from "stream";
import {
  INLINE_IMAGE_BUDGET_BYTES,
  MAX_PARTS,
  parseMessage,
  TEXT_BODY_BUDGET_BYTES
} from "./parser";

let attachmentDir: string;

beforeEach(() => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "mime-parser-"));
  attachmentDir = path.join(root, "attachments");
});

afterEach(() => {
  fs.rmSync(path.dirname(attachmentDir), { recursive: true, force: true });
});

/** A message from its lines, CRLF-terminated as SMTP delivers them. */
const message = (...lines: string[]) => lines.map((line) => line + "\r\n").join("");

/** Feeds `raw` to the parser in `size`-byte chunks. */
const parse = (raw: string | Buffer, size = 64 * 1024) => {
  const bytes = typeof raw === "string" ? Buffer.from(raw, "utf8") : raw;
  async function* chunks() {
    for (let i = 0; i < bytes.length; i += size) yield bytes.subarray(i, i + size);
  }
  return parseMessage(chunks(), { attachmentDir });
};

const sha256 = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");

const pseudoRandom = (length: number) =>
  Buffer.from(Array.from({ length }, (_, i) => (i * 131 + 7) % 251));

const base64Lines = (bytes: Buffer) => bytes.toString("base64").replace(/.{76}/g, "$&\r\n");

describe("parseMessage headers", () => {
  it("reads a single-part message and keeps its final line break", async () => {
    const parsed = await parse(
      message(
        "From: Sender <sender@example.org>",
        "To: rcpt@example.com",
        "Subject: Hello",
        "Message-ID: <id-1@example.org>",
        "Date: Tue, 27 Oct 2026 10:00:00 +0900",
        "",
        "line one",
        "line two"
      )
    );
    expect(parsed.messageId).toBe("<id-1@example.org>");
    expect(parsed.subject).toBe("Hello");
    expect(parsed.date?.toISOString()).toBe("2026-10-27T01:00:00.000Z");
    expect(parsed.from).toEqual({
      value: [{ address: "sender@example.org", name: "Sender" }],
      text: '"Sender" <sender@example.org>'
    });
    expect(parsed.text).toBe("line one\nline two\n");
    expect(parsed.html).toBeUndefined();
    expect(parsed.attachments).toEqual([]);
  });

  it("decodes encoded-word subjects in any charset", async () => {
    const parsed = await parse(
      message("Subject: =?EUC-KR?B?x9Gx2w==?= =?ISO-2022-JP?B?GyRCRnxLXDhsGyhC?=", "", "body")
    );
    expect(parsed.subject).toBe("한글日本語");
  });

  it("keeps the last of a repeated single header and lists repeated recipients", async () => {
    const parsed = await parse(
      message(
        "From: one@x.org",
        "From: two@x.org",
        "To: a@x.org",
        "To: b@x.org",
        "Subject: first",
        "Subject: last",
        "",
        "x"
      )
    );
    expect(parsed.from?.value[0].address).toBe("two@x.org");
    expect(parsed.subject).toBe("last");
    expect(Array.isArray(parsed.to)).toBe(true);
    expect((parsed.to as { text: string }[]).map((to) => to.text)).toEqual(["a@x.org", "b@x.org"]);
  });

  it("brackets a bare message id and replaces an unreadable date with now", async () => {
    const before = Date.now();
    const parsed = await parse(message("Message-ID: bare@example.org", "Date: not a date", "", "x"));
    expect(parsed.messageId).toBe("<bare@example.org>");
    expect(parsed.date!.getTime()).toBeGreaterThanOrEqual(before);
  });

  it("reads raw UTF-8 header octets as UTF-8", async () => {
    expect((await parse(message("Subject: 8비트 제목", "", "body"))).subject).toBe("8비트 제목");
  });
});

describe("parseMessage bodies", () => {
  it("takes the HTML of an alternative and the text of its plain part", async () => {
    const parsed = await parse(
      message(
        'Content-Type: multipart/alternative; boundary="b"',
        "",
        "--b",
        "Content-Type: text/plain",
        "",
        "Plain",
        "--b",
        "Content-Type: text/html",
        "",
        "<p>HTML</p>",
        "--b--"
      )
    );
    expect(parsed.text).toBe("Plain");
    expect(parsed.html).toBe("<p>HTML</p>");
  });

  it("renders plain text for an HTML-only message", async () => {
    const html = "<h1>Title</h1><p>Para <a href='https://x.org'>link</a></p>";
    const parsed = await parse(message("Content-Type: text/html", "", html));
    expect(parsed.html).toBe(html + "\n");
    expect(parsed.text).toBe("TITLE\n\nPara link");
  });

  it("adds a plain part outside the alternative to the HTML, with links", async () => {
    const parsed = await parse(
      message(
        'Content-Type: multipart/mixed; boundary="m"',
        "",
        "--m",
        'Content-Type: multipart/alternative; boundary="a"',
        "",
        "--a",
        "Content-Type: text/plain",
        "",
        "Main",
        "--a",
        "Content-Type: text/html",
        "",
        "<p>Main</p>",
        "--a--",
        "--m",
        "Content-Type: text/plain",
        "",
        "Info: https://lists.example.org/info & more",
        "--m--"
      )
    );
    expect(parsed.text).toBe("Main\nInfo: https://lists.example.org/info & more");
    expect(parsed.html).toBe(
      "<p>Main</p><br/>\n<p>Info: " +
        '<a href="https://lists.example.org/info">https://lists.example.org/info</a>' +
        " &amp; more</p>"
    );
  });

  it("renders a long plain line beside an HTML part in linear time", async () => {
    const started = performance.now();
    const parsed = await parse(
      message(
        'Content-Type: multipart/mixed; boundary="m"',
        "",
        "--m",
        "Content-Type: text/html",
        "",
        "<p>hi</p>",
        "--m",
        "Content-Type: text/plain",
        "",
        "a".repeat(TEXT_BODY_BUDGET_BYTES - 1024),
        "--m--"
      )
    );
    expect(performance.now() - started).toBeLessThan(2000);
    expect(parsed.html?.length).toBeGreaterThan(TEXT_BODY_BUDGET_BYTES - 1024);
  });

  it("decodes text parts in their declared charset", async () => {
    const shiftJis = Buffer.from([0x82, 0xb1, 0x82, 0xf1]).toString("base64");
    const parsed = await parse(
      message(
        "Content-Type: text/plain; charset=shift_jis",
        "Content-Transfer-Encoding: base64",
        "",
        shiftJis
      )
    );
    expect(parsed.text).toBe("こん");
  });

  it("reads a us-ascii-labelled body that carries 8-bit octets as UTF-8", async () => {
    const parsed = await parse(message("Content-Type: text/plain; charset=us-ascii", "", "café"));
    expect(parsed.text).toBe("café\n");
  });

  it("decodes quoted-printable soft breaks and escapes", async () => {
    const parsed = await parse(
      message(
        "Content-Type: text/plain; charset=utf-8",
        "Content-Transfer-Encoding: quoted-printable",
        "",
        "caf=C3=A9 =",
        "au lait  ",
        "=3D"
      )
    );
    expect(parsed.text).toBe("café au lait\n=\n");
  });

  it("undoes format=flowed with delsp", async () => {
    const parsed = await parse(
      message(
        "Content-Type: text/plain; format=flowed; delsp=yes",
        "",
        "This is a long ",
        "flowed line.",
        "",
        "> quoted"
      )
    );
    expect(parsed.text).toBe("This is a longflowed line.\n\n> quoted");
  });

  it("treats LF-only line endings like CRLF", async () => {
    const lf = await parse(
      'Content-Type: multipart/alternative; boundary="b"\n\n' +
        "--b\nContent-Type: text/plain\n\nA\nB\n--b--\n"
    );
    expect(lf.text).toBe("A\nB");
  });

  it("reads nothing from a multipart with no boundary", async () => {
    const parsed = await parse(message("Content-Type: multipart/mixed", "", "some text"));
    expect(parsed.text).toBeUndefined();
    expect(parsed.html).toBeUndefined();
  });

  it("shows the headers of an inline embedded message", async () => {
    const parsed = await parse(
      message(
        'Content-Type: multipart/mixed; boundary="m"',
        "",
        "--m",
        "Content-Type: text/plain",
        "",
        "See below.",
        "--m",
        "Content-Type: message/rfc822",
        "Content-Disposition: inline",
        "",
        "From: Inner <inner@x.org>",
        "Subject: Inner subject",
        "Date: Mon, 26 Oct 2026 09:00:00 +0000",
        "",
        "Inner body",
        "--m--"
      )
    );
    expect(parsed.text).toBe(
      'See below.\n\nFrom: "Inner" <inner@x.org>\nSubject: Inner subject\n' +
        "Date: Mon, 26 Oct 2026 09:00:00 GMT\n\nInner body"
    );
    expect(parsed.attachments).toEqual([]);
  });

  it("decodes a delivery-status part as text", async () => {
    const parsed = await parse(
      message(
        'Content-Type: multipart/report; boundary="r"',
        "",
        "--r",
        "Content-Type: text/plain",
        "",
        "Failed.",
        "--r",
        "Content-Type: message/delivery-status",
        "",
        "Action: failed",
        "--r--"
      )
    );
    expect(parsed.text).toBe("Failed.\nAction: failed");
  });
});

describe("parseMessage attachments", () => {
  const mixed = (...parts: string[][]) =>
    message(
      'Content-Type: multipart/mixed; boundary="m"',
      "",
      ...parts.flatMap((part) => ["--m", ...part]),
      "--m--"
    );

  it("writes a decoded attachment to a file with its name, type and size", async () => {
    const content = pseudoRandom(100_000);
    const parsed = await parse(
      mixed(
        ["Content-Type: text/plain", "", "See attached."],
        [
          'Content-Type: application/pdf; name="report.pdf"',
          'Content-Disposition: attachment; filename="report.pdf"',
          "Content-Transfer-Encoding: base64",
          "",
          base64Lines(content)
        ]
      )
    );
    expect(parsed.text).toBe("See attached.");
    expect(parsed.attachments).toHaveLength(1);
    const [attachment] = parsed.attachments;
    expect(attachment.filename).toBe("report.pdf");
    expect(attachment.contentType).toBe("application/pdf");
    expect(attachment.size).toBe(content.length);
    expect(attachment.path.startsWith(attachmentDir)).toBe(true);
    expect(sha256(fs.readFileSync(attachment.path))).toBe(sha256(content));
  });

  it("writes the same bytes whatever the chunk size", async () => {
    const content = pseudoRandom(5000);
    const raw = mixed(
      ["Content-Type: text/plain", "", "hi"],
      ["Content-Type: application/octet-stream", "Content-Transfer-Encoding: base64", "",
        base64Lines(content)]
    );
    for (const size of [1, 2, 3, 7, 64]) {
      const parsed = await parse(raw, size);
      expect(parsed.text).toBe("hi");
      expect(sha256(fs.readFileSync(parsed.attachments[0].path))).toBe(sha256(content));
    }
  });

  it("decodes RFC 2231 and encoded-word filenames", async () => {
    const parsed = await parse(
      mixed(
        [
          "Content-Type: application/pdf",
          "Content-Disposition: attachment;",
          " filename*0*=UTF-8''%EB%B3%B4%EA%B3%A0;",
          ' filename*1=".pdf"',
          "",
          "x"
        ],
        [
          'Content-Type: application/octet-stream; name="=?UTF-8?B?7ZWc6riALmRvY3g=?="',
          "Content-Disposition: attachment",
          "",
          "y"
        ]
      )
    );
    expect(parsed.attachments.map((attachment) => attachment.filename)).toEqual([
      "보고.pdf",
      "한글.docx"
    ]);
  });

  it("names an octet-stream part's type after its filename extension", async () => {
    const parsed = await parse(
      mixed(
        ["Content-Type: text/plain", "", "x"],
        [
          "Content-Type: application/octet-stream",
          'Content-Disposition: attachment; filename="photo.jpg"',
          "",
          "jpeg"
        ],
        ["Content-Type: application/x-custom", "Content-Disposition: attachment", "", "raw"]
      )
    );
    const types = parsed.attachments.map((attachment) => [attachment.filename, attachment.contentType]);
    expect(types).toEqual([
      ["photo.jpg", "image/jpeg"],
      [undefined, "application/x-custom"]
    ]);
  });

  it("keeps a forwarded message/rfc822 part as an attachment", async () => {
    const parsed = await parse(
      mixed(
        ["Content-Type: text/plain", "", "Fwd"],
        ["Content-Type: message/rfc822", "", "Subject: inner", "", "inner body"]
      )
    );
    expect(parsed.text).toBe("Fwd");
    expect(parsed.attachments).toHaveLength(1);
    expect(parsed.attachments[0].contentType).toBe("message/rfc822");
    const content = fs.readFileSync(parsed.attachments[0].path, "utf8");
    expect(content).toBe("Subject: inner\r\n\r\ninner body");
  });

  it("inlines a cid image into the HTML and keeps it as an attachment", async () => {
    const png = Buffer.from("89504e470d0a1a0a", "hex").toString("base64");
    const parsed = await parse(
      message(
        'Content-Type: multipart/related; boundary="r"',
        "",
        "--r",
        "Content-Type: text/html",
        "",
        '<img src="cid:logo@x">',
        "--r",
        "Content-Type: image/png",
        "Content-ID: <logo@x>",
        "Content-Transfer-Encoding: base64",
        "",
        png,
        "--r--"
      )
    );
    expect(parsed.html).toBe(`<img src="data:image/png;base64,${png}">`);
    expect(parsed.attachments[0].cid).toBe("logo@x");
  });

  it("leaves a cid reference in place past the inline image budget", async () => {
    const image = pseudoRandom(INLINE_IMAGE_BUDGET_BYTES + 3);
    const parsed = await parse(
      message(
        'Content-Type: multipart/related; boundary="r"',
        "",
        "--r",
        "Content-Type: text/html",
        "",
        '<img src="cid:big@x">',
        "--r",
        "Content-Type: image/png",
        "Content-ID: <big@x>",
        "Content-Transfer-Encoding: base64",
        "",
        base64Lines(image),
        "--r--"
      )
    );
    expect(parsed.html).toBe('<img src="cid:big@x">');
    expect(parsed.attachments[0].size).toBe(image.length);
  });

  it("stores a text body past the in-memory budget as an attachment instead", async () => {
    const html = "<p>" + "x".repeat(TEXT_BODY_BUDGET_BYTES) + "</p>";
    const parsed = await parse(`Content-Type: text/html\r\n\r\n${html}`);
    expect(parsed.html).toBeUndefined();
    expect(parsed.attachments).toHaveLength(1);
    expect(parsed.attachments[0].filename).toBe("body.html");
    expect(parsed.attachments[0].contentType).toBe("text/html");
    expect(fs.readFileSync(parsed.attachments[0].path, "utf8")).toBe(html);
  });
});

describe("parseMessage on adversarial input", () => {
  it("stays linear on near-limit headers and bodies built to trip backtracking", async () => {
    const inputs = [
      "Subject: a" + "\r".repeat(900_000) + "b\r\n\r\nbody",
      "Content-Transfer-Encoding: " + "(".repeat(900_000) + "\r\n\r\nbody",
      "To: @@" + "a!".repeat(450_000) + "\r\n\r\nbody",
      "Subject: a" + "\r\n b".repeat(225_000) + "\r\n\r\nbody",
      "Content-Type: text/plain; format=flowed; delsp=yes\r\n\r\n" + "ab \r\n".repeat(400_000)
    ];
    for (const raw of inputs) {
      const started = performance.now();
      await parse(raw);
      // Linear work here takes tens of milliseconds; quadratic takes minutes.
      expect(performance.now() - started).toBeLessThan(2000);
    }
  });
});

describe("parseMessage failures", () => {
  it("rejects a message with too many parts", async () => {
    const parts = Array.from({ length: MAX_PARTS + 1 }, () => ["Content-Type: text/plain", "", "x"]);
    const raw = message(
      'Content-Type: multipart/mixed; boundary="m"',
      "",
      ...parts.flatMap((part) => ["--m", ...part]),
      "--m--"
    );
    await expect(parse(raw)).rejects.toThrow("Max allowed child nodes exceeded");
  });

  it("rejects a part whose header block is too large", async () => {
    const raw = message("X-Filler: " + "a".repeat(1024 * 1024 + 10), "", "body");
    await expect(parse(raw)).rejects.toThrow("Max header size");
  });

  it("rejects when the source fails, with the attachment file closed", async () => {
    const source = new PassThrough();
    const parsing = parseMessage(source as Readable, { attachmentDir });
    source.write(
      message(
        'Content-Type: multipart/mixed; boundary="m"',
        "",
        "--m",
        "Content-Type: application/zip",
        "Content-Transfer-Encoding: base64",
        ""
      )
    );
    source.write(base64Lines(pseudoRandom(400_000)));
    await new Promise((resolve) => setTimeout(resolve, 20));
    source.destroy(new Error("connection reset"));
    await expect(parsing).rejects.toThrow("connection reset");
    expect(fs.readdirSync(attachmentDir)).toHaveLength(1);
    fs.rmSync(attachmentDir, { recursive: true, force: true });
    expect(fs.existsSync(attachmentDir)).toBe(false);
  });
});
