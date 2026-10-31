'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
const DB_FILE = path.join(DATA_DIR, 'db.json');

const DEFAULT_SETTINGS = {
  clubName: '欢乐匹克球社',
  announcement: '',
  startRating: 1500,
  kProvisional: 40,
  kNormal: 24,
  kHigh: 16,
  highThreshold: 1800,
  provisionalMatches: 10,
  minWinDelta: 10,
  disputeHours: 48,
  antiFarm: true,
  antiFarmFactor: 0.5,
  antiFarmHours: 24
};

function ensureDir() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

function emptyDb() {
  return {
    meta: { version: 1, createdAt: Date.now() },
    users: [],
    matches: [],
    settings: { ...DEFAULT_SETTINGS },
    ratings: {},
    logs: []
  };
}

function load() {
  ensureDir();
  if (!fs.existsSync(DB_FILE)) {
    const db = emptyDb();
    save(db);
    return db;
  }
  let db;
  try {
    db = JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
  } catch (err) {
    const broken = DB_FILE + '.broken-' + Date.now();
    fs.copyFileSync(DB_FILE, broken);
    console.error('[store] 数据库文件损坏，已备份到', broken);
    db = emptyDb();
  }
  db.meta = db.meta || { version: 1, createdAt: Date.now() };
  db.users = Array.isArray(db.users) ? db.users : [];
  db.matches = Array.isArray(db.matches) ? db.matches : [];
  db.ratings = db.ratings && typeof db.ratings === 'object' ? db.ratings : {};
  db.logs = Array.isArray(db.logs) ? db.logs : [];
  db.settings = { ...DEFAULT_SETTINGS, ...(db.settings || {}) };
  return db;
}

function save(db) {
  ensureDir();
  const tmp = DB_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(db, null, 2));
  fs.renameSync(tmp, DB_FILE);
}

let cachedSecret = null;
function secret() {
  if (cachedSecret) return cachedSecret;
  ensureDir();
  const file = path.join(DATA_DIR, 'secret.key');
  if (!fs.existsSync(file)) {
    fs.writeFileSync(file, crypto.randomBytes(32).toString('hex'), { mode: 0o600 });
  }
  cachedSecret = fs.readFileSync(file, 'utf8').trim();
  return cachedSecret;
}

function randomId(prefix, bytes = 6) {
  return prefix + crypto.randomBytes(bytes).toString('hex');
}

function randomPassword(length = 10) {
  const alphabet = 'abcdefghjkmnpqrstuvwxyzABCDEFGHJKMNPQRSTUVWXYZ23456789';
  const bytes = crypto.randomBytes(length);
  let out = '';
  for (let i = 0; i < length; i++) out += alphabet[bytes[i] % alphabet.length];
  return out;
}

module.exports = {
  DATA_DIR,
  DB_FILE,
  DEFAULT_SETTINGS,
  load,
  save,
  secret,
  randomId,
  randomPassword,
  ensureDir
};
