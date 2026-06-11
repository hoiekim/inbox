/**
 * Tests for idle-manager.ts — IdleManager.notifyNewMail mailbox filtering.
 *
 * Regression coverage for #549: PR #373 added a per-mailbox filter so an IDLE
 * session is only notified when it watches one of the target mailboxes (with an
 * INBOX catch-all). PR #331's async refactor constructed `mailboxSet` but never
 * consulted it, so every session for the user got EXISTS regardless of mailbox.
 */

import { describe, it, expect, mock, beforeEach, afterAll } from "bun:test";
// idle-manager ↔ push ↔ server-barrel form a runtime import cycle: idle-manager
// imports the `server` barrel (for `logger`), which re-exports push.ts, whose
// top-level `createPush(realIdleManager)` needs the idleManager singleton. When
// idle-manager is the test entry the barrel reaches push before the singleton is
// constructed. Importing push first forces the graph to initialize in the order
// the production server uses, so the singleton is ready.
import "../push";
import { idleManager } from "./idle-manager";
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
