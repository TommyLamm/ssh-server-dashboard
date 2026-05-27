require('dotenv').config();
const express = require('express');
const expressWs = require('express-ws');
const jwt = require('jsonwebtoken');
const path = require('path');
const db = require('./db');
const sshPool = require('./sshPool');

const app = express();
const wsInstance = expressWs(app);

app.use(express.json());
app.use(express.static(path.join(__dirname, '../public')));

const PORT = process.env.PORT || 3000;
const USERNAME = process.env.DASHBOARD_USERNAME || 'admin';
const PASSWORD = process.env.DASHBOARD_PASSWORD || 'admin';
const JWT_SECRET = process.env.DASHBOARD_SECRET || 'fallback-jwt-secret';

// Production Safeguard for JWT Secret
if (process.env.NODE_ENV === 'production' && (!process.env.DASHBOARD_SECRET || process.env.DASHBOARD_SECRET === 'fallback-jwt-secret')) {
  throw new Error('A secure, non-default DASHBOARD_SECRET environment variable is required in production.');
}

// Middleware to authenticate JWT
function authenticate(req, res, next) {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1];
  if (!token) return res.status(401).json({ error: 'Unauthorized' });

  jwt.verify(token, JWT_SECRET, (err, user) => {
    if (err) return res.status(403).json({ error: 'Forbidden' });
    req.user = user;
    next();
  });
}

// Safe WebSocket sender helper
function sendWs(ws, msg) {
  if (ws.readyState === 1) { // WebSocket.OPEN is 1
    try {
      ws.send(JSON.stringify(msg));
    } catch (err) {
      console.warn('WebSocket send failed:', err.message);
    }
  }
}

// REST endpoints
app.post('/api/login', (req, res) => {
  const { username, password } = req.body;
  if (username === USERNAME && password === PASSWORD) {
    const token = jwt.sign({ username }, JWT_SECRET, { expiresIn: '24h' });
    return res.json({ token });
  }
  res.status(401).json({ error: 'Invalid credentials' });
});

