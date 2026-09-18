import fs from "fs";
import type { RequestHandler } from "express";
import fileupload, { UploadedFile } from "express-fileupload";

import { logger } from "../logger";

const MAX_FILE_SIZE = 25 * 1024 * 1024;

export const MAX_ATTACHMENTS_PER_MAIL = 20;

// Busboy silently discards every part past `limits.files`, so parsing one more
// than the mail cap is what lets the route answer "too many attachments"
// instead of dropping the surplus without telling the sender.
const MAX_PARSED_FILES = MAX_ATTACHMENTS_PER_MAIL + 1;

/** A field holds one `UploadedFile` when a single part carried its name. */
export const toUploadList = (
  files: UploadedFile | UploadedFile[] | undefined
): UploadedFile[] => (files ? (Array.isArray(files) ? files : [files]) : []);

/**
 * Deletes each part's temp file once the response is over.
 *
 * `express-fileupload` reclaims a temp file only on its own error, timeout and
 * limit paths — a parsed upload belongs to the app from then on, and the app is
 * the only thing that knows the response is done.
 */
const reclaimTempFiles: RequestHandler = (req, res, next) => {
  res.once("close", () => {
    for (const { tempFilePath } of Object.values(req.files ?? {}).flatMap(toUploadList)) {
      if (!tempFilePath) continue;
      fs.unlink(tempFilePath, (error) => {
        if (error && error.code !== "ENOENT") {
          logger.warn("Failed to reclaim an upload temp file", { tempFilePath, error });
        }
      });
    }
  });
  next();
};

const parseUploads = fileupload({
  limits: { fileSize: MAX_FILE_SIZE, files: MAX_PARSED_FILES },
  abortOnLimit: true,
  useTempFiles: true,
  tempFileDir: "/tmp/",
  limitHandler: (_req, res) => {
    res.status(413).json({
      status: "failed",
      message: `Each attachment must be smaller than ${MAX_FILE_SIZE / 1024 / 1024}MB`
    });
  }
});

/**
 * Multipart handling for the one route that accepts uploads. Mount it inside a
 * router that already authenticates, so unauthenticated bytes never reach disk.
 *
 * ```ts
 * router.use("/send", ...uploadHandlers);
 * ```
 *
 * The reclaim hook is registered ahead of the parser so it also covers the
 * responses the parser sends itself.
 */
export const uploadHandlers: RequestHandler[] = [reclaimTempFiles, parseUploads];
