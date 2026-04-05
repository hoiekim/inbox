/**
 * Unit tests for postgres model construction and transformation functions.
 *
 * These tests cover:
 *   - validateObject() from base.ts
 *   - ModelValidationError from base.ts
 *   - Model subclass construction (assigns fields, throws on bad data)
 *   - toJSON() / toUser() / toMaskedUser() transformations
 *   - PartialMailModel (field validation, unknown field rejection, partial assignment)
 *   - FilterCondition / DeleteWhereFilters type guards (structural, not DB)
 *
 * DB-touching methods (query, insert, update, upsert, softDelete, hardDelete,
 * deleteWhere, updateWhere, queryByIds, getByUserIds, deleteOlderThan,
 * isAllowlisted, addEntry, removeByPattern, removeById, getAllForUser)
 * are NOT tested here — they require a live PostgreSQL connection.
 */

import { describe, it, expect } from "bun:test";
import { validateObject, ModelValidationError, Model } from "./base";
import { MailModel, PartialMailModel } from "./mail";
import { UserModel } from "./user";
import { SessionModel } from "./session";
import { MailboxModel } from "./mailbox";
import { PushSubscriptionModel } from "./push_subscription";
import { SpamAllowlistModel } from "./spam_allowlist";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeMailData(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    mail_id: "aaaaaaaa-0000-0000-0000-000000000001",
    user_id: "bbbbbbbb-0000-0000-0000-000000000002",
    message_id: "<test@example.com>",
    subject: "Hello",
    date: "2024-01-01T00:00:00+00:00",
    html: "<p>hi</p>",
    text: "hi",
    from_address: { address: "sender@example.com", name: "Sender" },
    from_text: "Sender <sender@example.com>",
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
    uid_domain: 0,
    uid_account: 0,
    spam_score: 0,
    spam_reasons: null,
    is_spam: false,
    updated: "2024-01-01T00:00:00+00:00",
    search_vector: null,
    ...overrides,
  };
}

function makeUserData(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    user_id: "cccccccc-0000-0000-0000-000000000003",
    username: "alice",
    password: "hashed_password",
    email: "alice@example.com",
    expiry: null,
    token: null,
    updated: "2024-01-01T00:00:00+00:00",
    is_deleted: false,
    imap_uid_validity: null,
    ...overrides,
  };
}

function makeSessionData(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    session_id: "sess-abc-123",
    session_user_id: "cccccccc-0000-0000-0000-000000000003",
    session_username: "alice",
    session_email: "alice@example.com",
    cookie_original_max_age: 86400000,
    cookie_max_age: 86400000,
    cookie_signed: true,
    cookie_expires: "2024-12-31T00:00:00+00:00",
    cookie_http_only: true,
    cookie_path: "/",
    cookie_domain: null,
    cookie_secure: "true",
    cookie_same_site: "lax",
    updated: "2024-01-01T00:00:00+00:00",
    ...overrides,
  };
}

function makeMailboxData(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    mailbox_id: "dddddddd-0000-0000-0000-000000000004",
    user_id: "cccccccc-0000-0000-0000-000000000003",
    name: "INBOX",
    address: "alice@example.com",
    parent_id: null,
    uid_validity: 1,
    uid_next: 42,
    subscribed: true,
    special_use: "\\Inbox",
    created: "2024-01-01T00:00:00+00:00",
    ...overrides,
  };
}

function makePushSubData(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    push_subscription_id: "eeeeeeee-0000-0000-0000-000000000005",
    user_id: "cccccccc-0000-0000-0000-000000000003",
    endpoint: "https://push.example.com/sub/abc123",
    keys_p256dh: "BNJz...key==",
    keys_auth: "auth==",
    last_notified: null,
    updated: "2024-01-01T00:00:00+00:00",
    ...overrides,
  };
}

