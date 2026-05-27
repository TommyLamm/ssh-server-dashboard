const sqlite3 = require('sqlite3').verbose();
const crypto = require('crypto');
const path = require('path');
const fs = require('fs');

const dbFile = process.env.DASHBOARD_DB_PATH || path.join(__dirname, '../data/dashboard.db');
const dbDir = path.dirname(dbFile);
if (!fs.existsSync(dbDir)) fs.mkdirSync(dbDir, { recursive: true });

let db = null;

function getDb() {
  if (!db) {
    db = new sqlite3.Database(dbFile);
  }
  return db;
}

// Hook into Jest's afterAll to close the database connection before the test file is unlinked.
if (typeof global.afterAll === 'function') {
  const originalAfterAll = global.afterAll;
  global.afterAll = function (fn) {
    originalAfterAll(async () => {
      if (db) {
        await new Promise((resolve) => db.close(() => resolve()));
        db = null;
      }
      return fn();
    });
  };
}

const ALGORITHM = 'aes-256-gcm';
// key must be 32 bytes (64 hex characters)
const KEY = Buffer.from(process.env.ENCRYPTION_KEY || '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef', 'hex');

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
  const parts = encryptedText.split(':');
  if (parts.length !== 3) return '';
  const iv = Buffer.from(parts[0], 'hex');
  const authTag = Buffer.from(parts[1], 'hex');
  const encrypted = parts[2];
  const decipher = crypto.createDecipheriv(ALGORITHM, KEY, iv);
  decipher.setAuthTag(authTag);
  let decrypted = decipher.update(encrypted, 'hex', 'utf8');
  decrypted += decipher.final('utf8');
  return decrypted;
}

function init() {
  return new Promise((resolve, reject) => {
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

function deleteServer(id) {
  return new Promise((resolve, reject) => {
    getDb().run(`DELETE FROM servers WHERE id = ?`, [id], function (err) {
      if (err) reject(err);
      else resolve(this.changes);
    });
  });
}

module.exports = {
  init,
  encrypt,
  decrypt,
  addServer,
  getServers,
  deleteServer
};
