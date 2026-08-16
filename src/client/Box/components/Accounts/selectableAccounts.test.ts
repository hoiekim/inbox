import { describe, it, expect } from "bun:test";
import { Account } from "common";
import { isSelectableAccount } from "./selectableAccounts";

const makeAccount = (key: string) =>
  new Account({
    key,
    updated: new Date("2026-01-01"),
    doc_count: 1,
    unread_doc_count: 0,
    saved_doc_count: 0
  });

const received = [makeAccount("a@x.com"), makeAccount("b@x.com")];
const sent = [makeAccount("sender@x.com")];
const spam = [makeAccount("spammy@x.com")];

describe("isSelectableAccount", () => {
  it("accepts a received account", () => {
    expect(isSelectableAccount("a@x.com", { received, sent, spam })).toBe(true);
  });

  it("accepts a sent-only account", () => {
    expect(isSelectableAccount("sender@x.com", { received, sent, spam })).toBe(
      true
    );
  });

  it("accepts a spam account", () => {
    expect(isSelectableAccount("spammy@x.com", { received, sent, spam })).toBe(
      true
    );
  });

  it("rejects a search term left in the selectedAccount slot", () => {
    expect(isSelectableAccount("invoice", { received, sent, spam })).toBe(false);
  });

  it("rejects an account the server no longer returns", () => {
    expect(isSelectableAccount("deleted@x.com", { received, sent, spam })).toBe(
      false
    );
  });

  it("rejects everything when the server returned no accounts", () => {
    expect(isSelectableAccount("a@x.com", {})).toBe(false);
  });

  it("matches the key exactly, not by prefix", () => {
    expect(isSelectableAccount("a@x.co", { received, sent, spam })).toBe(false);
    expect(isSelectableAccount("a@x.com.evil", { received, sent, spam })).toBe(
      false
    );
  });
});
