const http = require('http');
const jwt = require('jsonwebtoken');
const app = require('../src/server');
const db = require('../src/db');
const sshPool = require('../src/sshPool');
const WebSocket = require('ws');

// Mock db and sshPool
jest.mock('../src/db');
jest.mock('../src/sshPool');

describe('Server & WebSocket API', () => {
  let server;
  let port;

  beforeAll((done) => {
    // Start listening on a random port
    server = app.listen(0, () => {
      port = server.address().port;
      done();
    });
  });

  afterAll((done) => {
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

  beforeEach(() => {
    jest.clearAllMocks();
  });

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

  test('POST /api/login success', async () => {
    const res = await makeRequest('POST', '/api/login', {
      username: 'admin',
      password: 'admin'
    });
    expect(res.status).toBe(200);
    expect(res.body.token).toBeDefined();
  });

  test('POST /api/login invalid credentials', async () => {
    const res = await makeRequest('POST', '/api/login', {
      username: 'admin',
      password: 'wrong'
    });
    expect(res.status).toBe(401);
  });

  test('GET /api/servers unauthorized without token', async () => {
    const res = await makeRequest('GET', '/api/servers');
    expect(res.status).toBe(401);
  });

  test('GET /api/servers success with token', async () => {
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

    const token = jwt.sign({ username: 'admin' }, 'fallback-jwt-secret');
    const res = await makeRequest('GET', '/api/servers', null, {
      'Authorization': `Bearer ${token}`
    });
    expect(res.status).toBe(200);
    expect(res.body).toBeInstanceOf(Array);
    expect(res.body[0].name).toBe('Server 1');
    expect(res.body[0].password).toBeUndefined();
    expect(res.body[0].private_key).toBeUndefined();
  });

  test('POST /api/servers success with token', async () => {
    db.addServer.mockResolvedValue(2);

    const token = jwt.sign({ username: 'admin' }, 'fallback-jwt-secret');
    const res = await makeRequest('POST', '/api/servers', {
      name: 'New Server',
      host: '2.2.2.2',
      port: 22,
      username: 'root',
      auth_type: 'password',
      password: 'newpassword',
      private_key: ''
    }, {
      'Authorization': `Bearer ${token}`
    });
    expect(res.status).toBe(201);
    expect(res.body.id).toBe(2);
    expect(db.addServer).toHaveBeenCalled();
  });

  test('POST /api/servers fails validation with invalid/missing name', async () => {
    const token = jwt.sign({ username: 'admin' }, 'fallback-jwt-secret');
    const res = await makeRequest('POST', '/api/servers', {
      name: '',
      host: '2.2.2.2',
      port: 22,
      username: 'root',
      auth_type: 'password'
    }, {
      'Authorization': `Bearer ${token}`
    });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('Name must be a non-empty string');
  });

  test('POST /api/servers fails validation with invalid port', async () => {
    const token = jwt.sign({ username: 'admin' }, 'fallback-jwt-secret');
    const res = await makeRequest('POST', '/api/servers', {
      name: 'Server Name',
      host: '2.2.2.2',
      port: 99999,
      username: 'root',
      auth_type: 'password'
    }, {
      'Authorization': `Bearer ${token}`
    });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('Port must be an integer between 1 and 65535');
  });

  test('POST /api/servers fails validation with invalid auth_type', async () => {
    const token = jwt.sign({ username: 'admin' }, 'fallback-jwt-secret');
    const res = await makeRequest('POST', '/api/servers', {
      name: 'Server Name',
      host: '2.2.2.2',
      port: 22,
      username: 'root',
      auth_type: 'invalid-auth'
    }, {
      'Authorization': `Bearer ${token}`
    });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('Auth type must be either password or key');
  });

  test('POST /api/servers fails validation with missing password for password auth_type', async () => {
    const token = jwt.sign({ username: 'admin' }, 'fallback-jwt-secret');
    const res = await makeRequest('POST', '/api/servers', {
      name: 'Server 1',
      host: '2.2.2.2',
      port: 22,
      username: 'root',
      auth_type: 'password',
      password: ''
    }, {
      'Authorization': `Bearer ${token}`
    });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('Password must be a non-empty string when auth_type is password');
  });

  test('POST /api/servers fails validation with missing private_key for key auth_type', async () => {
    const token = jwt.sign({ username: 'admin' }, 'fallback-jwt-secret');
    const res = await makeRequest('POST', '/api/servers', {
      name: 'Server 1',
      host: '2.2.2.2',
      port: 22,
      username: 'root',
      auth_type: 'key',
      private_key: ''
    }, {
      'Authorization': `Bearer ${token}`
    });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('Private key must be a non-empty string when auth_type is key');
  });

  test('DELETE /api/servers/:id success with token', async () => {
    db.deleteServer.mockResolvedValue(1);

    const token = jwt.sign({ username: 'admin' }, 'fallback-jwt-secret');
    const res = await makeRequest('DELETE', '/api/servers/1', null, {
      'Authorization': `Bearer ${token}`
    });
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(db.deleteServer).toHaveBeenCalledWith(1);
    expect(sshPool.closeConnection).toHaveBeenCalledWith(1);
  });

  test('WebSocket /ws/monitor auth failed', (done) => {
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
    ws.on('close', () => {
      done();
    });
  });

  test('WebSocket /ws/monitor auth and select-server success', (done) => {
    const token = jwt.sign({ username: 'admin' }, 'fallback-jwt-secret');
    const ws = new WebSocket(`ws://localhost:${port}/ws/monitor`);

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

    const mockConn = {};
    sshPool.getConnection.mockResolvedValue(mockConn);
    sshPool.execCommand.mockImplementation((conn, cmd) => {
      if (cmd.includes('Cpu(s)')) return Promise.resolve('%Cpu(s): 10.0 us, 5.0 sy, 85.0 id');
      if (cmd.includes('free')) return Promise.resolve('Mem: 1000 500');
      if (cmd.includes('df')) return Promise.resolve('/dev/sda1 ext4 100G 40G 60G 40% /');
      if (cmd.includes('uptime')) return Promise.resolve('up 2 hours');
      if (cmd.includes('ps -eo')) return Promise.resolve('PID USER %CPU %MEM COMMAND\n1204 root 2.4 0.5 nginx');
      if (cmd.includes('docker stats')) return Promise.resolve('{"name":"web","cpu":"1.5%","mem":"50MiB / 1GiB"}');
      if (cmd.includes('tail -n 100')) return Promise.resolve('file logs');
      return Promise.resolve('');
    });
    sshPool.parseCpu.mockReturnValue(15.0);
    sshPool.parseMem.mockReturnValue({ total: 1000, used: 500, percent: 50.0 });
    sshPool.parseDisk.mockReturnValue([{ device: '/dev/sda1', used_percent: 40 }]);
    sshPool.parseProcesses.mockReturnValue([{ pid: 1204, user: 'root', cpu: 2.4, mem: 0.5, command: 'nginx' }]);
    sshPool.parseDocker.mockReturnValue([{ name: 'web', cpu: '1.5%', mem: '50MiB / 1GiB' }]);

    ws.on('open', () => {
      ws.send(JSON.stringify({ type: 'auth', token }));
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
        
        ws.send(JSON.stringify({ type: 'fetch-processes' }));
      } else if (data.type === 'processes') {
        expect(data.processes[0].pid).toBe(1204);
        expect(data.serverId).toBe(1);
        
        ws.send(JSON.stringify({ type: 'fetch-docker' }));
      } else if (data.type === 'docker') {
        expect(data.containers[0].name).toBe('web');
        expect(data.serverId).toBe(1);

        ws.send(JSON.stringify({ type: 'fetch-logs', logPath: '/var/log/syslog', isService: false }));
      } else if (data.type === 'logs') {
        expect(data.logs).toBe('file logs');
        expect(data.serverId).toBe(1);
        ws.close();
      }
    });

    ws.on('close', () => {
      done();
    });
  });

  test('WebSocket /ws/monitor rejects command injection in fetch-logs', (done) => {
    const token = jwt.sign({ username: 'admin' }, 'fallback-jwt-secret');
    const ws = new WebSocket(`ws://localhost:${port}/ws/monitor`);

    db.getServers.mockResolvedValue([
      { id: 1, name: 'Server 1', host: '1.1.1.1', port: 22, username: 'root', auth_type: 'password' }
    ]);

    ws.on('open', () => {
      ws.send(JSON.stringify({ type: 'auth', token }));
    });

    let step = 0;
    ws.on('message', (msg) => {
      const data = JSON.parse(msg);
      if (data.type === 'authenticated') {
        ws.send(JSON.stringify({ type: 'select-server', serverId: 1 }));
      } else if (data.type === 'metrics') {
        ws.send(JSON.stringify({ type: 'fetch-logs', logPath: '/var/log/syslog; rm -rf /', isService: false }));
      } else if (data.type === 'error' && step === 0) {
        expect(data.message).toBe('Invalid log file path');
        step = 1;
        ws.send(JSON.stringify({ type: 'fetch-logs', logPath: 'nginx; rm -rf /', isService: true }));
      } else if (data.type === 'error' && step === 1) {
        expect(data.message).toBe('Invalid service name');
        ws.close();
      }
    });

    ws.on('close', () => {
      done();
    });
  });

  test('WebSocket /ws/monitor evicts clients when a server is deleted', (done) => {
    const token = jwt.sign({ username: 'admin' }, 'fallback-jwt-secret');
    const ws = new WebSocket(`ws://localhost:${port}/ws/monitor`);

    db.getServers.mockResolvedValue([
      { id: 1, name: 'Server 1', host: '1.1.1.1', port: 22, username: 'root', auth_type: 'password' }
    ]);
    const mockConn = {};
    sshPool.getConnection.mockResolvedValue(mockConn);
    sshPool.execCommand.mockResolvedValue('');

    ws.on('open', () => {
      ws.send(JSON.stringify({ type: 'auth', token }));
    });

    ws.on('message', async (msg) => {
      const data = JSON.parse(msg);
      if (data.type === 'authenticated') {
        ws.send(JSON.stringify({ type: 'select-server', serverId: 1 }));
      } else if (data.type === 'metrics') {
        db.deleteServer.mockResolvedValue(1);
        const res = await makeRequest('DELETE', '/api/servers/1', null, {
          'Authorization': `Bearer ${token}`
        });
        expect(res.status).toBe(200);
        expect(res.body.success).toBe(true);
      } else if (data.type === 'error') {
        expect(data.message).toBe('Server deleted');
        ws.close();
      }
    });

    ws.on('close', () => {
      done();
    });
  });
});
