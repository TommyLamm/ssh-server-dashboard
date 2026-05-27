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

  afterAll(() => {
    if (fs.existsSync(dbPath)) fs.unlinkSync(dbPath);
  });

  test('should encrypt and decrypt correctly', () => {
    const raw = 'my_secret_ssh_key';
    const encrypted = dbModule.encrypt(raw);
    expect(encrypted).not.toBe(raw);
    const decrypted = dbModule.decrypt(encrypted);
    expect(decrypted).toBe(raw);
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
});
