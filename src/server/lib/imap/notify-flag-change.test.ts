import { describe, it, expect } from "bun:test";
import { ImapSession } from "./session";
import type { Store } from "./store";
import type { SequenceState } from "./sequence-resolver";
import type { MailFlagUpdate } from "../postgres/repositories/mails";

const seqStateFor = (uids: number[]): SequenceState => ({
  seqToUid: [...uids],
  uidToSeq: new Map(uids.map((uid, index) => [uid, index + 1])),
});

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const update = (uid: number, flags: Partial<MailFlagUpdate> = {}): MailFlagUpdate => ({
  mail_id: `mail-${uid}`,
  uid,
  read: false,
  saved: false,
  deleted: false,
  draft: false,
  answered: false,
  ...flags,
});

const makeSession = (
  advertised: number[],
  getMailFlagUpdates: (box: string, mailIds: string[]) => Promise<MailFlagUpdate[] | null>,
  opts: { isIdling?: boolean } = {}
) => {
  const writes: string[] = [];
  const socket = {
    destroyed: false,
    writable: true,
    write: (data: string) => {
      writes.push(data);
      return true;
    },
    setTimeout: () => {},
  };
  const session = new ImapSession({ isTls: false } as never, socket as never);
  Object.assign(session as unknown as Record<string, unknown>, {
    store: { getMailFlagUpdates } as unknown as Store,
    selectedMailbox: "INBOX",
    seqState: seqStateFor(advertised),
    isIdling: opts.isIdling ?? true,
    idleTag: "A1",
  });
  return { session, writes, wire: () => writes.join("") };
};

describe("ImapSession.notifyFlagChange", () => {
  it("emits untagged FETCH (FLAGS) with sequence numbers, not UIDs", async () => {
    const { session, wire } = makeSession([10, 20, 30], async () => [
      update(10, { read: true }),
      update(30, { read: true, saved: true }),
    ]);

    await session.notifyFlagChange(["mail-10", "mail-30"]);

    expect(wire()).toBe(
      "* 1 FETCH (FLAGS (\\Seen))\r\n* 3 FETCH (FLAGS (\\Seen \\Flagged))\r\n"
    );
  });

  it("skips updates for mails outside the session's current view", async () => {
    const { session, wire } = makeSession([10, 20], async () => [
      update(10, { read: true }),
      update(99, { read: true }),
    ]);

    await session.notifyFlagChange(["mail-10", "mail-99"]);

    expect(wire()).toBe("* 1 FETCH (FLAGS (\\Seen))\r\n");
  });

  it("writes nothing when the session is not idling", async () => {
    const { session, writes } = makeSession(
      [10],
      async () => [update(10, { read: true })],
      { isIdling: false }
    );

    await session.notifyFlagChange(["mail-10"]);

    expect(writes).toEqual([]);
  });

  it("writes nothing when the flag read fails", async () => {
    const { session, writes } = makeSession([10], async () => null);

    await session.notifyFlagChange(["mail-10"]);

    expect(writes).toEqual([]);
  });

  it("serializes concurrent notifications so FETCH lines never interleave", async () => {
    const { session, wire } = makeSession([10, 20], async () => {
      await delay(10);
      return [update(10, { read: true }), update(20, { read: true })];
    });

    await Promise.all([
      session.notifyFlagChange(["mail-10", "mail-20"]),
      session.notifyFlagChange(["mail-10", "mail-20"]),
    ]);

    expect(wire()).toBe(
      "* 1 FETCH (FLAGS (\\Seen))\r\n" +
        "* 2 FETCH (FLAGS (\\Seen))\r\n" +
        "* 1 FETCH (FLAGS (\\Seen))\r\n" +
        "* 2 FETCH (FLAGS (\\Seen))\r\n"
    );
  });
});
