/**
 * SQL-shape guards for the IMAP range and count reads, asserted on what the
 * builders emit — the convention `mail-modseq.test.ts` states: *"Pure `build*`
 * helpers pin the SQL shape with no pool interception."*
 *
 * Pinning these by regex over the function's own source could not distinguish
 * a reformat from a semantic change: the character sequence is what it saw,
 * and a template token that never renders looks the same as one that does.
 * Every assertion below reads the string Postgres would receive.
 */

import { describe, it, expect } from "bun:test";
import {
  buildAllUidsQuery,
  buildCountMessagesQuery,
  buildExpungeDeletedFilters,
  buildExpungeDeletedSelectQuery,
  buildExpungeUidsFilters,
  buildExpungeUidsSelectQuery,
  buildFirstUnseenUidQuery,
  buildMailsByRangeQuery,
  buildSearchMailsByUidQuery,
} from "./imap-query";
import { membershipExpression, usesDomainUidSpace } from "./views";

const USER = "11111111-1111-1111-1111-111111111111";
const ACCOUNT_BOX = "INBOX/accounts/a";
const USER_BOX = "Archive";

const range = (
  overrides: {
    mailbox?: string | null;
    sent?: boolean;
    useUid?: boolean;
    fields?: string[];
    changedSince?: number;
  } = {}
) =>
  buildMailsByRangeQuery(
    USER,
    overrides.mailbox === undefined ? null : overrides.mailbox,
    overrides.sent ?? false,
    3,
    9,
    overrides.useUid ?? true,
    overrides.fields ?? ["*"],
    overrides.changedSince
  );

describe("buildCountMessagesQuery", () => {
  it("counts only rows the mailbox contains, in both branches", () => {
    for (const mailbox of [null, "Drafts", "Junk", ACCOUNT_BOX, USER_BOX]) {
      const { sql } = buildCountMessagesQuery(USER, mailbox, false);
      const prefix = usesDomainUidSpace(mailbox) ? "" : "m.";
      const membership = membershipExpression(mailbox, false, prefix);
      expect(sql).toContain(`COUNT(*) FILTER (WHERE ${membership}) as total`);
      expect(sql).toContain(
        `COUNT(*) FILTER (WHERE ${prefix}read = FALSE AND ${membership}) as unread`
      );
    }
  });

  it("applies the INBOX predicate so quarantined mail is not counted", () => {
    // `is_spam`/`draft` mail is in Junk/Drafts, not INBOX — counting it makes
    // EXISTS report more messages than the client can FETCH.
    const { sql } = buildCountMessagesQuery(USER, null, false);
    expect(sql).toContain("is_spam = FALSE AND draft = FALSE");
  });

  it("selects the utility views by their own flag", () => {
    expect(buildCountMessagesQuery(USER, "Drafts", false).sql).toContain(
      "FILTER (WHERE draft = TRUE)"
    );
    expect(buildCountMessagesQuery(USER, "Junk", false).sql).toContain(
      "FILTER (WHERE is_spam = TRUE)"
    );
  });

  it("does not derive UIDNEXT from a MAX over the surviving rows", () => {
    // Those rows are the ones that survived: an EXPUNGE, hard delete or
    // spam-mark of the highest-UID mail would lower it, which RFC 3501
    // §2.3.1.1 forbids. UIDNEXT comes from `mail_uid_counters`.
    for (const mailbox of [null, ACCOUNT_BOX]) {
      const { sql } = buildCountMessagesQuery(USER, mailbox, false);
      expect(sql).not.toContain("MAX(");
      expect(sql).not.toContain("max_uid");
    }
  });

  it("hides expunged rows from both branches", () => {
    expect(buildCountMessagesQuery(USER, null, false).sql).toContain(
      "expunged = FALSE"
    );
    expect(buildCountMessagesQuery(USER, ACCOUNT_BOX, false).sql).toContain(
      "m.expunged = FALSE"
    );
  });

  it("joins the mapping table on the mailbox path the caller passed", () => {
    // Deriving the join target from the account address breaks user-created
    // boxes: `Archive` stores rows under `Archive`, so a derived
    // `INBOX/accounts/Archive` returns nothing and the mail is invisible.
    const { sql, values } = buildCountMessagesQuery(USER, USER_BOX, false);
    expect(sql).toContain("JOIN mail_mailbox_uid x");
    expect(sql).toContain("AND x.mailbox = $3");
    expect(values).toEqual([USER, false, USER_BOX]);
  });

  it("binds no mailbox on the domain branch", () => {
    expect(buildCountMessagesQuery(USER, null, true).values).toEqual([
      USER,
      true,
    ]);
  });
});

