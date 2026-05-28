const http = require('http');
const jwt = require('jsonwebtoken');
const app = require('../src/server');
const db = require('../src/db');
const sshPool = require('../src/sshPool');
const WebSocket = require('ws');
const { generateToken, generateExpiredToken, makeAuthHeader, TEST_JWT_SECRET } = require('./helpers');

jest.mock('../src/db');
jest.mock('../src/sshPool');

jest.setTimeout(10000);

describe('Server Dashboard API', () => {
  let server;
  let port;
  const connections = new Set();

  beforeAll((done) => {
    server = app.listen(0, () => {
      port = server.address().port;
      done();
    });
    server.on('connection', (conn) => {
      connections.add(conn);
      conn.on('close', () => {
        connections.delete(conn);
      });
    });
  });

  afterAll((done) => {
    for (const conn of connections) {
      conn.destroy();
    }
    server.close(done);
  });

  function makeRequest(method, path, body = null, headers = {}) {
    return new Promise((resolve, reject) => {
      const options = {
        hostname: 'localhost',
        port: port,
        path: path,
        method: method,
        headers: {
          'Content-Type': 'application/json',
          ...headers
        }
      };
      const req = http.request(options, (res) => {
        let data = '';
        res.on('data', chunk => data += chunk);
        res.on('end', () => {
          try {
            const parsed = JSON.parse(data);
            resolve({ status: res.statusCode, body: parsed });
          } catch (e) {
            resolve({ status: res.statusCode, body: data });
          }
        });
      });
      req.on('error', reject);
      if (body) {
        req.write(JSON.stringify(body));
      }
      req.end();
    });
  }

  /** Helper: connect a WebSocket and authenticate */
  function connectAuthWs() {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(`ws://localhost:${port}/ws/monitor`);
      ws.on('open', () => {
        ws.send(JSON.stringify({ type: 'auth', token: generateToken() }));
      });
      ws.on('message', (msg) => {
        const data = JSON.parse(msg);
        if (data.type === 'authenticated') {
          resolve(ws);
        } else if (data.type === 'error') {
          reject(new Error(data.message));
        }
      });
      ws.on('error', reject);
    });
  }

  beforeEach(() => {
    jest.clearAllMocks();
  });

  // ============================================================
  // Production Safeguards
  // ============================================================
  describe('Production safeguards', () => {
    test('should throw error in production if DASHBOARD_SECRET is default or missing', () => {
      const originalEnv = process.env.NODE_ENV;
      const originalSecret = process.env.DASHBOARD_SECRET;
      try {
        process.env.NODE_ENV = 'production';
        process.env.DASHBOARD_SECRET = 'fallback-jwt-secret';
        jest.isolateModules(() => {
          expect(() => require('../src/server')).toThrow('A secure, non-default DASHBOARD_SECRET environment variable is required in production.');
        });
      } finally {
        process.env.NODE_ENV = originalEnv;
        process.env.DASHBOARD_SECRET = originalSecret;
      }
    });
  });

  // ============================================================
  // REST API: POST /api/login
  // ============================================================
  describe('POST /api/login', () => {
    test('success with valid credentials', async () => {
      const res = await makeRequest('POST', '/api/login', {
        username: 'admin',
        password: 'admin'
      });
      expect(res.status).toBe(200);
      expect(res.body.token).toBeDefined();
    });

    test('fails with invalid credentials', async () => {
      const res = await makeRequest('POST', '/api/login', {
        username: 'admin',
        password: 'wrong'
      });
      expect(res.status).toBe(401);
      expect(res.body.error).toBe('Invalid credentials');
    });

    test('fails with missing body fields', async () => {
      const res = await makeRequest('POST', '/api/login', {});
      expect(res.status).toBe(401);
    });
  });

  // ============================================================
  // REST API: GET /api/servers
  // ============================================================
  describe('GET /api/servers', () => {
    test('unauthorized without token', async () => {
      const res = await makeRequest('GET', '/api/servers');
      expect(res.status).toBe(401);
    });

    test('forbidden with expired token', async () => {
      const expiredToken = generateExpiredToken();
      // Wait a moment for token to expire
      await new Promise(r => setTimeout(r, 1100));
      const res = await makeRequest('GET', '/api/servers', null, {
        'Authorization': `Bearer ${expiredToken}`
      });
      expect(res.status).toBe(403);
    });

    test('forbidden with malformed Authorization header', async () => {
      const res = await makeRequest('GET', '/api/servers', null, {
        'Authorization': 'NotBearer sometoken'
      });
      expect(res.status).toBe(401);
    });

    test('success with valid token, strips credentials', async () => {
      db.getServers.mockResolvedValue([
        {
          id: 1,
          name: 'Server 1',
          host: '1.1.1.1',
          port: 22,
          username: 'root',
          auth_type: 'password',
          password: 'superpassword',
          private_key: 'superkey'
        }
      ]);

      const res = await makeRequest('GET', '/api/servers', null, makeAuthHeader());
      expect(res.status).toBe(200);
      expect(res.body).toBeInstanceOf(Array);
      expect(res.body[0].name).toBe('Server 1');
      expect(res.body[0].password).toBeUndefined();
      expect(res.body[0].private_key).toBeUndefined();
    });

    test('returns 500 when db throws', async () => {
      db.getServers.mockRejectedValue(new Error('DB connection lost'));
      const res = await makeRequest('GET', '/api/servers', null, makeAuthHeader());
      expect(res.status).toBe(500);
      expect(res.body.error).toBeDefined();
    });
  });

  // ============================================================
  // REST API: POST /api/servers
  // ============================================================
  describe('POST /api/servers', () => {
    const validServer = {
      name: 'New Server',
      host: '2.2.2.2',
      port: 22,
      username: 'root',
      auth_type: 'password',
      password: 'newpassword',
      private_key: ''
    };

    test('success with valid data', async () => {
      db.addServer.mockResolvedValue(2);
      const res = await makeRequest('POST', '/api/servers', validServer, makeAuthHeader());
      expect(res.status).toBe(201);
      expect(res.body.id).toBe(2);
      expect(db.addServer).toHaveBeenCalledWith(
        expect.objectContaining({
          name: 'New Server',
          host: '2.2.2.2',
          port: 22,
          username: 'root',
          auth_type: 'password'
        })
      );
    });

    test('fails with empty name', async () => {
      const res = await makeRequest('POST', '/api/servers', { ...validServer, name: '' }, makeAuthHeader());
      expect(res.status).toBe(400);
      expect(res.body.error).toBe('Name must be a non-empty string');
    });

    test('fails with empty host', async () => {
      const res = await makeRequest('POST', '/api/servers', { ...validServer, host: '' }, makeAuthHeader());
      expect(res.status).toBe(400);
      expect(res.body.error).toBe('Host must be a non-empty string');
    });

    test('fails with empty username', async () => {
      const res = await makeRequest('POST', '/api/servers', { ...validServer, username: '' }, makeAuthHeader());
      expect(res.status).toBe(400);
      expect(res.body.error).toBe('Username must be a non-empty string');
    });

    test('fails with invalid port', async () => {
      const res = await makeRequest('POST', '/api/servers', { ...validServer, port: 99999 }, makeAuthHeader());
      expect(res.status).toBe(400);
      expect(res.body.error).toBe('Port must be an integer between 1 and 65535');
    });

    test('fails with invalid auth_type', async () => {
      const res = await makeRequest('POST', '/api/servers', { ...validServer, auth_type: 'invalid' }, makeAuthHeader());
      expect(res.status).toBe(400);
      expect(res.body.error).toBe('Auth type must be either password or key');
    });

    test('fails with missing password for password auth', async () => {
      const res = await makeRequest('POST', '/api/servers', { ...validServer, password: '' }, makeAuthHeader());
      expect(res.status).toBe(400);
      expect(res.body.error).toBe('Password must be a non-empty string when auth_type is password');
    });

    test('fails with missing private_key for key auth', async () => {
      const res = await makeRequest('POST', '/api/servers', { ...validServer, auth_type: 'key', private_key: '' }, makeAuthHeader());
      expect(res.status).toBe(400);
      expect(res.body.error).toBe('Private key must be a non-empty string when auth_type is key');
    });

    test('returns 500 when db throws', async () => {
      db.addServer.mockRejectedValue(new Error('INSERT failed'));
      const res = await makeRequest('POST', '/api/servers', validServer, makeAuthHeader());
      expect(res.status).toBe(500);
    });
  });

  // ============================================================
  // REST API: PUT /api/servers/:id
  // ============================================================
  describe('PUT /api/servers/:id', () => {
    test('success with valid update', async () => {
      db.updateServer.mockResolvedValue(1);
      const res = await makeRequest('PUT', '/api/servers/1', { name: 'Updated' }, makeAuthHeader());
      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(db.updateServer).toHaveBeenCalledWith(1, expect.objectContaining({ name: 'Updated' }));
    });

    test('returns 404 when no changes (server not found)', async () => {
      db.updateServer.mockResolvedValue(0);
      const res = await makeRequest('PUT', '/api/servers/999', { name: 'Ghost' }, makeAuthHeader());
      expect(res.status).toBe(404);
    });

    test('returns 400 for invalid ID', async () => {
      const res = await makeRequest('PUT', '/api/servers/abc', { name: 'test' }, makeAuthHeader());
      expect(res.status).toBe(400);
      expect(res.body.error).toBe('Invalid server ID');
    });

    test('validates name if provided', async () => {
      const res = await makeRequest('PUT', '/api/servers/1', { name: '' }, makeAuthHeader());
      expect(res.status).toBe(400);
    });

    test('validates port if provided', async () => {
      const res = await makeRequest('PUT', '/api/servers/1', { port: 99999 }, makeAuthHeader());
      expect(res.status).toBe(400);
    });

    test('closes SSH connection after update', async () => {
      db.updateServer.mockResolvedValue(1);
      await makeRequest('PUT', '/api/servers/1', { host: '10.0.0.1' }, makeAuthHeader());
      expect(sshPool.closeConnection).toHaveBeenCalledWith(1);
    });
  });

  // ============================================================
  // REST API: DELETE /api/servers/:id
  // ============================================================
  describe('DELETE /api/servers/:id', () => {
    test('success with valid ID', async () => {
      db.deleteServer.mockResolvedValue(1);
      const res = await makeRequest('DELETE', '/api/servers/1', null, makeAuthHeader());
      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(db.deleteServer).toHaveBeenCalledWith(1);
      expect(sshPool.closeConnection).toHaveBeenCalledWith(1);
    });

    test('returns 400 for invalid/NaN ID', async () => {
      const res = await makeRequest('DELETE', '/api/servers/abc', null, makeAuthHeader());
      expect(res.status).toBe(400);
      expect(res.body.error).toBe('Invalid server ID');
    });

    test('returns 404 for non-existent server', async () => {
      db.deleteServer.mockResolvedValue(0);
      const res = await makeRequest('DELETE', '/api/servers/999', null, makeAuthHeader());
      expect(res.status).toBe(404);
      expect(res.body.error).toBe('Server not found');
    });
  });

  // ============================================================
  // REST API: GET /health
  // ============================================================
  describe('GET /health', () => {
    test('returns ok status and uptime', async () => {
      const res = await makeRequest('GET', '/health');
      expect(res.status).toBe(200);
      expect(res.body.status).toBe('ok');
      expect(typeof res.body.uptime).toBe('number');
    });
  });

  // ============================================================
  // WebSocket: Authentication
  // ============================================================
  describe('WebSocket authentication', () => {
    test('auth failed with invalid token', (done) => {
      const ws = new WebSocket(`ws://localhost:${port}/ws/monitor`);
      ws.on('open', () => {
        ws.send(JSON.stringify({ type: 'auth', token: 'invalid-token' }));
      });
      ws.on('message', (msg) => {
        const data = JSON.parse(msg);
        if (data.type === 'error') {
          expect(data.message).toBe('Auth failed');
          ws.close();
        }
      });
      ws.on('close', () => done());
    });

    test('rejects message before auth with Unauthorized', (done) => {
      const ws = new WebSocket(`ws://localhost:${port}/ws/monitor`);
      ws.on('open', () => {
        ws.send(JSON.stringify({ type: 'select-server', serverId: 1 }));
      });
      ws.on('message', (msg) => {
        const data = JSON.parse(msg);
        if (data.type === 'error') {
          expect(data.message).toBe('Unauthorized');
        }
      });
      ws.on('close', () => done());
    });
  });

  // ============================================================
  // WebSocket: Server Monitoring
  // ============================================================
  describe('WebSocket monitoring', () => {
    const mockServerList = [
      {
        id: 1,
        name: 'Server 1',
        host: '1.1.1.1',
        port: 22,
        username: 'root',
        auth_type: 'password',
        password: 'superpassword',
        private_key: 'superkey'
      }
    ];

    function setupMocks() {
      db.getServerById.mockResolvedValue(mockServerList[0]);
      db.getServers.mockResolvedValue(mockServerList);
      const mockConn = {};
      sshPool.getConnection.mockResolvedValue(mockConn);
      sshPool.execCommand.mockImplementation((conn, cmd) => {
        if (cmd.includes('Cpu(s)')) return Promise.resolve('%Cpu(s): 10.0 us, 5.0 sy, 85.0 id');
        if (cmd.includes('free')) return Promise.resolve('Mem: 1000 500');
        if (cmd.includes('df')) return Promise.resolve('/dev/sda1 ext4 100G 40G 60G 40% /');
        if (cmd.includes('uptime')) return Promise.resolve('up 2 hours');
        if (cmd.includes('ps -eo')) return Promise.resolve('PID USER %CPU %MEM COMMAND\n1204 root 2.4 0.5 nginx');
        if (cmd.includes('docker stats')) return Promise.resolve('{"name":"web","cpu":"1.5%","mem":"50MiB / 1GiB"}');
        if (cmd.includes('tail -n')) return Promise.resolve('file logs');
        return Promise.resolve('');
      });
      sshPool.parseCpu.mockReturnValue(15.0);
      sshPool.parseMem.mockReturnValue({ total: 1000, used: 500, percent: 50.0 });
      sshPool.parseDisk.mockReturnValue([{ device: '/dev/sda1', used_percent: 40 }]);
      sshPool.parseProcesses.mockReturnValue([{ pid: 1204, user: 'root', cpu: 2.4, mem: 0.5, command: 'nginx' }]);
      sshPool.parseDocker.mockReturnValue([{ name: 'web', cpu: '1.5%', mem: '50MiB / 1GiB' }]);
    }

    test('auth + select-server + metrics flow', (done) => {
      setupMocks();
      const ws = new WebSocket(`ws://localhost:${port}/ws/monitor`);

      ws.on('open', () => {
        ws.send(JSON.stringify({ type: 'auth', token: generateToken() }));
      });

      ws.on('message', (msg) => {
        const data = JSON.parse(msg);
        if (data.type === 'authenticated') {
          ws.send(JSON.stringify({ type: 'select-server', serverId: 1 }));
        } else if (data.type === 'metrics') {
          expect(data.serverId).toBe(1);
          expect(data.status).toBe('online');
          expect(data.metrics.cpu).toBe(15.0);
          expect(data.metrics.mem.percent).toBe(50.0);
          ws.close();
        }
      });

      ws.on('close', () => done());
    });

    test('fetch-processes returns process data', (done) => {
      setupMocks();
      const ws = new WebSocket(`ws://localhost:${port}/ws/monitor`);

      ws.on('open', () => {
        ws.send(JSON.stringify({ type: 'auth', token: generateToken() }));
      });

      ws.on('message', (msg) => {
        const data = JSON.parse(msg);
        if (data.type === 'authenticated') {
          ws.send(JSON.stringify({ type: 'select-server', serverId: 1 }));
        } else if (data.type === 'metrics') {
          ws.send(JSON.stringify({ type: 'fetch-processes' }));
        } else if (data.type === 'processes') {
          expect(data.processes[0].pid).toBe(1204);
          expect(data.serverId).toBe(1);
          ws.close();
        }
      });

      ws.on('close', () => done());
    });

    test('fetch-docker returns container data', (done) => {
      setupMocks();
      const ws = new WebSocket(`ws://localhost:${port}/ws/monitor`);

      ws.on('open', () => {
        ws.send(JSON.stringify({ type: 'auth', token: generateToken() }));
      });

      ws.on('message', (msg) => {
        const data = JSON.parse(msg);
        if (data.type === 'authenticated') {
          ws.send(JSON.stringify({ type: 'select-server', serverId: 1 }));
        } else if (data.type === 'metrics') {
          ws.send(JSON.stringify({ type: 'fetch-docker' }));
        } else if (data.type === 'docker') {
          expect(data.containers[0].name).toBe('web');
          expect(data.serverId).toBe(1);
          ws.close();
        }
      });

      ws.on('close', () => done());
    });

    test('fetch-logs returns log data', (done) => {
      setupMocks();
      const ws = new WebSocket(`ws://localhost:${port}/ws/monitor`);

      ws.on('open', () => {
        ws.send(JSON.stringify({ type: 'auth', token: generateToken() }));
      });

      ws.on('message', (msg) => {
        const data = JSON.parse(msg);
        if (data.type === 'authenticated') {
          ws.send(JSON.stringify({ type: 'select-server', serverId: 1 }));
        } else if (data.type === 'metrics') {
          ws.send(JSON.stringify({ type: 'fetch-logs', logPath: '/var/log/syslog', isService: false }));
        } else if (data.type === 'logs') {
          expect(data.logs).toBe('file logs');
          expect(data.serverId).toBe(1);
          ws.close();
        }
      });

      ws.on('close', () => done());
    });

    test('select-server with non-existent ID returns error', (done) => {
      db.getServerById.mockResolvedValue(null);
      const ws = new WebSocket(`ws://localhost:${port}/ws/monitor`);

      ws.on('open', () => {
        ws.send(JSON.stringify({ type: 'auth', token: generateToken() }));
      });

      ws.on('message', (msg) => {
        const data = JSON.parse(msg);
        if (data.type === 'authenticated') {
          ws.send(JSON.stringify({ type: 'select-server', serverId: 999 }));
        } else if (data.type === 'error') {
          expect(data.message).toBe('Server not found');
          ws.close();
        }
      });

      ws.on('close', () => done());
    });
  });

  // ============================================================
  // WebSocket: Command injection prevention
  // ============================================================
  describe('WebSocket log path validation', () => {
    function setupForLogs() {
      db.getServerById.mockResolvedValue({
        id: 1, name: 'Server 1', host: '1.1.1.1', port: 22,
        username: 'root', auth_type: 'password'
      });
    }

    test('rejects command injection in file path', (done) => {
      setupForLogs();
      const ws = new WebSocket(`ws://localhost:${port}/ws/monitor`);

      ws.on('open', () => {
        ws.send(JSON.stringify({ type: 'auth', token: generateToken() }));
      });

      let gotMetrics = false;
      ws.on('message', (msg) => {
        const data = JSON.parse(msg);
        if (data.type === 'authenticated') {
          ws.send(JSON.stringify({ type: 'select-server', serverId: 1 }));
        } else if (data.type === 'metrics' && !gotMetrics) {
          gotMetrics = true;
          ws.send(JSON.stringify({ type: 'fetch-logs', logPath: '/var/log/syslog; rm -rf /', isService: false }));
        } else if (data.type === 'error') {
          expect(data.message).toBe('Invalid log file path');
          ws.close();
        }
      });

      ws.on('close', () => done());
    });

    test('rejects command injection in service name', (done) => {
      setupForLogs();
      const ws = new WebSocket(`ws://localhost:${port}/ws/monitor`);

      ws.on('open', () => {
        ws.send(JSON.stringify({ type: 'auth', token: generateToken() }));
      });

      let gotMetrics = false;
      ws.on('message', (msg) => {
        const data = JSON.parse(msg);
        if (data.type === 'authenticated') {
          ws.send(JSON.stringify({ type: 'select-server', serverId: 1 }));
        } else if (data.type === 'metrics' && !gotMetrics) {
          gotMetrics = true;
          ws.send(JSON.stringify({ type: 'fetch-logs', logPath: 'nginx; rm -rf /', isService: true }));
        } else if (data.type === 'error') {
          expect(data.message).toBe('Invalid service name');
          ws.close();
        }
      });

      ws.on('close', () => done());
    });

    test('rejects path traversal with ..', (done) => {
      setupForLogs();
      const ws = new WebSocket(`ws://localhost:${port}/ws/monitor`);

      ws.on('open', () => {
        ws.send(JSON.stringify({ type: 'auth', token: generateToken() }));
      });

      let gotMetrics = false;
      ws.on('message', (msg) => {
        const data = JSON.parse(msg);
        if (data.type === 'authenticated') {
          ws.send(JSON.stringify({ type: 'select-server', serverId: 1 }));
        } else if (data.type === 'metrics' && !gotMetrics) {
          gotMetrics = true;
          ws.send(JSON.stringify({ type: 'fetch-logs', logPath: '/var/log/../../etc/shadow', isService: false }));
        } else if (data.type === 'error') {
          expect(data.message).toBe('Invalid log file path');
          ws.close();
        }
      });

      ws.on('close', () => done());
    });

    test('rejects paths outside /var/log/', (done) => {
      setupForLogs();
      const ws = new WebSocket(`ws://localhost:${port}/ws/monitor`);

      ws.on('open', () => {
        ws.send(JSON.stringify({ type: 'auth', token: generateToken() }));
      });

      let gotMetrics = false;
      ws.on('message', (msg) => {
        const data = JSON.parse(msg);
        if (data.type === 'authenticated') {
          ws.send(JSON.stringify({ type: 'select-server', serverId: 1 }));
        } else if (data.type === 'metrics' && !gotMetrics) {
          gotMetrics = true;
          ws.send(JSON.stringify({ type: 'fetch-logs', logPath: '/etc/shadow', isService: false }));
        } else if (data.type === 'error') {
          expect(data.message).toBe('Invalid log file path');
          ws.close();
        }
      });

      ws.on('close', () => done());
    });
  });

  // ============================================================
  // WebSocket: Server deletion eviction
  // ============================================================
  describe('WebSocket server deletion eviction', () => {
    test('evicts clients when a server is deleted', (done) => {
      db.getServerById.mockResolvedValue({
        id: 1, name: 'Server 1', host: '1.1.1.1', port: 22,
        username: 'root', auth_type: 'password'
      });
      const mockConn = {};
      sshPool.getConnection.mockResolvedValue(mockConn);
      sshPool.execCommand.mockResolvedValue('');

      const ws = new WebSocket(`ws://localhost:${port}/ws/monitor`);

      ws.on('open', () => {
        ws.send(JSON.stringify({ type: 'auth', token: generateToken() }));
      });

      ws.on('message', async (msg) => {
        const data = JSON.parse(msg);
        if (data.type === 'authenticated') {
          ws.send(JSON.stringify({ type: 'select-server', serverId: 1 }));
        } else if (data.type === 'metrics') {
          db.deleteServer.mockResolvedValue(1);
          const res = await makeRequest('DELETE', '/api/servers/1', null, makeAuthHeader());
          expect(res.status).toBe(200);
          expect(res.body.success).toBe(true);
        } else if (data.type === 'error') {
          expect(data.message).toBe('Server deleted');
          ws.close();
        }
      });

      ws.on('close', () => done());
    });
  });
});
