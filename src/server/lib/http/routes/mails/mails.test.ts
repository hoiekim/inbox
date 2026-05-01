/**
 * Tests for mails route handlers:
 *   get-headers, get-accounts, get-body, delete, post-mark,
 *   get-search, get-spam, get-domain, get-allowlist, post-allowlist,
 *   delete-allowlist, post-send, post-spam-mark, get-attachment
 */
import { describe, it, expect, mock, beforeEach } from "bun:test";
import type { ApiResponse } from "../route";

// ── Shared mocks for "server" barrel ─────────────────────────────────────────

const mockGetMailHeaders = mock(async () => []);
const mockGetAccounts = mock(async () => ({ received: [], sent: [] }));
const mockGetMailBody = mock(async () => null as unknown);
const mockDeleteMail = mock(async () => {});
const mockMarkRead = mock(async () => {});
const mockMarkSaved = mock(async () => {});
const mockDecrementBadgeCount = mock(async () => {});
const mockAddressToUsername = mock((addr: string) => addr.split("@")[0]);
const mockGetUser = mock(async () => null as unknown);

// New mocks for additional routes
const mockSearchMail = mock(async () => []);
const mockGetSpamHeaders = mock(async () => []);
const mockGetDomain = mock(() => "example.com");
const mockGetAllowlistForUser = mock(async () => []);
const mockAddAllowlistEntry = mock(async () => null as unknown);
const mockRemoveAllowlistEntry = mock(async () => false as unknown);
const mockSendMail = mock(async () => {});
const mockMarkSpam = mock(async () => false as unknown);
const mockGetAttachment = mock(() => undefined as unknown);
const mockMailsTableQueryOne = mock(async () => null as unknown);
const AUTH_ERROR_MESSAGE = "Authentication required";

class MockMailValidationError extends Error {}
class MockMailSendingError extends Error {}

mock.module("server", () => ({
  getMailHeaders: mockGetMailHeaders,
  getAccounts: mockGetAccounts,
  getMailBody: mockGetMailBody,
  deleteMail: mockDeleteMail,
  markRead: mockMarkRead,
  markSaved: mockMarkSaved,
  decrementBadgeCount: mockDecrementBadgeCount,
  addressToUsername: mockAddressToUsername,
  getUser: mockGetUser,
  logger: { error: mock(() => {}), info: mock(() => {}), warn: mock(() => {}) },
  searchMail: mockSearchMail,
  getSpamHeaders: mockGetSpamHeaders,
  getDomain: mockGetDomain,
  getAllowlistForUser: mockGetAllowlistForUser,
  addAllowlistEntry: mockAddAllowlistEntry,
  removeAllowlistEntry: mockRemoveAllowlistEntry,
  sendMail: mockSendMail,
  markSpam: mockMarkSpam,
  getAttachment: mockGetAttachment,
  AUTH_ERROR_MESSAGE,
  MailValidationError: MockMailValidationError,
  MailSendingError: MockMailSendingError,
  mailsTable: { queryOne: mockMailsTableQueryOne },
  SpamAllowlistModel: class {},
  // Push route exports needed when this mock is active for push.test.ts
  getPushPublicKey: mock(() => "vapid-public-key"),
  storeSubscription: mock(async () => null),
  refreshSubscription: mock(async () => null),
  // Users/token route exports
  setUserInfo: mock(async () => null),
  isValidEmail: mock(() => true),
  createToken: mock(async () => ({ id: "u1", username: "u", token: "tok" })),
  getSignedUser: mock(() => null),
  createAuthenticationMail: mock(() => ({})),
  startTimer: mock(() => {}),
  version: "0.0.0",
}));

// Mock logger used directly in post-mark
mock.module("../../../logger", () => ({
  logger: { error: mock(() => {}), info: mock(() => {}), warn: mock(() => {}) },
}));

// ── Helper factories ──────────────────────────────────────────────────────────

const makeUser = (username = "alice", id = "u1") => ({ id, username });

