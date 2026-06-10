/**
 * IDLE Manager - Handles IMAP IDLE sessions and real-time notifications
 */

import type { ImapSession } from "./session";
import { logger } from "server";

interface IdleSession {
  session: ImapSession;
  tag: string;
  mailbox: string;
  username: string;
  startTime: Date;
}

// The sweep interval must stay well below the timeout so the keepalive runs
// several times before a session is force-terminated.
export const IDLE_HEARTBEAT_INTERVAL_MS = 5 * 60 * 1000;
export const IDLE_TIMEOUT_MS = 25 * 60 * 1000;

export class IdleManager {
  private idleSessions: Map<string, IdleSession> = new Map();
  private heartbeatInterval: NodeJS.Timeout | null = null;

  constructor() {
    this.startHeartbeat();
  }

  /**
   * Register a session for IDLE
   */
  addIdleSession(
    sessionId: string,
    session: ImapSession,
    tag: string,
    mailbox: string,
    username: string
  ) {
    const idleSession: IdleSession = {
      session,
      tag,
      mailbox,
      username,
      startTime: new Date()
    };

    this.idleSessions.set(sessionId, idleSession);
    logger.debug("IDLE session started", { component: "imap.idle", username, mailbox });
  }

  /**
   * Remove a session from IDLE
   */
  removeIdleSession(sessionId: string) {
    const idleSession = this.idleSessions.get(sessionId);
    if (idleSession) {
      this.idleSessions.delete(sessionId);
      logger.debug("IDLE session ended", {
        component: "imap.idle",
        username: idleSession.username,
        mailbox: idleSession.mailbox
      });
    }
  }

  /**
   * Notify all IDLE sessions for specific users about new mail.
   * Queries the actual mailbox message count before sending EXISTS per RFC 3501 §7.3.1.
   */
  async notifyNewMail(usernames: string[], mailboxes?: string[]) {
    const usernameSet = new Set(usernames);
    const mailboxSet = mailboxes ? new Set(mailboxes) : null;

    const notifications: Array<{ sessionId: string; idleSession: IdleSession }> = [];
    this.idleSessions.forEach((idleSession, sessionId) => {
      if (!usernameSet.has(idleSession.username)) return;
      if (mailboxSet !== null) {
        const watching = idleSession.mailbox;
        // INBOX is the aggregate view showing every account's mail, so it is
        // always notified; other sessions only when watching a target mailbox.
        if (watching !== "INBOX" && !mailboxSet.has(watching)) return;
      }
      notifications.push({ sessionId, idleSession });
    });

    await Promise.all(
      notifications.map(async ({ sessionId, idleSession }) => {
        try {
          const counts = await idleSession.session.countMailboxMessages(idleSession.mailbox);
          const total = counts?.total ?? 1;

          idleSession.session.write(`* ${total} EXISTS\r\n`);
          idleSession.session.write(`* 0 RECENT\r\n`);

          logger.debug("Notified IDLE session about new mail", {
            component: "imap.idle",
            username: idleSession.username,
            mailbox: idleSession.mailbox,
            total,
          });
        } catch (error) {
          logger.error("Error notifying IDLE session", { component: "imap.idle", sessionId }, error);
          this.removeIdleSession(sessionId);
        }
      })
    );
  }

  /**
   * Send heartbeat to all IDLE sessions to keep connections alive
   */
  private startHeartbeat() {
    this.heartbeatInterval = setInterval(() => {
      this.heartbeatTick(new Date());
    }, IDLE_HEARTBEAT_INTERVAL_MS);
  }

  /**
   * One heartbeat sweep: keep young sessions alive, force-terminate sessions
   * past the timeout. Termination goes through `session.endIdle("timeout")` so
   * IDLE state (isIdling, the data listener, the manager record) is cleared in
   * one place — leaving the manager record alone would brick the connection
   * (RFC 3501: subsequent commands are dropped while isIdling stays true).
   */
  heartbeatTick(now: Date) {
    this.idleSessions.forEach((idleSession, sessionId) => {
      try {
        const sessionAge = now.getTime() - idleSession.startTime.getTime();
        if (sessionAge > IDLE_TIMEOUT_MS) {
          idleSession.session.endIdle("timeout");
        } else {
          // Untagged keepalive is allowed mid-IDLE (RFC 3501 §7).
          idleSession.session.write("* OK Still here\r\n");
        }
      } catch (error) {
        logger.error("Error sending heartbeat to session", { component: "imap.idle", sessionId }, error);
        this.removeIdleSession(sessionId);
      }
    });
  }

  /**
   * Get count of active IDLE sessions
   */
  getActiveSessionCount(): number {
    return this.idleSessions.size;
  }

  /**
   * Get IDLE sessions for a specific user
   */
  getUserSessions(username: string): IdleSession[] {
    return Array.from(this.idleSessions.values()).filter(
      (session) => session.username === username
    );
  }

  /**
   * Cleanup on shutdown
   */
  shutdown() {
    if (this.heartbeatInterval) {
      clearInterval(this.heartbeatInterval);
    }

    this.idleSessions.forEach((idleSession, _) => {
      try {
        idleSession.session.write("* BYE Server shutting down\r\n");
      } catch {
        // Ignore errors during shutdown
      }
    });

    this.idleSessions.clear();
  }
}

// Singleton instance
export const idleManager = new IdleManager();
