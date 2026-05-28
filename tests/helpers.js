const jwt = require('jsonwebtoken');

const TEST_JWT_SECRET = process.env.DASHBOARD_SECRET || 'fallback-jwt-secret';

function generateToken(username = 'admin') {
  return jwt.sign({ username }, TEST_JWT_SECRET);
}

function generateExpiredToken(username = 'admin') {
  return jwt.sign({ username }, TEST_JWT_SECRET, { expiresIn: '0s' });
}

function makeAuthHeader(username = 'admin') {
  return { 'Authorization': `Bearer ${generateToken(username)}` };
}

module.exports = { TEST_JWT_SECRET, generateToken, generateExpiredToken, makeAuthHeader };