const makeReq = (overrides: Record<string, unknown> = {}) =>
  ({
    method: "GET",
    session: { user: makeUser() },
    params: {},
    query: {},
    body: {},
    ...overrides,
  }) as unknown as import("express").Request;

const makeRes = () => {
  const res: Record<string, unknown> = { _code: 200, _body: undefined };
  res.status = mock((code: number) => { res._code = code; return res; });
  res.json = mock((body: unknown) => { res._body = body; return res; });
  res.send = mock((body: unknown) => { res._body = body; return res; });
  res.write = mock(() => true);
  res.end = mock(() => res);
  return res as unknown as import("express").Response & { _code: number; _body: unknown };
};

const stream = mock(() => {});
const noopStream = stream as unknown as import("../route").Stream<unknown>;

// ── get-headers route ─────────────────────────────────────────────────────────

describe("getHeadersRoute", () => {
  beforeEach(() => {
    mockGetMailHeaders.mockClear();
    mockAddressToUsername.mockClear();
  });

  it("returns success with mail headers for valid user", async () => {
    const { getHeadersRoute } = await import("./get-headers");

    const fakeMails = [{ id: "m1", subject: "Hello" }];
    mockGetMailHeaders.mockResolvedValueOnce(fakeMails as never);

    const req = makeReq({
      method: "GET",
      session: { user: makeUser("alice") },
      params: { account: "alice@example.com" },
      query: {},
    });
    const res = makeRes();

    const result = await getHeadersRoute.callback(req, res, noopStream);
    expect((result as ApiResponse<unknown>).status).toBe("success");
    expect((result as ApiResponse<unknown>).body).toEqual(fakeMails);
  });

  it("allows admin user to access any account", async () => {
    const { getHeadersRoute } = await import("./get-headers");

    mockGetMailHeaders.mockResolvedValueOnce([] as never);
    mockAddressToUsername.mockReturnValueOnce("bob");

    const req = makeReq({
      method: "GET",
      session: { user: makeUser("admin") },
      params: { account: "bob@example.com" },
      query: {},
    });
    const res = makeRes();

    const result = await getHeadersRoute.callback(req, res, noopStream);
    expect((result as ApiResponse<unknown>).status).toBe("success");
  });

  it("returns failed when user tries to access another user's account", async () => {
    const { getHeadersRoute } = await import("./get-headers");

    mockAddressToUsername.mockReturnValueOnce("charlie");

    const req = makeReq({
      method: "GET",
      session: { user: makeUser("alice") },
      params: { account: "charlie@example.com" },
      query: {},
    });
    const res = makeRes();

    const result = await getHeadersRoute.callback(req, res, noopStream);
    expect((result as ApiResponse<unknown>).status).toBe("failed");
  });

  it("passes query options (sent/new/saved) to getMailHeaders", async () => {
    const { getHeadersRoute } = await import("./get-headers");

    mockGetMailHeaders.mockResolvedValueOnce([]);
    mockAddressToUsername.mockReturnValueOnce("alice");

    const req = makeReq({
      method: "GET",
      session: { user: makeUser("alice") },
      params: { account: "alice@example.com" },
      query: { sent: "1", new: "1" },
    });
    const res = makeRes();

    await getHeadersRoute.callback(req, res, noopStream);

    const callArgs = mockGetMailHeaders.mock.calls[0];
    expect(callArgs[2]).toMatchObject({ sent: true, new: true, saved: false });
  });
});

// ── get-accounts route ────────────────────────────────────────────────────────

