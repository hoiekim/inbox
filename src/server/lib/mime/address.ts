import { domainToUnicode } from "url";
import { decodeWords } from "./header";

export interface ParsedAddressValue {
  address?: string;
  name: string;
  group?: ParsedAddressValue[];
}

export interface ParsedAddress {
  value: ParsedAddressValue[];
  text: string;
}

interface Token {
  type: "operator" | "text";
  value: string;
  noBreak?: boolean;
}

/** Each opening operator and the character that closes it ("" for a lone delimiter). */
const OPERATORS: Record<string, string> = {
  '"': '"',
  "(": ")",
  "<": ">",
  ",": "",
  ":": ";",
  // Outside a group a semicolon is not valid, but some clients type it as a
  // list separator, so it delimits like a comma.
  ";": ""
};

const AT = 0x40;

const isWordChar = (code: number): boolean =>
  (code >= 0x30 && code <= 0x39) ||
  (code >= 0x41 && code <= 0x5a) ||
  (code >= 0x61 && code <= 0x7a) ||
  code === 0x5f;

/** Whitespace as JavaScript's `\s` defines it. */
const isSpace = (code: number): boolean =>
  (code >= 0x09 && code <= 0x0d) ||
  code === 0x20 ||
  code === 0xa0 ||
  code === 0x1680 ||
  (code >= 0x2000 && code <= 0x200a) ||
  code === 0x2028 ||
  code === 0x2029 ||
  code === 0x202f ||
  code === 0x205f ||
  code === 0x3000 ||
  code === 0xfeff;

/**
 * The first `[start, end)` of `text` matching `\s*\b[^@\s]+@[^\s]+\b\s*` as a
 * regex: an address written inside a display name, with the whitespace around
 * it. Hand-written because the regex restarts at every character of a long
 * run with no `@`, which is quadratic in the length of the header.
 */
const findAddressInText = (text: string): [number, number] | undefined => {
  const code = (i: number) => text.charCodeAt(i);
  const boundary = (i: number) =>
    (i > 0 && isWordChar(code(i - 1))) !== (i < text.length && isWordChar(code(i)));
  let i = 0;
  while (i < text.length) {
    if (code(i) === AT || isSpace(code(i))) {
      i++;
      continue;
    }
    const runStart = i;
    let runEnd = i;
    while (runEnd < text.length && code(runEnd) !== AT && !isSpace(code(runEnd))) runEnd++;
    i = runEnd;
    if (code(runEnd) !== AT) continue;

    let local = runStart;
    while (local < runEnd && !boundary(local)) local++;
    if (local === runEnd) continue;

    let domainEnd = runEnd + 1;
    while (domainEnd < text.length && !isSpace(code(domainEnd))) domainEnd++;
    let end = domainEnd;
    while (end > runEnd + 1 && !boundary(end)) end--;
    if (end === runEnd + 1) continue;

    let start = local;
    if (local === runStart) while (start > 0 && isSpace(code(start - 1))) start--;
    if (end === domainEnd) while (end < text.length && isSpace(code(end))) end++;
    return [start, end];
  }
  return undefined;
};

const tokenize = (input: string): Token[] => {
  const list: Token[] = [];
  let expecting = "";
  let node: Token | null = null;
  let escaped = false;

  for (let i = 0; i < input.length; i++) {
    let chr = input.charAt(i);
    const next = i < input.length - 1 ? input.charAt(i + 1) : null;

    if (!escaped) {
      if (chr === expecting) {
        const closing: Token = { type: "operator", value: chr };
        if (next && ![" ", "\t", "\r", "\n", ",", ";"].includes(next)) closing.noBreak = true;
        list.push(closing);
        node = null;
        expecting = "";
        continue;
      }
      if (!expecting && chr in OPERATORS) {
        list.push({ type: "operator", value: chr });
        node = null;
        expecting = OPERATORS[chr];
        continue;
      }
      if ((expecting === '"' || expecting === "'") && chr === "\\") {
        escaped = true;
        continue;
      }
    }

    if (!node) {
      node = { type: "text", value: "" };
      list.push(node);
    }
    if (chr === "\n") chr = " ";
    if (chr.charCodeAt(0) >= 0x21 || chr === " " || chr === "\t") node.value += chr;
    escaped = false;
  }

  return list
    .map((token) => ({ ...token, value: token.value.trim() }))
    .filter((token) => token.value);
};

const MAX_GROUP_DEPTH = 50;

