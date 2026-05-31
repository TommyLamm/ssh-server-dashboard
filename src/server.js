require('dotenv').config();
const express = require('express');
const expressWs = require('express-ws');
const jwt = require('jsonwebtoken');
const path = require('path');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const db = require('./db');
const sshPool = require('./sshPool');
const logger = require('./logger');

const app = express();
const wsInstance = expressWs(app);

if (process.env.NODE_ENV === 'production') {
  app.set('trust proxy', 1);
}

app.use(cors({
  origin: process.env.CORS_ORIGIN || false,
  credentials: true
}));
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'"],
      styleSrc: ["'self'", "'unsafe-inline'", "https://fonts.googleapis.com"],
      fontSrc: ["'self'", "https://fonts.gstatic.com"],
      connectSrc: ["'self'", "ws:", "wss:"],
      imgSrc: ["'self'", "data:"],
      upgradeInsecureRequests: null, // Allow HTTP connections on LAN without forcing HTTPS upgrade
    }
  }
}));
app.use(express.json({ limit: '10kb' }));
app.use(express.static(path.join(__dirname, '../public')));

// M2: In production, deploy behind a reverse proxy (nginx/Caddy) with TLS termination.
// This server does not handle HTTPS directly. Ensure the proxy sets X-Forwarded-Proto.

const PORT = process.env.PORT || 3000;
const USERNAME = process.env.DASHBOARD_USERNAME;
const PASSWORD = process.env.DASHBOARD_PASSWORD;
const JWT_SECRET = process.env.DASHBOARD_SECRET;
const POLL_INTERVAL = parseInt(process.env.POLL_INTERVAL, 10) || 3000;
const LOG_TAIL_LINES = Math.min(Math.max(parseInt(process.env.LOG_TAIL_LINES, 10) || 100, 1), 10000);
const MAX_PROCESSES = Math.min(Math.max(parseInt(process.env.MAX_PROCESSES, 10) || 30, 1), 500);

// Startup Safeguard: always require credentials (regardless of NODE_ENV)
if (!USERNAME || !PASSWORD) {
  throw new Error('DASHBOARD_USERNAME and DASHBOARD_PASSWORD environment variables are required.');
}
if (!JWT_SECRET) {
  throw new Error('DASHBOARD_SECRET environment variable is required.');
}

const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  message: { error: 'Too many login attempts. Please try again later.' },
  standardHeaders: true,
  legacyHeaders: false
});

// NOTE: Single-admin-user system. All authenticated users share the same
// access level to all registered servers. If multi-user support is needed,
// implement per-user server ownership and role-based access control (RBAC).

// Parse JWT token from httpOnly cookie or Authorization header
function getCookieToken(req) {
  const cookieHeader = req.headers.cookie;
  if (!cookieHeader) return null;
  const match = cookieHeader.match(/(?:^|;\s*)token=([^;]*)/);
  return match ? match[1] : null;
}

// Middleware to authenticate JWT
function authenticate(req, res, next) {
  let tokenValue = getCookieToken(req);
  if (!tokenValue) {
    const authHeader = req.headers['authorization'];
    if (authHeader && authHeader.startsWith('Bearer ')) {
      tokenValue = authHeader.split(' ')[1];
    }
  }
  if (!tokenValue) return res.status(401).json({ error: 'Unauthorized' });

  jwt.verify(tokenValue, JWT_SECRET, (err, user) => {
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
      logger.warn('WebSocket send failed', { error: err.message });
    }
  }
}

// M6: Progressive account lockout tracking
const failedAttempts = new Map();
setInterval(() => {
  const cutoff = Date.now() - 3600000;
  for (const [ip, data] of failedAttempts) {
    if (data.lastAttempt < cutoff) failedAttempts.delete(ip);
  }
}, 600000);

