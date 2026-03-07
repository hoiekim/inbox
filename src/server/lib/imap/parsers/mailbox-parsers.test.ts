import { parseCommand } from './index';

describe('mailbox-parsers', () => {
  describe('parseSelect', () => {
    it('should parse SELECT with simple mailbox', () => {
      const result = parseCommand('A001 SELECT INBOX');
      expect(result.success).toBe(true);
      expect(result.value?.tag).toBe('A001');
      expect(result.value?.request.type).toBe('SELECT');
      if (result.value?.request.type !== 'SELECT') {
        throw new Error('Expected SELECT request type');
      }
      expect(result.value.request.data.mailbox).toBe('INBOX');
    });

    it('should parse SELECT with quoted mailbox containing spaces', () => {
      const result = parseCommand('A001 SELECT "Sent Items"');
      expect(result.success).toBe(true);
      expect(result.value?.request.type).toBe('SELECT');
      if (result.value?.request.type !== 'SELECT') {
        throw new Error('Expected SELECT request type');
      }
      expect(result.value.request.data.mailbox).toBe('Sent Items');
    });

    it('should parse SELECT with nested hierarchy', () => {
      const result = parseCommand('A001 SELECT "INBOX/Work/Projects"');
      expect(result.success).toBe(true);
      expect(result.value?.request.type).toBe('SELECT');
      if (result.value?.request.type !== 'SELECT') {
        throw new Error('Expected SELECT request type');
      }
      expect(result.value.request.data.mailbox).toBe('INBOX/Work/Projects');
    });

    it('should fail SELECT without mailbox', () => {
      const result = parseCommand('A001 SELECT');
      expect(result.success).toBe(false);
    });
  });

  describe('parseExamine', () => {
    it('should parse EXAMINE with simple mailbox (read-only)', () => {
      const result = parseCommand('A001 EXAMINE INBOX');
      expect(result.success).toBe(true);
      expect(result.value?.request.type).toBe('EXAMINE');
      if (result.value?.request.type !== 'EXAMINE') {
        throw new Error('Expected EXAMINE request type');
      }
      expect(result.value.request.data.mailbox).toBe('INBOX');
    });

    it('should parse EXAMINE with quoted mailbox', () => {
      const result = parseCommand('A001 EXAMINE "Archive/2025"');
      expect(result.success).toBe(true);
      expect(result.value?.request.type).toBe('EXAMINE');
      if (result.value?.request.type !== 'EXAMINE') {
        throw new Error('Expected EXAMINE request type');
      }
      expect(result.value.request.data.mailbox).toBe('Archive/2025');
    });
  });

  describe('parseStatus', () => {
    it('should parse STATUS with single item', () => {
      const result = parseCommand('A001 STATUS INBOX (MESSAGES)');
      expect(result.success).toBe(true);
      expect(result.value?.request.type).toBe('STATUS');
      if (result.value?.request.type !== 'STATUS') {
        throw new Error('Expected STATUS request type');
      }
      expect(result.value.request.data.mailbox).toBe('INBOX');
      expect(result.value.request.data.items).toEqual(['MESSAGES']);
    });

    it('should parse STATUS with multiple items', () => {
      const result = parseCommand('A001 STATUS INBOX (MESSAGES RECENT UIDNEXT UIDVALIDITY UNSEEN)');
      expect(result.success).toBe(true);
      expect(result.value?.request.type).toBe('STATUS');
      if (result.value?.request.type !== 'STATUS') {
        throw new Error('Expected STATUS request type');
      }
      expect(result.value.request.data.items).toEqual([
        'MESSAGES',
        'RECENT',
        'UIDNEXT',
        'UIDVALIDITY',
        'UNSEEN'
      ]);
    });

    it('should parse STATUS with quoted mailbox', () => {
      const result = parseCommand('A001 STATUS "Sent Items" (MESSAGES UNSEEN)');
      expect(result.success).toBe(true);
      expect(result.value?.request.type).toBe('STATUS');
      if (result.value?.request.type !== 'STATUS') {
        throw new Error('Expected STATUS request type');
      }
      expect(result.value.request.data.mailbox).toBe('Sent Items');
    });

    it('should parse STATUS with lowercase items (case normalized)', () => {
      const result = parseCommand('A001 STATUS INBOX (messages unseen)');
      expect(result.success).toBe(true);
      expect(result.value?.request.type).toBe('STATUS');
      if (result.value?.request.type !== 'STATUS') {
        throw new Error('Expected STATUS request type');
      }
      expect(result.value.request.data.items).toEqual(['MESSAGES', 'UNSEEN']);
    });

    it('should fail STATUS with unknown item', () => {
      const result = parseCommand('A001 STATUS INBOX (MESSAGES INVALID)');
      expect(result.success).toBe(false);
    });

    it('should fail STATUS without parentheses', () => {
      const result = parseCommand('A001 STATUS INBOX MESSAGES');
      expect(result.success).toBe(false);
    });
  });

  describe('parseCreate', () => {
    it('should parse CREATE with simple mailbox', () => {
      const result = parseCommand('A001 CREATE "New Folder"');
      expect(result.success).toBe(true);
      expect(result.value?.request.type).toBe('CREATE');
      if (result.value?.request.type !== 'CREATE') {
        throw new Error('Expected CREATE request type');
      }
      expect(result.value.request.data.mailbox).toBe('New Folder');
    });

    it('should parse CREATE with nested hierarchy', () => {
      const result = parseCommand('A001 CREATE "INBOX/Work/Projects/2026"');
      expect(result.success).toBe(true);
      expect(result.value?.request.type).toBe('CREATE');
      if (result.value?.request.type !== 'CREATE') {
        throw new Error('Expected CREATE request type');
      }
      expect(result.value.request.data.mailbox).toBe('INBOX/Work/Projects/2026');
    });

    it('should parse CREATE with unquoted mailbox', () => {
      const result = parseCommand('A001 CREATE Drafts');
      expect(result.success).toBe(true);
      expect(result.value?.request.type).toBe('CREATE');
      if (result.value?.request.type !== 'CREATE') {
        throw new Error('Expected CREATE request type');
      }
      expect(result.value.request.data.mailbox).toBe('Drafts');
    });
  });

  describe('parseDelete', () => {
    it('should parse DELETE with simple mailbox', () => {
      const result = parseCommand('A001 DELETE "Old Folder"');
      expect(result.success).toBe(true);
      expect(result.value?.request.type).toBe('DELETE');
      if (result.value?.request.type !== 'DELETE') {
        throw new Error('Expected DELETE request type');
      }
      expect(result.value.request.data.mailbox).toBe('Old Folder');
    });

    it('should parse DELETE with unquoted mailbox', () => {
      const result = parseCommand('A001 DELETE Trash');
      expect(result.success).toBe(true);
      expect(result.value?.request.type).toBe('DELETE');
      if (result.value?.request.type !== 'DELETE') {
        throw new Error('Expected DELETE request type');
      }
      expect(result.value.request.data.mailbox).toBe('Trash');
    });
  });

  describe('parseRename', () => {
    it('should parse RENAME with quoted names', () => {
      const result = parseCommand('A001 RENAME "Old Name" "New Name"');
      expect(result.success).toBe(true);
      expect(result.value?.request.type).toBe('RENAME');
      if (result.value?.request.type !== 'RENAME') {
        throw new Error('Expected RENAME request type');
      }
      expect(result.value.request.data.oldName).toBe('Old Name');
      expect(result.value.request.data.newName).toBe('New Name');
    });

    it('should parse RENAME with unquoted names', () => {
      const result = parseCommand('A001 RENAME OldFolder NewFolder');
      expect(result.success).toBe(true);
      expect(result.value?.request.type).toBe('RENAME');
      if (result.value?.request.type !== 'RENAME') {
        throw new Error('Expected RENAME request type');
      }
      expect(result.value.request.data.oldName).toBe('OldFolder');
      expect(result.value.request.data.newName).toBe('NewFolder');
    });

    it('should fail RENAME with missing new name', () => {
      const result = parseCommand('A001 RENAME "Old Name"');
      expect(result.success).toBe(false);
    });
  });

  describe('parseList', () => {
    it('should parse LIST with empty reference and wildcard', () => {
      const result = parseCommand('A001 LIST "" *');
      expect(result.success).toBe(true);
      expect(result.value?.request.type).toBe('LIST');
      if (result.value?.request.type !== 'LIST') {
        throw new Error('Expected LIST request type');
      }
      expect(result.value.request.data.reference).toBe('');
      expect(result.value.request.data.pattern).toBe('*');
    });

    it('should parse LIST with reference path', () => {
      const result = parseCommand('A001 LIST "INBOX/" *');
      expect(result.success).toBe(true);
      expect(result.value?.request.type).toBe('LIST');
      if (result.value?.request.type !== 'LIST') {
        throw new Error('Expected LIST request type');
      }
      expect(result.value.request.data.reference).toBe('INBOX/');
      expect(result.value.request.data.pattern).toBe('*');
    });

    it('should parse LIST with % wildcard', () => {
      const result = parseCommand('A001 LIST "" %');
      expect(result.success).toBe(true);
      expect(result.value?.request.type).toBe('LIST');
      if (result.value?.request.type !== 'LIST') {
        throw new Error('Expected LIST request type');
      }
      expect(result.value.request.data.pattern).toBe('%');
    });

    it('should parse LIST with specific pattern', () => {
      const result = parseCommand('A001 LIST "" "INBOX"');
      expect(result.success).toBe(true);
      expect(result.value?.request.type).toBe('LIST');
      if (result.value?.request.type !== 'LIST') {
        throw new Error('Expected LIST request type');
      }
      expect(result.value.request.data.reference).toBe('');
      expect(result.value.request.data.pattern).toBe('INBOX');
    });

    it('should parse LSUB command', () => {
      const result = parseCommand('A001 LSUB "" *');
      expect(result.success).toBe(true);
      expect(result.value?.request.type).toBe('LSUB');
      if (result.value?.request.type !== 'LSUB') {
        throw new Error('Expected LSUB request type');
      }
      expect(result.value.request.data.reference).toBe('');
      expect(result.value.request.data.pattern).toBe('*');
    });
  });

  describe('parseSubscribe', () => {
    it('should parse SUBSCRIBE with quoted mailbox', () => {
      const result = parseCommand('A001 SUBSCRIBE "INBOX/Notifications"');
      expect(result.success).toBe(true);
      expect(result.value?.request.type).toBe('SUBSCRIBE');
      if (result.value?.request.type !== 'SUBSCRIBE') {
        throw new Error('Expected SUBSCRIBE request type');
      }
      expect(result.value.request.data.mailbox).toBe('INBOX/Notifications');
    });

    it('should parse SUBSCRIBE with unquoted mailbox', () => {
      const result = parseCommand('A001 SUBSCRIBE INBOX');
      expect(result.success).toBe(true);
      expect(result.value?.request.type).toBe('SUBSCRIBE');
    });
  });

  describe('parseUnsubscribe', () => {
    it('should parse UNSUBSCRIBE with quoted mailbox', () => {
      const result = parseCommand('A001 UNSUBSCRIBE "Old Subscription"');
      expect(result.success).toBe(true);
      expect(result.value?.request.type).toBe('UNSUBSCRIBE');
      if (result.value?.request.type !== 'UNSUBSCRIBE') {
        throw new Error('Expected UNSUBSCRIBE request type');
      }
      expect(result.value.request.data.mailbox).toBe('Old Subscription');
    });

    it('should parse UNSUBSCRIBE with unquoted mailbox', () => {
      const result = parseCommand('A001 UNSUBSCRIBE Drafts');
      expect(result.success).toBe(true);
      expect(result.value?.request.type).toBe('UNSUBSCRIBE');
    });
  });
});
