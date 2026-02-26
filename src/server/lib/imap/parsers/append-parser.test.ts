import { parseAppend } from './append-parser';
import { ParseContext } from '../types';

const createContext = (input: string): ParseContext => ({
  input,
  position: 0,
  length: input.length
});

describe('parseAppend', () => {
  describe('basic parsing', () => {
    it('should parse APPEND with quoted mailbox and synchronizing literal', () => {
      const input = '"INBOX" {5}\r\nHello';
      const context = createContext(input);
      const result = parseAppend(context);

      expect(result.success).toBe(true);
      expect(result.value?.data.mailbox).toBe('INBOX');
      expect(result.value?.data.message).toBe('Hello');
    });

    it('should parse APPEND with flags', () => {
      const input = '"INBOX" (\\Seen \\Flagged) {5}\r\nHello';
      const context = createContext(input);
      const result = parseAppend(context);

      expect(result.success).toBe(true);
      expect(result.value?.data.mailbox).toBe('INBOX');
      expect(result.value?.data.flags).toEqual(['\\Seen', '\\Flagged']);
      expect(result.value?.data.message).toBe('Hello');
    });

    it('should parse APPEND with date', () => {
      const input = '"INBOX" "01-Jan-2024 12:00:00 +0000" {5}\r\nHello';
      const context = createContext(input);
      const result = parseAppend(context);

      expect(result.success).toBe(true);
      expect(result.value?.data.mailbox).toBe('INBOX');
      expect(result.value?.data.date).toBe('01-Jan-2024 12:00:00 +0000');
      expect(result.value?.data.message).toBe('Hello');
    });

    it('should parse APPEND with flags and date', () => {
      const input = '"INBOX" (\\Seen) "01-Jan-2024 12:00:00 +0000" {5}\r\nHello';
      const context = createContext(input);
      const result = parseAppend(context);

      expect(result.success).toBe(true);
      expect(result.value?.data.mailbox).toBe('INBOX');
      expect(result.value?.data.flags).toEqual(['\\Seen']);
      expect(result.value?.data.date).toBe('01-Jan-2024 12:00:00 +0000');
      expect(result.value?.data.message).toBe('Hello');
    });
  });

  describe('non-synchronizing literals (LITERAL+)', () => {
    it('should parse APPEND with non-synchronizing literal {size+}', () => {
      const input = '"INBOX" {5+}\r\nHello';
      const context = createContext(input);
      const result = parseAppend(context);

      expect(result.success).toBe(true);
      expect(result.value?.data.mailbox).toBe('INBOX');
      expect(result.value?.data.message).toBe('Hello');
    });

    it('should parse APPEND with non-synchronizing literal and flags', () => {
      const input = '"INBOX" (\\Seen) {12+}\r\nHello World!';
      const context = createContext(input);
      const result = parseAppend(context);

      expect(result.success).toBe(true);
      expect(result.value?.data.mailbox).toBe('INBOX');
      expect(result.value?.data.flags).toEqual(['\\Seen']);
      expect(result.value?.data.message).toBe('Hello World!');
    });

    it('should handle large non-synchronizing literal sizes', () => {
      const size = 1048576; // 1MB
      const message = 'X'.repeat(size);
      const input = `"INBOX" {${size}+}\r\n${message}`;
      const context = createContext(input);
      const result = parseAppend(context);

      expect(result.success).toBe(true);
      expect(result.value?.data.message.length).toBe(size);
    });
  });

  describe('error cases', () => {
    it('should fail when literal is missing', () => {
      const input = '"INBOX"';
      const context = createContext(input);
      const result = parseAppend(context);

      expect(result.success).toBe(false);
      expect(result.error).toContain('literal');
    });

    it('should fail with invalid literal format (missing closing brace)', () => {
      const input = '"INBOX" {5\r\nHello';
      const context = createContext(input);
      const result = parseAppend(context);

      expect(result.success).toBe(false);
      expect(result.error).toContain('Invalid literal format');
    });

    it('should fail with invalid literal size', () => {
      const input = '"INBOX" {abc}\r\nHello';
      const context = createContext(input);
      const result = parseAppend(context);

      expect(result.success).toBe(false);
      expect(result.error).toContain('Invalid literal size');
    });
  });
});