app.get('/api/servers', authenticate, async (req, res) => {
  try {
    const servers = await db.getServers();
    const sanitized = servers.map(s => ({
      id: s.id,
      name: s.name,
      host: s.host,
      port: s.port,
      username: s.username,
      auth_type: s.auth_type
    }));
    res.json(sanitized);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/servers', authenticate, async (req, res) => {
  try {
    const { name, host, username, port, auth_type } = req.body;

    if (typeof name !== 'string' || !name.trim()) {
      return res.status(400).json({ error: 'Name must be a non-empty string' });
    }
    if (typeof host !== 'string' || !host.trim()) {
      return res.status(400).json({ error: 'Host must be a non-empty string' });
    }
    if (typeof username !== 'string' || !username.trim()) {
      return res.status(400).json({ error: 'Username must be a non-empty string' });
    }
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      return res.status(400).json({ error: 'Port must be an integer between 1 and 65535' });
    }
    if (auth_type !== 'password' && auth_type !== 'key') {
      return res.status(400).json({ error: 'Auth type must be either password or key' });
    }

    const serverId = await db.addServer(req.body);
    res.status(201).json({ id: serverId });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.delete('/api/servers/:id', authenticate, async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    await db.deleteServer(id);
    sshPool.closeConnection(id);

    // Evict all WebSocket clients monitoring this server
    const wss = wsInstance.getWss();
    wss.clients.forEach(client => {
      if (client.activeServerId === id) {
        sendWs(client, { type: 'error', message: 'Server deleted' });
        if (client.monitorInterval) {
          clearInterval(client.monitorInterval);
          client.monitorInterval = null;
        }
        client.activeServerId = null;
      }
    });

    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// WebSocket real-time monitor stream
app.ws('/ws/monitor', (ws, req) => {
  // Prevent process crashes due to unhandled socket errors
  ws.on('error', (err) => {
    console.error('WebSocket client error:', err.message);
  });

  ws.activeServerId = null;
  ws.monitorInterval = null;
  let serverInfo = null;
  let authenticated = false;

  ws.on('message', async (msg) => {
    try {
      const data = JSON.parse(msg);

      if (data.type === 'auth') {
        jwt.verify(data.token, JWT_SECRET, async (err) => {
          if (err) {
            sendWs(ws, { type: 'error', message: 'Auth failed' });
            return ws.close();
          }
          authenticated = true;
          sendWs(ws, { type: 'authenticated' });
        });
        return;
      }

      if (!authenticated) {
        sendWs(ws, { type: 'error', message: 'Unauthorized' });
        return ws.close();
      }

      if (data.type === 'select-server') {
        if (ws.monitorInterval) {
          clearInterval(ws.monitorInterval);
          ws.monitorInterval = null;
        }
        ws.activeServerId = null;

        const servers = await db.getServers();
        serverInfo = servers.find(s => s.id === parseInt(data.serverId, 10));

        if (!serverInfo) {
          return sendWs(ws, { type: 'error', message: 'Server not found' });
        }

        ws.activeServerId = serverInfo.id;

        async function fetchMetrics() {
          try {
            if (ws.activeServerId !== serverInfo.id) return;
            const conn = await sshPool.getConnection(serverInfo);
            
            const [cpuOut, memOut, diskOut, uptimeOut] = await Promise.all([
              sshPool.execCommand(conn, "top -bn1 | grep 'Cpu(s)'"),
              sshPool.execCommand(conn, "free -b"),
              sshPool.execCommand(conn, "df -h --output=source,fstype,size,used,avail,pcent,target -x tmpfs -x devtmpfs"),
              sshPool.execCommand(conn, "uptime -p")
            ]);

            const cpu = sshPool.parseCpu(cpuOut);
            const mem = sshPool.parseMem(memOut);
            const disk = sshPool.parseDisk(diskOut);
            const uptime = uptimeOut.trim();

            sendWs(ws, {
              type: 'metrics',
              serverId: serverInfo.id,
              status: 'online',
              metrics: { cpu, mem, disk, uptime }
            });
          } catch (err) {
            sendWs(ws, {
              type: 'metrics',
              serverId: serverInfo.id,
              status: 'offline',
              error: err.message
            });
          }
        }

        fetchMetrics();
        ws.monitorInterval = setInterval(fetchMetrics, 2000);
      }

      if (data.type === 'fetch-processes') {
        if (!ws.activeServerId || !serverInfo || ws.activeServerId !== serverInfo.id) {
          return;
        }
        const conn = await sshPool.getConnection(serverInfo);
        const processesOut = await sshPool.execCommand(conn, "ps -eo pid,user,%cpu,%mem,comm --sort=-%cpu | head -n 30");
        const processes = sshPool.parseProcesses(processesOut);
        sendWs(ws, { type: 'processes', serverId: serverInfo.id, processes });
      }

      if (data.type === 'fetch-docker') {
        if (!ws.activeServerId || !serverInfo || ws.activeServerId !== serverInfo.id) {
          return;
        }
        try {
          const conn = await sshPool.getConnection(serverInfo);
          const dockerOut = await sshPool.execCommand(conn, "docker stats --no-stream --format '{\"name\":\"{{.Name}}\",\"cpu\":\"{{.CPUPerc}}\",\"mem\":\"{{.MemUsage}}\"}'");
          const containers = sshPool.parseDocker(dockerOut);
          sendWs(ws, { type: 'docker', serverId: serverInfo.id, containers });
        } catch (e) {
          sendWs(ws, { type: 'docker', serverId: serverInfo.id, error: 'Docker daemon unreachable or not installed' });
        }
      }

      if (data.type === 'fetch-logs') {
        if (!ws.activeServerId || !serverInfo || ws.activeServerId !== serverInfo.id) {
          return;
        }

        // Validation against command injection
        const serviceRegex = /^[a-zA-Z0-9_\-@.]*$/;
        const fileRegex = /^\/[a-zA-Z0-9_\-\/.]*$/;
        if (data.isService) {
          if (!data.logPath || !serviceRegex.test(data.logPath)) {
            return sendWs(ws, { type: 'error', message: 'Invalid service name' });
          }
        } else {
          if (!data.logPath || !fileRegex.test(data.logPath)) {
            return sendWs(ws, { type: 'error', message: 'Invalid log file path' });
          }
        }

        const conn = await sshPool.getConnection(serverInfo);
        let logCmd = `tail -n 100 "${data.logPath}"`;
        if (data.isService) {
          logCmd = `journalctl -u "${data.logPath}" -n 100 --no-pager`;
        }
        const logs = await sshPool.execCommand(conn, logCmd);
        sendWs(ws, { type: 'logs', serverId: serverInfo.id, logs });
      }

    } catch (e) {
      sendWs(ws, { type: 'error', message: e.message });
    }
  });

  ws.on('close', () => {
    if (ws.monitorInterval) {
      clearInterval(ws.monitorInterval);
      ws.monitorInterval = null;
    }
  });
});

if (require.main === module) {
  db.init().then(() => {
    app.listen(PORT, () => {
      console.log(`Server Dashboard listening on port ${PORT}`);
    });
  }).catch(err => {
    console.error("Database initialization failed:", err.message);
    process.exit(1);
  });
}

module.exports = app;
