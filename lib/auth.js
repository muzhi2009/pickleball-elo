'use strict';

const crypto = require('node:crypto');
const { secret } = require('./store');

const TOKEN_TTL = 30 * 24 * 3600 * 1000;

function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(String(password), salt, 64).toString('hex');
  return `scrypt$${salt}$${hash}`;
}

function verifyPassword(password, stored) {
  try {
    const parts = String(stored || '').split('$');
    if (parts.length !== 3 || parts[0] !== 'scrypt') return false;
    const calc = crypto.scryptSync(String(password), parts[1], 64);
    const expected = Buffer.from(parts[2], 'hex');
    if (calc.length !== expected.length) return false;
    return crypto.timingSafeEqual(calc, expected);
  } catch {
    return false;
  }
}

function sign(payload) {
  return crypto.createHmac('sha256', secret()).update(payload).digest('base64url');
}

function makeToken(user) {
  const payload = Buffer.from(JSON.stringify({
    uid: user.id,
    ep: user.sessionEpoch || 0,
    exp: Date.now() + TOKEN_TTL
  })).toString('base64url');
  return payload + '.' + sign(payload);
}

function readToken(token) {
  if (!token || typeof token !== 'string') return null;
  const index = token.lastIndexOf('.');
  if (index <= 0) return null;
  const payload = token.slice(0, index);
  const signature = token.slice(index + 1);
  const good = sign(payload);
  if (signature.length !== good.length) return null;
  if (!crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(good))) return null;
  try {
    const data = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    if (!data.exp || data.exp < Date.now()) return null;
    return data;
  } catch {
    return null;
  }
}

module.exports = { hashPassword, verifyPassword, makeToken, readToken, TOKEN_TTL };
