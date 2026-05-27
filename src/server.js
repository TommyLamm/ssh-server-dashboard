require('dotenv').config();
const express = require('express');
const expressWs = require('express-ws');
const jwt = require('jsonwebtoken');
const path = require('path');
const db = require('./db');
const sshPool = require('./sshPool');

const app = express();
expressWs(app);

app.use(express.json());
app.use(express.static(path.join(__dirname, '../public')));

const PORT = process.env.PORT || 3000;
const USERNAME = process.env.DASHBOARD_USERNAME || 'admin';
const PASSWORD = process.env.DASHBOARD_PASSWORD || 'admin';
const JWT_SECRET = process.env.DASHBOARD_SECRET || 'fallback-jwt-secret';

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
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// WebSocket real-time monitor stream
app.ws('/ws/monitor', (ws, req) => {
  let intervalId = null;
  let serverInfo = null;
  let authenticated = false;

  ws.on('message', async (msg) => {
    try {
      const data = JSON.parse(msg);

      if (data.type === 'auth') {
        jwt.verify(data.token, JWT_SECRET, async (err) => {
          if (err) {
            ws.send(JSON.stringify({ type: 'error', message: 'Auth failed' }));
            return ws.close();
          }
          authenticated = true;
          ws.send(JSON.stringify({ type: 'authenticated' }));
        });
        return;
      }

      if (!authenticated) {
        ws.send(JSON.stringify({ type: 'error', message: 'Unauthorized' }));
        return ws.close();
      }

      if (data.type === 'select-server') {
        if (intervalId) {
          clearInterval(intervalId);
          intervalId = null;
        }

        const servers = await db.getServers();
        serverInfo = servers.find(s => s.id === parseInt(data.serverId, 10));

        if (!serverInfo) {
          return ws.send(JSON.stringify({ type: 'error', message: 'Server not found' }));
        }

        async function fetchMetrics() {
          try {
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

            ws.send(JSON.stringify({
              type: 'metrics',
              serverId: serverInfo.id,
              status: 'online',
              metrics: { cpu, mem, disk, uptime }
            }));
          } catch (err) {
            ws.send(JSON.stringify({
              type: 'metrics',
              serverId: serverInfo.id,
              status: 'offline',
              error: err.message
            }));
          }
        }

        fetchMetrics();
        intervalId = setInterval(fetchMetrics, 2000);
      }

      if (data.type === 'fetch-processes') {
        if (!serverInfo) return;
        const conn = await sshPool.getConnection(serverInfo);
        const processesOut = await sshPool.execCommand(conn, "ps -eo pid,user,%cpu,%mem,comm --sort=-%cpu | head -n 30");
        const processes = sshPool.parseProcesses(processesOut);
        ws.send(JSON.stringify({ type: 'processes', processes }));
      }

      if (data.type === 'fetch-docker') {
        if (!serverInfo) return;
        try {
          const conn = await sshPool.getConnection(serverInfo);
          const dockerOut = await sshPool.execCommand(conn, "docker stats --no-stream --format '{\"name\":\"{{.Name}}\",\"cpu\":\"{{.CPUPerc}}\",\"mem\":\"{{.MemUsage}}\"}'");
          const containers = sshPool.parseDocker(dockerOut);
          ws.send(JSON.stringify({ type: 'docker', containers }));
        } catch (e) {
          ws.send(JSON.stringify({ type: 'docker', error: 'Docker daemon unreachable or not installed' }));
        }
      }

      if (data.type === 'fetch-logs') {
        if (!serverInfo) return;
        const conn = await sshPool.getConnection(serverInfo);
        let logCmd = `tail -n 100 "${data.logPath}"`;
        if (data.isService) {
          logCmd = `journalctl -u "${data.logPath}" -n 100 --no-pager`;
        }
        const logs = await sshPool.execCommand(conn, logCmd);
        ws.send(JSON.stringify({ type: 'logs', logs }));
      }

    } catch (e) {
      ws.send(JSON.stringify({ type: 'error', message: e.message }));
    }
  });

  ws.on('close', () => {
    if (intervalId) {
      clearInterval(intervalId);
      intervalId = null;
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