describe("getAccountsRoute", () => {
  beforeEach(() => mockGetAccounts.mockClear());

  it("returns received and sent accounts", async () => {
    const { getAccountsRoute } = await import("./get-accounts");

    const fakeAccounts = {
      received: [{ address: "alice@example.com" }],
      sent: [{ address: "bob@example.com" }],
    };
    mockGetAccounts.mockResolvedValueOnce(fakeAccounts as never);

    const req = makeReq({ session: { user: makeUser("alice") } });
    const res = makeRes();

    const result = await getAccountsRoute.callback(req, res, noopStream);
    expect((result as ApiResponse<unknown>).status).toBe("success");
    expect((result as ApiResponse<unknown>).body).toMatchObject(fakeAccounts);
  });

  it("calls getAccounts with the session user", async () => {
    const { getAccountsRoute } = await import("./get-accounts");

    mockGetAccounts.mockResolvedValueOnce({ received: [], sent: [] } as never);
    const user = makeUser("bob");
    const req = makeReq({ session: { user } });
    const res = makeRes();

    await getAccountsRoute.callback(req, res, noopStream);

    expect(mockGetAccounts).toHaveBeenCalledWith(user);
  });
});

// ── get-body route ────────────────────────────────────────────────────────────

describe("getBodyRoute", () => {
  beforeEach(() => mockGetMailBody.mockClear());

  it("returns mail body when found", async () => {
    const { getBodyRoute } = await import("./get-body");

    const fakeMail = { id: "m1", html: "<p>Hello</p>" };
    mockGetMailBody.mockResolvedValueOnce(fakeMail);

    const req = makeReq({ params: { id: "m1" } });
    const res = makeRes();

    const result = await getBodyRoute.callback(req, res, noopStream);
    expect((result as ApiResponse<unknown>).status).toBe("success");
    expect((result as ApiResponse<unknown>).body).toEqual(fakeMail);
  });

  it("returns failed when mail is not found", async () => {
    const { getBodyRoute } = await import("./get-body");

    mockGetMailBody.mockResolvedValueOnce(null);

    const req = makeReq({ params: { id: "missing" } });
    const res = makeRes();

    const result = await getBodyRoute.callback(req, res, noopStream);
    expect((result as ApiResponse<unknown>).status).toBe("failed");
    expect((result as ApiResponse<unknown>).message).toBeTruthy();
  });
});

// ── delete mail route ─────────────────────────────────────────────────────────

describe("deleteMailRoute", () => {
  beforeEach(() => {
    mockGetMailBody.mockClear();
    mockDeleteMail.mockClear();
  });

  it("deletes mail and returns success when mail belongs to user", async () => {
    const { deleteMailRoute } = await import("./delete");

    mockGetMailBody.mockResolvedValueOnce({ id: "m1" });

    const req = makeReq({ method: "DELETE", params: { id: "m1" } });
    const res = makeRes();

    const result = await deleteMailRoute.callback(req, res, noopStream);
    expect((result as ApiResponse<unknown>).status).toBe("success");
    expect(mockDeleteMail).toHaveBeenCalledWith("u1", "m1");
  });

  it("returns failed when mail not found (or belongs to another user)", async () => {
    const { deleteMailRoute } = await import("./delete");

    mockGetMailBody.mockResolvedValueOnce(null);

    const req = makeReq({ method: "DELETE", params: { id: "other-m" } });
    const res = makeRes();

    const result = await deleteMailRoute.callback(req, res, noopStream);
    expect((result as ApiResponse<unknown>).status).toBe("failed");
    expect(mockDeleteMail).not.toHaveBeenCalled();
  });
});

// ── post-mark route ───────────────────────────────────────────────────────────

