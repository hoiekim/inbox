import { describe, it, expect } from "bun:test";
import { Account } from "common";
import { mergeSavedAccounts } from "./savedAccounts";

const makeAccount = (
  key: string,
  saved_doc_count: number,
  doc_count = saved_doc_count
) =>
  new Account({
    key,
    updated: new Date("2026-01-01"),
    doc_count,
    unread_doc_count: 0,
    saved_doc_count
  });

describe("mergeSavedAccounts", () => {
  it("includes received accounts that have starred mails", () => {
    const received = [makeAccount("a@x.com", 2), makeAccount("b@x.com", 0)];
    const result = mergeSavedAccounts(received, []);
    expect(result.map((e) => e.key)).toEqual(["a@x.com"]);
  });

  it("includes sent accounts that have starred mails (regression for #568)", () => {
    // A starred *sent* mail's account lives only in `sent`; before the fix
    // the Saved view filtered `received` only, so it was unreachable.
    const sent = [makeAccount("me@x.com", 1)];
    const result = mergeSavedAccounts([], sent);
    expect(result.map((e) => e.key)).toEqual(["me@x.com"]);
    expect(result[0].saved_doc_count).toBe(1);
  });

  it("merges an account present in both folders into one entry with summed counts", () => {
    const received = [makeAccount("me@x.com", 2, 5)];
    const sent = [makeAccount("me@x.com", 3, 4)];
    const result = mergeSavedAccounts(received, sent);
    expect(result).toHaveLength(1);
    expect(result[0].key).toBe("me@x.com");
    expect(result[0].saved_doc_count).toBe(5);
    expect(result[0].doc_count).toBe(9);
  });

  it("excludes accounts with no starred mails from either folder", () => {
    const received = [makeAccount("a@x.com", 0)];
    const sent = [makeAccount("b@x.com", 0)];
    expect(mergeSavedAccounts(received, sent)).toEqual([]);
  });

  it("does not mutate the source account objects", () => {
    const shared = makeAccount("me@x.com", 2, 5);
    const sent = [makeAccount("me@x.com", 3, 4)];
    mergeSavedAccounts([shared], sent);
    expect(shared.saved_doc_count).toBe(2);
    expect(shared.doc_count).toBe(5);
  });
});