describe("buildMailsByRangeQuery — synthetic projections", () => {
  it("projects octet_length of the body columns when asked", () => {
    // A stream caller pre-measures the `{N}` literal from these without
    // loading the body.
    const { sql } = range({ fields: ["mail_id", "text_octets", "html_octets"] });
    expect(sql).toContain("octet_length(text) AS text_octets");
    expect(sql).toContain("octet_length(html) AS html_octets");
  });

  it("qualifies the octet_length with the mails alias in the JOIN branch", () => {
    // Unqualified, `text` is ambiguous across the join.
    const { sql } = range({
      mailbox: ACCOUNT_BOX,
      fields: ["mail_id", "text_octets", "html_octets"],
    });
    expect(sql).toContain("octet_length(m.text) AS text_octets");
    expect(sql).toContain("octet_length(m.html) AS html_octets");
  });

  it("omits the octet projections when they were not requested", () => {
    const { sql } = range({ fields: ["mail_id", "subject"] });
    expect(sql).not.toContain("octet_length");
  });

  it("never emits a synthetic name as a mails column reference", () => {
    // `text_octets` / `html_octets` / `uid_mailbox` are PartialMailModel
    // fields, not columns — leaking one into the SELECT list is a syntax
    // error at query time.
    for (const mailbox of [null, ACCOUNT_BOX]) {
      const { sql } = range({
        mailbox,
        fields: ["mail_id", "uid_mailbox", "text_octets", "html_octets"],
      });
      const projected = sql
        .slice(sql.indexOf("SELECT") + "SELECT".length, sql.indexOf("FROM"))
        .split(",")
        .map((item) => item.trim().replace(/^m\./, ""));
      // An `AS <synthetic>` alias is the correct shape; a bare one is the
      // leak, so compare whole projection items rather than substrings.
      expect(projected).not.toContain("text_octets");
      expect(projected).not.toContain("html_octets");
      expect(projected).not.toContain("uid_mailbox");
      expect(projected).toContain("mail_id");
    }
  });

  it("aliases the domain UID as uid_mailbox on the domain branch", () => {
    const { sql } = range({ fields: ["mail_id", "uid_mailbox"] });
    expect(sql).toContain("uid_domain AS uid_mailbox");
  });

  it("aliases the mapping row's UID as uid_mailbox on the JOIN branch", () => {
    // The per-mailbox UID is the one the client sees, so the JOIN branch must
    // not fall back to the domain UID.
    const { sql } = range({ mailbox: ACCOUNT_BOX, fields: ["mail_id", "uid_mailbox"] });
    expect(sql).toContain("x.uid AS uid_mailbox");
    expect(sql).not.toContain("uid_domain AS uid_mailbox");
  });

  it("always projects mail_id, the key the result map is built on", () => {
    const { sql, selectedFields } = range({ fields: ["subject"] });
    expect(selectedFields).toContain("mail_id");
    expect(sql).toContain("mail_id");
  });

  it("drops unknown fields rather than interpolating them into the SELECT", () => {
    const { sql, selectedFields } = range({ fields: ["mail_id", "bogus_field"] });
    expect(selectedFields).not.toContain("bogus_field");
    expect(sql).not.toContain("bogus_field");
  });
});

describe("buildMailsByRangeQuery — CHANGEDSINCE", () => {
  it("filters in SQL rather than post-filtering the whole window", () => {
    expect(range({ changedSince: 42 }).sql).toContain("AND modseq > $5");
  });

  it("qualifies the predicate with the mails alias on the JOIN branch", () => {
    expect(range({ mailbox: ACCOUNT_BOX, changedSince: 42 }).sql).toContain(
      "AND m.modseq > $6"
    );
  });

  it("omits the predicate entirely when no modifier was given", () => {
    for (const mailbox of [null, ACCOUNT_BOX]) {
      for (const useUid of [false, true]) {
        expect(range({ mailbox, useUid }).sql).not.toContain("modseq >");
      }
    }
  });

  it("binds changedSince into the slot its placeholder names", () => {
    // The predicate references the param appended after each branch's fixed
    // argument list, so a drift here compares a mod-sequence against a UID.
    const domain = range({ changedSince: 42 });
    expect(domain.values).toEqual([USER, false, 3, 9, 42]);
    const mapped = range({ mailbox: ACCOUNT_BOX, changedSince: 42 });
    expect(mapped.values).toEqual([USER, false, ACCOUNT_BOX, 3, 9, 42]);
  });
});

