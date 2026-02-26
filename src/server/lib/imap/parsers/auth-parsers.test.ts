import { parseCommand } from './index';

describe('auth-parsers', () => {
  describe('parseLogin', () => {
    it('should parse LOGIN with simple credentials', () => {
      const result = parseCommand('A001 LOGIN user password');
      expect(result.success).toBe(true);
      expect(result.value?.tag).toBe('A001');
      expect(result.value?.request.type).toBe('LOGIN');
      if (result.value?.request.type !== 'LOGIN') {
        throw new Error('Expected LOGIN request type');
      }
      expect(result.value.request.data.username).toBe('user');
      expect(result.value.request.data.password).toBe('password');
    });

    it('should parse LOGIN with quoted username', () => {
      const result = parseCommand('A001 LOGIN "john.doe@example.com" password');
      expect(result.success).toBe(true);
      expect(result.value?.request.type).toBe('LOGIN');
      if (result.value?.request.type !== 'LOGIN') {
        throw new Error('Expected LOGIN request type');
      }
      expect(result.value.request.data.username).toBe('john.doe@example.com');
      expect(result.value.request.data.password).toBe('password');
    });

    it('should parse LOGIN with quoted password', () => {
      const result = parseCommand('A001 LOGIN user "my secret password"');
      expect(result.success).toBe(true);
      expect(result.value?.request.type).toBe('LOGIN');
      if (result.value?.request.type !== 'LOGIN') {
        throw new Error('Expected LOGIN request type');
      }
      expect(result.value.request.data.username).toBe('user');
      expect(result.value.request.data.password).toBe('my secret password');
    });

    it('should parse LOGIN with special characters in quoted password', () => {
      const result = parseCommand('A001 LOGIN user "p@ss{w0rd}!#$%"');
      expect(result.success).toBe(true);
      expect(result.value?.request.type).toBe('LOGIN');
      if (result.value?.request.type !== 'LOGIN') {
        throw new Error('Expected LOGIN request type');
      }
      expect(result.value.request.data.password).toBe('p@ss{w0rd}!#$%');
    });

    it('should parse LOGIN with both credentials quoted', () => {
      const result = parseCommand('A001 LOGIN "user@domain.com" "complex password"');
      expect(result.success).toBe(true);
      expect(result.value?.request.type).toBe('LOGIN');
      if (result.value?.request.type !== 'LOGIN') {
        throw new Error('Expected LOGIN request type');
      }
      expect(result.value.request.data.username).toBe('user@domain.com');
      expect(result.value.request.data.password).toBe('complex password');
    });

    it('should fail LOGIN with missing password', () => {
      const result = parseCommand('A001 LOGIN user');
      expect(result.success).toBe(false);
    });

    it('should fail LOGIN with missing username', () => {
      const result = parseCommand('A001 LOGIN');
      expect(result.success).toBe(false);
    });

    it('should parse LOGIN with numeric credentials', () => {
      const result = parseCommand('A001 LOGIN 12345 67890');
      expect(result.success).toBe(true);
      expect(result.value?.request.type).toBe('LOGIN');
      if (result.value?.request.type !== 'LOGIN') {
        throw new Error('Expected LOGIN request type');
      }
      expect(result.value.request.data.username).toBe('12345');
      expect(result.value.request.data.password).toBe('67890');
    });
  });

  describe('parseAuthenticate', () => {
    it('should parse AUTHENTICATE PLAIN without initial response', () => {
      const result = parseCommand('A001 AUTHENTICATE PLAIN');
      expect(result.success).toBe(true);
      expect(result.value?.tag).toBe('A001');
      expect(result.value?.request.type).toBe('AUTHENTICATE');
      if (result.value?.request.type !== 'AUTHENTICATE') {
        throw new Error('Expected AUTHENTICATE request type');
      }
      expect(result.value.request.data.mechanism).toBe('PLAIN');
      expect(result.value.request.data.initialResponse).toBeUndefined();
    });

    it('should parse AUTHENTICATE PLAIN with initial response', () => {
      // Base64 encoded "\0user\0password" is AGVtYWlsQGV4YW1wbGUuY29tAHBhc3N3b3Jk
      const result = parseCommand('A001 AUTHENTICATE PLAIN AGVtYWlsQGV4YW1wbGUuY29tAHBhc3N3b3Jk');
      expect(result.success).toBe(true);
      expect(result.value?.request.type).toBe('AUTHENTICATE');
      if (result.value?.request.type !== 'AUTHENTICATE') {
        throw new Error('Expected AUTHENTICATE request type');
      }
      expect(result.value.request.data.mechanism).toBe('PLAIN');
      expect(result.value.request.data.initialResponse).toBe('AGVtYWlsQGV4YW1wbGUuY29tAHBhc3N3b3Jk');
    });

    it('should parse AUTHENTICATE with LOGIN mechanism', () => {
      const result = parseCommand('A001 AUTHENTICATE LOGIN');
      expect(result.success).toBe(true);
      expect(result.value?.request.type).toBe('AUTHENTICATE');
      if (result.value?.request.type !== 'AUTHENTICATE') {
        throw new Error('Expected AUTHENTICATE request type');
      }
      expect(result.value.request.data.mechanism).toBe('LOGIN');
    });

    it('should fail AUTHENTICATE with missing mechanism', () => {
      const result = parseCommand('A001 AUTHENTICATE');
      expect(result.success).toBe(false);
    });

    it('should parse AUTHENTICATE with lowercase mechanism (case preserved)', () => {
      const result = parseCommand('A001 AUTHENTICATE plain');
      expect(result.success).toBe(true);
      expect(result.value?.request.type).toBe('AUTHENTICATE');
      if (result.value?.request.type !== 'AUTHENTICATE') {
        throw new Error('Expected AUTHENTICATE request type');
      }
      // Mechanism should be preserved as-is
      expect(result.value.request.data.mechanism).toBe('plain');
    });

    it('should parse AUTHENTICATE XOAUTH2', () => {
      const result = parseCommand('A001 AUTHENTICATE XOAUTH2');
      expect(result.success).toBe(true);
      expect(result.value?.request.type).toBe('AUTHENTICATE');
      if (result.value?.request.type !== 'AUTHENTICATE') {
        throw new Error('Expected AUTHENTICATE request type');
      }
      expect(result.value.request.data.mechanism).toBe('XOAUTH2');
    });
  });
});
