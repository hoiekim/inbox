import { describe, it, expect, mock, beforeEach } from "bun:test";

process.env.EMAIL_DOMAIN = "mydomain";
process.env.MAILGUN_KEY = "test-key";

// Mock fs first (before mailgun.ts is imported)
const mockReadFileSync = mock(() => Buffer.from("file-content"));
mock.module("fs", () => ({
  default: { readFileSync: mockReadFileSync },
  readFileSync: mockReadFileSync,
}));

// Mock form-data
mock.module("form-data", () => ({
  default: class FormData {},
}));

// Track mailgun API calls
const mockMessagesCreate = mock(() =>
  Promise.resolve({ id: "msg-id-123", message: "Queued. Thank you." })
);

// Mock mailgun.js — the module exports a default class whose instances have .client()
mock.module("mailgun.js", () => {
  class MockMailgun {
    client(_opts: unknown) {
      return { messages: { create: mockMessagesCreate } };
    }
  }
  return { default: MockMailgun };
});

// Mock logger
mock.module("../logger", () => ({
  logger: {
    info: mock(() => {}),
    error: mock(() => {}),
    warn: mock(() => {}),
    debug: mock(() => {}),
  },
}));

// Mock server exports — only getUserDomain is mocked; getText uses real implementation
// to avoid contaminating util.test.ts via bun's shared module registry
mock.module("server", () => ({
  getUserDomain: (username: string) =>
    username === "admin" ? "example.com" : `${username}.example.com`,
}));

