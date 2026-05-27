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
  });

  test('should encrypt and decrypt correctly', () => {
    const raw = 'my_secret_ssh_key';
    const encrypted = dbModule.encrypt(raw);
    expect(encrypted).not.toBe(raw);
    const decrypted = dbModule.decrypt(encrypted);
    expect(decrypted).toBe(raw);
  });

  test('should fallback to plaintext when decrypting unencrypted string', () => {
    const raw = 'my_plaintext_password';
    const decrypted = dbModule.decrypt(raw);
    expect(decrypted).toBe(raw);
  });

  test('should fallback to original ciphertext if decryption fails', () => {
    const invalidCiphertext = '1234567890ab:1234567890ab:1234';
    const decrypted = dbModule.decrypt(invalidCiphertext);
    expect(decrypted).toBe(invalidCiphertext);
  });

  test('should add and retrieve a server successfully', async () => {
    const serverId = await dbModule.addServer({
      name: 'Test Server',
      host: '192.168.1.100',
      port: 22,
      username: 'ubuntu',
      auth_type: 'password',
      password: 'mypassword',
      private_key: ''
    });

    expect(serverId).toBeGreaterThan(0);

    const servers = await dbModule.getServers();
    expect(servers.length).toBe(1);
    expect(servers[0].name).toBe('Test Server');
    expect(servers[0].password).toBe('mypassword');
  });

  test('should delete a server successfully', async () => {
    const serverId = await dbModule.addServer({
      name: 'Temp Server',
      host: '192.168.1.101',
      port: 22,
      username: 'ubuntu',
      auth_type: 'password',
      password: 'password123',
      private_key: ''
    });

    const initialServers = await dbModule.getServers();
    expect(initialServers.some(s => s.id === serverId)).toBe(true);

    const changes = await dbModule.deleteServer(serverId);
    expect(changes).toBe(1);

    const finalServers = await dbModule.getServers();
    expect(finalServers.some(s => s.id === serverId)).toBe(false);
  });

  test('should close the database connection successfully', async () => {
    await expect(dbModule.close()).resolves.toBeUndefined();
  });

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
});