describe("buildMailsByRangeQuery — range and membership", () => {
  it("applies the membership rule in every branch", () => {
    // Dropped from a branch, quarantined mail reappears past the filtered
    // enumeration and `FETCH <last seq>` addresses a message the client was
    // told does not exist. The mapped boxes take the JOIN branch, which
    // qualifies the rule with `m.` across the join.
    for (const mailbox of [null, "Drafts", "Junk", ACCOUNT_BOX, USER_BOX]) {
      for (const useUid of [false, true]) {
        const prefix = usesDomainUidSpace(mailbox) ? "" : "m.";
        const expression = membershipExpression(mailbox, false, prefix);
        if (expression === "TRUE") continue;
        const { sql } = range({ mailbox, useUid });
        expect(sql).toContain(expression);
      }
    }
  });

  it("hides expunged rows in every branch", () => {
    for (const mailbox of [null, ACCOUNT_BOX]) {
      for (const useUid of [false, true]) {
        expect(range({ mailbox, useUid }).sql).toContain("expunged = FALSE");
      }
    }
  });

  it("ranges over the UID space on a UID fetch", () => {
    expect(range({ useUid: true }).sql).toContain(
      "uid_domain >= $3 AND uid_domain <= $4"
    );
    expect(range({ mailbox: ACCOUNT_BOX, useUid: true }).sql).toContain(
      "x.uid >= $4 AND x.uid <= $5"
    );
  });

  it("converts a sequence range to a zero-based OFFSET and a count", () => {
    // Sequence numbers are 1-based and inclusive at both ends, so `3:9` is
    // nine-minus-three-plus-one rows starting after two.
    expect(range({ useUid: false }).values).toEqual([USER, false, 2, 7]);
    expect(range({ mailbox: ACCOUNT_BOX, useUid: false }).values).toEqual([
      USER,
      false,
      ACCOUNT_BOX,
      2,
      7,
    ]);
  });

  it("orders by the UID space the branch enumerates", () => {
    expect(range().sql).toContain("ORDER BY uid_domain ASC");
    expect(range({ mailbox: ACCOUNT_BOX }).sql).toContain("ORDER BY x.uid ASC");
  });

  it("joins the mapping table on the mailbox path the caller passed", () => {
    const { sql } = range({ mailbox: USER_BOX });
    expect(sql).toContain("AND x.mailbox = $3");
    expect(sql).not.toContain("INBOX/accounts/");
  });
});

describe("buildSearchMailsByUidQuery", () => {
  const search = (mailbox: string | null, sent = false) =>
    buildSearchMailsByUidQuery(USER, mailbox, sent, [{ type: "SEEN" }]);

  it("returns every match — SEARCH is uncapped per RFC 3501 §6.4.4", () => {
    // A cap under `ORDER BY uid ASC` would silently drop the newest messages
    // on any mailbox larger than it.
    for (const mailbox of [null, ACCOUNT_BOX]) {
      expect(search(mailbox).sql).not.toMatch(/\bLIMIT\b/i);
    }
  });

  it("hides expunged rows and anything the mailbox does not show", () => {
    // SEARCH must not return UIDs the client cannot then FETCH.
    for (const mailbox of [null, "Drafts", "Junk", ACCOUNT_BOX]) {
      const { sql } = search(mailbox);
      expect(sql).toContain("m.expunged = FALSE");
      expect(sql).toContain(membershipExpression(mailbox, false, "m."));
    }
  });

  it("enumerates the domain UID space on a domain view", () => {
    const { sql, values } = search(null);
    expect(sql).toContain("SELECT uid_domain as uid FROM mails m");
    expect(sql).toContain("ORDER BY uid_domain ASC");
    expect(values.slice(0, 2)).toEqual([USER, false]);
  });

  it("joins the mapping table and enumerates its UID on a mapped box", () => {
    const { sql, values } = search(USER_BOX);
    expect(sql).toContain("FROM mails m, mail_mailbox_uid x");
    expect(sql).toContain("x.mailbox = $3");
    expect(sql).toContain("ORDER BY x.uid ASC");
    expect(values.slice(0, 3)).toEqual([USER, false, USER_BOX]);
  });

  it("binds criterion parameters after the branch's own", () => {
    const { sql, values } = buildSearchMailsByUidQuery(USER, USER_BOX, false, [
      { type: "BODY", value: "needle" },
    ]);
    expect(values).toEqual([USER, false, USER_BOX, "%needle%"]);
    expect(sql).toContain("text ILIKE $4");
  });
});

