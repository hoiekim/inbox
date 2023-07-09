import fs from "fs";
import { htmlToText } from "html-to-text";
import { v4 as uuid } from "uuid";

export const TO_ADDRESS_FIELD = "envelopeTo.address";
export const FROM_ADDRESS_FIELD = "from.value.address";

export const getDomain = () => process.env.EMAIL_DOMAIN || "mydomain";

export const getUserDomain = (username: string) => {
  const domain = getDomain();
  if (username === "admin") return domain;
  return `${username}.${domain}`;
};

export const ATTACHMENT_FOLDER = "./attachments";

export const getAttachmentId = (): string => {
  let id = uuid();
  let filePath = getAttachmentFilePath(id);
  while (fs.existsSync(filePath)) {
    console.warn(`Duplicate uuid is found: ${filePath}`);
    console.log("Proceeding to regenerate uuid");
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
  return fs.readFileSync(`./attachments/${id}`);
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
