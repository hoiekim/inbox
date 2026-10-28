const EMPTY = Buffer.alloc(0);

/**
 * Incremental Content-Transfer-Encoding decoder. `write` returns whatever is
 * already decodable and keeps only the few bytes that are not, so a part of
 * any size passes through in constant memory. The returned buffer may be the
 * decoder's own scratch space: it is valid until the next call.
 */
export interface TransferDecoder {
  write(chunk: Buffer): Buffer;
  end(): Buffer;
}

const BASE64_VALUES = new Int8Array(256).fill(-1);
"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/"
  .split("")
  .forEach((char, value) => {
    BASE64_VALUES[char.charCodeAt(0)] = value;
  });

/**
 * Base64 (RFC 2045 §6.8). Characters outside the alphabet — line breaks,
 * stray whitespace — are skipped, and decoding stops being strict at `=`:
 * padding only ends the current quantum, so concatenated encodings decode
 * back to back.
 */
class Base64Decoder implements TransferDecoder {
  private quantum = 0;
  private filled = 0;
  private scratch = Buffer.alloc(0);

  write(chunk: Buffer): Buffer {
    const needed = Math.ceil((chunk.length * 3) / 4) + 3;
    if (this.scratch.length < needed) this.scratch = Buffer.allocUnsafe(needed);
    const out = this.scratch;
    let length = 0;
    for (let i = 0; i < chunk.length; i++) {
      const byte = chunk[i];
      if (byte === 0x3d) {
        length = this.flushPartial(out, length);
        continue;
      }
      const value = BASE64_VALUES[byte];
      if (value < 0) continue;
      this.quantum = (this.quantum << 6) | value;
      if (++this.filled === 4) {
        out[length++] = (this.quantum >> 16) & 0xff;
        out[length++] = (this.quantum >> 8) & 0xff;
        out[length++] = this.quantum & 0xff;
        this.quantum = 0;
        this.filled = 0;
      }
    }
    return out.subarray(0, length);
  }

  end(): Buffer {
    const out = Buffer.allocUnsafe(3);
    return out.subarray(0, this.flushPartial(out, 0));
  }

  /** Emits the whole octets of an incomplete quantum (2 or 3 characters). */
  private flushPartial(out: Buffer, length: number): number {
    if (this.filled === 2) {
      out[length++] = (this.quantum >> 4) & 0xff;
    } else if (this.filled === 3) {
      out[length++] = (this.quantum >> 10) & 0xff;
      out[length++] = (this.quantum >> 2) & 0xff;
    }
    this.quantum = 0;
    this.filled = 0;
    return length;
  }
}

const EQUALS = 0x3d;
const CR = 0x0d;
const LF = 0x0a;
const SPACE = 0x20;
const TAB = 0x09;

const hexValue = (byte: number): number => {
  if (byte >= 0x30 && byte <= 0x39) return byte - 0x30;
  if (byte >= 0x41 && byte <= 0x46) return byte - 0x37;
  if (byte >= 0x61 && byte <= 0x66) return byte - 0x57;
  return -1;
};

const decodeEscapes = (bytes: Buffer): Buffer => {
  if (!bytes.includes(EQUALS)) return bytes;
  const out = Buffer.allocUnsafe(bytes.length);
  let length = 0;
  for (let i = 0; i < bytes.length; i++) {
    const byte = bytes[i];
    if (byte === EQUALS && i + 2 < bytes.length) {
      const high = hexValue(bytes[i + 1]);
      const low = hexValue(bytes[i + 2]);
      if (high >= 0 && low >= 0) {
        out[length++] = (high << 4) | low;
        i += 2;
        continue;
      }
    }
    out[length++] = byte;
  }
  return out.subarray(0, length);
};

/** Longest unterminated line held back before its decodable prefix is released. */
const MAX_QP_CARRY = 64 * 1024;

/**
 * Quoted-printable (RFC 2045 §6.7): trailing whitespace before a line break is
 * dropped, `=` at the end of a line joins it to the next, and `=XX` is one
 * octet. Octets that arrive unencoded pass through as they are.
 */
class QuotedPrintableDecoder implements TransferDecoder {
  private carry: Buffer = EMPTY;

  write(chunk: Buffer): Buffer {
    const data = this.carry.length ? Buffer.concat([this.carry, chunk]) : chunk;
    const parts: Buffer[] = [];
    let start = 0;
    let lf = data.indexOf(LF, start);
    while (lf !== -1) {
      parts.push(this.decodeLine(data.subarray(start, lf), true));
      start = lf + 1;
      lf = data.indexOf(LF, start);
    }
    let rest = data.subarray(start);
    if (rest.length > MAX_QP_CARRY) {
      let cut = rest.length;
      const isTrailing = (byte: number) => byte === SPACE || byte === TAB || byte === CR;
      while (cut > 0 && isTrailing(rest[cut - 1])) cut--;
      if (rest[cut - 1] === EQUALS) cut -= 1;
      else if (rest[cut - 2] === EQUALS) cut -= 2;
      if (cut > 0) {
        parts.push(decodeEscapes(rest.subarray(0, cut)));
        rest = rest.subarray(cut);
      }
    }
    this.carry = Buffer.from(rest);
    return parts.length === 1 ? parts[0] : Buffer.concat(parts);
  }

  end(): Buffer {
    const rest = this.carry;
    this.carry = EMPTY;
    return rest.length ? this.decodeLine(rest, false) : EMPTY;
  }

  private decodeLine(line: Buffer, terminated: boolean): Buffer {
    let end = line.length;
    const hasCr = terminated && end > 0 && line[end - 1] === CR;
    if (hasCr) end--;
    while (end > 0 && (line[end - 1] === SPACE || line[end - 1] === TAB)) end--;
    const decoded = decodeEscapes(line.subarray(0, end));
    if (end > 0 && line[end - 1] === EQUALS) {
      return decoded.subarray(0, decoded.length - 1);
    }
    if (!terminated) return decoded;
    return Buffer.concat([decoded, hasCr ? CRLF : LF_ONLY]);
  }
}

const CRLF = Buffer.from("\r\n");
const LF_ONLY = Buffer.from("\n");

class IdentityDecoder implements TransferDecoder {
  write(chunk: Buffer): Buffer {
    return chunk;
  }

  end(): Buffer {
    return EMPTY;
  }
}

/** The decoder for a Content-Transfer-Encoding value; anything unrecognized passes through. */
export const createTransferDecoder = (encoding: string): TransferDecoder => {
  if (encoding === "base64") return new Base64Decoder();
  if (encoding === "quoted-printable") return new QuotedPrintableDecoder();
  return new IdentityDecoder();
};
