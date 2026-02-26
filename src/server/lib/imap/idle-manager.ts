/**
 * IDLE Manager - Handles IMAP IDLE sessions and real-time notifications
 */

import { ImapSession } from "./session";
import { logger } from "../logger";

interface IdleSession {
  session: ImapSession;
  tag: string;
  mailbox: string;
  username: string;
  startTime: Date;
}

class IdleManager {
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
   * Notify all IDLE sessions for specific users about new mail
   */
  notifyNewMail(usernames: string[]) {
    const usernameSet = new Set(usernames);

    this.idleSessions.forEach((idleSession, sessionId) => {
      if (usernameSet.has(idleSession.username)) {
        try {
          // Send EXISTS notification (new message count)
          // In a real implementation, you'd query the actual count
          idleSession.session.write("* 1 EXISTS\r\n");
          idleSession.session.write("* 1 RECENT\r\n");

          logger.debug("Notified IDLE session about new mail", {
            component: "imap.idle",
            username: idleSession.username
          });
        } catch (error) {
          logger.error("Error notifying IDLE session", { component: "imap.idle", sessionId }, error);
          // Remove broken session
          this.removeIdleSession(sessionId);
        }
      }
    });
  }

  /**
   * Send heartbeat to all IDLE sessions to keep connections alive
   */
  private startHeartbeat() {
    // Send heartbeat every 29 minutes (IMAP standard allows 30 min timeout)
    this.heartbeatInterval = setInterval(() => {
      const now = new Date();

      this.idleSessions.forEach((idleSession, sessionId) => {
        try {
          // Send a comment as heartbeat (RFC 3501 allows this)
          idleSession.session.write("* OK Still here\r\n");

          // Remove sessions older than 25 minutes to prevent timeout
          const sessionAge = now.getTime() - idleSession.startTime.getTime();
          if (sessionAge > 25 * 60 * 1000) {
            idleSession.session.write(
              `${idleSession.tag} OK IDLE terminated (timeout)\r\n`
            );
            this.removeIdleSession(sessionId);
          }
        } catch (error) {
          logger.error("Error sending heartbeat to session", { component: "imap.idle", sessionId }, error);
          this.removeIdleSession(sessionId);
        }
      });
    }, 29 * 60 * 1000); // 29 minutes
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
