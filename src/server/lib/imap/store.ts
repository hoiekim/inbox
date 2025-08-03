import { Mail, SignedUser } from "common";

// class that creates "store" object
export class Store {
  constructor(private user: SignedUser) {}

  listMailboxes = async (): Promise<string[]> => {
    return []; // This should return the actual mailboxes for the user
  };

  countMessages = async (box: string): Promise<number | null> => {
    return 0; // This should return the count of messages in the specified mailbox
  };

  getMessages = async (
    box: string,
    start: number,
    end: number,
    fields: string[]
  ): Promise<Mail[]> => {
    return []; // This should return the messages in the specified range with requested fields
  };

  setFlags = async (
    box: string,
    index: number,
    flags: string[]
  ): Promise<void> => {
    return; // This should set the flags for the specified message
  };

  copyMessage = async (
    fromBox: string,
    toBox: string,
    index: number
  ): Promise<void> => {
    return; // This should copy the message from one mailbox to another
  };

  expunge = async (box: string): Promise<void> => {
    return; // This should remove deleted messages from the specified mailbox
  };

  search = async (box: string, criteria: string[]): Promise<Mail[]> => {
    return []; // This should return messages matching the search criteria
  };
}
