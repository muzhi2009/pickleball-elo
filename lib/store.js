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
  antiFarmHours: 24,
  requireApproval: true,
  maxPendingPerUser: 20
};

/** 比赛状态：pending 待审核 / active 已生效 / rejected 已驳回 / void 已作废 */
const MATCH_STATUS = ['pending', 'active', 'rejected', 'void'];

/** 成员角色：admin 管理员 / reviewer 审核员 / member 普通成员 */
const USER_ROLES = ['admin', 'reviewer', 'member'];

/**
 * 补齐历史比赛缺少的审核字段。
 * 旧数据只有 active / void，一律视作「上线前录入，免审已通过」。
 */
function migrateMatches(db) {
  let changed = false;
  for (const match of db.matches) {
    if (!match || typeof match !== 'object') continue;
    if (!MATCH_STATUS.includes(match.status)) {
      match.status = 'active';
      changed = true;
    }
    if (!match.review || typeof match.review !== 'object') {
      match.review = {
        by: null,
        at: match.createdAt || null,
        note: '',
        self: false,
        legacy: true,
        history: []
      };
      changed = true;
    } else if (!Array.isArray(match.review.history)) {
      match.review.history = [];
      changed = true;
    }
  }
  return changed;
}

function migrateUsers(db) {
  let changed = false;
  for (const user of db.users) {
    if (!user || typeof user !== 'object') continue;
    if (!USER_ROLES.includes(user.role)) {
      user.role = 'member';
      changed = true;
    }
  }
  return changed;
}

function ensureDir() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

function emptyDb() {
  return {
    meta: { version: 1, createdAt: Date.now() },
    users: [],
    matches: [],
    gameScores: [],
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
  db.gameScores = Array.isArray(db.gameScores) ? db.gameScores : [];
  db.settings = { ...DEFAULT_SETTINGS, ...(db.settings || {}) };

  // 结构升级：只在确有改动时备份一次原文件，然后立即落盘
  const matchesChanged = migrateMatches(db);
  const usersChanged = migrateUsers(db);
  if (matchesChanged || usersChanged) {
    const backup = DB_FILE + '.bak-' + Date.now();
    try {
      fs.copyFileSync(DB_FILE, backup);
      console.log('[store] 数据结构已升级，原文件备份到', backup);
    } catch (err) {
      console.error('[store] 升级前备份失败：', err.message);
    }
    save(db);
  }
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
  MATCH_STATUS,
  USER_ROLES,
  load,
  save,
  secret,
  randomId,
  randomPassword,
  ensureDir
};
