const sqlite3 = require('sqlite3').verbose();
const crypto = require('crypto');
const path = require('path');
const logger = require('./logger');
const fs = require('fs');

const dbFile = process.env.DASHBOARD_DB_PATH || path.join(__dirname, '../data/dashboard.db');
const keyFile = path.join(path.dirname(dbFile), 'encryption.key');

function getEncryptionKey() {
  const HEX_KEY_REGEX = /^[0-9a-fA-F]{64}$/;
  const rawKey = process.env.ENCRYPTION_KEY;
  const DEFAULT_KEY = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';

  if (process.env.NODE_ENV === 'production' && (!rawKey || rawKey === DEFAULT_KEY)) {
    throw new Error('A secure, non-default ENCRYPTION_KEY environment variable is required in production.');
  }
  
  // 1. If ENCRYPTION_KEY env variable is set, validate and use it
  if (rawKey) {
    if (!HEX_KEY_REGEX.test(rawKey)) {
      throw new Error('ENCRYPTION_KEY must be a 64-character hex string (32 bytes).');
    }
    return Buffer.from(rawKey, 'hex');
  }

  // 2. If DASHBOARD_SECRET is set, derive key using SHA-256
  if (process.env.DASHBOARD_SECRET) {
    if (process.env.NODE_ENV === 'production' && process.env.DASHBOARD_SECRET === 'SuperSecretKeyForJWTAuth123!') {
      throw new Error('A secure, non-default DASHBOARD_SECRET environment variable is required in production.');
    }
    return crypto.scryptSync(process.env.DASHBOARD_SECRET, 'server-dashboard-kdf-v1', 32);
  }

  // 3. Try reading from persistent file
  try {
    const dbDir = path.dirname(dbFile);
    if (!fs.existsSync(dbDir)) fs.mkdirSync(dbDir, { recursive: true });
    if (fs.existsSync(keyFile)) {
      const savedKey = fs.readFileSync(keyFile, 'utf8').trim();
      if (HEX_KEY_REGEX.test(savedKey)) {
        return Buffer.from(savedKey, 'hex');
      }
    }
  } catch (err) {
    logger.warn('Failed to read encryption key file', { error: err.message });
  }

  // 4. Generate random key and save it
  const randomKey = crypto.randomBytes(32);
  try {
    const dbDir = path.dirname(dbFile);
    if (!fs.existsSync(dbDir)) fs.mkdirSync(dbDir, { recursive: true });
    fs.writeFileSync(keyFile, randomKey.toString('hex'), { encoding: 'utf8', mode: 0o600 });
  } catch (err) {
    logger.warn('Failed to save encryption key file', { error: err.message });
  }
  return randomKey;
}

const KEY = getEncryptionKey();

let db = null;

function getDb() {
  if (!db) {
    db = new sqlite3.Database(dbFile);
  }
  return db;
}

const ALGORITHM = 'aes-256-gcm';

function encrypt(text) {
  if (!text) return '';
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv(ALGORITHM, KEY, iv);
  let encrypted = cipher.update(text, 'utf8', 'hex');
  encrypted += cipher.final('hex');
  const authTag = cipher.getAuthTag().toString('hex');
  return `${iv.toString('hex')}:${authTag}:${encrypted}`;
}

function decrypt(encryptedText) {
  if (!encryptedText) return '';
  const GCM_FORMAT_REGEX = /^[0-9a-fA-F]{24}:[0-9a-fA-F]{32}:[0-9a-fA-F]+$/;
  if (!GCM_FORMAT_REGEX.test(encryptedText)) {
    logger.warn('Decrypt: value not in expected encrypted format', { hint: 'possible unencrypted legacy data' });
    return null;
  }
  const parts = encryptedText.split(':');
  try {
    const iv = Buffer.from(parts[0], 'hex');
    const authTag = Buffer.from(parts[1], 'hex');
    const encrypted = parts[2];
    const decipher = crypto.createDecipheriv(ALGORITHM, KEY, iv);
    decipher.setAuthTag(authTag);
    let decrypted = decipher.update(encrypted, 'hex', 'utf8');
    decrypted += decipher.final('utf8');
    return decrypted;
  } catch (err) {
    logger.warn('Decryption failed', { error: err.message });
    return null; // Return null instead of ciphertext to avoid leaking it or passing it to connections
  }
}