describe("postMarkMailRoute", () => {
  beforeEach(() => {
    mockGetMailBody.mockClear();
    mockMarkRead.mockClear();
    mockMarkSaved.mockClear();
    mockDecrementBadgeCount.mockClear();
  });

  it("marks mail as read and returns success", async () => {
    const { postMarkMailRoute } = await import("./post-mark");

    mockGetMailBody.mockResolvedValueOnce({ id: "m1" });

    const req = makeReq({
      method: "POST",
      body: { mail_id: "m1", read: true },
    });
    const res = makeRes();

    const result = await postMarkMailRoute.callback(req, res, noopStream);
    expect((result as ApiResponse<unknown>).status).toBe("success");
    expect(mockMarkRead).toHaveBeenCalledWith("u1", "m1");
  });

  it("marks mail as saved when save=true", async () => {
    const { postMarkMailRoute } = await import("./post-mark");

    mockGetMailBody.mockResolvedValueOnce({ id: "m1" });

    const req = makeReq({
      method: "POST",
      body: { mail_id: "m1", save: true },
    });
    const res = makeRes();

    const result = await postMarkMailRoute.callback(req, res, noopStream);
    expect((result as ApiResponse<unknown>).status).toBe("success");
    expect(mockMarkSaved).toHaveBeenCalledWith("u1", "m1", true);
  });

  it("marks mail as unsaved when save=false", async () => {
    const { postMarkMailRoute } = await import("./post-mark");

    mockGetMailBody.mockResolvedValueOnce({ id: "m1" });

    const req = makeReq({
      method: "POST",
      body: { mail_id: "m1", save: false },
    });
    const res = makeRes();

    const result = await postMarkMailRoute.callback(req, res, noopStream);
    expect((result as ApiResponse<unknown>).status).toBe("success");
    expect(mockMarkSaved).toHaveBeenCalledWith("u1", "m1", false);
  });

  it("returns failed when mail not found", async () => {
    const { postMarkMailRoute } = await import("./post-mark");

    mockGetMailBody.mockResolvedValueOnce(null);

    const req = makeReq({
      method: "POST",
      body: { mail_id: "bad-id", read: true },
    });
    const res = makeRes();

    const result = await postMarkMailRoute.callback(req, res, noopStream);
    expect((result as ApiResponse<unknown>).status).toBe("failed");
    expect(mockMarkRead).not.toHaveBeenCalled();
  });

  it("does not call markRead when read is not explicitly true", async () => {
    const { postMarkMailRoute } = await import("./post-mark");

    mockGetMailBody.mockResolvedValueOnce({ id: "m1" });

    const req = makeReq({
      method: "POST",
      body: { mail_id: "m1" },
    });
    const res = makeRes();

    await postMarkMailRoute.callback(req, res, noopStream);
    expect(mockMarkRead).not.toHaveBeenCalled();
  });
});

// ── get-search route ──────────────────────────────────────────────────────────

describe("getSearchRoute", () => {
  beforeEach(() => mockSearchMail.mockClear());

  it("returns search results for a given value", async () => {
    const { getSearchRoute } = await import("./get-search");
    const fakeMails = [{ id: "m1", subject: "Test" }];
    mockSearchMail.mockResolvedValueOnce(fakeMails as never);

    const req = makeReq({ params: { value: "Test" }, query: {} });
    const result = await getSearchRoute.callback(req, makeRes(), noopStream);

    expect((result as ApiResponse<unknown>).status).toBe("success");
    expect((result as ApiResponse<unknown>).body).toEqual(fakeMails);
    expect(mockSearchMail).toHaveBeenCalledTimes(1);
  });

  it("passes field query param to searchMail", async () => {
    const { getSearchRoute } = await import("./get-search");
    mockSearchMail.mockResolvedValueOnce([]);

    const req = makeReq({ params: { value: "hello" }, query: { field: "subject" } });
    await getSearchRoute.callback(req, makeRes(), noopStream);

    expect(mockSearchMail).toHaveBeenCalledWith(
      expect.objectContaining({ id: "u1" }),
      "hello",
      "subject"
    );
  });
});

// ── get-spam route ────────────────────────────────────────────────────────────

describe("getSpamMailsRoute", () => {
  beforeEach(() => mockGetSpamHeaders.mockClear());

  it("returns spam headers for authenticated user", async () => {
    const { getSpamMailsRoute } = await import("./get-spam");
    const spamMails = [{ id: "s1" }];
    mockGetSpamHeaders.mockResolvedValueOnce(spamMails as never);

    const req = makeReq();
    const result = await getSpamMailsRoute.callback(req, makeRes(), noopStream);

    expect((result as ApiResponse<unknown>).status).toBe("success");
    expect((result as ApiResponse<unknown>).body).toEqual(spamMails);
  });
});

// ── get-domain route ──────────────────────────────────────────────────────────

