import { describe, it, expect, mock, beforeEach } from "bun:test";

const mockMarkMailRead = mock(() => Promise.resolve(true));
const mockMarkMailSaved = mock(() => Promise.resolve(true));
const mockDeleteMail = mock(() => Promise.resolve(true));

mock.module("../postgres/repositories/mails", () => ({
  markMailRead: mockMarkMailRead,
  markMailSaved: mockMarkMailSaved,
  deleteMail: mockDeleteMail,
}));

import { markRead, markSaved, deleteMail } from "./update";

describe("markRead", () => {
  beforeEach(() => {
    mockMarkMailRead.mockReset();
    mockMarkMailRead.mockResolvedValue(true);
  });

  it("should call markMailRead with correct args", async () => {
    await markRead("user-123", "mail-abc");
    expect(mockMarkMailRead).toHaveBeenCalledWith("user-123", "mail-abc");
  });

  it("should return the result from markMailRead", async () => {
    mockMarkMailRead.mockResolvedValue(true);
    const result = await markRead("user-123", "mail-abc");
    expect(result).toBe(true);
  });

  it("should propagate errors from markMailRead", async () => {
    mockMarkMailRead.mockRejectedValue(new Error("DB error"));
    await expect(markRead("user-123", "mail-abc")).rejects.toThrow("DB error");
  });

  it("should call markMailRead once per invocation", async () => {
    await markRead("user-1", "mail-1");
    await markRead("user-2", "mail-2");
    expect(mockMarkMailRead).toHaveBeenCalledTimes(2);
  });
});

describe("markSaved", () => {
  beforeEach(() => {
    mockMarkMailSaved.mockReset();
    mockMarkMailSaved.mockResolvedValue(true);
  });

  it("should call markMailSaved with correct args when saving", async () => {
    await markSaved("user-123", "mail-abc", true);
    expect(mockMarkMailSaved).toHaveBeenCalledWith("user-123", "mail-abc", true);
  });

  it("should call markMailSaved with correct args when unsaving", async () => {
    await markSaved("user-123", "mail-abc", false);
    expect(mockMarkMailSaved).toHaveBeenCalledWith("user-123", "mail-abc", false);
  });

  it("should return the result from markMailSaved", async () => {
    mockMarkMailSaved.mockResolvedValue(true);
    const result = await markSaved("user-123", "mail-abc", true);
    expect(result).toBe(true);
  });

  it("should propagate errors from markMailSaved", async () => {
    mockMarkMailSaved.mockRejectedValue(new Error("DB error"));
    await expect(markSaved("user-123", "mail-abc", true)).rejects.toThrow("DB error");
  });
});

describe("deleteMail", () => {
  beforeEach(() => {
    mockDeleteMail.mockReset();
    mockDeleteMail.mockResolvedValue(true);
  });

  it("should call pgDeleteMail with correct args", async () => {
    await deleteMail("user-123", "mail-abc");
    expect(mockDeleteMail).toHaveBeenCalledWith("user-123", "mail-abc");
  });

  it("should return the result from pgDeleteMail", async () => {
    mockDeleteMail.mockResolvedValue(true);
    const result = await deleteMail("user-123", "mail-abc");
    expect(result).toBe(true);
  });

  it("should propagate errors from pgDeleteMail", async () => {
    mockDeleteMail.mockRejectedValue(new Error("Delete failed"));
    await expect(deleteMail("user-123", "mail-abc")).rejects.toThrow("Delete failed");
  });

  it("should call deleteMail once per invocation", async () => {
    await deleteMail("user-1", "mail-1");
    await deleteMail("user-2", "mail-2");
    expect(mockDeleteMail).toHaveBeenCalledTimes(2);
  });
});