import { sendMailgunMail } from "./mailgun";
import { MailDataToSend } from "common";

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
  beforeEach(() => {
    mockMessagesCreate.mockReset();
    mockMessagesCreate.mockResolvedValue({ id: "msg-id-123", message: "Queued. Thank you." });
    mockReadFileSync.mockReset();
    mockReadFileSync.mockReturnValue(Buffer.from("file-content"));
    process.env.EMAIL_DOMAIN = "mydomain";
    process.env.MAILGUN_KEY = "test-key";
  });

  it("should send when recipients include external addresses", async () => {
    const mail = new MailDataToSend({ ...baseMail, to: "external@gmail.com" });
    await sendMailgunMail("admin", mail);
    expect(mockMessagesCreate).toHaveBeenCalled();
  });

  it("should pass the envelope to as an array of trimmed addresses", async () => {
    const mail = new MailDataToSend({ ...baseMail, to: "a@gmail.com, b@yahoo.com" });
    await sendMailgunMail("admin", mail);
    const msgData = mockMessagesCreate.mock.calls[0][1];
    const toList: string[] = Array.isArray(msgData.to) ? msgData.to : [msgData.to];
    expect(toList).toContain("a@gmail.com");
    expect(toList).toContain("b@yahoo.com");
  });

  // Mailgun renders a `To:` header from the `to:` parameter on its own.
  // Passing `h:To` as well appends a SECOND `To:` header to the RFC 5322
  // message, which Gmail rejects with `5.7.1 … multiple To headers`. Keep
  // the envelope-only shape.
  it("should not set the h:To custom header (would duplicate the To: header)", async () => {
    const mail = new MailDataToSend({ ...baseMail, to: "a@gmail.com, b@yahoo.com" });
    await sendMailgunMail("admin", mail);
    const msgData = mockMessagesCreate.mock.calls[0][1];
    expect(msgData["h:To"]).toBeUndefined();
  });

  it("should format from address with senderFullName when provided", async () => {
    // getUserDomain mock returns "example.com" for admin
    const mail = new MailDataToSend({ ...baseMail, senderFullName: "Admin User" });
    await sendMailgunMail("admin", mail);
    const msgData = mockMessagesCreate.mock.calls[0][1];
    expect(msgData.from).toContain("Admin User");
    expect(msgData.from).toContain("admin@");
  });

  it("should format from address without senderFullName when not provided", async () => {
    const mail = new MailDataToSend({ ...baseMail, senderFullName: "" });
    await sendMailgunMail("admin", mail);
    const msgData = mockMessagesCreate.mock.calls[0][1];
    expect(msgData.from).toContain("admin@");
    expect(msgData.from).not.toContain(" <"); // no name part
  });

  it("should include subject, html, and text in message", async () => {
    const mail = new MailDataToSend({ ...baseMail, subject: "My Test Subject", html: "<p>Hello World</p>" });
    await sendMailgunMail("admin", mail);
    const msgData = mockMessagesCreate.mock.calls[0][1];
    expect(msgData.subject).toBe("My Test Subject");
    expect(msgData.html).toBe("<p>Hello World</p>");
    expect(msgData.text).toBeDefined();
  });

  it("should include cc and bcc when provided", async () => {
    const mail = new MailDataToSend({ ...baseMail, cc: "cc@external.com", bcc: "bcc@external.com" });
    await sendMailgunMail("admin", mail);
    const msgData = mockMessagesCreate.mock.calls[0][1];
    expect(msgData.cc).toBe("cc@external.com");
    expect(msgData.bcc).toBe("bcc@external.com");
  });

  it("should address a Bcc-only send to the sender rather than an empty To", async () => {
    const mail = new MailDataToSend({
      ...baseMail,
      to: "",
      bcc: "hidden@external.com",
    });
    await sendMailgunMail("admin", mail);
    const msgData = mockMessagesCreate.mock.calls[0][1];
    expect(msgData.to).toEqual(["admin@example.com"]);
    expect(msgData.bcc).toBe("hidden@external.com");
  });

  it("should never promote a bcc address into the visible To", async () => {
    const mail = new MailDataToSend({
      ...baseMail,
      to: "",
      bcc: "hidden@external.com, other@external.com",
    });
    await sendMailgunMail("admin", mail);
    const toList = mockMessagesCreate.mock.calls[0][1].to as string[];
    expect(toList).not.toContain("hidden@external.com");
    expect(toList).not.toContain("other@external.com");
  });

  it("should skip Mailgun only when every recipient across to/cc/bcc is host-domain", async () => {
    const mail = new MailDataToSend({
      ...baseMail,
      to: "inside@mydomain",
      cc: "colleague@mydomain",
      bcc: "another@mydomain",
    });
    await sendMailgunMail("admin", mail);
    expect(mockMessagesCreate).not.toHaveBeenCalled();
  });

  it("should still send when the only external recipient sits in bcc", async () => {
    const mail = new MailDataToSend({
      ...baseMail,
      to: "inside@mydomain",
      bcc: "outside@gmail.com",
    });
    await sendMailgunMail("admin", mail);
    expect(mockMessagesCreate).toHaveBeenCalledTimes(1);
    const msgData = mockMessagesCreate.mock.calls[0][1];
    expect(msgData.bcc).toBe("outside@gmail.com");
    // The host-domain To recipient is filtered, so the sender stands in —
    // an empty `to` would be rejected by Mailgun.
    expect(msgData.to).toEqual(["admin@example.com"]);
  });

  it("should still send when the only external recipient sits in cc", async () => {
    const mail = new MailDataToSend({
      ...baseMail,
      to: "inside@mydomain",
      cc: "outside@gmail.com",
    });
    await sendMailgunMail("admin", mail);
    expect(mockMessagesCreate).toHaveBeenCalledTimes(1);
    expect(mockMessagesCreate.mock.calls[0][1].cc).toBe("outside@gmail.com");
  });

  it("should keep host-domain addresses out of the rendered To header", async () => {
    const mail = new MailDataToSend({
      ...baseMail,
      to: "inside@mydomain, outside@gmail.com",
    });
    await sendMailgunMail("admin", mail);
    expect(mockMessagesCreate.mock.calls[0][1].to).toEqual(["outside@gmail.com"]);
  });

  it("should include inReplyTo header when provided", async () => {
    const mail = new MailDataToSend({ ...baseMail, inReplyTo: "<original-msg@example.com>" });
    await sendMailgunMail("admin", mail);
    const msgData = mockMessagesCreate.mock.calls[0][1];
    expect(msgData["h:In-Reply-To"]).toBe("<original-msg@example.com>");
  });

  it("should return data from mailgun API on success", async () => {
    const expected = { id: "msg-id-999", message: "Queued. Thank you." };
    mockMessagesCreate.mockResolvedValue(expected);
    const result = await sendMailgunMail("admin", baseMail);
    expect(result).toEqual(expected);
  });

  it("should handle file attachment from tempFilePath", async () => {
    const mockFile = {
      name: "test.pdf",
      mimetype: "application/pdf",
      size: 1024,
      tempFilePath: "/tmp/uploaded-file.pdf",
      data: Buffer.alloc(0),
    };
    await sendMailgunMail("admin", baseMail, mockFile as import("express-fileupload").UploadedFile);
    expect(mockReadFileSync).toHaveBeenCalledWith("/tmp/uploaded-file.pdf");
    const msgData = mockMessagesCreate.mock.calls[0][1];
    expect(msgData.attachment).toHaveLength(1);
    expect(msgData.attachment[0].filename).toBe("test.pdf");
  });

  it("should handle file attachment from data buffer", async () => {
    const fileData = Buffer.from("file-content");
    const mockFile = {
      name: "image.jpg",
      mimetype: "image/jpeg",
      size: 512,
      tempFilePath: "",
      data: fileData,
    };
    await sendMailgunMail("admin", baseMail, mockFile as import("express-fileupload").UploadedFile);
    const msgData = mockMessagesCreate.mock.calls[0][1];
    expect(msgData.attachment).toHaveLength(1);
    expect(msgData.attachment[0].filename).toBe("image.jpg");
  });

  it("should handle array of file attachments", async () => {
    const mockFiles = [
      { name: "a.pdf", mimetype: "application/pdf", size: 100, tempFilePath: "", data: Buffer.from("a") },
      { name: "b.pdf", mimetype: "application/pdf", size: 200, tempFilePath: "", data: Buffer.from("b") },
    ];
    await sendMailgunMail("admin", baseMail, mockFiles as import("express-fileupload").UploadedFile[]);
    const msgData = mockMessagesCreate.mock.calls[0][1];
    expect(msgData.attachment).toHaveLength(2);
  });

  it("should propagate errors from mailgun API", async () => {
    mockMessagesCreate.mockRejectedValue(new Error("Mailgun API error"));
    const mail = new MailDataToSend({ ...baseMail });
    await expect(sendMailgunMail("admin", mail)).rejects.toThrow("Mailgun API error");
  });
});