describe("buildAllUidsQuery / buildFirstUnseenUidQuery", () => {
  it("applies the membership rule on both branches of both queries", () => {
    // These two back the sequence-number map and the `[UNSEEN <seq>]` response
    // code. A filtered enumeration against an unfiltered count makes EXISTS
    // exceed the addressable sequence range.
    for (const mailbox of [null, "Drafts", "Junk", ACCOUNT_BOX, USER_BOX]) {
      for (const sent of [false, true]) {
        const prefix = usesDomainUidSpace(mailbox) ? "" : "m.";
        const expression = membershipExpression(mailbox, sent, prefix);
        for (const build of [buildAllUidsQuery, buildFirstUnseenUidQuery]) {
          const { sql } = build(USER, mailbox, sent);
          if (expression === "TRUE") continue;
          expect(sql).toContain(expression);
        }
      }
    }
  });

  it("hides expunged rows from the sequence map", () => {
    expect(buildAllUidsQuery(USER, null, false).sql).toContain("expunged = FALSE");
    expect(buildAllUidsQuery(USER, ACCOUNT_BOX, false).sql).toContain(
      "m.expunged = FALSE"
    );
  });

  it("orders the sequence map by the UID space the branch enumerates", () => {
    expect(buildAllUidsQuery(USER, null, false).sql).toContain(
      "ORDER BY uid_domain ASC"
    );
    expect(buildAllUidsQuery(USER, ACCOUNT_BOX, false).sql).toContain(
      "ORDER BY x.uid ASC"
    );
  });

  it("takes the lowest-UID unread row, not the unread count", () => {
    for (const mailbox of [null, ACCOUNT_BOX]) {
      const { sql } = buildFirstUnseenUidQuery(USER, mailbox, false);
      const prefix = usesDomainUidSpace(mailbox) ? "" : "m.";
      expect(sql).toContain(`${prefix}read = FALSE`);
      expect(sql).toContain("LIMIT 1");
      expect(sql).not.toContain("COUNT(");
    }
  });

  it("binds the mailbox only on the mapped branch", () => {
    expect(buildAllUidsQuery(USER, null, true).values).toEqual([USER, true]);
    expect(buildAllUidsQuery(USER, USER_BOX, true).values).toEqual([
      USER,
      true,
      USER_BOX,
    ]);
  });
});

describe("expunge filters and lookups", () => {
  it("restricts a domain EXPUNGE to \\Deleted rows the box still shows", () => {
    // Without the membership rule an INBOX EXPUNGE would collect quarantined
    // spam the client never saw and could not have flagged.
    expect(buildExpungeDeletedFilters(USER, null, false)).toEqual({
      user_id: USER,
      sent: false,
      deleted: true,
      expunged: false,
      is_spam: false,
      draft: false,
    });
  });

  it("selects the utility views by their own flag on EXPUNGE", () => {
    expect(buildExpungeDeletedFilters(USER, "Junk", false)).toMatchObject({
      is_spam: true,
    });
    expect(buildExpungeDeletedFilters(USER, "Drafts", false)).toMatchObject({
      draft: true,
    });
  });

  it("carries the membership rule into the mapped EXPUNGE lookup", () => {
    for (const mailbox of [ACCOUNT_BOX, USER_BOX]) {
      const { sql, values } = buildExpungeDeletedSelectQuery(
        USER,
        mailbox,
        false
      );
      const expression = membershipExpression(mailbox, false, "m.");
      if (expression !== "TRUE") expect(sql).toContain(expression);
      expect(sql).toContain("m.deleted = TRUE AND m.expunged = FALSE");
      expect(sql).toContain("AND x.mailbox = $3");
      expect(values).toEqual([USER, false, mailbox]);
    }
  });

  it("restricts a domain MOVE removal to the named UIDs the box shows", () => {
    // MOVE's source-side removal ignores \Deleted, so membership is the only
    // thing keeping it inside the selected mailbox.
    expect(buildExpungeUidsFilters(USER, null, false, [4, 9])).toEqual({
      user_id: USER,
      sent: false,
      expunged: false,
      uid_domain: { op: "IN", value: [4, 9] },
      is_spam: false,
      draft: false,
    });
    expect(buildExpungeUidsFilters(USER, null, false, [4, 9])).not.toHaveProperty(
      "deleted"
    );
  });

  it("numbers the mapped MOVE lookup's UID placeholders after its fixed args", () => {
    const { sql, values } = buildExpungeUidsSelectQuery(USER, USER_BOX, false, [
      4, 9, 11,
    ]);
    expect(sql).toContain("x.uid IN ($4,$5,$6)");
    expect(values).toEqual([USER, false, USER_BOX, 4, 9, 11]);
    expect(sql).toContain("m.expunged = FALSE");
  });
});
