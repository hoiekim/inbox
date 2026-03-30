import fs from "fs";
import { htmlToText } from "html-to-text";
import { v4 as uuid } from "uuid";
import { logger } from "../logger";

export const TO_ADDRESS_FIELD = "mail.envelopeTo.address";
export const FROM_ADDRESS_FIELD = "mail.from.value.address";
export const nestedPath = (field: string) => {
  return field.slice(0, field.lastIndexOf("."));
};

export const ATTACHMENT_FOLDER = "./attachments";

export const getAttachmentId = (): string => {
  let id = uuid();
  let filePath = getAttachmentFilePath(id);
  while (fs.existsSync(filePath)) {
    logger.warn(`Duplicate uuid is found: ${filePath}`);
    logger.info("Proceeding to regenerate uuid");
    id = uuid();
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

export const getText = (html: string) => {
  const text = htmlToText(html, {
    selectors: [
      { selector: "img", format: "skip" },
      { selector: "a", options: { ignoreHref: true } }
    ]
  });

  const urlEliminated = text.replace(
    /(?:https?|ftp):\/\/[^\s/$.?#].[^\s]*\b/g,
    "[url]"
  );

  const spacesCompressed = urlEliminated
    .replace(/((?![\n])\s)+/g, " ")
    .replace(/(\n\s|\s\n|\n)+/g, "\n");

  return spacesCompressed;
};