// REST endpoints
app.post('/api/login', loginLimiter, (req, res) => {
  const clientIp = req.ip;
  const attempts = failedAttempts.get(clientIp) || { count: 0, lastAttempt: 0 };

  // Progressive lockout after 5 failed attempts
  if (attempts.count >= 5) {
    const lockoutMs = Math.min(Math.pow(2, attempts.count - 5) * 60000, 3600000);
    const elapsed = Date.now() - attempts.lastAttempt;
    if (elapsed < lockoutMs) {
      const remainingSec = Math.ceil((lockoutMs - elapsed) / 1000);
      return res.status(429).json({ error: `Account locked. Try again in ${remainingSec} seconds.` });
    }
  }

  const { username, password } = req.body;
  if (username === USERNAME && password === PASSWORD) {
    failedAttempts.delete(clientIp);
    const token = jwt.sign({ username }, JWT_SECRET, { expiresIn: '24h' });
    res.cookie('token', token, {
      httpOnly: true,
      sameSite: 'strict',
      path: '/',
      maxAge: 24 * 60 * 60 * 1000,
      secure: process.env.NODE_ENV === 'production' && req.secure
    });
    return res.json({ success: true });
  }
  attempts.count++;
  attempts.lastAttempt = Date.now();
  failedAttempts.set(clientIp, attempts);
  logger.warn('Failed login attempt', { ip: clientIp, attempt: attempts.count });
  res.status(401).json({ error: 'Invalid credentials' });
});

app.post('/api/logout', (req, res) => {
  res.clearCookie('token', { httpOnly: true, sameSite: 'strict', path: '/' });
  res.json({ success: true });
});

app.get('/api/servers', authenticate, async (req, res) => {
  try {
    const servers = await db.getServersListView();
    res.json(servers);
  } catch (err) {
    const errMsg = process.env.NODE_ENV === 'production' ? 'Internal server error' : err.message;
    res.status(500).json({ error: errMsg });
  }
});

app.post('/api/servers', authenticate, async (req, res) => {
  try {
    const { name, host, username, port, auth_type, password, private_key } = req.body || {};

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
    if (auth_type === 'password' && (typeof password !== 'string' || !password.trim())) {
      return res.status(400).json({ error: 'Password must be a non-empty string when auth_type is password' });
    }
    if (auth_type === 'key' && (typeof private_key !== 'string' || !private_key.trim())) {
      return res.status(400).json({ error: 'Private key must be a non-empty string when auth_type is key' });
    }

    const serverId = await db.addServer({ name, host, username, port, auth_type, password, private_key });
    res.status(201).json({ id: serverId });
  } catch (err) {
    const errMsg = process.env.NODE_ENV === 'production' ? 'Internal server error' : err.message;
    res.status(500).json({ error: errMsg });
  }
});

app.put('/api/servers/:id', authenticate, async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (isNaN(id)) return res.status(400).json({ error: 'Invalid server ID' });
    
    const { name, host, username, port, auth_type, password, private_key } = req.body || {};
    const updates = {};
    if (name !== undefined) {
      if (typeof name !== 'string' || !name.trim()) return res.status(400).json({ error: 'Name must be a non-empty string' });
      updates.name = name;
    }
    if (host !== undefined) {
      if (typeof host !== 'string' || !host.trim()) return res.status(400).json({ error: 'Host must be a non-empty string' });
      updates.host = host;
    }
    if (port !== undefined) {
      if (!Number.isInteger(port) || port < 1 || port > 65535) return res.status(400).json({ error: 'Port must be an integer between 1 and 65535' });
      updates.port = port;
    }
    if (username !== undefined) {
      if (typeof username !== 'string' || !username.trim()) return res.status(400).json({ error: 'Username must be a non-empty string' });
      updates.username = username;
    }
    if (auth_type !== undefined) {
      if (auth_type !== 'password' && auth_type !== 'key') return res.status(400).json({ error: 'Auth type must be either password or key' });
      updates.auth_type = auth_type;
    }
    if (password !== undefined) updates.password = password;
    if (private_key !== undefined) updates.private_key = private_key;
    
    const changes = await db.updateServer(id, updates);
    if (changes === 0) return res.status(404).json({ error: 'Server not found or no changes made' });
    
    sshPool.closeConnection(id);
    res.json({ success: true, changes });
  } catch (err) {
    const errMsg = process.env.NODE_ENV === 'production' ? 'Internal server error' : err.message;
    res.status(500).json({ error: errMsg });
  }
});

