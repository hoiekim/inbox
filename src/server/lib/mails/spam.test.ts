import { describe, it, expect, mock, beforeEach } from "bun:test";

const mockMarkMailSpam = mock(() =>
  Promise.resolve({ found: true, changed: true })
);

mock.module("../postgres/repositories/mails", () => ({
  markMailSpam: mockMarkMailSpam,
}));

import { markSpam } from "./spam";

describe("markSpam", () => {
  beforeEach(() => {
    mockMarkMailSpam.mockClear();
  });

  it("should call markMailSpam with correct args when marking as spam", async () => {
    await markSpam("user-123", "mail-abc", true);
    expect(mockMarkMailSpam).toHaveBeenCalledWith("user-123", "mail-abc", true);
  });

  it("should call markMailSpam with correct args when unmarking spam", async () => {
    await markSpam("user-123", "mail-abc", false);
    expect(mockMarkMailSpam).toHaveBeenCalledWith("user-123", "mail-abc", false);
  });

  it("returns found+changed when the row's is_spam actually flipped", async () => {
    mockMarkMailSpam.mockResolvedValue({ found: true, changed: true });
    const result = await markSpam("user-123", "mail-abc", true);
    expect(result).toEqual({ found: true, changed: true });
  });

  it("returns found-without-change for an idempotent re-mark", async () => {
    mockMarkMailSpam.mockResolvedValue({ found: true, changed: false });
    const result = await markSpam("user-123", "mail-abc", true);
    expect(result).toEqual({ found: true, changed: false });
  });

  it("returns not-found when the (user, mail) pair does not exist", async () => {
    mockMarkMailSpam.mockResolvedValue({ found: false, changed: false });
    const result = await markSpam("user-123", "mail-abc", true);
    expect(result).toEqual({ found: false, changed: false });
  });

  it("should propagate errors from markMailSpam", async () => {
    mockMarkMailSpam.mockRejectedValue(new Error("DB error"));
    await expect(markSpam("user-123", "mail-abc", true)).rejects.toThrow("DB error");
  });
});
