import { describe, it, expect, mock, beforeEach } from "bun:test";
import type { ApiResponse } from "../route";

// ── Mocks ─────────────────────────────────────────────────────────────────────

const mockGetPushPublicKey = mock(() => "test-vapid-public-key");
const mockStoreSubscription = mock(async () => null as unknown);
const mockRefreshSubscription = mock(async () => null as unknown);

// Include base set of server exports so this mock doesn't break test files
// that run after this one (Bun's mock.module is global within a coverage run).
mock.module("server", () => ({
  getPushPublicKey: mockGetPushPublicKey,
  storeSubscription: mockStoreSubscription,
  refreshSubscription: mockRefreshSubscription,
  // Base exports needed by users/mails test files
  getUser: mock(async () => null),
  setUserInfo: mock(async () => null),
  isValidEmail: mock(() => true),
  createToken: mock(async () => ({ id: "u1", username: "u", token: "tok" })),
  getSignedUser: mock(() => null),
  createAuthenticationMail: mock(() => ({})),
  sendMail: mock(async () => {}),
  startTimer: mock(() => {}),
  version: "0.0.0",
  getMailHeaders: mock(async () => []),
  getAccounts: mock(async () => ({ received: [], sent: [] })),
  getMailBody: mock(async () => null),
  deleteMail: mock(async () => {}),
  markRead: mock(async () => {}),
  markSaved: mock(async () => {}),
  decrementBadgeCount: mock(async () => {}),
  addressToUsername: mock((addr: string) => addr.split("@")[0]),
  searchMail: mock(async () => []),
  getSpamHeaders: mock(async () => []),
  getDomain: mock(() => "example.com"),
  getAllowlistForUser: mock(async () => []),
  addAllowlistEntry: mock(async () => null),
  removeAllowlistEntry: mock(async () => false),
  markSpam: mock(async () => false),
  getAttachment: mock(() => undefined),
  AUTH_ERROR_MESSAGE: "Authentication required",
  MailValidationError: class extends Error {},
  MailSendingError: class extends Error {},
  mailsTable: { queryOne: mock(async () => null) },
  SpamAllowlistModel: class {},
  logger: { error: mock(() => {}), info: mock(() => {}), warn: mock(() => {}) },
}));

// ── Helpers ───────────────────────────────────────────────────────────────────

const makeReq = (overrides: Record<string, unknown> = {}) =>
  ({
    session: { user: { id: "u1", username: "alice" } },
    params: {},
    body: {},
    ...overrides,
  }) as unknown as import("express").Request;

const makeRes = () => {
  const res: Record<string, unknown> = { _code: 200, _body: undefined };
  res.status = mock((code: number) => { res._code = code; return res; });
  res.json = mock((body: unknown) => { res._body = body; return res; });
  res.end = mock(() => res);
  return res as unknown as import("express").Response & { _code: number; _body: unknown };
};

const noopStream = mock(() => {}) as unknown as import("../route").Stream<unknown>;

// ── get-public-key ────────────────────────────────────────────────────────────

describe("getPublicKeyRoute", () => {
  beforeEach(() => mockGetPushPublicKey.mockClear());

  it("returns the VAPID public key", async () => {
    const { getPublicKeyRoute } = await import("./get-public-key");
    const result = await getPublicKeyRoute.callback(makeReq(), makeRes(), noopStream);
    expect((result as ApiResponse<unknown>).status).toBe("success");
    expect((result as ApiResponse<unknown>).body).toBe("test-vapid-public-key");
    expect(mockGetPushPublicKey).toHaveBeenCalledTimes(1);
  });
});

// ── get-refresh ───────────────────────────────────────────────────────────────

describe("getRefreshRoute", () => {
  beforeEach(() => mockRefreshSubscription.mockClear());

  it("returns success when subscription is found", async () => {
    const { getRefreshRoute } = await import("./get-refresh");
    mockRefreshSubscription.mockResolvedValueOnce({ _id: "sub1" });
    const req = makeReq({ params: { id: "sub1" } });
    const result = await getRefreshRoute.callback(req, makeRes(), noopStream);
    expect((result as ApiResponse<unknown>).status).toBe("success");
  });

  it("returns failed when subscription is not found", async () => {
    const { getRefreshRoute } = await import("./get-refresh");
    mockRefreshSubscription.mockResolvedValueOnce(null);
    const req = makeReq({ params: { id: "nonexistent" } });
    const result = await getRefreshRoute.callback(req, makeRes(), noopStream);
    expect((result as ApiResponse<unknown>).status).toBe("failed");
    expect((result as ApiResponse<unknown>).message).toMatch(/No subscription found/i);
  });
});

// ── post-subscribe ────────────────────────────────────────────────────────────

describe("postSubscribeRoute", () => {
  beforeEach(() => mockStoreSubscription.mockClear());

  it("returns success with subscription id when stored", async () => {
    const { postSubscribeRoute } = await import("./post-subscribe");
    const fakeSub = { endpoint: "https://fcm.example.com", keys: { p256dh: "abc", auth: "xyz" } };
    mockStoreSubscription.mockResolvedValueOnce({ _id: "sub42" });
    const req = makeReq({ body: { subscription: fakeSub } });
    const result = await postSubscribeRoute.callback(req, makeRes(), noopStream);
    expect((result as ApiResponse<unknown>).status).toBe("success");
    expect((result as ApiResponse<unknown>).body).toBe("sub42");
    expect(mockStoreSubscription).toHaveBeenCalledWith("u1", fakeSub);
  });

  it("returns failed when store returns null", async () => {
    const { postSubscribeRoute } = await import("./post-subscribe");
    const fakeSub = { endpoint: "https://fcm.example.com", keys: { p256dh: "abc", auth: "xyz" } };
    mockStoreSubscription.mockResolvedValueOnce(null);
    const req = makeReq({ body: { subscription: fakeSub } });
    const result = await postSubscribeRoute.callback(req, makeRes(), noopStream);
    expect((result as ApiResponse<unknown>).status).toBe("failed");
    expect((result as ApiResponse<unknown>).message).toMatch(/Failed to store subscription/i);
  });
});