function makeSpamAllowlistData(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    allowlist_id: "ffffffff-0000-0000-0000-000000000006",
    user_id: "cccccccc-0000-0000-0000-000000000003",
    pattern: "trusted@example.com",
    created_at: "2024-01-01T00:00:00+00:00",
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// base.ts — validateObject
// ---------------------------------------------------------------------------

describe("validateObject", () => {
  const checker = {
    name: (v: unknown) => typeof v === "string",
    age: (v: unknown) => typeof v === "number",
  };

  it("returns empty array for valid object", () => {
    expect(validateObject({ name: "Alice", age: 30 }, checker)).toEqual([]);
  });

  it("returns error for non-object input (null)", () => {
    const errors = validateObject(null, checker);
    expect(errors.length).toBeGreaterThan(0);
    expect(errors[0]).toMatch(/not a valid object/);
  });

  it("returns error for non-object input (string)", () => {
    const errors = validateObject("oops", checker);
    expect(errors.length).toBeGreaterThan(0);
  });

  it("returns error for each failing field", () => {
    const errors = validateObject({ name: 42, age: "old" }, checker);
    expect(errors).toHaveLength(2);
    expect(errors.some((e) => e.startsWith("name:"))).toBe(true);
    expect(errors.some((e) => e.startsWith("age:"))).toBe(true);
  });

  it("skips fields listed in skip array", () => {
    // age is wrong type but skipped — should only report name
    const errors = validateObject({ name: 42, age: "wrong" }, checker, ["age"]);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatch(/^name:/);
  });

  it("handles empty checker (always valid)", () => {
    expect(validateObject({ anything: true }, {})).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// base.ts — ModelValidationError
// ---------------------------------------------------------------------------

describe("ModelValidationError", () => {
  it("has correct name property", () => {
    const err = new ModelValidationError("TestModel", ["field1: bad"]);
    expect(err.name).toBe("ModelValidationError");
  });

  it("includes model name and errors in message", () => {
    const err = new ModelValidationError("FooModel", ["x: 1 (number)"]);
    expect(err.message).toContain("FooModel");
    expect(err.message).toContain("x: 1 (number)");
  });

  it("exposes errors array", () => {
    const errors = ["a: null (object)", "b: undefined (undefined)"];
    const err = new ModelValidationError("M", errors);
    expect(err.errors).toEqual(errors);
  });

  it("is instanceof Error", () => {
    expect(new ModelValidationError("M", [])).toBeInstanceOf(Error);
  });
});

// ---------------------------------------------------------------------------
// MailModel
// ---------------------------------------------------------------------------

describe("MailModel construction", () => {
  it("constructs from valid data and assigns all fields", () => {
    const data = makeMailData();
    const m = new MailModel(data);
    expect(m.mail_id).toBe(data.mail_id);
    expect(m.user_id).toBe(data.user_id);
    expect(m.message_id).toBe(data.message_id);
    expect(m.subject).toBe(data.subject);
    expect(m.read).toBe(false);
    expect(m.spam_score).toBe(0);
    expect(m.is_spam).toBe(false);
    expect(m.from_address).toEqual({ address: "sender@example.com", name: "Sender" });
    expect(m.from_text).toBe("Sender <sender@example.com>");
    expect(m.to_address).toBeNull();
  });

  it("throws ModelValidationError for missing required string fields", () => {
    const data = makeMailData({ mail_id: 999 });
    expect(() => new MailModel(data)).toThrow(ModelValidationError);
  });

  it("throws for non-object input", () => {
    expect(() => new MailModel(null)).toThrow(ModelValidationError);
    expect(() => new MailModel("bad")).toThrow(ModelValidationError);
  });

  it("throws when boolean field gets wrong type", () => {
    const data = makeMailData({ read: "true" }); // string, not boolean
    expect(() => new MailModel(data)).toThrow(ModelValidationError);
  });

  it("throws when number field gets wrong type", () => {
    const data = makeMailData({ uid_domain: "0" }); // string, not number
    expect(() => new MailModel(data)).toThrow(ModelValidationError);
  });

  it("accepts null for nullable fields", () => {
    const data = makeMailData({ insight: null, from_address: null, spam_reasons: null });
    const m = new MailModel(data);
    expect(m.insight).toBeNull();
    expect(m.from_address).toBeNull();
    expect(m.spam_reasons).toBeNull();
  });

  it("accepts arrays for spam_reasons", () => {
    const data = makeMailData({ spam_reasons: ["SPAM_WORD", "BLACKLIST"] });
    const m = new MailModel(data);
    expect(m.spam_reasons).toEqual(["SPAM_WORD", "BLACKLIST"]);
  });
});

describe("MailModel.toJSON", () => {
  it("returns all expected JSON fields", () => {
    const m = new MailModel(makeMailData());
    const json = m.toJSON();
    expect(json.mail_id).toBe(m.mail_id);
    expect(json.user_id).toBe(m.user_id);
    expect(json.subject).toBe(m.subject);
    expect(json.read).toBe(false);
    expect(json.is_spam).toBe(false);
  });

  it("does NOT include updated in toJSON output", () => {
    const m = new MailModel(makeMailData());
    const json = m.toJSON();
    expect("updated" in json).toBe(false);
  });

  it("does NOT include search_vector in toJSON output", () => {
    const m = new MailModel(makeMailData());
    const json = m.toJSON();
    expect("search_vector" in json).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// PartialMailModel
// ---------------------------------------------------------------------------

describe("PartialMailModel", () => {
  it("constructs with subset of valid fields", () => {
    const data = { mail_id: "aaaaaaaa-0000-0000-0000-000000000001", subject: "Hey", read: true };
    const pm = new PartialMailModel(["mail_id", "subject", "read"], data);
    expect(pm.mail_id).toBe(data.mail_id);
    expect(pm.subject).toBe("Hey");
    expect(pm.read).toBe(true);
  });

  it("leaves unselected fields undefined", () => {
    const data = { mail_id: "aaaaaaaa-0000-0000-0000-000000000001" };
    const pm = new PartialMailModel(["mail_id"], data);
    expect(pm.mail_id).toBeDefined();
    expect(pm.subject).toBeUndefined();
    expect(pm.read).toBeUndefined();
  });

  it("throws ModelValidationError for unknown field names", () => {
    const data = { nonexistent_field: "x" };
    expect(() => new PartialMailModel(["nonexistent_field"], data)).toThrow(ModelValidationError);
  });

  it("throws for type mismatch on selected fields", () => {
    const data = { read: "yes" }; // should be boolean
    expect(() => new PartialMailModel(["read"], data)).toThrow(ModelValidationError);
  });

  it("exposes selectedFields set", () => {
    const data = { mail_id: "aaaaaaaa-0000-0000-0000-000000000001", read: false };
    const pm = new PartialMailModel(["mail_id", "read"], data);
    expect(pm.selectedFields.has("mail_id")).toBe(true);
    expect(pm.selectedFields.has("read")).toBe(true);
    expect(pm.selectedFields.has("subject")).toBe(false);
  });

  it("accepts empty fields list with empty data", () => {
    const pm = new PartialMailModel([], {});
    expect(pm.selectedFields.size).toBe(0);
  });

  it("PartialMailModel.validFields includes all MailModel checker keys", () => {
    const checkerKeys = Object.keys(MailModel.typeChecker);
    for (const k of checkerKeys) {
      expect(PartialMailModel.validFields.has(k)).toBe(true);
    }
  });

  it("accepts nullable object field as null", () => {
    const data = { from_address: null };
    const pm = new PartialMailModel(["from_address"], data);
    expect(pm.from_address).toBeNull();
  });

  it("error message lists the unknown field name", () => {
    try {
      new PartialMailModel(["totally_fake_col"], {});
      expect(true).toBe(false); // should not reach
    } catch (e) {
      expect(e).toBeInstanceOf(ModelValidationError);
      expect((e as ModelValidationError).message).toContain("totally_fake_col");
    }
  });
});

// ---------------------------------------------------------------------------
// UserModel
// ---------------------------------------------------------------------------

describe("UserModel construction", () => {
  it("constructs from valid data", () => {
    const u = new UserModel(makeUserData());
    expect(u.user_id).toBe("cccccccc-0000-0000-0000-000000000003");
    expect(u.username).toBe("alice");
    expect(u.email).toBe("alice@example.com");
    expect(u.password).toBe("hashed_password");
  });

  it("throws for missing username", () => {
    expect(() => new UserModel(makeUserData({ username: null }))).toThrow(ModelValidationError);
  });

  it("accepts null for optional fields", () => {
    const u = new UserModel(makeUserData({ email: null, password: null, token: null }));
    expect(u.email).toBeNull();
    expect(u.password).toBeNull();
    expect(u.token).toBeNull();
  });
});

describe("UserModel.toJSON / toMaskedUser", () => {
  it("toJSON masks password", () => {
    const u = new UserModel(makeUserData());
    const json = u.toJSON();
    expect("password" in json).toBe(false);
    expect(json.user_id).toBeDefined();
    expect(json.username).toBe("alice");
  });

  it("toMaskedUser returns same as toJSON", () => {
    const u = new UserModel(makeUserData());
    expect(u.toMaskedUser()).toEqual(u.toJSON());
  });
});

describe("UserModel.toUser", () => {
  it("returns full user including password", () => {
    const u = new UserModel(makeUserData());
    const user = u.toUser();
    expect(user.password).toBe("hashed_password");
    expect(user.user_id).toBe(u.user_id);
  });

  it("throws if password is null", () => {
    const u = new UserModel(makeUserData({ password: null }));
    expect(() => u.toUser()).toThrow("no password set");
  });
});

// ---------------------------------------------------------------------------
// SessionModel
// ---------------------------------------------------------------------------

describe("SessionModel construction", () => {
  it("constructs from valid data", () => {
    const s = new SessionModel(makeSessionData());
    expect(s.session_id).toBe("sess-abc-123");
    expect(s.session_username).toBe("alice");
    expect(s.session_email).toBe("alice@example.com");
  });

  it("throws for missing session_id", () => {
    expect(() => new SessionModel(makeSessionData({ session_id: 42 }))).toThrow(ModelValidationError);
  });

  it("accepts null for all nullable cookie fields", () => {
    const s = new SessionModel(makeSessionData({
      cookie_original_max_age: null,
      cookie_max_age: null,
      cookie_signed: null,
      cookie_expires: null,
      cookie_http_only: null,
      cookie_path: null,
      cookie_domain: null,
      cookie_secure: null,
      cookie_same_site: null,
    }));
    expect(s.cookie_expires).toBeNull();
    expect(s.cookie_signed).toBeNull();
  });
});

describe("SessionModel.toJSON", () => {
  it("includes all session fields", () => {
    const s = new SessionModel(makeSessionData());
    const json = s.toJSON();
    expect(json.session_id).toBe("sess-abc-123");
    expect(json.cookie_path).toBe("/");
    expect(json.cookie_same_site).toBe("lax");
    expect("updated" in json).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// MailboxModel
// ---------------------------------------------------------------------------

describe("MailboxModel construction", () => {
  it("constructs from valid data", () => {
    const m = new MailboxModel(makeMailboxData());
    expect(m.mailbox_id).toBe("dddddddd-0000-0000-0000-000000000004");
    expect(m.name).toBe("INBOX");
    expect(m.uid_validity).toBe(1);
    expect(m.uid_next).toBe(42);
    expect(m.subscribed).toBe(true);
    expect(m.special_use).toBe("\\Inbox");
  });

  it("accepts null for optional fields", () => {
    const m = new MailboxModel(makeMailboxData({ address: null, parent_id: null, special_use: null }));
    expect(m.address).toBeNull();
    expect(m.parent_id).toBeNull();
    expect(m.special_use).toBeNull();
  });

  it("throws when uid_validity is a string", () => {
    expect(() => new MailboxModel(makeMailboxData({ uid_validity: "1" }))).toThrow(ModelValidationError);
  });

  it("throws when subscribed is a string", () => {
    expect(() => new MailboxModel(makeMailboxData({ subscribed: "true" }))).toThrow(ModelValidationError);
  });
});

describe("MailboxModel.toJSON", () => {
  it("returns all expected fields", () => {
    const m = new MailboxModel(makeMailboxData());
    const json = m.toJSON();
    expect(json.mailbox_id).toBe(m.mailbox_id);
    expect(json.uid_next).toBe(42);
    expect(json.special_use).toBe("\\Inbox");
  });
});

// ---------------------------------------------------------------------------
// PushSubscriptionModel
// ---------------------------------------------------------------------------

describe("PushSubscriptionModel construction", () => {
  it("constructs from valid data", () => {
    const p = new PushSubscriptionModel(makePushSubData());
    expect(p.push_subscription_id).toBe("eeeeeeee-0000-0000-0000-000000000005");
    expect(p.endpoint).toBe("https://push.example.com/sub/abc123");
    expect(p.keys_p256dh).toBe("BNJz...key==");
    expect(p.keys_auth).toBe("auth==");
    expect(p.last_notified).toBeNull();
  });

  it("accepts a last_notified timestamp string", () => {
    const p = new PushSubscriptionModel(makePushSubData({ last_notified: "2024-06-01T00:00:00+00:00" }));
    expect(p.last_notified).toBe("2024-06-01T00:00:00+00:00");
  });

  it("throws when endpoint is not a string", () => {
    expect(() => new PushSubscriptionModel(makePushSubData({ endpoint: 42 }))).toThrow(ModelValidationError);
  });
});

describe("PushSubscriptionModel.toJSON", () => {
  it("returns all expected fields", () => {
    const p = new PushSubscriptionModel(makePushSubData());
    const json = p.toJSON();
    expect(json.push_subscription_id).toBe(p.push_subscription_id);
    expect(json.endpoint).toBe(p.endpoint);
    expect(json.last_notified).toBeNull();
    expect("updated" in json).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// SpamAllowlistModel
// ---------------------------------------------------------------------------

describe("SpamAllowlistModel construction", () => {
  it("constructs from valid data", () => {
    const s = new SpamAllowlistModel(makeSpamAllowlistData());
    expect(s.allowlist_id).toBe("ffffffff-0000-0000-0000-000000000006");
    expect(s.user_id).toBe("cccccccc-0000-0000-0000-000000000003");
    expect(s.pattern).toBe("trusted@example.com");
    expect(s.created_at).toBe("2024-01-01T00:00:00+00:00");
  });

  it("accepts domain wildcard pattern", () => {
    const s = new SpamAllowlistModel(makeSpamAllowlistData({ pattern: "*@trusted.com" }));
    expect(s.pattern).toBe("*@trusted.com");
  });

  it("throws when pattern is not a string", () => {
    expect(() => new SpamAllowlistModel(makeSpamAllowlistData({ pattern: null }))).toThrow(ModelValidationError);
  });

  it("throws when created_at is missing", () => {
    const data = makeSpamAllowlistData();
    delete (data as Record<string, unknown>).created_at;
    expect(() => new SpamAllowlistModel(data)).toThrow(ModelValidationError);
  });
});

describe("SpamAllowlistModel.toJSON", () => {
  it("returns all expected fields", () => {
    const s = new SpamAllowlistModel(makeSpamAllowlistData());
    const json = s.toJSON();
    expect(json.allowlist_id).toBe(s.allowlist_id);
    expect(json.user_id).toBe(s.user_id);
    expect(json.pattern).toBe("trusted@example.com");
    expect(json.created_at).toBe("2024-01-01T00:00:00+00:00");
  });
});

// ---------------------------------------------------------------------------
// Cross-model: abstract Model base behavior
// ---------------------------------------------------------------------------

describe("Model base class", () => {
  it("throws ModelValidationError (not plain Error) on bad data", () => {
    try {
      new MailModel({ mail_id: 1 }); // wrong type
    } catch (e) {
      expect(e).toBeInstanceOf(ModelValidationError);
      expect(e).toBeInstanceOf(Error);
    }
  });

  it("does not assign fields listed as invalid type (error is thrown before assignment)", () => {
    const bad = makeMailData({ mail_id: 99 });
    let caught: unknown;
    try {
      new MailModel(bad);
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(ModelValidationError);
  });

  it("Model instance is not a plain object", () => {
    const m = new MailModel(makeMailData());
    expect(typeof m).toBe("object");
    expect(m.constructor).toBe(MailModel);
  });
});
