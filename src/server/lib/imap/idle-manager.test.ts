/**
 * Tests for idle-manager.ts.
 *
 * Suite 1 — IdleManager.notifyNewMail mailbox filtering. Regression coverage for
 * #549: PR #373 added a per-mailbox filter so an IDLE session is only notified
 * when it watches one of the target mailboxes (with an INBOX catch-all). PR
 * #331's async refactor constructed `mailboxSet` but never consulted it, so
 * every session for the user got EXISTS regardless of mailbox.
 *
 * Suite 2 — heartbeat sweep, covers #547:
 *   Bug 1: a timed-out session must be terminated through session.endIdle(), not
 *          by dropping the manager record alone (which leaves isIdling true,
 *          silently swallowing later commands).
 *   Bug 2: the sweep interval must stay below the timeout, or the first tick
 *          terminates every session before any keepalive helps.
 */

import { describe, it, expect, mock, beforeEach, afterAll } from "bun:test";
// idle-manager ↔ push ↔ server-barrel form a runtime import cycle: idle-manager
// imports the `server` barrel (for `logger`), which re-exports push.ts, whose
// top-level `createPush(realIdleManager)` needs the idleManager singleton. When
// idle-manager is the test entry the barrel reaches push before the singleton is
// constructed. Importing push first forces the graph to initialize in the order
// the production server uses, so the singleton is ready.
import "../push";
import {
  idleManager,
  IdleManager,
  IDLE_HEARTBEAT_INTERVAL_MS,
  IDLE_TIMEOUT_MS,
} from "./idle-manager";
import type { ImapSession } from "./session";

const makeSession = () => {
  const write = mock(() => {});
  const countMailboxMessages = mock(() =>
    Promise.resolve({ total: 3, unread: 1, maxUid: 3 })
  );
  const session = { write, countMailboxMessages } as unknown as ImapSession;
  return { session, write, countMailboxMessages };
};

describe("IdleManager.notifyNewMail mailbox filtering", () => {
  let inbox: ReturnType<typeof makeSession>;
  let usps: ReturnType<typeof makeSession>;
  let drafts: ReturnType<typeof makeSession>;

  beforeEach(() => {
    // shutdown() clears any sessions a prior test registered on the singleton.
    idleManager.shutdown();
    inbox = makeSession();
    usps = makeSession();
    drafts = makeSession();
    idleManager.addIdleSession("s-inbox", inbox.session, "t1", "INBOX", "alice");
    idleManager.addIdleSession("s-usps", usps.session, "t2", "usps@hoie.kim", "alice");
    idleManager.addIdleSession("s-drafts", drafts.session, "t3", "Drafts", "alice");
  });

  afterAll(() => {
    idleManager.shutdown();
  });

  it("notifies only the matching mailbox and the INBOX catch-all", async () => {
    await idleManager.notifyNewMail(["alice"], ["usps@hoie.kim"]);

    // INBOX is the aggregate view — always notified.
    expect(inbox.countMailboxMessages).toHaveBeenCalledTimes(1);
    expect(inbox.write).toHaveBeenCalled();
    // The targeted per-account mailbox is notified.
    expect(usps.countMailboxMessages).toHaveBeenCalledTimes(1);
    expect(usps.write).toHaveBeenCalled();
    // A session watching an unrelated mailbox is NOT notified.
    expect(drafts.countMailboxMessages).not.toHaveBeenCalled();
    expect(drafts.write).not.toHaveBeenCalled();
  });

  it("notifies every session for the user when no mailbox filter is given", async () => {
    await idleManager.notifyNewMail(["alice"]);

    expect(inbox.write).toHaveBeenCalled();
    expect(usps.write).toHaveBeenCalled();
    expect(drafts.write).toHaveBeenCalled();
  });

  it("does not notify sessions belonging to a different user", async () => {
    const bob = makeSession();
    idleManager.addIdleSession("s-bob", bob.session, "t4", "INBOX", "bob");

    await idleManager.notifyNewMail(["alice"], ["usps@hoie.kim"]);

    expect(bob.write).not.toHaveBeenCalled();
  });
});

// Minimal stand-in for ImapSession. endIdle mirrors the real method's contract:
// it drops the manager record (the real session calls idleManager.removeIdleSession).
function makeFakeSession(manager: IdleManager, sessionId: string) {
  const writes: string[] = [];
  const endIdleCalls: (string | undefined)[] = [];
  const session = {
    write: (data: string) => {
      writes.push(data);
      return true;
    },
    endIdle: (reason?: string) => {
      endIdleCalls.push(reason);
      manager.removeIdleSession(sessionId);
    },
  };
  return { session: session as unknown as ImapSession, writes, endIdleCalls };
}

describe("idle-manager timing constants (#547 bug 2)", () => {
  it("sweeps several times before the timeout cutoff", () => {
    expect(IDLE_HEARTBEAT_INTERVAL_MS).toBeLessThan(IDLE_TIMEOUT_MS);
    // Want multiple keepalives in the window, not exactly one before death.
    expect(IDLE_TIMEOUT_MS / IDLE_HEARTBEAT_INTERVAL_MS).toBeGreaterThanOrEqual(3);
  });
});

describe("idle-manager heartbeatTick (#547 bug 1)", () => {
  it("keeps a young session alive without ending IDLE", () => {
    const manager = new IdleManager();
    const fake = makeFakeSession(manager, "young");
    manager.addIdleSession("young", fake.session, "a1", "INBOX", "admin");

    // 1 minute in — well under the timeout.
    manager.heartbeatTick(new Date(Date.now() + 60 * 1000));

    expect(fake.writes).toContain("* OK Still here\r\n");
    expect(fake.endIdleCalls).toHaveLength(0);
    expect(manager.getActiveSessionCount()).toBe(1);
    manager.shutdown();
  });

  it("terminates a timed-out session through endIdle, dropping the record", () => {
    const manager = new IdleManager();
    const fake = makeFakeSession(manager, "old");
    // startTime is "now"; advance the tick past the cutoff.
    manager.addIdleSession("old", fake.session, "a1", "INBOX", "admin");

    manager.heartbeatTick(new Date(Date.now() + IDLE_TIMEOUT_MS + 1000));

    expect(fake.endIdleCalls).toEqual(["timeout"]);
    // No wasted keepalive on the terminating tick.
    expect(fake.writes).not.toContain("* OK Still here\r\n");
    expect(manager.getActiveSessionCount()).toBe(0);
    manager.shutdown();
  });
});
