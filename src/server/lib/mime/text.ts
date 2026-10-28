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

const isWordChar = (c: number): boolean =>
  (c >= 0x30 && c <= 0x39) || (c >= 0x41 && c <= 0x5a) || (c >= 0x61 && c <= 0x7a) || c === 0x5f;

const isLabelChar = (c: number): boolean =>
  (c >= 0x30 && c <= 0x39) || (c >= 0x41 && c <= 0x5a) || (c >= 0x61 && c <= 0x7a) || c === 0x2d;

/** A character of an e-mail address's local part: letters, digits and `._%+-`. */
const isLocalChar = (c: number): boolean =>
  isLabelChar(c) || c === 0x2e || c === 0x5f || c === 0x25 || c === 0x2b;

/** Ends a link: whitespace as JavaScript's `\s` defines it, `<`, `>` and `"`. */
const isLinkEnd = (c: number): boolean =>
  c === 0x3c ||
  c === 0x3e ||
  c === 0x22 ||
  (c >= 0x09 && c <= 0x0d) ||
  c === 0x20 ||
  c === 0xa0 ||
  c === 0x1680 ||
  (c >= 0x2000 && c <= 0x200a) ||
  c === 0x2028 ||
  c === 0x2029 ||
  c === 0x202f ||
  c === 0x205f ||
  c === 0x3000 ||
  c === 0xfeff;

const LINK_PREFIXES = ["http://", "https://", "git://", "mailto:", "www."];

/** End of a scheme or `www.` link starting at `start`, or -1 when none starts there. */
const linkEndAt = (text: string, start: number): number => {
  if (start > 0 && isWordChar(text.charCodeAt(start - 1))) return -1;
  const prefix = LINK_PREFIXES.find((candidate) => text.startsWith(candidate, start));
  if (!prefix) return -1;
  let end = start + prefix.length;
  while (end < text.length && !isLinkEnd(text.charCodeAt(end))) end++;
  return end > start + prefix.length ? end : -1;
};

/** End of a dotted domain (`label(.label)+`) starting at `start`, or -1. */
const domainEndAt = (text: string, start: number): number => {
  let end = start;
  while (end < text.length && isLabelChar(text.charCodeAt(end))) end++;
  if (end === start) return -1;
  let labels = 0;
  while (text.charCodeAt(end) === 0x2e && isLabelChar(text.charCodeAt(end + 1))) {
    end += 2;
    while (end < text.length && isLabelChar(text.charCodeAt(end))) end++;
    labels++;
  }
  return labels ? end : -1;
};

/**
 * Finds the links in `text` as `[start, end)` ranges, left to right: `http`,
 * `https` and `git` URLs, `mailto:` and `www.` links, and bare e-mail
 * addresses. One forward pass; each run of address characters is measured
 * once, so the cost stays linear in the length of the text.
 */
const findLinks = (text: string): [number, number][] => {
  const links: [number, number][] = [];
  let runEnd = -1;
  let addressEnd = -1;
  let i = 0;
  while (i < text.length) {
    const linkEnd = linkEndAt(text, i);
    if (linkEnd !== -1) {
      links.push([i, linkEnd]);
      i = linkEnd;
      continue;
    }
    if (isLocalChar(text.charCodeAt(i))) {
      if (i >= runEnd) {
        runEnd = i;
        while (runEnd < text.length && isLocalChar(text.charCodeAt(runEnd))) runEnd++;
        addressEnd = text.charCodeAt(runEnd) === 0x40 ? domainEndAt(text, runEnd + 1) : -1;
      }
      if (addressEnd !== -1) {
        links.push([i, addressEnd]);
        i = addressEnd;
        continue;
      }
    }
    i++;
  }
  return links;
};

const TRAILING_PUNCTUATION = new Set(".,;:!?'\")]}>");

const withoutTrailingPunctuation = (link: string): string => {
  let end = link.length;
  while (end > 0 && TRAILING_PUNCTUATION.has(link[end - 1])) end--;
  return link.slice(0, end);
};

const hrefFor = (link: string): string => {
  if (/^(?:https?|git):\/\/|^mailto:/i.test(link)) return link;
  if (/^www\./i.test(link)) return `http://${link}`;
  return `mailto:${link}`;
};

const LINE_TERMINATORS = new Set(["\n", "\r", " ", " "]);

/** Drops the spaces and tabs that end each line. */
const trimLineEnds = (text: string): string => {
  const kept: string[] = [];
  let from = 0;
  let blankStart = -1;
  for (let i = 0; i <= text.length; i++) {
    const char = text[i];
    if (char === " " || char === "\t") {
      if (blankStart === -1) blankStart = i;
      continue;
    }
    if (blankStart !== -1 && (i === text.length || LINE_TERMINATORS.has(char))) {
      kept.push(text.slice(from, blankStart));
      from = i;
    }
    blankStart = -1;
  }
  kept.push(text.slice(from));
  return kept.join("");
};

/**
 * Renders a plain-text body part as HTML: paragraphs on blank lines, `<br/>`
 * on single breaks, and URLs, `www.` hosts and e-mail addresses as links.
 */
export const textToHtml = (text: string): string => {
  const pieces: string[] = [];
  let last = 0;
  for (const [start, end] of findLinks(text)) {
    const link = withoutTrailingPunctuation(text.slice(start, end));
    if (!link) continue;
    pieces.push(encodeText(text.slice(last, start)));
    const href = hrefFor(link).replace(/"/g, "&quot;");
    pieces.push(`<a href="${href}">${encodeText(link)}</a>`);
    last = start + link.length;
  }
  pieces.push(encodeText(text.slice(last)));

  return (
    "<p>" +
    trimLineEnds(pieces.join("").replace(/\r?\n/g, "\n").trim())
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
