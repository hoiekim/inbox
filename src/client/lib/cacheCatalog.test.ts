import { describe, it, expect } from "bun:test";
import { MailHeaderData } from "common";
import { matchCacheCatalog, cacheCatalog } from "./cacheCatalog";

describe("cacheCatalog", () => {
  it("matches the mail-headers list endpoints (all category variants)", () => {
    expect(matchCacheCatalog("/api/mails/headers/me@hoie.kim")?.id).toBe(
      "mail-headers"
    );
    expect(matchCacheCatalog("/api/mails/headers/me@hoie.kim?sent=1")?.id).toBe(
      "mail-headers"
    );
    expect(matchCacheCatalog("/api/mails/headers/me@hoie.kim?new=1")?.id).toBe(
      "mail-headers"
    );
    expect(
      matchCacheCatalog("/api/mails/headers/me@hoie.kim?saved=1")?.id
    ).toBe("mail-headers");
  });

  it("does not match volatile or unrelated endpoints", () => {
    // search is query-specific and volatile — deliberately excluded
    expect(matchCacheCatalog("/api/mails/search/me@hoie.kim")).toBeUndefined();
    expect(matchCacheCatalog("/api/mails/body/abc")).toBeUndefined();
    expect(matchCacheCatalog("/api/mails/accounts")).toBeUndefined();
    expect(matchCacheCatalog("/api/users/login")).toBeUndefined();
  });

  it("revives stored plain objects into MailHeaderData instances identical to the network path", () => {
    const entry = matchCacheCatalog("/api/mails/headers/me@hoie.kim")!;
    const stored = [
      {
        id: "m1",
        subject: "hello",
        read: true,
        saved: false,
        date: "2026-06-25T00:00:00.000Z",
      },
    ];
    const revived = entry.revive(stored) as MailHeaderData[];
    expect(revived).toHaveLength(1);
    expect(revived[0]).toBeInstanceOf(MailHeaderData);
    expect(revived[0].id).toBe("m1");
    expect(revived[0].subject).toBe("hello");
    expect(revived[0].read).toBe(true);
    // hydrated data must be identical to `new MailHeaderData(plainFromNetwork)`
    expect(JSON.stringify(revived[0])).toBe(
      JSON.stringify(new MailHeaderData(stored[0]))
    );
  });

  it("revive passes through non-array payloads unchanged", () => {
    const entry = matchCacheCatalog("/api/mails/headers/x")!;
    expect(entry.revive(null)).toBe(null);
  });

  it("every catalog entry declares a positive maxAge", () => {
    for (const entry of cacheCatalog) {
      expect(entry.maxAgeMs).toBeGreaterThan(0);
    }
  });
});