describe("getDomainRoute", () => {
  beforeEach(() => mockGetDomain.mockClear());

  it("returns the configured domain", async () => {
    const { getDomainRoute } = await import("./get-domain");
    const result = await getDomainRoute.callback(makeReq(), makeRes(), noopStream);

    expect((result as ApiResponse<unknown>).status).toBe("success");
    expect((result as ApiResponse<unknown>).body).toBe("example.com");
  });
});

// ── get-allowlist route ───────────────────────────────────────────────────────

describe("getSpamAllowlistRoute", () => {
  beforeEach(() => mockGetAllowlistForUser.mockClear());

  it("returns mapped allowlist entries", async () => {
    const { getSpamAllowlistRoute } = await import("./get-allowlist");
    const entries = [
      { allowlist_id: "a1", pattern: "*@spam.com", created_at: "2026-01-01" },
    ];
    mockGetAllowlistForUser.mockResolvedValueOnce(entries as never);

    const result = await getSpamAllowlistRoute.callback(makeReq(), makeRes(), noopStream);

    expect((result as ApiResponse<unknown>).status).toBe("success");
    expect((result as ApiResponse<unknown>).body).toEqual([
      { id: "a1", pattern: "*@spam.com", createdAt: "2026-01-01" },
    ]);
  });

  it("returns empty array when no entries", async () => {
    const { getSpamAllowlistRoute } = await import("./get-allowlist");
    mockGetAllowlistForUser.mockResolvedValueOnce([]);

    const result = await getSpamAllowlistRoute.callback(makeReq(), makeRes(), noopStream);

    expect((result as ApiResponse<unknown>).status).toBe("success");
    expect((result as ApiResponse<unknown>).body).toEqual([]);
  });
});

// ── post-allowlist route ──────────────────────────────────────────────────────

describe("postSpamAllowlistRoute", () => {
  beforeEach(() => mockAddAllowlistEntry.mockClear());

  it("rejects missing pattern", async () => {
    const { postSpamAllowlistRoute } = await import("./post-allowlist");
    const req = makeReq({ body: {} });
    const result = await postSpamAllowlistRoute.callback(req, makeRes(), noopStream);
    expect((result as ApiResponse<unknown>).status).toBe("failed");
    expect((result as ApiResponse<unknown>).message).toMatch(/pattern is required/i);
  });

  it("rejects invalid pattern format", async () => {
    const { postSpamAllowlistRoute } = await import("./post-allowlist");
    const req = makeReq({ body: { pattern: "notavalidemail" } });
    const result = await postSpamAllowlistRoute.callback(req, makeRes(), noopStream);
    expect((result as ApiResponse<unknown>).status).toBe("failed");
    expect((result as ApiResponse<unknown>).message).toMatch(/email address/i);
  });

  it("returns failed when entry already exists (null returned)", async () => {
    const { postSpamAllowlistRoute } = await import("./post-allowlist");
    mockAddAllowlistEntry.mockResolvedValueOnce(null);
    const req = makeReq({ body: { pattern: "*@spam.com" } });
    const result = await postSpamAllowlistRoute.callback(req, makeRes(), noopStream);
    expect((result as ApiResponse<unknown>).status).toBe("failed");
    expect((result as ApiResponse<unknown>).message).toMatch(/already exists/i);
  });

  it("returns success with new entry on exact email pattern", async () => {
    const { postSpamAllowlistRoute } = await import("./post-allowlist");
    mockAddAllowlistEntry.mockResolvedValueOnce({
      allowlist_id: "a2",
      pattern: "bad@spam.com",
      created_at: "2026-04-01",
    });
    const req = makeReq({ body: { pattern: "bad@spam.com" } });
    const result = await postSpamAllowlistRoute.callback(req, makeRes(), noopStream);
    expect((result as ApiResponse<unknown>).status).toBe("success");
    expect((result as ApiResponse<unknown>).body).toMatchObject({ id: "a2", pattern: "bad@spam.com" });
  });

  it("returns success with domain wildcard pattern", async () => {
    const { postSpamAllowlistRoute } = await import("./post-allowlist");
    mockAddAllowlistEntry.mockResolvedValueOnce({
      allowlist_id: "a3",
      pattern: "*@domain.com",
      created_at: "2026-04-01",
    });
    const req = makeReq({ body: { pattern: "*@domain.com" } });
    const result = await postSpamAllowlistRoute.callback(req, makeRes(), noopStream);
    expect((result as ApiResponse<unknown>).status).toBe("success");
    expect((result as ApiResponse<unknown>).body).toMatchObject({ pattern: "*@domain.com" });
  });
});

