/**
 * Drives the upload middleware over a real socket: the only place the disk
 * footprint of a request is observable is the filesystem after the response.
 */
import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import express from "express";
import fs from "fs";
import type { Server } from "http";

import { MAX_ATTACHMENTS_PER_MAIL, toUploadList, uploadHandlers } from "./upload";

const TEMP_DIR = "/tmp";
// express-fileupload names every temp file `tmp-<counter>-<pid><timestamp>`,
// so this process's uploads are separable from everything else in /tmp.
const OWN_TEMP_FILE = new RegExp(`^tmp-\\d+-${process.pid}\\d+$`);

const countOwnTempFiles = () =>
  fs.readdirSync(TEMP_DIR).filter((name) => OWN_TEMP_FILE.test(name)).length;

/** The unlink is fired from a response listener, so it lands after the body. */
const settledTempFileCount = async () => {
  for (let attempt = 0; attempt < 50; attempt++) {
    const count = countOwnTempFiles();
    if (count === 0) return count;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  return countOwnTempFiles();
};

let server: Server;
let baseUrl: string;

beforeAll(async () => {
  const mailsRouter = express.Router();
  mailsRouter.use("/send", ...uploadHandlers);
  mailsRouter.post("/send", (req, res) => {
    const uploads = toUploadList(req.files?.attachments);
    res.json({
      received: uploads.length,
      bytes: uploads.map((file) => fs.readFileSync(file.tempFilePath).toString())
    });
  });

  const app = express();
  app.use("/api/mails", mailsRouter);

  server = await new Promise<Server>((resolve) => {
    const started = app.listen(0, () => resolve(started));
  });
  const { port } = server.address() as { port: number };
  baseUrl = `http://127.0.0.1:${port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
});

const BOUNDARY = "----uploadtest";

const multipart = (parts: { payload: string }[]) => {
  const chunks = parts.map(
    ({ payload }, index) =>
      `--${BOUNDARY}\r\n` +
      `Content-Disposition: form-data; name="attachments"; filename="p${index}.txt"\r\n` +
      `Content-Type: text/plain\r\n\r\n${payload}\r\n`
  );
  return Buffer.from(chunks.join("") + `--${BOUNDARY}--\r\n`);
};

const post = (path: string, body: Buffer) =>
  fetch(`${baseUrl}${path}`, {
    method: "POST",
    headers: { "Content-Type": `multipart/form-data; boundary=${BOUNDARY}` },
    body: new Uint8Array(body)
  });

const filler = (count: number) => Array.from({ length: count }, (_, i) => ({ payload: `p${i}` }));

describe("upload middleware", () => {
  it("hands readable temp files to the handler and reclaims them afterwards", async () => {
    const res = await post(
      "/api/mails/send",
      multipart([{ payload: "alpha" }, { payload: "beta" }])
    );
    const body = (await res.json()) as { received: number; bytes: string[] };

    expect(body).toEqual({ received: 2, bytes: ["alpha", "beta"] });
    expect(await settledTempFileCount()).toBe(0);
  });

  it("stops parsing one part past the mail cap so the route can reject the rest", async () => {
    const res = await post("/api/mails/send", multipart(filler(MAX_ATTACHMENTS_PER_MAIL + 30)));
    const body = (await res.json()) as { received: number };

    expect(body.received).toBe(MAX_ATTACHMENTS_PER_MAIL + 1);
    expect(await settledTempFileCount()).toBe(0);
  });

  it("answers an oversize part with the app's JSON envelope and reclaims its siblings", async () => {
    const oversize = "0".repeat(26 * 1024 * 1024);
    const res = await post(
      "/api/mails/send",
      multipart([{ payload: "sibling" }, { payload: oversize }])
    );
    const body = (await res.json()) as { status: string; message: string };

    expect(res.status).toBe(413);
    expect(body.status).toBe("failed");
    expect(body.message).toMatch(/25MB/);
    expect(await settledTempFileCount()).toBe(0);
  });
});
