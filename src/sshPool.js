const { Client } = require('ssh2');

function parseCpu(stdout) {
  const match = stdout.match(/%Cpu\(s\):\s*([\d.]+)\s*us,\s*([\d.]+)\s*sy/);
  if (match) {
    return parseFloat(match[1]) + parseFloat(match[2]);
  }
  return 0.0;
}

function parseMem(stdout) {
  const lines = stdout.split('\n');
  const memLine = lines.find(l => l.trim().startsWith('Mem:'));
  if (memLine) {
    const cols = memLine.replace(/\s+/g, ' ').trim().split(' ');
    const total = parseInt(cols[1], 10);
    const used = parseInt(cols[2], 10);
    const percent = total > 0 ? (used / total) * 100 : 0;
    return { total, used, percent };
  }
  return { total: 0, used: 0, percent: 0 };
}

function parseDisk(stdout) {
  const lines = stdout.trim().split('\n');
  const disks = [];
  lines.forEach(line => {
    if (!line || line.startsWith('source') || line.trim().startsWith('Filesystem')) return;
    const cols = line.replace(/\s+/g, ' ').trim().split(' ');
    if (cols.length >= 7) {
      disks.push({
        device: cols[0],
        fstype: cols[1],
        size: cols[2],
        used: cols[3],
        avail: cols[4],
        used_percent: parseInt(cols[5].replace('%', ''), 10),
        mount: cols[6]
      });
    }
  });
  return disks;
}

function parseProcesses(stdout) {
  const lines = stdout.trim().split('\n');
  const processes = [];
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;
    const cols = line.replace(/\s+/g, ' ').split(' ');
    if (cols.length >= 5) {
      processes.push({
        pid: parseInt(cols[0], 10),
        user: cols[1],
        cpu: parseFloat(cols[2]),
        mem: parseFloat(cols[3]),
        command: cols.slice(4).join(' ')
      });
    }
  }
  return processes;
}

function parseDocker(stdout) {
  const lines = stdout.trim().split('\n');
  const containers = [];
  lines.forEach(line => {
    if (!line) return;
    try {
      containers.push(JSON.parse(line));
    } catch (e) {
      // Skip invalid JSON
    }
  });
  return containers;
}

// Active connections pool mapping server ID to client connections
const pool = {};

function getConnection(server) {
  return new Promise((resolve, reject) => {
    if (pool[server.id]) {
      return resolve(pool[server.id]);
    }

    const conn = new Client();
    conn.on('ready', () => {
      pool[server.id] = conn;
      resolve(conn);
    }).on('error', (err) => {
      delete pool[server.id];
      reject(err);
    }).on('close', () => {
      delete pool[server.id];
    }).connect({
      host: server.host,
      port: server.port || 22,
      username: server.username,
      password: server.auth_type === 'password' ? server.password : undefined,
      privateKey: server.auth_type === 'key' ? server.private_key : undefined,
      readyTimeout: 10000
    });
  });
}

function execCommand(conn, cmd) {
  return new Promise((resolve, reject) => {
    conn.exec(cmd, (err, stream) => {
      if (err) return reject(err);
      let stdout = '';
      let stderr = '';
      stream.on('close', (code) => {
        if (code !== 0) {
          reject(new Error(stderr || `Exited with code ${code}`));
        } else {
          resolve(stdout);
        }
      }).on('data', (data) => {
        stdout += data.toString();
      }).stderr.on('data', (data) => {
        stderr += data.toString();
      });
    });
  });
}

module.exports = {
  parseCpu,
  parseMem,
  parseDisk,
  parseProcesses,
  parseDocker,
  getConnection,
  execCommand,
  pool
};