app.delete('/api/servers/:id', authenticate, async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (isNaN(id)) return res.status(400).json({ error: 'Invalid server ID' });
    const changes = await db.deleteServer(id);
    if (changes === 0) return res.status(404).json({ error: 'Server not found' });
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
    const errMsg = process.env.NODE_ENV === 'production' ? 'Internal server error' : err.message;
    res.status(500).json({ error: errMsg });
  }
});

app.get('/health', (req, res) => {
  res.json({ status: 'ok', uptime: process.uptime() });
});

// WebSocket real-time monitor stream
app.ws('/ws/monitor', (ws, req) => {
  const MAX_WS_CONNECTIONS = parseInt(process.env.MAX_WS_CONNECTIONS, 10) || 50;
  const wss = wsInstance.getWss();
  if (wss.clients.size > MAX_WS_CONNECTIONS) {
    ws.close(1013, 'Maximum connections reached');
    return;
  }

  // HTTP-level JWT verification via cookie or query parameter
  const wsToken = getCookieToken(req) || (req.query && req.query.token);
  if (!wsToken) {
    ws.close(1008, 'Authentication required');
    return;
  }
  try {
    jwt.verify(wsToken, JWT_SECRET);
  } catch (err) {
    ws.close(1008, 'Invalid token');
    return;
  }

  // Prevent process crashes due to unhandled socket errors
  ws.on('error', (err) => {
    logger.error('WebSocket client error', { error: err.message });
  });

  ws.activeServerId = null;
  ws.monitorInterval = null;
  ws.authenticated = true;

  // Notify client that auth is complete
  sendWs(ws, { type: 'authenticated' });

  let activeSessionId = 0;
  let serverInfo = null;

  // H2 Fix: Per-connection WebSocket message rate limiting
  const wsMessageTimestamps = [];
  const WS_RATE_LIMIT = 20;     // max messages per window
  const WS_RATE_WINDOW = 5000;  // 5-second sliding window (ms)

  ws.on('message', async (msg) => {
    try {
      // Rate limiting check
      const now = Date.now();
      wsMessageTimestamps.push(now);
      while (wsMessageTimestamps.length > 0 && wsMessageTimestamps[0] < now - WS_RATE_WINDOW) {
        wsMessageTimestamps.shift();
      }
      if (wsMessageTimestamps.length > WS_RATE_LIMIT) {
        return sendWs(ws, { type: 'error', message: 'Rate limit exceeded. Please slow down.' });
      }

      const data = JSON.parse(msg);

      if (data.type === 'select-server') {
        const currentSessionId = ++activeSessionId;

        if (ws.monitorInterval) {
          clearInterval(ws.monitorInterval);
          ws.monitorInterval = null;
        }
        ws.activeServerId = null;

        serverInfo = await db.getServerById(parseInt(data.serverId, 10));
        if (currentSessionId !== activeSessionId) return;

        if (!serverInfo) {
          return sendWs(ws, { type: 'error', message: 'Server not found' });
        }

        ws.activeServerId = serverInfo.id;

        async function fetchMetrics() {
          try {
            if (currentSessionId !== activeSessionId) return;
            if (ws.activeServerId !== serverInfo.id) return;
            const conn = await sshPool.getConnection(serverInfo);
            
            const [cpuOut, memOut, diskOut, uptimeOut] = await Promise.all([
              sshPool.execCommand(conn, "cat /proc/stat; sleep 0.5; cat /proc/stat"),
              sshPool.execCommand(conn, "free -b"),
              sshPool.execCommand(conn, "df -h --output=source,fstype,size,used,avail,pcent,target -x tmpfs -x devtmpfs"),
              sshPool.execCommand(conn, "uptime -p")
            ]);

            const cpuData = sshPool.parseCpu(cpuOut);
            const cpu = typeof cpuData === 'object' && cpuData !== null ? cpuData.overall : cpuData;
            const cpuCores = typeof cpuData === 'object' && cpuData !== null ? cpuData.cores : [];
            const mem = sshPool.parseMem(memOut);
            const disk = sshPool.parseDisk(diskOut);
            const uptime = uptimeOut.trim();

            if (currentSessionId !== activeSessionId) return;

            sendWs(ws, {
              type: 'metrics',
              serverId: serverInfo.id,
              status: 'online',
              metrics: { cpu, cores: cpuCores, mem, disk, uptime }
            });
          } catch (err) {
            if (currentSessionId !== activeSessionId) return;
            sendWs(ws, {
              type: 'metrics',
              serverId: serverInfo.id,
              status: 'offline',
              error: process.env.NODE_ENV === 'production' ? 'Connection failed' : err.message
            });
          }
        }

        fetchMetrics();
        ws.monitorInterval = setInterval(fetchMetrics, POLL_INTERVAL);
      }

      if (data.type === 'fetch-processes') {
        const targetServer = serverInfo;
        if (!ws.activeServerId || !targetServer || ws.activeServerId !== targetServer.id) {
          return;
        }
        const conn = await sshPool.getConnection(targetServer);
        const processesOut = await sshPool.execCommand(conn, 'top -b -n 2 -d 0.2');
        const processes = sshPool.parseProcesses(processesOut);

        // Filter out idle kernel threads (0% CPU and 0 MB Memory)
        const activeProcesses = processes.filter(p => p.cpu > 0 || p.mem > 0);

        // Sort by CPU descending, then Memory descending as tie-breaker
        activeProcesses.sort((a, b) => {
          if (b.cpu !== a.cpu) {
            return b.cpu - a.cpu;
          }
          return b.mem - a.mem;
        });

        sendWs(ws, { type: 'processes', serverId: targetServer.id, processes: activeProcesses.slice(0, MAX_PROCESSES) });
      }

      if (data.type === 'fetch-docker') {
        const targetServer = serverInfo;
        if (!ws.activeServerId || !targetServer || ws.activeServerId !== targetServer.id) {
          return;
        }
        try {
          const conn = await sshPool.getConnection(targetServer);
          const dockerOut = await sshPool.execCommand(conn, "docker stats --no-stream --format '{\"name\":\"{{.Name}}\",\"cpu\":\"{{.CPUPerc}}\",\"mem\":\"{{.MemUsage}}\"}'");
          const containers = sshPool.parseDocker(dockerOut);
          sendWs(ws, { type: 'docker', serverId: targetServer.id, containers });
        } catch (e) {
          sendWs(ws, { type: 'docker', serverId: targetServer.id, error: 'Docker daemon unreachable or not installed' });
        }
      }

      if (data.type === 'fetch-logs') {
        const targetServer = serverInfo;
        if (!ws.activeServerId || !targetServer || ws.activeServerId !== targetServer.id) {
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
          if (data.logPath.includes('..')) {
            return sendWs(ws, { type: 'error', message: 'Invalid log file path' });
          }
          if (!data.logPath.startsWith('/var/log/')) {
            return sendWs(ws, { type: 'error', message: 'Invalid log file path' });
          }
        }

        const conn = await sshPool.getConnection(targetServer);
        let logCmd = `tail -n ${LOG_TAIL_LINES} "${data.logPath}"`;
        if (data.isService) {
          logCmd = `journalctl -u "${data.logPath}" -n ${LOG_TAIL_LINES} --no-pager`;
        }
        const logs = await sshPool.execCommand(conn, logCmd);
        sendWs(ws, { type: 'logs', serverId: targetServer.id, logs });
      }

    } catch (e) {
      const errMsg = process.env.NODE_ENV === 'production' ? 'Internal error' : e.message;
      sendWs(ws, { type: 'error', message: errMsg });
    }
  });

  ws.on('close', () => {
    if (ws.monitorInterval) {
      clearInterval(ws.monitorInterval);
      ws.monitorInterval = null;
    }
  });
});

function gracefulShutdown(signal) {
  logger.info('Shutting down gracefully', { signal });
  const wss = wsInstance.getWss();
  wss.clients.forEach(client => {
    if (client.monitorInterval) clearInterval(client.monitorInterval);
    client.close(1001, 'Server shutting down');
  });
  sshPool.closeAll();
  db.close().then(() => {
    logger.info('Cleanup complete, exiting');
    process.exit(0);
  }).catch(() => process.exit(1));
}
process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));

if (require.main === module) {
  db.init().then(() => {
    app.listen(PORT, () => {
      logger.info('Server Dashboard started', { port: PORT });
    });
  }).catch(err => {
    logger.error('Database initialization failed', { error: err.message });
    process.exit(1);
  });
}

module.exports = app;
