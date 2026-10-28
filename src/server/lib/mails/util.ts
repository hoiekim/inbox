import fs from "fs";
import { logger } from "../logger";
import { htmlToPlainText } from "./plain-text";

export const TO_ADDRESS_FIELD = "mail.envelopeTo.address";
export const FROM_ADDRESS_FIELD = "mail.from.value.address";
export const nestedPath = (field: string) => {
  return field.slice(0, field.lastIndexOf("."));
};

export const ATTACHMENT_FOLDER = "./attachments";

export const getAttachmentId = (): string => {
  let id = crypto.randomUUID();
  let filePath = getAttachmentFilePath(id);
  while (fs.existsSync(filePath)) {
    logger.warn(`Duplicate uuid is found: ${filePath}`);
    logger.info("Proceeding to regenerate uuid");
    id = crypto.randomUUID();
    filePath = getAttachmentFilePath(id);
  }
  return id;
};

export const getAttachmentFilePath = (id?: string) => {
  const definedId = id || getAttachmentId();
  return `${ATTACHMENT_FOLDER}/${definedId}`;
};

export const getAttachment = (id: string) => {
  const filePath = getAttachmentFilePath(id);
  if (fs.existsSync(filePath)) return fs.readFileSync(filePath);
  return undefined;
};

/** The stored attachment as a file read lazily when sent, or undefined when it is missing. */
export const getAttachmentFile = async (id: string) => {
  const file = Bun.file(getAttachmentFilePath(id));
  return (await file.exists()) ? file : undefined;
};

export const getText = (html: string) => {
  const text = htmlToPlainText(html);

  const urlEliminated = text.replace(
    /(?:https?|ftp):\/\/[^\s/$.?#].[^\s]*\b/g,
    "[url]"
  );

  const spacesCompressed = urlEliminated
    .replace(/((?![\n])\s)+/g, " ")
    .replace(/(\n\s|\s\n|\n)+/g, "\n");

  return spacesCompressed;
};
