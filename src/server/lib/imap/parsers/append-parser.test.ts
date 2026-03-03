import { parseCommand } from './index';

describe('append-parser', () => {
  describe('parseAppend', () => {
    it('should parse APPEND with simple mailbox and message', () => {
      const message = 'From: test@example.com\r\nSubject: Test\r\n\r\nHello';
      const result = parseCommand(`A001 APPEND INBOX {${message.length}}\r\n${message}`);
      expect(result.success).toBe(true);
      expect(result.value?.tag).toBe('A001');
      expect(result.value?.request.type).toBe('APPEND');
      if (result.value?.request.type !== 'APPEND') {
        throw new Error('Expected APPEND request type');
      }
      expect(result.value.request.data.mailbox).toBe('INBOX');
      expect(result.value.request.data.message).toBe(message);
      expect(result.value.request.data.flags).toBeUndefined();
      expect(result.value.request.data.date).toBeUndefined();
    });

    it('should parse APPEND with quoted mailbox name', () => {
      const message = 'Hello';
      const result = parseCommand(`A001 APPEND "Sent Items" {${message.length}}\r\n${message}`);
      expect(result.success).toBe(true);
      expect(result.value?.request.type).toBe('APPEND');
      if (result.value?.request.type !== 'APPEND') {
        throw new Error('Expected APPEND request type');
      }
      expect(result.value.request.data.mailbox).toBe('Sent Items');
    });

    it('should parse APPEND with flags', () => {
      const message = 'Hello';
      const result = parseCommand(`A001 APPEND INBOX (\\Seen \\Flagged) {${message.length}}\r\n${message}`);
      expect(result.success).toBe(true);
      expect(result.value?.request.type).toBe('APPEND');
      if (result.value?.request.type !== 'APPEND') {
        throw new Error('Expected APPEND request type');
      }
      expect(result.value.request.data.flags).toEqual(['\\Seen', '\\Flagged']);
    });

    it('should parse APPEND with single flag', () => {
      const message = 'Hello';
      const result = parseCommand(`A001 APPEND INBOX (\\Draft) {${message.length}}\r\n${message}`);
      expect(result.success).toBe(true);
      expect(result.value?.request.type).toBe('APPEND');
      if (result.value?.request.type !== 'APPEND') {
        throw new Error('Expected APPEND request type');
      }
      expect(result.value.request.data.flags).toEqual(['\\Draft']);
    });

    it('should parse APPEND with date', () => {
      const message = 'Hello';
      const result = parseCommand(`A001 APPEND INBOX "25-Feb-2026 10:30:00 -0800" {${message.length}}\r\n${message}`);
      expect(result.success).toBe(true);
      expect(result.value?.request.type).toBe('APPEND');
      if (result.value?.request.type !== 'APPEND') {
        throw new Error('Expected APPEND request type');
      }
      expect(result.value.request.data.date).toBe('25-Feb-2026 10:30:00 -0800');
    });

    it('should parse APPEND with flags and date', () => {
      const message = 'Test message';
      const result = parseCommand(`A001 APPEND INBOX (\\Seen) "25-Feb-2026 10:30:00 -0800" {${message.length}}\r\n${message}`);
      expect(result.success).toBe(true);
      expect(result.value?.request.type).toBe('APPEND');
      if (result.value?.request.type !== 'APPEND') {
        throw new Error('Expected APPEND request type');
      }
      expect(result.value.request.data.flags).toEqual(['\\Seen']);
      expect(result.value.request.data.date).toBe('25-Feb-2026 10:30:00 -0800');
      expect(result.value.request.data.message).toBe(message);
    });

    it('should parse APPEND with multiple flags', () => {
      const message = 'Hello';
      const result = parseCommand(`A001 APPEND INBOX (\\Seen \\Answered \\Flagged \\Deleted) {${message.length}}\r\n${message}`);
      expect(result.success).toBe(true);
      expect(result.value?.request.type).toBe('APPEND');
      if (result.value?.request.type !== 'APPEND') {
        throw new Error('Expected APPEND request type');
      }
      expect(result.value.request.data.flags).toEqual(['\\Seen', '\\Answered', '\\Flagged', '\\Deleted']);
    });

    it('should fail APPEND with missing literal', () => {
      const result = parseCommand('A001 APPEND INBOX');
      expect(result.success).toBe(false);
    });

    it('should fail APPEND with malformed literal (no closing brace)', () => {
      const result = parseCommand('A001 APPEND INBOX {100');
      expect(result.success).toBe(false);
    });

    it('should fail APPEND with invalid literal size', () => {
      const result = parseCommand('A001 APPEND INBOX {abc}\r\ndata');
      expect(result.success).toBe(false);
    });

    it('should parse APPEND with hierarchical mailbox', () => {
      const message = 'Hi';
      const result = parseCommand(`A001 APPEND "INBOX/Subfolder/Deep" {${message.length}}\r\n${message}`);
      expect(result.success).toBe(true);
      expect(result.value?.request.type).toBe('APPEND');
      if (result.value?.request.type !== 'APPEND') {
        throw new Error('Expected APPEND request type');
      }
      expect(result.value.request.data.mailbox).toBe('INBOX/Subfolder/Deep');
    });

    it('should parse APPEND with empty flags list', () => {
      const message = 'Test';
      const result = parseCommand(`A001 APPEND INBOX () {${message.length}}\r\n${message}`);
      expect(result.success).toBe(true);
      expect(result.value?.request.type).toBe('APPEND');
      if (result.value?.request.type !== 'APPEND') {
        throw new Error('Expected APPEND request type');
      }
      expect(result.value.request.data.flags).toEqual([]);
    });

    it('should parse APPEND with binary-like message content', () => {
      const message = 'Content with \x00 null bytes and \xFF high bytes';
      const result = parseCommand(`A001 APPEND INBOX {${message.length}}\r\n${message}`);
      expect(result.success).toBe(true);
      expect(result.value?.request.type).toBe('APPEND');
      if (result.value?.request.type !== 'APPEND') {
        throw new Error('Expected APPEND request type');
      }
      expect(result.value.request.data.message).toBe(message);
    });

    it('should handle APPEND with exact literal size', () => {
      const message = 'Exactly this much';
      const result = parseCommand(`A001 APPEND INBOX {${message.length}}\r\n${message}`);
      expect(result.success).toBe(true);
      expect(result.value?.request.type).toBe('APPEND');
      if (result.value?.request.type !== 'APPEND') {
        throw new Error('Expected APPEND request type');
      }
      expect(result.value.request.data.message.length).toBe(message.length);
    });

    it('should parse APPEND with zero-length message', () => {
      const result = parseCommand('A001 APPEND INBOX {0}\r\n');
      expect(result.success).toBe(true);
      expect(result.value?.request.type).toBe('APPEND');
      if (result.value?.request.type !== 'APPEND') {
        throw new Error('Expected APPEND request type');
      }
      expect(result.value.request.data.message).toBe('');
    });
  });
});
