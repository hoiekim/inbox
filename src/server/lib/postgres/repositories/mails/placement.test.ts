/**
 * `saveMail`'s utility-folder placement, on BOTH branches.
 *
 * The INSERT branch is observable from the caller's input object, so
 * `imap/store.test.ts` can pin it. The 23505 merge branch is not: it rewrites a
 * row that already exists, and a caller-side assertion passes whether or not
 * that write happens. This file runs the REAL `saveMail` so the merge branch's
 * SQL is what gets asserted.
 *
 * Why it matters: a utility view selects its rows by flag. An APPEND into
 * `Drafts` for a Message-ID the account already has takes the merge branch, and
 * a merge that skipped the flag would answer `OK [APPENDUID …]` for a message
 * that landed in no box the client named.
 *
 * Two module-registry hazards have to be cleared to get here, both process-wide
 * and neither undoable from this file:
 *
 *  - `imap/store.test.ts` mock.modules the `repositories/mails` barrel with a
 *    stub `saveMail`, and `mock.module` replaces the export binding graph-wide
 *    — a plain `import "./core"` resolves to that stub even though it never
 *    names the barrel. Bun keys the registry by the full specifier string, so a
 *    cache-busting query suffix is a different key and reaches the real module.
 *  - The pg FakePool seam then does not bind (first importer of `client.ts`
 *    wins), so the pool is mocked at the leaf `client` module instead, and
 *    restored in `afterAll` so nothing bleeds onward.
 */
import { describe, it, expect, mock, beforeEach, afterAll } from "bun:test";

type Call = { sql: string; values: unknown[] };
let calls: Call[] = [];

/** Set per test: what the INSERT does. */
let insertBehavior: "ok" | "conflict" = "ok";

const EXISTING_MAIL_ID = "existing-mail-id";

/**
 * The row the merge branch re-reads. `MailModel` validates every column, so
 * this has to be complete — the flags are the part the assertions care about,
 * and they start in the state the placement is supposed to change.
 */
const existingRow = () => ({
  mail_id: EXISTING_MAIL_ID,
  user_id: "user-1",
  message_id: "<msg@example.com>",
  subject: "s",
  date: new Date().toISOString(),
  html: "",
  text: "",
  from_address: null,
  from_text: null,
  to_address: null,
  to_text: null,
  cc_address: null,
  cc_text: null,
  bcc_address: null,
  bcc_text: null,
  reply_to_address: null,
  reply_to_text: null,
  envelope_from: null,
  envelope_to: null,
  attachments: null,
  read: false,
  saved: false,
  sent: false,
  deleted: false,
  draft: false,
  answered: false,
  expunged: false,
  insight: null,
  uid_domain: 7,
  modseq: 1,
  spam_score: 0,
  spam_reasons: null,
  is_spam: false,
  rfc822_size: 0,
  text_line_count: 1,
  html_line_count: 1,
  updated: new Date().toISOString(),
  search_vector: null,
});

const fakeQuery = async (sql: string, values?: unknown[]) => {
  calls.push({ sql, values: values ?? [] });
  const text = sql.trim().toUpperCase();

  // Order matters: the `mails` INSERT also ends in RETURNING and contains
  // VALUES, so match the table name before any generic shape.
  if (text.startsWith("INSERT INTO MAILS ")) {
    if (insertBehavior === "conflict") {
      throw Object.assign(new Error("duplicate key"), { code: "23505" });
    }
    return { rows: [{ mail_id: "new-mail-id" }], rowCount: 1 };
  }
  // getNextModseq reserves through `mail_uid_counters`.
  if (text.includes("MAIL_UID_COUNTERS")) {
    return { rows: [{ last_uid: 42 }], rowCount: 1 };
  }
  // The merge branch's re-read of the existing row.
  if (text.startsWith("SELECT") && text.includes("FROM MAILS")) {
    return { rows: [existingRow()], rowCount: 1 };
  }
  return { rows: [], rowCount: 0 };
};

const realClient = await import("../../client");
mock.module("../../client", () => ({ ...realClient, pool: { query: fakeQuery } }));

const { saveMail } = await import(`${import.meta.dir}/core.ts?real=725`);

afterAll(() => {
  mock.module("../../client", () => realClient);
});

beforeEach(() => {
  calls = [];
  insertBehavior = "ok";
});

const input = (placement?: { draft?: boolean; is_spam?: boolean }) => ({
  user_id: "user-1",
  message_id: "<msg@example.com>",
  subject: "s",
  placement,
});

/** Every UPDATE issued against `mails`, lowercased for substring matching. */
const mailUpdates = () =>
  calls.map((c) => c.sql.trim().toLowerCase()).filter((s) => s.startsWith("update mails"));

describe("saveMail — utility placement on the INSERT branch", () => {
  it("writes the flag as part of the inserted row", async () => {
    await saveMail(input({ draft: true }));
    const insert = calls.find((c) => c.sql.trim().toLowerCase().startsWith("insert into mails"));
    expect(insert).toBeDefined();
    expect(insert!.sql.toLowerCase()).toContain("draft");
    // The row carries `draft = TRUE`, not the SaveMailInput default of FALSE.
    expect(insert!.values).toContain(true);
  });
});

describe("saveMail — utility placement on the 23505 merge branch", () => {
  it("sets the flag on the existing row so the message is in the box the client named", async () => {
    insertBehavior = "conflict";
    const result = await saveMail(input({ draft: true }));

    // The merge branch must still resolve to the pre-existing row.
    expect(result?._id).toBe(EXISTING_MAIL_ID);

    expect(mailUpdates().some((s) => s.includes("draft"))).toBe(true);
  });

  it("advances the mod-sequence, because placement is a membership change", async () => {
    insertBehavior = "conflict";
    await saveMail(input({ is_spam: true }));

    const placementUpdate = mailUpdates().find((s) => s.includes("is_spam"));
    expect(placementUpdate).toBeDefined();
    expect(placementUpdate).toContain("modseq");
  });

  it("issues no placement UPDATE when the destination is not a utility folder", async () => {
    insertBehavior = "conflict";
    await saveMail(input(undefined));

    expect(mailUpdates().some((s) => s.includes("draft") || s.includes("is_spam"))).toBe(false);
  });
});