const handleAddress = (tokens: Token[], depth: number): ParsedAddressValue[] => {
  let isGroup = false;
  let state: "text" | "address" | "comment" | "group" = "text";
  const data = {
    address: [] as string[],
    comment: [] as string[],
    group: [] as string[],
    text: [] as string[]
  };
  const textWasQuoted: boolean[] = [];
  let insideQuotes = false;

  tokens.forEach((token, i) => {
    const previous = i ? tokens[i - 1] : null;
    if (token.type === "operator") {
      switch (token.value) {
        case "<":
          state = "address";
          insideQuotes = false;
          break;
        case "(":
          state = "comment";
          insideQuotes = false;
          break;
        case ":":
          state = "group";
          isGroup = true;
          insideQuotes = false;
          break;
        case '"':
          insideQuotes = !insideQuotes;
          state = "text";
          break;
        default:
          state = "text";
          insideQuotes = false;
      }
      return;
    }
    let value = token.value;
    // An unquoted name holding a stray "<": everything up to it is dropped.
    if (state === "address") value = value.replace(/^[^<]*<\s*/, "");
    const bucket = data[state];
    if (previous?.noBreak && bucket.length) {
      bucket[bucket.length - 1] += value;
      if (state === "text" && insideQuotes) textWasQuoted[textWasQuoted.length - 1] = true;
    } else {
      bucket.push(value);
      if (state === "text") textWasQuoted.push(insideQuotes);
    }
  });

  if (!data.text.length && data.comment.length) {
    data.text = data.comment;
    data.comment = [];
  }

  if (isGroup) {
    const members: ParsedAddressValue[] = [];
    if (data.group.length) {
      // Groups cannot nest; a nested one contributes its members directly.
      parseAddressValues(data.group.join(","), depth + 1).forEach((member) => {
        if (member.group) members.push(...member.group);
        else members.push(member);
      });
    }
    return [{ name: data.text.join(" "), group: members }];
  }

  if (!data.address.length && data.text.length) {
    // An address quoted as a display name is never promoted to the address:
    // `"user@evil"@example.com` must not route to `user@evil`.
    for (let i = data.text.length - 1; i >= 0; i--) {
      if (!textWasQuoted[i] && /^[^@\s]+@[^@\s]+$/.test(data.text[i])) {
        data.address = data.text.splice(i, 1);
        textWasQuoted.splice(i, 1);
        break;
      }
    }
    if (!data.address.length) {
      for (let i = data.text.length - 1; i >= 0; i--) {
        if (textWasQuoted[i]) continue;
        const text = data.text[i];
        const found = findAddressInText(text);
        if (!found) {
          data.text[i] = text.trim();
          continue;
        }
        data.address = [text.slice(found[0], found[1]).trim()];
        data.text[i] = (text.slice(0, found[0]) + " " + text.slice(found[1])).trim();
        break;
      }
    }
  }

  if (!data.text.length && data.comment.length) {
    data.text = data.comment;
    data.comment = [];
  }

  if (data.address.length > 1) data.text = data.text.concat(data.address.splice(1));

  const text = data.text.join(" ");
  const address = data.address.join(" ");
  const entry = { address: address || text || "", name: text || address || "" };
  if (entry.address === entry.name) {
    if (entry.address.includes("@")) entry.name = "";
    else entry.address = "";
  }
  return [entry];
};

const parseAddressValues = (input: string, depth = 0): ParsedAddressValue[] => {
  if (depth > MAX_GROUP_DEPTH) return [];
  const groups: Token[][] = [];
  let current: Token[] = [];
  for (const token of tokenize(input)) {
    if (token.type === "operator" && (token.value === "," || token.value === ";")) {
      if (current.length) groups.push(current);
      current = [];
    } else {
      current.push(token);
    }
  }
  if (current.length) groups.push(current);
  return groups.flatMap((tokens) => handleAddress(tokens, depth));
};

const ENCODED_WORDS_ONLY = /^(=\?([^?]+)\?[Bb]\?[^?]*\?=)(\s*=\?([^?]+)\?[Bb]\?[^?]*\?=)*$/;

const punycodeDomainToUnicode = (address: string): string => {
  const at = address.lastIndexOf("@");
  const domain = address.slice(at + 1);
  const unicode = domain
    .split(".")
    .map((label) => (label.startsWith("xn--") ? domainToUnicode(label) || label : label))
    .join(".");
  return address.slice(0, at + 1) + unicode;
};

const decodeAddresses = (addresses: ParsedAddressValue[]): void => {
  const expanded = new WeakSet<ParsedAddressValue>();
  for (let i = 0; i < addresses.length; i++) {
    const entry = addresses[i];
    entry.name = (entry.name || "").trim();

    // A display name made only of B-encoded words, with no address beside it,
    // is a whole address list someone encoded; it is decoded and re-parsed.
    if (!entry.address && ENCODED_WORDS_ONLY.test(entry.name) && !expanded.has(entry)) {
      const reparsed = parseAddressValues(decodeWords(entry.name));
      reparsed.forEach((parsed) => {
        expanded.add(parsed);
        addresses.push(parsed);
      });
      addresses.splice(i, 1);
      i--;
      continue;
    }

    if (entry.name) entry.name = decodeWords(entry.name);
    if (entry.address && /@xn--/.test(entry.address)) {
      entry.address = punycodeDomainToUnicode(entry.address);
    }
    if (entry.group) decodeAddresses(entry.group);
  }
};

const formatText = (addresses: ParsedAddressValue[]): string =>
  addresses
    .map((entry) => {
      let text = "";
      if (entry.name) text += `"${entry.name}"` + (entry.group ? ": " : "");
      if (entry.address) text += entry.name ? ` <${entry.address}>` : entry.address;
      if (entry.group) text += formatText(entry.group) + ";";
      return text;
    })
    .join(", ");

/**
 * Parses an unfolded address header value (`From`, `To`, `Cc`, ...) into its
 * entries, with display names decoded from RFC 2047 encoded words, IDN domains
 * shown in Unicode, and RFC 5322 groups kept as `group` members. `text` is the
 * list written back out as `"Name" <address>`.
 */
export const parseAddressHeader = (value: string): ParsedAddress => {
  const entries = parseAddressValues(value);
  decodeAddresses(entries);
  return { value: entries, text: formatText(entries) };
};
