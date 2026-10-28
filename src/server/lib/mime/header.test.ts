import { describe, expect, it } from "bun:test";
import {
  decodeWords,
  ensureMessageIdFormat,
  parseHeaderValue,
  rawOctetsAsUtf8,
  splitHeaderLine
} from "./header";

describe("decodeWords", () => {
  it("decodes B and Q encoded words", () => {
    expect(decodeWords("=?UTF-8?B?7JWI64WV?=")).toBe("안녕");
    expect(decodeWords("=?utf-8?q?caf=C3=A9_au_lait?=")).toBe("café au lait");
  });

  it("decodes words in legacy CJK and Cyrillic charsets", () => {
    expect(decodeWords("=?EUC-KR?B?x9Gx2w==?=")).toBe("한글");
    expect(decodeWords("=?ISO-2022-JP?B?GyRCRnxLXDhsGyhC?=")).toBe("日本語");
    expect(decodeWords("=?Shift_JIS?B?k/qWe4zq?=")).toBe("日本語");
    expect(decodeWords("=?GB18030?B?1tDOxA==?=")).toBe("中文");
    expect(decodeWords("=?windows-1251?B?7/Do4uXy?=")).toBe("привет");
    expect(decodeWords("=?iso-8859-1?Q?R=E9sum=E9?=")).toBe("Résumé");
  });

  it("joins adjacent words of one charset before decoding a split character", () => {
    // "한" is ED 95 9C; the first word carries two of its three octets.
    expect(decodeWords("=?UTF-8?Q?=ED=95?= =?UTF-8?Q?=9C?=")).toBe("한");
    expect(decodeWords("=?UTF-8?B?7ZU=?= =?UTF-8?B?nA==?=")).toBe("한");
  });

  it("drops whitespace between encoded words but keeps it around plain text", () => {
    expect(decodeWords("=?UTF-8?Q?a?=  =?UTF-8?Q?b?= c")).toBe("ab c");
  });

  it("falls back to UTF-8 for an unknown charset and leaves malformed words alone", () => {
    expect(decodeWords("=?x-unknown?Q?abc?=")).toBe("abc");
    expect(decodeWords("=?utf-8?Q?broken=ZZ?=")).toBe("broken=ZZ");
    expect(decodeWords("plain =?not a word")).toBe("plain =?not a word");
  });
});

describe("parseHeaderValue", () => {
  it("splits the value from quoted and bare parameters", () => {
    expect(parseHeaderValue('text/plain; charset="UTF-8"; format=flowed')).toEqual({
      value: "text/plain",
      params: { charset: "UTF-8", format: "flowed" }
    });
  });

  it("joins RFC 2231 continuations and decodes their charset", () => {
    const parsed = parseHeaderValue(
      "attachment; filename*0*=UTF-8''%EB%B3%B4%EA%B3%A0; filename*1*=%EC%84%9C; filename*2=.pdf"
    );
    expect(parsed.params.filename).toBe("보고서.pdf");
  });

  it("decodes a charset-tagged value without continuations", () => {
    expect(parseHeaderValue("attachment; filename*=iso-8859-1''caf%E9.txt").params.filename).toBe(
      "café.txt"
    );
  });

  it("keeps a trailing key without a value", () => {
    expect(parseHeaderValue("inline; foo").params).toEqual({ foo: "" });
  });
});

describe("splitHeaderLine", () => {
  it("unfolds a folded line and lowercases the key", () => {
    expect(splitHeaderLine("Subject: one\r\n two")).toEqual({ key: "subject", value: "one two" });
  });
});

describe("rawOctetsAsUtf8", () => {
  it("re-reads raw UTF-8 octets and leaves anything else as it is", () => {
    const raw = Buffer.from("한글.pdf", "utf8").toString("latin1");
    expect(rawOctetsAsUtf8(raw)).toBe("한글.pdf");
    expect(rawOctetsAsUtf8("caf\xe9")).toBe("caf\xe9");
    expect(rawOctetsAsUtf8("보고서")).toBe("보고서");
  });
});

describe("ensureMessageIdFormat", () => {
  it("wraps an id in angle brackets once", () => {
    expect(ensureMessageIdFormat("abc@x")).toBe("<abc@x>");
    expect(ensureMessageIdFormat("<abc@x>")).toBe("<abc@x>");
    expect(ensureMessageIdFormat("")).toBeUndefined();
  });
});