// ── delete-allowlist route ────────────────────────────────────────────────────

describe("deleteSpamAllowlistRoute", () => {
  beforeEach(() => mockRemoveAllowlistEntry.mockClear());

  it("returns failed when entry not found", async () => {
    const { deleteSpamAllowlistRoute } = await import("./delete-allowlist");
    mockRemoveAllowlistEntry.mockResolvedValueOnce(false);
    const req = makeReq({ params: { pattern: "*%40spam.com" } });
    const result = await deleteSpamAllowlistRoute.callback(req, makeRes(), noopStream);
    expect((result as ApiResponse<unknown>).status).toBe("failed");
    expect((result as ApiResponse<unknown>).message).toMatch(/not found/i);
  });

  it("returns success when entry removed", async () => {
    const { deleteSpamAllowlistRoute } = await import("./delete-allowlist");
    mockRemoveAllowlistEntry.mockResolvedValueOnce(true);
    const req = makeReq({ params: { pattern: "*%40spam.com" } });
    const result = await deleteSpamAllowlistRoute.callback(req, makeRes(), noopStream);
    expect((result as ApiResponse<unknown>).status).toBe("success");
  });
});

// ── post-send route ───────────────────────────────────────────────────────────

describe("postSendMailRoute", () => {
  beforeEach(() => mockSendMail.mockClear());

  it("returns success when mail is sent", async () => {
    const { postSendMailRoute } = await import("./post-send");
    mockSendMail.mockResolvedValueOnce(undefined);
    const req = makeReq({
      body: { to: "test@example.com", subject: "Hi", text: "Hello" },
    });
    const result = await postSendMailRoute.callback(req, makeRes(), noopStream);
    expect((result as ApiResponse<unknown>).status).toBe("success");
  });

  it("returns failed on MailValidationError", async () => {
    const { postSendMailRoute } = await import("./post-send");
    mockSendMail.mockRejectedValueOnce(new MockMailValidationError("bad mail"));
    const req = makeReq({ body: { to: "x@x.com", subject: "s", text: "t" } });
    const result = await postSendMailRoute.callback(req, makeRes(), noopStream);
    expect((result as ApiResponse<unknown>).status).toBe("failed");
    expect((result as ApiResponse<unknown>).message).toBe("bad mail");
  });

  it("returns failed on MailSendingError", async () => {
    const { postSendMailRoute } = await import("./post-send");
    mockSendMail.mockRejectedValueOnce(new MockMailSendingError("send failed"));
    const req = makeReq({ body: { to: "x@x.com", subject: "s", text: "t" } });
    const result = await postSendMailRoute.callback(req, makeRes(), noopStream);
    expect((result as ApiResponse<unknown>).status).toBe("failed");
    expect((result as ApiResponse<unknown>).message).toBe("send failed");
  });

  it("rethrows unknown errors", async () => {
    const { postSendMailRoute } = await import("./post-send");
    const unknownError = new Error("unexpected");
    mockSendMail.mockRejectedValueOnce(unknownError);
    const req = makeReq({ body: { to: "x@x.com", subject: "s", text: "t" } });
    await expect(postSendMailRoute.callback(req, makeRes(), noopStream)).rejects.toThrow("unexpected");
  });
});

// ── post-spam-mark route ──────────────────────────────────────────────────────

