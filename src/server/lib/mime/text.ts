import type { ParsedAddress, ParsedAddressValue } from "./address";

const hexReference = (char: string): string =>
  `&#x${char.codePointAt(0)!.toString(16).toUpperCase()};`;

/**
 * Escapes text for HTML: markup-significant characters and every non-ASCII
 * character become hexadecimal character references.
 */
export const encodeEntities = (text: string): string =>
  text.replace(/[&<>"'`]|[^\x00-\x7f]/gu, hexReference);

const NAMED: Record<string, string> = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" };

/** Like {@link encodeEntities}, but with the four named references HTML authors expect. */
const encodeText = (text: string): string =>
  text.replace(/[&<>"'`]|[^\x00-\x7f]/gu, (char) => NAMED[char] ?? hexReference(char));

const LINK = new RegExp(
  [
    "\\b(?:https?|git):\\/\\/[^\\s<>\"]+",
    "\\bmailto:[^\\s<>\"]+",
    "\\bwww\\.[^\\s<>\"]+",
    "[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\\.[A-Za-z0-9-]+)+"
  ].join("|"),
  "g"
);

const TRAILING_PUNCTUATION = /[.,;:!?'")\]}>]+$/;

const hrefFor = (link: string): string => {
  if (/^(?:https?|git):\/\/|^mailto:/i.test(link)) return link;
  if (/^www\./i.test(link)) return `http://${link}`;
  return `mailto:${link}`;
};

/**
 * Renders a plain-text body part as HTML: paragraphs on blank lines, `<br/>`
 * on single breaks, and URLs, `www.` hosts and e-mail addresses as links.
 */
export const textToHtml = (text: string): string => {
  const pieces: string[] = [];
  let last = 0;
  for (const match of text.matchAll(LINK)) {
    let link = match[0];
    const trailing = link.match(TRAILING_PUNCTUATION);
    if (trailing) link = link.slice(0, link.length - trailing[0].length);
    if (!link) continue;
    const index = match.index!;
    if (index < last) continue;
    pieces.push(encodeText(text.slice(last, index)));
    const href = hrefFor(link).replace(/"/g, "&quot;");
    pieces.push(`<a href="${href}">${encodeText(link)}</a>`);
    last = index + link.length;
  }
  pieces.push(encodeText(text.slice(last)));

  return (
    "<p>" +
    pieces
      .join("")
      .replace(/\r?\n/g, "\n")
      .trim()
      .replace(/[ \t]+$/gm, "")
      .trim()
      .replace(/\n\n+/g, "</p><p>")
      .trim()
      .replace(/\n/g, "<br/>") +
    "</p>"
  );
};

/** Formats an address list as the HTML spans an embedded message's header block shows. */
export const addressesToHtml = (addresses: ParsedAddressValue[]): string =>
  addresses
    .map((entry) => {
      let html = '<span class="mp_address_group">';
      if (entry.name) {
        html +=
          '<span class="mp_address_name">' +
          encodeEntities(entry.name) +
          (entry.group ? ": " : "") +
          "</span>";
      }
      if (entry.address) {
        const address = encodeEntities(entry.address);
        const link = `<a href="mailto:${address}" class="mp_address_email">${address}</a>`;
        html += entry.name ? ` &lt;${link}&gt;` : link;
      }
      if (entry.group) html += addressesToHtml(entry.group) + ";";
      return html + "</span>";
    })
    .join(", ");

/** The headers an embedded message (`message/rfc822` shown inline) contributes to the body. */
export interface EmbeddedHeaders {
  from?: ParsedAddress;
  subject?: string;
  date?: Date;
  to?: ParsedAddress | ParsedAddress[];
  cc?: ParsedAddress | ParsedAddress[];
  bcc?: ParsedAddress | ParsedAddress[];
}

const META_KEYS = ["From", "Subject", "Date", "To", "Cc", "Bcc"] as const;

const metaEntries = (headers: EmbeddedHeaders) =>
  META_KEYS.flatMap((key) => {
    const raw = headers[key.toLowerCase() as keyof EmbeddedHeaders];
    const value = Array.isArray(raw) ? raw[raw.length - 1] : raw;
    return value ? [{ key, value }] : [];
  });

export const embeddedHeadersAsText = (headers: EmbeddedHeaders): string =>
  "\n" +
  metaEntries(headers)
    .map(({ key, value }) => {
      if (value instanceof Date) return `${key}: ${value.toUTCString()}`;
      if (typeof value === "string") return `${key}: ${value}`;
      return `${key}: ${value.text}`;
    })
    .join("\n") +
  "\n";

export const embeddedHeadersAsHtml = (headers: EmbeddedHeaders): string =>
  '<table class="mp_head">' +
  metaEntries(headers)
    .map(({ key, value }) => {
      let html: string;
      if (value instanceof Date) html = value.toUTCString();
      else if (typeof value === "string") {
        html = encodeEntities(value);
        if (key === "Subject") html = `<strong>${html}</strong>`;
      } else html = addressesToHtml(value.value);
      return (
        `<tr><td class="mp_head_key">${encodeEntities(key)}:</td>` +
        `<td class="mp_head_value">${html}<td></tr>`
      );
    })
    .join("\n") +
  "<table>";