function init() {
  return new Promise((resolve, reject) => {
    const dbDir = path.dirname(dbFile);
    if (!fs.existsSync(dbDir)) fs.mkdirSync(dbDir, { recursive: true });

    const database = getDb();
    database.serialize(() => {
      database.run(`
        CREATE TABLE IF NOT EXISTS servers (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          name TEXT NOT NULL,
          host TEXT NOT NULL,
          port INTEGER DEFAULT 22,
          username TEXT NOT NULL,
          auth_type TEXT NOT NULL,
          password TEXT,
          private_key TEXT,
          created_at DATETIME DEFAULT CURRENT_TIMESTAMP
        )
      `, (err) => {
        if (err) reject(err);
        else resolve();
      });
    });
  });
}

function addServer(server) {
  return new Promise((resolve, reject) => {
    const encryptedPassword = encrypt(server.password);
    const encryptedKey = encrypt(server.private_key);
    getDb().run(
      `INSERT INTO servers (name, host, port, username, auth_type, password, private_key) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [server.name, server.host, server.port || 22, server.username, server.auth_type, encryptedPassword, encryptedKey],
      function (err) {
        if (err) reject(err);
        else resolve(this.lastID);
      }
    );
  });
}

function getServers() {
  return new Promise((resolve, reject) => {
    getDb().all(`SELECT * FROM servers`, [], (err, rows) => {
      if (err) {
        reject(err);
      } else {
        const decrypted = rows.map(row => ({
          ...row,
          password: decrypt(row.password),
          private_key: decrypt(row.private_key)
        }));
        resolve(decrypted);
      }
    });
  });
}

function getServersListView() {
  return new Promise((resolve, reject) => {
    getDb().all(`SELECT id, name, host, port, username, auth_type FROM servers`, [], (err, rows) => {
      if (err) reject(err);
      else resolve(rows);
    });
  });
}

function getServerById(id) {
  return new Promise((resolve, reject) => {
    getDb().get(`SELECT * FROM servers WHERE id = ?`, [id], (err, row) => {
      if (err) {
        reject(err);
      } else if (!row) {
        resolve(null);
      } else {
        resolve({
          ...row,
          password: decrypt(row.password),
          private_key: decrypt(row.private_key)
        });
      }
    });
  });
}

function updateServer(id, server) {
  return new Promise((resolve, reject) => {
    const fields = [];
    const params = [];
    
    if (server.name !== undefined) { fields.push('name = ?'); params.push(server.name); }
    if (server.host !== undefined) { fields.push('host = ?'); params.push(server.host); }
    if (server.port !== undefined) { fields.push('port = ?'); params.push(server.port); }
    if (server.username !== undefined) { fields.push('username = ?'); params.push(server.username); }
    if (server.auth_type !== undefined) { fields.push('auth_type = ?'); params.push(server.auth_type); }
    if (server.password !== undefined && server.password !== '') { fields.push('password = ?'); params.push(encrypt(server.password)); }
    if (server.private_key !== undefined && server.private_key !== '') { fields.push('private_key = ?'); params.push(encrypt(server.private_key)); }
    
    if (fields.length === 0) {
      resolve(0);
      return;
    }
    
    params.push(id);
    const sql = `UPDATE servers SET ${fields.join(', ')} WHERE id = ?`;
    getDb().run(sql, params, function (err) {
      if (err) reject(err);
      else resolve(this.changes);
    });
  });
}

function deleteServer(id) {
  return new Promise((resolve, reject) => {
    getDb().run(`DELETE FROM servers WHERE id = ?`, [id], function (err) {
      if (err) reject(err);
      else resolve(this.changes);
    });
  });
}

function close() {
  return new Promise((resolve, reject) => {
    if (!db) {
      resolve();
      return;
    }
    db.close((err) => {
      if (err) {
        reject(err);
      } else {
        db = null;
        resolve();
      }
    });
  });
}

module.exports = {
  init,
  encrypt,
  decrypt,
  addServer,
  getServers,
  getServersListView,
  getServerById,
  updateServer,
  deleteServer,
  close
};
