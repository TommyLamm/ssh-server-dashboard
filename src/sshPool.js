const { Client } = require('ssh2');

function parseCpu(stdout) {
  const lines = stdout.split('\n');
  const cpuLine = lines.find(l => l.trim().startsWith('%Cpu(s):'));
  if (cpuLine) {
    const match = cpuLine.match(/([\d.]+)\s*%?\s*id/);
    if (match) {
      const idle = parseFloat(match[1]);
      if (isNaN(idle)) return 0.0;
      return Math.max(0, Math.min(100, 100 - idle));
    }
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
    if (isNaN(total) || isNaN(used) || isNaN(percent)) {
      return { total: 0, used: 0, percent: 0 };
    }
    return { total, used, percent };
  }
  return { total: 0, used: 0, percent: 0 };
}

function parseDisk(stdout) {
  const lines = stdout.trim().split('\n');
  const disks = [];
  lines.forEach(line => {
    if (!line || line.trim().startsWith('source') || line.trim().startsWith('Filesystem')) return;
    const cols = line.replace(/\s+/g, ' ').trim().split(' ');
    if (cols.length >= 7) {
      let used_percent = parseInt(cols[5].replace('%', ''), 10);
      if (isNaN(used_percent)) {
        used_percent = 0;
      }
      disks.push({
        device: cols[0],
        fstype: cols[1],
        size: cols[2],
        used: cols[3],
        avail: cols[4],
        used_percent,
        mount: cols.slice(6).join(' ')
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
      let pid = parseInt(cols[0], 10);
      let cpu = parseFloat(cols[2]);
      let mem = parseFloat(cols[3]);
      if (isNaN(pid)) pid = 0;
      if (isNaN(cpu)) cpu = 0.0;
      if (isNaN(mem)) mem = 0.0;
      processes.push({
        pid,
        user: cols[1],
        cpu,
        mem,
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
      const parsed = JSON.parse(line);
      if (parsed !== null && typeof parsed === 'object') {
        containers.push(parsed);
      }
    } catch (e) {
      // Skip invalid JSON
    }
  });
  return containers;
}

// Active connections pool mapping server ID to client connection promise
const pool = {};

function getConnection(server) {
  if (pool[server.id]) {
    return pool[server.id];
  }

  const promise = new Promise((resolve, reject) => {
    const conn = new Client();
    conn.on('ready', () => {
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
      readyTimeout: 10000,
      keepaliveInterval: 10000,
      keepaliveCountMax: 3
    });
  });

  pool[server.id] = promise;
  return promise;
}

function closeConnection(serverId) {
  const promise = pool[serverId];
  if (promise) {
    delete pool[serverId];
    promise.then(conn => {
      try { conn.end(); } catch (e) {}
    }).catch(() => {});
  }
}

function execCommand(conn, cmd) {
  return new Promise((resolve, reject) => {
    let streamRef = null;
    let timedOut = false;

    const timeoutId = setTimeout(() => {
      timedOut = true;
      if (streamRef) {
        try { streamRef.destroy(); } catch (e) {}
      }
      reject(new Error(`Command timed out after 15s: ${cmd}`));
    }, 15000);

    // Enforce C locale for parsing reliability
    try {
      conn.exec(`export LC_ALL=C; ${cmd}`, (err, stream) => {
        if (err) {
          clearTimeout(timeoutId);
          return reject(err);
        }
        if (timedOut) {
          try { stream.destroy(); } catch (e) {}
          return;
        }
        streamRef = stream;

        let stdout = '';
        let stderr = '';

        const cleanup = () => {
          clearTimeout(timeoutId);
        };

        stream.on('close', (code) => {
          cleanup();
          if (code !== 0) {
            reject(new Error(stderr.trim() || `Exited with code ${code}`));
          } else {
            resolve(stdout);
          }
        });

        stream.on('data', (data) => {
          stdout += data.toString();
        });

        stream.stderr.on('data', (data) => {
          stderr += data.toString();
        });

        stream.on('error', (err) => {
          cleanup();
          reject(err);
        });

        stream.stderr.on('error', (err) => {
          cleanup();
          reject(err);
        });
      });
    } catch (execErr) {
      clearTimeout(timeoutId);
      reject(execErr);
    }
  });
}

module.exports = {
  parseCpu,
  parseMem,
  parseDisk,
  parseProcesses,
  parseDocker,
  getConnection,
  closeConnection,
  execCommand,
  pool
};