describe("postMarkSpamMailRoute", () => {
  beforeEach(() => mockMarkSpam.mockClear());

  it("rejects when is_spam is not boolean", async () => {
    const { postMarkSpamMailRoute } = await import("./post-spam-mark");
    const req = makeReq({ body: { mail_id: "m1", is_spam: "yes" } });
    const result = await postMarkSpamMailRoute.callback(req, makeRes(), noopStream);
    expect((result as ApiResponse<unknown>).status).toBe("failed");
    expect((result as ApiResponse<unknown>).message).toMatch(/boolean/i);
  });

  it("returns failed when mail not found or no permission", async () => {
    const { postMarkSpamMailRoute } = await import("./post-spam-mark");
    mockMarkSpam.mockResolvedValueOnce(null);
    const req = makeReq({ body: { mail_id: "m1", is_spam: true } });
    const result = await postMarkSpamMailRoute.callback(req, makeRes(), noopStream);
    expect((result as ApiResponse<unknown>).status).toBe("failed");
    expect((result as ApiResponse<unknown>).message).toMatch(/not found/i);
  });

  it("returns success when spam marked", async () => {
    const { postMarkSpamMailRoute } = await import("./post-spam-mark");
    mockMarkSpam.mockResolvedValueOnce({ id: "m1" });
    const req = makeReq({ body: { mail_id: "m1", is_spam: true } });
    const result = await postMarkSpamMailRoute.callback(req, makeRes(), noopStream);
    expect((result as ApiResponse<unknown>).status).toBe("success");
  });

  it("returns success when spam unmarked (is_spam false)", async () => {
    const { postMarkSpamMailRoute } = await import("./post-spam-mark");
    mockMarkSpam.mockResolvedValueOnce({ id: "m1" });
    const req = makeReq({ body: { mail_id: "m1", is_spam: false } });
    const result = await postMarkSpamMailRoute.callback(req, makeRes(), noopStream);
    expect((result as ApiResponse<unknown>).status).toBe("success");
  });
});

// ── get-attachment route ──────────────────────────────────────────────────────

describe("getAttachmentRoute", () => {
  beforeEach(() => {
    mockMailsTableQueryOne.mockClear();
    mockGetAttachment.mockClear();
  });

  it("returns failed with auth error when no session user", async () => {
    const { getAttachmentRoute } = await import("./get-attachment");
    const req = makeReq({ session: { user: undefined } });
    const result = await getAttachmentRoute.callback(req, makeRes(), noopStream);
    expect((result as ApiResponse<unknown>).status).toBe("failed");
    expect((result as ApiResponse<unknown>).message).toBe(AUTH_ERROR_MESSAGE);
  });

  it("returns failed when mail not found (IDOR protection)", async () => {
    const { getAttachmentRoute } = await import("./get-attachment");
    mockMailsTableQueryOne.mockResolvedValueOnce(null);
    const req = makeReq({ params: { id: "att1" } });
    const result = await getAttachmentRoute.callback(req, makeRes(), noopStream);
    expect((result as ApiResponse<unknown>).status).toBe("failed");
    expect((result as ApiResponse<unknown>).message).toBe("Not found");
  });

  it("returns failed when attachment file missing from disk", async () => {
    const { getAttachmentRoute } = await import("./get-attachment");
    mockMailsTableQueryOne.mockResolvedValueOnce({ id: "m1" });
    mockGetAttachment.mockReturnValueOnce(undefined);
    const req = makeReq({ params: { id: "att1" } });
    const result = await getAttachmentRoute.callback(req, makeRes(), noopStream);
    expect((result as ApiResponse<unknown>).status).toBe("failed");
  });

  it("returns attachment buffer when found", async () => {
    const { getAttachmentRoute } = await import("./get-attachment");
    const fakeBuffer = Buffer.from("file content");
    mockMailsTableQueryOne.mockResolvedValueOnce({ id: "m1" });
    mockGetAttachment.mockReturnValueOnce(fakeBuffer);
    const req = makeReq({ params: { id: "att1" } });
    const result = await getAttachmentRoute.callback(req, makeRes(), noopStream);
    expect(result).toBe(fakeBuffer);
  });
});
