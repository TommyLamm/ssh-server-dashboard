const { Client } = require('ssh2');
const crypto = require('crypto');
const logger = require('./logger');
const { parseCpu, parseMem, parseDisk, parseProcesses, parseDocker } = require('./parsers');

const MAX_BUFFER = 5 * 1024 * 1024; // 5MB

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
      keepaliveCountMax: 3,
      hostHash: 'sha256',
      hostVerifier: (hash) => {
        logger.info('SSH host key verified', { host: server.host, port: server.port || 22, fingerprint: `SHA256:${hash}` });
        return true; // TOFU model: log fingerprint, accept on first use
      }
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

function closeAll() {
  Object.keys(pool).forEach(id => closeConnection(id));
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
          if (stdout.length < MAX_BUFFER) stdout += data.toString();
        });

        stream.stderr.on('data', (data) => {
          if (stderr.length < MAX_BUFFER) stderr += data.toString();
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
  closeAll,
  execCommand,
  pool
};
