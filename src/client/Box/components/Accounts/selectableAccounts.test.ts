import { describe, it, expect } from "bun:test";
import { Account } from "common";
import { Category } from "client";
import { accountsForCategory } from "./selectableAccounts";

const makeAccount = (key: string, unread = 0, saved = 0) =>
  new Account({
    key,
    updated: new Date("2026-01-01"),
    doc_count: 1,
    unread_doc_count: unread,
    saved_doc_count: saved
  });

const received = [
  makeAccount("read@x.com"),
  makeAccount("unread@x.com", 3),
  makeAccount("starred@x.com", 0, 2)
];
const sent = [makeAccount("sender@x.com")];
const spam = [makeAccount("spammy@x.com")];
const lists = { received, sent, spam };

const keys = (category: Category) =>
  accountsForCategory(category, lists).map((a) => a.key);

describe("accountsForCategory", () => {
  it("lists received accounts for All Mails", () => {
    expect(keys(Category.AllMails)).toEqual([
      "read@x.com",
      "unread@x.com",
      "starred@x.com"
    ]);
  });

  it("lists only accounts with unread mail for New Mails", () => {
    expect(keys(Category.NewMails)).toEqual(["unread@x.com"]);
  });

  it("lists only accounts with starred mail for Saved Mails", () => {
    expect(keys(Category.SavedMails)).toEqual(["starred@x.com"]);
  });

  it("lists sent accounts for Sent Mails", () => {
    expect(keys(Category.SentMails)).toEqual(["sender@x.com"]);
  });

  it("lists spam accounts for Spam Mails", () => {
    expect(keys(Category.SpamMails)).toEqual(["spammy@x.com"]);
  });

  // The regression that the union-wide predicate this replaced could not
  // catch: an address holding sent mail but no received mail is a valid
  // selection under Sent Mails and a phantom under All Mails (#786).
  it("does not list a sent-only account under All Mails", () => {
    expect(keys(Category.AllMails)).not.toContain("sender@x.com");
  });

  it("does not list a spam-only account under All Mails", () => {
    expect(keys(Category.AllMails)).not.toContain("spammy@x.com");
  });

  it("does not list a received account under Sent Mails", () => {
    expect(keys(Category.SentMails)).not.toContain("read@x.com");
  });

  it("returns an empty list when the server returned no accounts", () => {
    expect(accountsForCategory(Category.AllMails, {})).toEqual([]);
    expect(accountsForCategory(Category.SentMails, {})).toEqual([]);
    expect(accountsForCategory(Category.SpamMails, {})).toEqual([]);
  });
});
