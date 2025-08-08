/**
 * IDLE Manager - Handles IMAP IDLE sessions and real-time notifications
 */

import { ImapSession } from "./session";

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
  addIdleSession(sessionId: string, session: ImapSession, tag: string, mailbox: string, username: string) {
    const idleSession: IdleSession = {
      session,
      tag,
      mailbox,
      username,
      startTime: new Date()
    };

    this.idleSessions.set(sessionId, idleSession);
    console.log(`IDLE session started for ${username} on ${mailbox}`);
  }

  /**
   * Remove a session from IDLE
   */
  removeIdleSession(sessionId: string) {
    const idleSession = this.idleSessions.get(sessionId);
    if (idleSession) {
      this.idleSessions.delete(sessionId);
      console.log(`IDLE session ended for ${idleSession.username} on ${idleSession.mailbox}`);
    }
  }

  /**
   * Notify all IDLE sessions for specific users about new mail
   */
  notifyNewMail(usernames: string[]) {
    const usernameSet = new Set(usernames);
    
    for (const [sessionId, idleSession] of this.idleSessions) {
      if (usernameSet.has(idleSession.username)) {
        try {
          // Send EXISTS notification (new message count)
          // In a real implementation, you'd query the actual count
          idleSession.session.write("* 1 EXISTS\r\n");
          idleSession.session.write("* 1 RECENT\r\n");
          
          console.log(`Notified IDLE session for ${idleSession.username} about new mail`);
        } catch (error) {
          console.error(`Error notifying IDLE session ${sessionId}:`, error);
          // Remove broken session
          this.removeIdleSession(sessionId);
        }
      }
    }
  }

  /**
   * Send heartbeat to all IDLE sessions to keep connections alive
   */
  private startHeartbeat() {
    // Send heartbeat every 29 minutes (IMAP standard allows 30 min timeout)
    this.heartbeatInterval = setInterval(() => {
      const now = new Date();
      
      for (const [sessionId, idleSession] of this.idleSessions) {
        try {
          // Send a comment as heartbeat (RFC 3501 allows this)
          idleSession.session.write("* OK Still here\r\n");
          
          // Remove sessions older than 25 minutes to prevent timeout
          const sessionAge = now.getTime() - idleSession.startTime.getTime();
          if (sessionAge > 25 * 60 * 1000) {
            idleSession.session.write(`${idleSession.tag} OK IDLE terminated (timeout)\r\n`);
            this.removeIdleSession(sessionId);
          }
        } catch (error) {
          console.error(`Error sending heartbeat to session ${sessionId}:`, error);
          this.removeIdleSession(sessionId);
        }
      }
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
      session => session.username === username
    );
  }

  /**
   * Cleanup on shutdown
   */
  shutdown() {
    if (this.heartbeatInterval) {
      clearInterval(this.heartbeatInterval);
    }
    
    // Notify all sessions that server is shutting down
    for (const [sessionId, idleSession] of this.idleSessions) {
      try {
        idleSession.session.write("* BYE Server shutting down\r\n");
      } catch (error) {
        // Ignore errors during shutdown
      }
    }
    
    this.idleSessions.clear();
  }
}

// Singleton instance
export const idleManager = new IdleManager();
