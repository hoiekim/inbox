import { describe, it, expect } from "bun:test";
import { ImapSession } from "./session";
import type { Store } from "./store";
import type { SequenceState } from "./sequence-resolver";

const seqStateFor = (uids: number[]): SequenceState => ({
  seqToUid: [...uids],
  uidToSeq: new Map(uids.map((uid, index) => [uid, index + 1])),
});

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const makeSession = (
  advertised: number[],
  getAllUids: (box: string) => Promise<number[] | null>
) => {
  const writes: string[] = [];
  const socket = {
    destroyed: false,
    writable: true,
    write: (data: string) => {
      writes.push(data);
      return true;
    },
  };
  const session = new ImapSession({ isTls: false } as never, socket as never);
  Object.assign(session as unknown as Record<string, unknown>, {
    store: { getAllUids } as unknown as Store,
    selectedMailbox: "INBOX",
    seqState: seqStateFor(advertised),
  });
  return { session, writes, wire: () => writes.join("") };
};

describe("ImapSession.notifyMailboxUpdate", () => {
  it("announces departures highest-first, then the new count", async () => {
    const { session, wire } = makeSession([10, 20, 30, 40], async () => [10, 30]);

    expect(await session.notifyMailboxUpdate()).toBe(2);
    expect(wire()).toBe("* 4 EXPUNGE\r\n* 2 EXPUNGE\r\n* 2 EXISTS\r\n* 0 RECENT\r\n");
  });

  it("writes nothing when the mailbox cannot be read", async () => {
    const { session, writes } = makeSession([10, 20, 30], async () => null);

    expect(await session.notifyMailboxUpdate()).toBeNull();
    expect(writes).toEqual([]);
  });

  it("leaves the mapping alone when the mailbox cannot be read", async () => {
    const { session } = makeSession([10, 20, 30], async () => null);

    await session.notifyMailboxUpdate();

    const { seqState } = session as unknown as { seqState: SequenceState };
    expect(seqState.seqToUid).toEqual([10, 20, 30]);
    expect(seqState.uidToSeq.get(30)).toBe(3);
  });

  it("announces a departure once when two notifications overlap", async () => {
    const { session, wire } = makeSession([10, 20, 30], async () => {
      await delay(10);
      return [10, 30, 40];
    });

    await Promise.all([session.notifyMailboxUpdate(), session.notifyMailboxUpdate()]);

    expect(wire()).toBe(
      "* 2 EXPUNGE\r\n* 3 EXISTS\r\n* 0 RECENT\r\n* 3 EXISTS\r\n* 0 RECENT\r\n"
    );
  });

  it("does not splice its responses into a command already on the wire", async () => {
    const { session, wire } = makeSession([10, 20, 30], async () => {
      await delay(5);
      return [10, 30];
    });

    // Stand-in for a FETCH response written in pieces around an await, which
    // is where RFC 3501 §7.4.1 forbids an EXPUNGE from appearing.
    const command = session.runSerial(async () => {
      session.write("* 1 FETCH (BODY[] {4}\r\n");
      await delay(20);
      session.write("done)\r\n");
    });
    const notification = session.notifyMailboxUpdate();
    await Promise.all([command, notification]);

    expect(wire()).toBe(
      "* 1 FETCH (BODY[] {4}\r\ndone)\r\n* 2 EXPUNGE\r\n* 2 EXISTS\r\n* 0 RECENT\r\n"
    );
  });
});
