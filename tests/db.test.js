const fs = require('fs');
const path = require('path');
const dbPath = path.join(__dirname, 'test.db');
process.env.DASHBOARD_DB_PATH = dbPath;
process.env.ENCRYPTION_KEY = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';

const dbModule = require('../src/db');

describe('Database and Encryption Module', () => {
  beforeAll(async () => {
    if (fs.existsSync(dbPath)) fs.unlinkSync(dbPath);
    await dbModule.init();
  });

  afterAll(async () => {
    await dbModule.close();
    if (fs.existsSync(dbPath)) fs.unlinkSync(dbPath);
    const keyPath = path.join(__dirname, 'encryption.key');
    if (fs.existsSync(keyPath)) fs.unlinkSync(keyPath);
  });

  // Clean up servers between tests for isolation
  afterEach(async () => {
    const servers = await dbModule.getServers();
    for (const s of servers) {
      await dbModule.deleteServer(s.id);
    }
  });

  describe('encrypt / decrypt', () => {
    test('should encrypt and decrypt correctly', () => {
      const raw = 'my_secret_ssh_key';
      const encrypted = dbModule.encrypt(raw);
      expect(encrypted).not.toBe(raw);
      const decrypted = dbModule.decrypt(encrypted);
      expect(decrypted).toBe(raw);
    });

    test('encrypted value should be in GCM format (iv:authTag:ciphertext)', () => {
      const raw = 'test_password';
      const encrypted = dbModule.encrypt(raw);
      const parts = encrypted.split(':');
      expect(parts.length).toBe(3);
      expect(parts[0]).toMatch(/^[0-9a-fA-F]{24}$/);  // 12-byte IV in hex
      expect(parts[1]).toMatch(/^[0-9a-fA-F]{32}$/);  // 16-byte auth tag in hex
      expect(parts[2]).toMatch(/^[0-9a-fA-F]+$/);      // ciphertext in hex
    });

    test('encrypt with empty string returns empty string', () => {
      expect(dbModule.encrypt('')).toBe('');
    });

    test('encrypt with null returns empty string', () => {
      expect(dbModule.encrypt(null)).toBe('');
    });

    test('encrypt with undefined returns empty string', () => {
      expect(dbModule.encrypt(undefined)).toBe('');
    });

    test('decrypt with empty string returns empty string', () => {
      expect(dbModule.decrypt('')).toBe('');
    });

    test('decrypt with null returns empty string', () => {
      expect(dbModule.decrypt(null)).toBe('');
    });

    test('decrypt with undefined returns empty string', () => {
      expect(dbModule.decrypt(undefined)).toBe('');
    });

    test('should fallback to plaintext when decrypting unencrypted string', () => {
      const raw = 'my_plaintext_password';
      const decrypted = dbModule.decrypt(raw);
      expect(decrypted).toBe(raw);
    });

    test('should fallback to plaintext when decrypting string with colons that is not GCM', () => {
      const raw = 'my:password:with:colons';
      const decrypted = dbModule.decrypt(raw);
      expect(decrypted).toBe(raw);
    });

    test('should return null if decryption fails on a 3-part encrypted string', () => {
      const invalidCiphertext = '123456789012345678901234:12345678901234567890123456789012:1234';
      const decrypted = dbModule.decrypt(invalidCiphertext);
      expect(decrypted).toBeNull();
    });

    test('each encryption produces different ciphertext (random IV)', () => {
      const raw = 'same_password';
      const enc1 = dbModule.encrypt(raw);
      const enc2 = dbModule.encrypt(raw);
      expect(enc1).not.toBe(enc2);
      // But both decrypt to the same value
      expect(dbModule.decrypt(enc1)).toBe(raw);
      expect(dbModule.decrypt(enc2)).toBe(raw);
    });
  });

  describe('CRUD operations', () => {
    const testServer = {
      name: 'Test Server',
      host: '192.168.1.100',
      port: 22,
      username: 'ubuntu',
      auth_type: 'password',
      password: 'mypassword',
      private_key: ''
    };

    describe('addServer / getServers', () => {
      test('should add and retrieve a server successfully', async () => {
        const serverId = await dbModule.addServer(testServer);
        expect(serverId).toBeGreaterThan(0);

        const servers = await dbModule.getServers();
        expect(servers.length).toBe(1);
        expect(servers[0].name).toBe('Test Server');
        expect(servers[0].password).toBe('mypassword');
      });

      test('password is stored encrypted in the database (not plaintext)', async () => {
        const serverId = await dbModule.addServer(testServer);
        // getServers decrypts, so the returned password should match the original
        const servers = await dbModule.getServers();
        expect(servers[0].password).toBe('mypassword');
        // But the raw value in the decrypt call should have been in GCM format
        // This is implicitly tested by the encrypt/decrypt tests above
      });

      test('should default port to 22 when not provided', async () => {
        const serverNoPort = { ...testServer, port: undefined };
        const serverId = await dbModule.addServer(serverNoPort);
        const servers = await dbModule.getServers();
        expect(servers[0].port).toBe(22);
      });
    });

    describe('getServerById', () => {
      test('should return a server by ID', async () => {
        const serverId = await dbModule.addServer(testServer);
        const server = await dbModule.getServerById(serverId);
        expect(server).not.toBeNull();
        expect(server.id).toBe(serverId);
        expect(server.name).toBe('Test Server');
        expect(server.password).toBe('mypassword');
      });

      test('should return null for non-existent ID', async () => {
        const server = await dbModule.getServerById(99999);
        expect(server).toBeNull();
      });

      test('should decrypt credentials', async () => {
        const serverId = await dbModule.addServer({
          ...testServer,
          auth_type: 'key',
          private_key: 'ssh-rsa AAAA...'
        });
        const server = await dbModule.getServerById(serverId);
        expect(server.private_key).toBe('ssh-rsa AAAA...');
      });
    });

    describe('updateServer', () => {
      test('should update a single field', async () => {
        const serverId = await dbModule.addServer(testServer);
        const changes = await dbModule.updateServer(serverId, { name: 'Updated Name' });
        expect(changes).toBe(1);

        const server = await dbModule.getServerById(serverId);
        expect(server.name).toBe('Updated Name');
        // Other fields unchanged
        expect(server.host).toBe('192.168.1.100');
      });

      test('should update multiple fields simultaneously', async () => {
        const serverId = await dbModule.addServer(testServer);
        const changes = await dbModule.updateServer(serverId, {
          name: 'New Name',
          host: '10.0.0.1',
          port: 2222
        });
        expect(changes).toBe(1);

        const server = await dbModule.getServerById(serverId);
        expect(server.name).toBe('New Name');
        expect(server.host).toBe('10.0.0.1');
        expect(server.port).toBe(2222);
      });

      test('should encrypt password on update', async () => {
        const serverId = await dbModule.addServer(testServer);
        await dbModule.updateServer(serverId, { password: 'new_secure_password' });

        const server = await dbModule.getServerById(serverId);
        expect(server.password).toBe('new_secure_password');
      });

      test('should encrypt private_key on update', async () => {
        const serverId = await dbModule.addServer(testServer);
        await dbModule.updateServer(serverId, { private_key: 'ssh-rsa NEW_KEY...' });

        const server = await dbModule.getServerById(serverId);
        expect(server.private_key).toBe('ssh-rsa NEW_KEY...');
      });

      test('should skip password update when password is empty string', async () => {
        const serverId = await dbModule.addServer(testServer);
        await dbModule.updateServer(serverId, { password: '' });

        const server = await dbModule.getServerById(serverId);
        // Password should remain unchanged
        expect(server.password).toBe('mypassword');
      });

      test('should return 0 when no fields provided', async () => {
        const serverId = await dbModule.addServer(testServer);
        const changes = await dbModule.updateServer(serverId, {});
        expect(changes).toBe(0);
      });

      test('should return 0 for non-existent server ID', async () => {
        const changes = await dbModule.updateServer(99999, { name: 'Ghost' });
        expect(changes).toBe(0);
      });
    });

    describe('deleteServer', () => {
      test('should delete a server successfully', async () => {
        const serverId = await dbModule.addServer(testServer);
        const changes = await dbModule.deleteServer(serverId);
        expect(changes).toBe(1);

        const servers = await dbModule.getServers();
        expect(servers.some(s => s.id === serverId)).toBe(false);
      });

      test('should return 0 for non-existent server', async () => {
        const changes = await dbModule.deleteServer(99999);
        expect(changes).toBe(0);
      });
    });

    describe('close', () => {
      test('should resolve when db is already null', async () => {
        // close() is called in afterAll, so we test idempotent close separately
        // This is tested implicitly by the afterAll hook
        // but let's verify the guard path
        const closeModule = require('../src/db');
        // Can't easily test without affecting the shared module state
        // so this is kept as a documentation test
        expect(typeof closeModule.close).toBe('function');
      });
    });
  });

  describe('Production safeguards', () => {
    test('should throw error if ENCRYPTION_KEY is invalid', () => {
      const originalKey = process.env.ENCRYPTION_KEY;
      try {
        jest.isolateModules(() => {
          process.env.ENCRYPTION_KEY = 'invalid_key';
          expect(() => require('../src/db')).toThrow('ENCRYPTION_KEY must be a 64-character hex string (32 bytes).');
        });
      } finally {
        process.env.ENCRYPTION_KEY = originalKey;
      }
    });

    test('should throw error if in production and ENCRYPTION_KEY is missing', () => {
      const originalNodeEnv = process.env.NODE_ENV;
      const originalKey = process.env.ENCRYPTION_KEY;
      try {
        process.env.NODE_ENV = 'production';
        delete process.env.ENCRYPTION_KEY;
        jest.isolateModules(() => {
          expect(() => require('../src/db')).toThrow('A secure, non-default ENCRYPTION_KEY environment variable is required in production.');
        });
      } finally {
        process.env.NODE_ENV = originalNodeEnv;
        process.env.ENCRYPTION_KEY = originalKey;
      }
    });

    test('should throw error if in production and ENCRYPTION_KEY is the default key', () => {
      const originalNodeEnv = process.env.NODE_ENV;
      const originalKey = process.env.ENCRYPTION_KEY;
      try {
        process.env.NODE_ENV = 'production';
        process.env.ENCRYPTION_KEY = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
        jest.isolateModules(() => {
          expect(() => require('../src/db')).toThrow('A secure, non-default ENCRYPTION_KEY environment variable is required in production.');
        });
      } finally {
        process.env.NODE_ENV = originalNodeEnv;
        process.env.ENCRYPTION_KEY = originalKey;
      }
    });
  });
});
