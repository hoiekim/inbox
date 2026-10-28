/**
 * Labels mail software writes that the WHATWG Encoding Standard does not list,
 * mapped onto the encoding they mean.
 */
const LABEL_ALIASES: Record<string, string> = {
  cp949: "euc-kr",
  uhc: "euc-kr",
  "windows-949": "euc-kr",
  "ks_c_5601-1989": "euc-kr",
  "x-windows-949": "euc-kr",
  "shift-jis": "shift_jis",
  "euc-cn": "gbk",
  "x-gbk": "gbk",
  "big5-hkscs": "big5"
};

const decoderCache = new Map<string, TextDecoder | null>();

const createDecoder = (label: string): TextDecoder | null => {
  try {
    return new TextDecoder(label);
  } catch {
    return null;
  }
};

/**
 * The decoder for a MIME charset label, or `null` when no encoding answers to
 * it. Spelling variants (`utf_8`, `win1252`, `latin-2`, `iso8859_15`) are
 * folded onto their canonical label before giving up.
 */
const decoderFor = (charset: string): TextDecoder | null => {
  const label = charset.trim().toLowerCase();
  const cached = decoderCache.get(label);
  if (cached !== undefined) return cached;

  const candidates = [
    LABEL_ALIASES[label] ?? label,
    label
      .replace(/^utf[-_]?(\d+)/, "utf-$1")
      .replace(/^win(?:dows)?[-_]?(\d+)/, "windows-$1")
      .replace(/^(?:latin|iso[-_]?8859)[-_]?(\d+)/, "iso-8859-$1")
      .replace(/^l[-_]?(\d+)$/, "iso-8859-$1")
  ];
  let decoder: TextDecoder | null = null;
  for (const candidate of candidates) {
    decoder = createDecoder(candidate);
    if (decoder) break;
  }
  decoderCache.set(label, decoder);
  return decoder;
};

const UTF8_LABEL = /^(?:utf-?8|7bit)$/i;

const UTF16_LABEL = /^utf[-_]?16$/i;
const UTF16BE = new TextDecoder("utf-16be");
const UTF16LE = new TextDecoder("utf-16le");

const UTF16_SNIFF_UNITS = 100;

/**
 * Unmarked `utf-16` takes its byte order from a BOM, else from which half of
 * each leading code unit is zero (ASCII-range text), else little-endian: mail
 * in the wild is overwhelmingly little-endian despite RFC 2781's default.
 */
const decodeUtf16 = (bytes: Uint8Array): string => {
  if (bytes[0] === 0xfe && bytes[1] === 0xff) return UTF16BE.decode(bytes);
  if (bytes[0] === 0xff && bytes[1] === 0xfe) return UTF16LE.decode(bytes);
  let bigEndianVotes = 0;
  let littleEndianVotes = 0;
  const end = Math.min(bytes.length - 1, UTF16_SNIFF_UNITS * 2);
  for (let i = 0; i < end; i += 2) {
    if (bytes[i] === 0 && bytes[i + 1] !== 0) bigEndianVotes++;
    else if (bytes[i] !== 0 && bytes[i + 1] === 0) littleEndianVotes++;
  }
  return (bigEndianVotes > littleEndianVotes ? UTF16BE : UTF16LE).decode(bytes);
};

/**
 * Decodes header bytes (an RFC 2047 encoded word) in `charset`. Unknown labels
 * fall back to UTF-8 rather than failing the whole header; `us-ascii` follows
 * the Encoding Standard and reads as windows-1252.
 */
export const decodeHeaderBytes = (bytes: Uint8Array, charset: string): string => {
  if (UTF8_LABEL.test(charset.trim())) return Buffer.from(bytes).toString("utf8");
  if (UTF16_LABEL.test(charset.trim())) return decodeUtf16(bytes);
  const decoder = decoderFor(charset);
  if (!decoder) return Buffer.from(bytes).toString("utf8");
  return decoder.decode(bytes);
};

/**
 * Decodes a text body part declared as `charset`.
 *
 * `us-ascii` is read as UTF-8 here, unlike in headers: a body labelled ASCII
 * that carries 8-bit octets is overwhelmingly UTF-8 from a client that did not
 * bother to relabel it, and reading it as windows-1252 would turn every such
 * character into mojibake.
 */
export const decodeBodyBytes = (bytes: Uint8Array, charset: string | undefined): string => {
  const label = (charset ?? "utf-8").toLowerCase().replace(/[^a-z0-9]+/g, "");
  if (label === "ascii" || label === "usascii" || label === "utf8") {
    return Buffer.from(bytes).toString("utf8");
  }
  if (label === "utf16") return decodeUtf16(bytes);
  const decoder = decoderFor(charset ?? "utf-8");
  if (!decoder) return Buffer.from(bytes).toString("utf8");
  return decoder.decode(bytes);
};
