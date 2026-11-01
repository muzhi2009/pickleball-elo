'use strict';

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const store = require('./lib/store');
const elo = require('./lib/elo');
const auth = require('./lib/auth');
const views = require('./lib/views');

const PORT = Number(process.env.PORT || 3000);
const HOST = process.env.HOST || '127.0.0.1';
const PUBLIC_DIR = path.join(__dirname, 'public');
const PAGE_SIZE = 20;

let db = store.load();
elo.recompute(db);
store.save(db);

const SECURITY_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'same-origin',
  'Content-Security-Policy': "default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; script-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'"
};

const MIME = {
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8'
};

/* ---------- 基础工具 ---------- */

function parseCookies(header) {
  const out = {};
  if (!header) return out;
  for (const part of String(header).split(';')) {
    const index = part.indexOf('=');
    if (index < 0) continue;
    const key = part.slice(0, index).trim();
    if (!key) continue;
    try {
      out[key] = decodeURIComponent(part.slice(index + 1).trim());
    } catch {
      out[key] = part.slice(index + 1).trim();
    }
  }
  return out;
}

function addCookie(res, cookie) {
  if (!res.cookies) res.cookies = [];
  res.cookies.push(cookie);
}

function send(res, status, body, type = 'text/html; charset=utf-8', extra = {}) {
  const headers = { ...SECURITY_HEADERS, 'Content-Type': type, ...extra };
  if (res.cookies && res.cookies.length) headers['Set-Cookie'] = res.cookies;
  res.writeHead(status, headers);
  res.end(body);
}

function redirect(res, location, status = 303) {
  const headers = { ...SECURITY_HEADERS, Location: location };
  if (res.cookies && res.cookies.length) headers['Set-Cookie'] = res.cookies;
  res.writeHead(status, headers);
  res.end();
}

function setFlash(res, type, msg) {
  const value = Buffer.from(JSON.stringify({ t: type, m: msg })).toString('base64url');
  addCookie(res, `flash=${value}; Path=/; Max-Age=60; HttpOnly; SameSite=Lax`);
}

function readFlash(req) {
  const raw = parseCookies(req.headers.cookie).flash;
  if (!raw) return null;
  try {
    const data = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8'));
    if (data && data.m) return { type: data.t || 'ok', msg: String(data.m) };
  } catch {
    /* ignore */
  }
  return null;
}

function consumeFlash(req, res) {
  const flash = readFlash(req);
  if (flash) addCookie(res, 'flash=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax');
  return flash;
}

function currentUser(req) {
  const token = parseCookies(req.headers.cookie).sid;
  const data = auth.readToken(token);
  if (!data) return null;
  const user = db.users.find((u) => u.id === data.uid);
  if (!user || user.status !== 'active') return null;
  if ((user.sessionEpoch || 0) !== data.ep) return null;
  return user;
}

function sessionCookie(req, user) {
  const token = auth.makeToken(user);
  const proto = String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim();
  const secure = proto === 'https' ? '; Secure' : '';
  return `sid=${token}; Path=/; Max-Age=${Math.floor(auth.TOKEN_TTL / 1000)}; HttpOnly; SameSite=Lax${secure}`;
}

function sameOrigin(req) {
  const host = req.headers.host;
  if (!host) return true;
  const origin = req.headers.origin;
  if (origin) {
    try { return new URL(origin).host === host; } catch { return false; }
  }
  const referer = req.headers.referer;
  if (referer) {
    try { return new URL(referer).host === host; } catch { return false; }
  }
  return true;
}

function clientIp(req) {
  const forwarded = req.headers['cf-connecting-ip'] || req.headers['x-forwarded-for'] || '';
  return String(forwarded).split(',')[0].trim() || req.socket.remoteAddress || 'unknown';
}

const buckets = new Map();
function rateLimit(key, limit, windowMs) {
  const now = Date.now();
  let bucket = buckets.get(key);
  if (!bucket || bucket.reset < now) {
    bucket = { count: 0, reset: now + windowMs };
    buckets.set(key, bucket);
  }
  bucket.count += 1;
  return bucket.count <= limit;
}

function readForm(req, limit = 200000) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > limit) {
        reject(new Error('请求内容过大'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(new URLSearchParams(Buffer.concat(chunks).toString('utf8'))));
    req.on('error', reject);
  });
}

function logAction(user, action, detail = '') {
  db.logs.push({ at: Date.now(), by: user ? user.nickname : 'system', action, detail: String(detail).slice(0, 200) });
  if (db.logs.length > 500) db.logs.splice(0, db.logs.length - 500);
}

function commit() {
  elo.recompute(db);
  store.save(db);
}

/* ---------- 角色与审核权限 ---------- */

function isAdmin(user) {
  return !!user && user.role === 'admin';
}

function isReviewer(user) {
  return !!user && (user.role === 'admin' || user.role === 'reviewer');
}

function roleLabel(role) {
  if (role === 'admin') return '管理员';
  if (role === 'reviewer') return '审核员';
  return '成员';
}

function reviewLabel(match) {
  if (match.status === 'pending') return '待审核';
  if (match.status === 'rejected') return '已驳回';
  if (match.status === 'void') return '已作废';
  const review = match.review || {};
  if (review.legacy) return '历史数据';
  return review.self ? '已通过（自审）' : '已通过';
}

/** 待审 / 驳回的比赛只对录入人和审核者可见，避免未生效数据混进公开列表 */
function canSeeMatch(user, match) {
  if (match.status !== 'pending' && match.status !== 'rejected') return true;
  if (!user) return false;
  if (isReviewer(user)) return true;
  return match.createdBy === user.id;
}

/** 管理员可审任何比赛；审核员不能审自己录的；普通成员没有审核权 */
function canReview(user, match) {
  if (!isReviewer(user)) return false;
  if (match.status !== 'pending') return false;
  if (isAdmin(user)) return true;
  return match.createdBy !== user.id;
}

/** 通过一场比赛，留下审核痕迹（自审会单独标记） */
function approveMatch(match, user, note = '') {
  const at = Date.now();
  const self = match.createdBy === user.id;
  const history = (match.review && match.review.history) || [];
  match.status = 'active';
  match.review = {
    ...(match.review || {}),
    by: user.id,
    at,
    note: String(note || '').slice(0, 200),
    self,
    legacy: false,
    history: [...history, { action: 'approve', by: user.id, at, note: String(note || '').slice(0, 200), self }]
  };
  logAction(user, self ? '通过比赛（自审）' : '通过比赛', `${match.type} ${match.id}`);
}

/* ---------- 小游戏：对局凭证与排行榜 ---------- */

const GAME_TOKEN_TTL = 6 * 3600 * 1000;   // 凭证有效期
const GAME_MIN_MS = 8000;                 // 一局至少这么久，挡掉瞬间刷分
const GAME_MAX_SCORE = 99999;             // 分数上限，超出视为异常
const usedGameTokens = new Map();         // nonce -> 使用时间，防重放

function signGameToken(payload) {
  return crypto.createHmac('sha256', store.secret()).update(payload).digest('base64url');
}

function makeGameToken(user) {
  const payload = Buffer.from(JSON.stringify({
    uid: user.id,
    iat: Date.now(),
    n: crypto.randomBytes(9).toString('base64url')
  })).toString('base64url');
  return payload + '.' + signGameToken(payload);
}

function readGameToken(token) {
  if (!token || typeof token !== 'string' || token.length > 600) return null;
  const index = token.lastIndexOf('.');
  if (index <= 0) return null;
  const payload = token.slice(0, index);
  const signature = token.slice(index + 1);
  const good = signGameToken(payload);
  if (signature.length !== good.length) return null;
  if (!crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(good))) return null;
  try {
    const data = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    if (!data || !data.uid || !data.n || typeof data.iat !== 'number') return null;
    return data;
  } catch {
    return null;
  }
}

function consumeGameToken(nonce) {
  const now = Date.now();
  if (usedGameTokens.size > 4000) {
    for (const [key, at] of usedGameTokens) {
      if (now - at > GAME_TOKEN_TTL) usedGameTokens.delete(key);
    }
  }
  if (usedGameTokens.has(nonce)) return false;
  usedGameTokens.set(nonce, now);
  return true;
}

function gameTop(limit = 10, meId = null) {
  const rank = [];
  for (const row of db.gameScores) {
    if (!row || !(row.best > 0)) continue;
    const user = db.users.find((u) => u.id === row.userId);
    if (!user || user.status !== 'active') continue;
    rank.push({ name: user.nickname, best: row.best, bestAt: row.bestAt || 0, me: user.id === meId });
  }
  rank.sort((a, b) => b.best - a.best || a.bestAt - b.bestAt);
  return rank.slice(0, limit);
}

function sendJson(res, status, data) {
  send(res, status, JSON.stringify(data), 'application/json; charset=utf-8', {
    'Cache-Control': 'no-store'
  });
}


function normalizeNickname(value) {
  return String(value || '').trim().replace(/\s+/g, ' ');
}

function nicknameError(nickname) {
  const length = [...nickname].length;
  if (length < 2 || length > 16) return '昵称需要 2-16 个字符';
  if (/[<>]/.test(nickname)) return '昵称不能包含 < 或 >';
  return null;
}

function findUserByNickname(nickname) {
  const lower = nickname.toLowerCase();
  return db.users.find((u) => u.nickname.toLowerCase() === lower);
}

function createUser({ nickname, password, role = 'member', status = 'active' }) {
  const user = {
    id: store.randomId('u_'),
    nickname,
    passwordHash: auth.hashPassword(password),
    role,
    status,
    createdAt: Date.now(),
    lastLogin: null,
    sessionEpoch: 0
  };
  db.users.push(user);
  return user;
}

function usersMap() {
  const map = {};
  for (const user of db.users) map[user.id] = user;
  return map;
}

function activePlayers() {
  return db.users
    .filter((u) => u.status === 'active')
    .map((u) => {
      const r = db.ratings[u.id]?.singles;
      return { id: u.id, nickname: u.nickname, rating: r ? r.rating : db.settings.startRating };
    })
    .sort((a, b) => a.nickname.localeCompare(b.nickname, 'zh'));
}

function ratingOf(userId, type) {
  const r = db.ratings[userId]?.[type];
  return r || { rating: db.settings.startRating, matches: 0, wins: 0, losses: 0 };
}

function delta7(userId, type) {
  const since = Date.now() - 7 * 24 * 3600 * 1000;
  let sum = 0;
  for (const match of db.matches) {
    if (match.status !== 'active' || match.type !== type || match.playedAt < since) continue;
    const change = (match.changes || []).find((c) => c.userId === userId);
    if (change) sum += change.delta;
  }
  return sum;
}

function parseMatch(body, { allowStatus = false } = {}) {
  const type = body.get('type') === 'doubles' ? 'doubles' : 'singles';
  const team1 = [String(body.get('t1p1') || '')];
  const team2 = [String(body.get('t2p1') || '')];
  if (type === 'doubles') {
    team1.push(String(body.get('t1p2') || ''));
    team2.push(String(body.get('t2p2') || ''));
  }

  const data = {
    type,
    team1,
    team2,
    t1p1: team1[0],
    t1p2: team1[1] || '',
    t2p1: team2[0],
    t2p2: team2[1] || '',
    winner: body.get('winner') === '2' ? 2 : 1,
    detail: body.get('detail') === '1',
    score1: body.get('score1') || '',
    score2: body.get('score2') || '',
    note: String(body.get('note') || '').trim().slice(0, 200),
    playedAt: String(body.get('playedAt') || ''),
    status: allowStatus && body.get('status') === 'void' ? 'void' : 'active'
  };

  const ids = [...team1, ...team2];
  if (ids.some((id) => !id)) return { error: '请选择全部上场选手', data };
  if (new Set(ids).size !== ids.length) return { error: '同一名选手不能重复上场', data };
  for (const id of ids) {
    const user = db.users.find((u) => u.id === id && u.status === 'active');
    if (!user) return { error: '有选手不存在或尚未通过审核', data };
  }

  let score1 = null;
  let score2 = null;
  if (data.detail) {
    score1 = Number(data.score1);
    score2 = Number(data.score2);
    if (!Number.isInteger(score1) || !Number.isInteger(score2) || score1 < 0 || score2 < 0 || score1 > 99 || score2 > 99) {
      return { error: '比分需要是 0-99 的整数', data };
    }
    if (score1 === score2) return { error: '比分不能相同，匹克球没有平局', data };
    if ((score1 > score2 ? 1 : 2) !== data.winner) return { error: '获胜队伍和比分不一致', data };
  }

  let playedAt = Date.parse(data.playedAt);
  if (!Number.isFinite(playedAt)) playedAt = Date.now();
  if (playedAt > Date.now() + 3600 * 1000) playedAt = Date.now();

  return { data: { ...data, score1, score2, playedAt } };
}

/* ---------- 页面渲染 ---------- */

function renderPage(req, res, viewFn, data = {}, status = 200) {
  const user = req.user || null;
  const ctx = {
    settings: db.settings,
    user,
    flash: consumeFlash(req, res),
    // 导航上的待办角标：只有审核者才会看到
    pendingReviews: isReviewer(user) ? db.matches.filter((m) => m.status === 'pending').length : 0,
    ...data
  };
  send(res, status, viewFn(ctx));
}

function notFound(req, res) {
  renderPage(req, res, views.errorPage, {
    errorTitle: '页面不存在',
    errorMessage: '你访问的地址没有内容。'
  }, 404);
}

/* ---------- 路由处理 ---------- */

async function handle(req, res) {
  const url = new URL(req.url, 'http://localhost');
  let pathname = url.pathname;
  if (pathname.length > 1 && pathname.endsWith('/')) pathname = pathname.slice(0, -1);

  req.user = currentUser(req);

  if (req.method === 'POST' && !sameOrigin(req)) {
    return send(res, 403, 'Forbidden', 'text/plain; charset=utf-8');
  }

  if (req.method === 'GET' && pathname.startsWith('/static/')) {
    return serveStatic(res, pathname);
  }

  if (req.method === 'GET' && pathname === '/healthz') {
    return send(res, 200, 'ok', 'text/plain; charset=utf-8');
  }

  /* 仅测试环境：导出数据库快照，供冒烟测试断言（生产不会注册这条路由） */
  if (process.env.TEST_HOOK === '1' && req.method === 'GET' && pathname === '/__test__/db') {
    return send(res, 200, JSON.stringify(db), 'application/json; charset=utf-8');
  }

  /* 首次初始化 */
  if (pathname === '/setup') {
    if (db.users.length > 0) return redirect(res, '/login');
    if (req.method === 'GET') {
      return renderPage(req, res, (ctx) => views.authPage(ctx, { mode: 'setup' }), {});
    }
    if (req.method === 'POST') {
      if (!rateLimit('setup:' + clientIp(req), 10, 3600 * 1000)) {
        return renderPage(req, res, (ctx) => views.authPage(ctx, { mode: 'setup', error: '操作太频繁，请稍后再试' }), {}, 429);
      }
      const body = await readForm(req);
      const nickname = normalizeNickname(body.get('nickname'));
      const password = String(body.get('password') || '');
      const password2 = String(body.get('password2') || '');
      let error = nicknameError(nickname);
      if (!error && password.length < 6) error = '密码至少 6 位';
      if (!error && password !== password2) error = '两次输入的密码不一致';
      if (error) {
        return renderPage(req, res, (ctx) => views.authPage(ctx, { mode: 'setup', error, values: { nickname } }), {}, 400);
      }
      const user = createUser({ nickname, password, role: 'admin', status: 'active' });
      logAction(user, '初始化站点', '创建管理员');
      commit();
      addCookie(res, sessionCookie(req, user));
      setFlash(res, 'ok', '管理员创建成功，欢迎！');
      return redirect(res, '/');
    }
  }

  /* 登录 / 注册 / 退出 */
  if (pathname === '/login') {
    if (req.user) return redirect(res, '/me');
    if (req.method === 'GET') {
      return renderPage(req, res, (ctx) => views.authPage(ctx, { mode: 'login' }), { title: '登录' });
    }
    if (req.method === 'POST') {
      if (!rateLimit('login:' + clientIp(req), 12, 10 * 60 * 1000)) {
        return renderPage(req, res, (ctx) => views.authPage(ctx, { mode: 'login', error: '尝试太频繁，请 10 分钟后再试' }), {}, 429);
      }
      const body = await readForm(req);
      const nickname = normalizeNickname(body.get('nickname'));
      const password = String(body.get('password') || '');
      const user = findUserByNickname(nickname);
      let error = null;
      if (!user || !auth.verifyPassword(password, user.passwordHash)) {
        error = '昵称或密码错误';
      } else if (user.status === 'pending') {
        error = '账号还在等待管理员审核';
      } else if (user.status === 'banned') {
        error = '账号已被封禁，请联系管理员';
      }
      if (error) {
        return renderPage(req, res, (ctx) => views.authPage(ctx, { mode: 'login', error, values: { nickname } }), {}, 401);
      }
      user.lastLogin = Date.now();
      store.save(db);
      addCookie(res, sessionCookie(req, user));
      setFlash(res, 'ok', `欢迎回来，${user.nickname}`);
      return redirect(res, '/');
    }
  }

  if (pathname === '/register') {
    if (req.method === 'GET') {
      return renderPage(req, res, (ctx) => views.authPage(ctx, { mode: 'register' }), { title: '注册' });
    }
    if (req.method === 'POST') {
      if (!rateLimit('register:' + clientIp(req), 6, 3600 * 1000)) {
        return renderPage(req, res, (ctx) => views.authPage(ctx, { mode: 'register', error: '注册太频繁，请稍后再试' }), {}, 429);
      }
      const body = await readForm(req);
      const nickname = normalizeNickname(body.get('nickname'));
      const password = String(body.get('password') || '');
      const password2 = String(body.get('password2') || '');
      let error = nicknameError(nickname);
      if (!error && findUserByNickname(nickname)) error = '这个昵称已经被使用了';
      if (!error && password.length < 6) error = '密码至少 6 位';
      if (!error && password !== password2) error = '两次输入的密码不一致';
      if (error) {
        return renderPage(req, res, (ctx) => views.authPage(ctx, { mode: 'register', error, values: { nickname } }), {}, 400);
      }
      const user = createUser({ nickname, password, role: 'member', status: 'pending' });
      logAction(user, '注册', '等待审核');
      commit();
      setFlash(res, 'ok', '注册成功，等待管理员审核通过后即可登录。');
      return redirect(res, '/login');
    }
  }

  if (pathname === '/logout' && req.method === 'POST') {
    addCookie(res, 'sid=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax');
    return redirect(res, '/');
  }

  /* 排行榜 */
  if (pathname === '/' && req.method === 'GET') {
    const type = url.searchParams.get('type') === 'doubles' ? 'doubles' : 'singles';
    const rows = db.users
      .filter((u) => u.status === 'active')
      .map((u) => {
        const r = ratingOf(u.id, type);
        return {
          id: u.id,
          nickname: u.nickname,
          rating: r.rating,
          matches: r.matches,
          wins: r.wins,
          losses: r.losses,
          delta7: delta7(u.id, type)
        };
      })
      .sort((a, b) => b.rating - a.rating || b.matches - a.matches || a.nickname.localeCompare(b.nickname, 'zh'));

    const stats = {
      members: rows.length,
      matches: db.matches.filter((m) => m.status === 'active').length
    };
    return renderPage(req, res, views.leaderboardPage, {
      type,
      rows,
      stats,
      announcement: db.settings.announcement || ''
    });
  }

  /* 比赛列表 */
  if (pathname === '/matches' && req.method === 'GET') {
    const type = url.searchParams.get('type');
    const filterType = type === 'singles' || type === 'doubles' ? type : null;
    const all = db.matches.filter((m) => canSeeMatch(req.user, m) && (!filterType || m.type === filterType));
    const pages = Math.max(1, Math.ceil(all.length / PAGE_SIZE));
    const pageNum = Math.min(pages, Math.max(1, Number(url.searchParams.get('page')) || 1));
    const items = all.slice((pageNum - 1) * PAGE_SIZE, pageNum * PAGE_SIZE);
    return renderPage(req, res, views.matchesPage, {
      items,
      users: usersMap(),
      page: pageNum,
      pages,
      total: all.length,
      type: filterType
    });
  }

  /* 比赛详情 */
  let match = pathname.match(/^\/matches\/([^/]+)$/);
  if (match && req.method === 'GET') {
    if (!req.user) {
      setFlash(res, 'err', '登录后才能查看比赛详情');
      return redirect(res, '/login');
    }
    const id = decodeURIComponent(match[1]);
    const item = db.matches.find((m) => m.id === id);
    if (!item || !canSeeMatch(req.user, item)) return notFound(req, res);
    const inMatch = (item.team1 || []).includes(req.user.id) || (item.team2 || []).includes(req.user.id);
    const withinWindow = Date.now() - (item.createdAt || 0) <= Number(db.settings.disputeHours) * 3600 * 1000;
    const canDispute = item.status === 'active' && !item.disputed && inMatch && withinWindow && req.user.role !== 'admin';
    return renderPage(req, res, views.matchPage, {
      match: item,
      users: usersMap(),
      canDispute,
      isAdmin: isAdmin(req.user),
      canReview: canReview(req.user, item)
    });
  }

  /* 发起申诉 */
  if ((match = pathname.match(/^\/matches\/([^/]+)\/dispute$/)) && req.method === 'POST') {
    if (!req.user) return redirect(res, '/login');
    const id = decodeURIComponent(match[1]);
    const item = db.matches.find((m) => m.id === id);
    if (!item) return notFound(req, res);
    const inMatch = (item.team1 || []).includes(req.user.id) || (item.team2 || []).includes(req.user.id);
    const withinWindow = Date.now() - (item.createdAt || 0) <= Number(db.settings.disputeHours) * 3600 * 1000;
    if (!inMatch || item.status !== 'active' || item.disputed || !withinWindow) {
      setFlash(res, 'err', '这场比赛当前不能申诉');
      return redirect(res, `/matches/${encodeURIComponent(id)}`);
    }
    const body = await readForm(req);
    const reason = String(body.get('reason') || '').trim().slice(0, 300);
    if (reason.length < 2) {
      setFlash(res, 'err', '请填写申诉理由');
      return redirect(res, `/matches/${encodeURIComponent(id)}`);
    }
    item.disputed = true;
    item.dispute = { by: req.user.id, reason, at: Date.now(), resolution: '' };
    logAction(req.user, '发起申诉', `${item.type} ${id}`);
    store.save(db);
    setFlash(res, 'ok', '申诉已提交，管理员会尽快处理。');
    return redirect(res, `/matches/${encodeURIComponent(id)}`);
  }

  /* 个人页面 */
  let playerMatch = pathname.match(/^\/players\/([^/]+)$/);
  if (playerMatch && req.method === 'GET') {
    if (!req.user) {
      setFlash(res, 'err', '登录后才能查看球员详情');
      return redirect(res, '/login');
    }
    const id = decodeURIComponent(playerMatch[1]);
    const player = db.users.find((u) => u.id === id && u.status !== 'pending');
    if (!player) return notFound(req, res);

    const history = [];
    for (const m of db.matches) {
      if (![...(m.team1 || []), ...(m.team2 || [])].includes(id)) continue;
      const change = (m.changes || []).find((c) => c.userId === id);
      if (!change) continue;
      history.push({ match: m, delta: change.delta, after: change.after });
    }
    history.sort((a, b) => (b.match.playedAt || 0) - (a.match.playedAt || 0));

    const chartFor = (type) => history
      .filter((hitem) => hitem.match.type === type && hitem.match.status === 'active')
      .slice(0, 20)
      .reverse()
      .map((hitem) => ({ rating: hitem.after }));

    const opponentStats = new Map();
    for (const m of db.matches) {
      if (m.status !== 'active') continue;
      const in1 = (m.team1 || []).includes(id);
      const in2 = (m.team2 || []).includes(id);
      if (!in1 && !in2) continue;
      const opponents = in1 ? m.team2 : m.team1;
      const won = (Number(m.winner) === 1) === in1;
      for (const oid of opponents || []) {
        const entry = opponentStats.get(oid) || { wins: 0, losses: 0 };
        if (won) entry.wins += 1; else entry.losses += 1;
        opponentStats.set(oid, entry);
      }
    }
    const opponents = [...opponentStats.entries()]
      .map(([oid, stat]) => ({
        nickname: db.users.find((u) => u.id === oid)?.nickname || '已删除',
        wins: stat.wins,
        losses: stat.losses,
        total: stat.wins + stat.losses
      }))
      .sort((a, b) => b.total - a.total)
      .slice(0, 12);

    return renderPage(req, res, views.playerPage, {
      player,
      ratings: {
        singles: ratingOf(id, 'singles'),
        doubles: ratingOf(id, 'doubles')
      },
      history: history.slice(0, 30),
      charts: { singles: chartFor('singles'), doubles: chartFor('doubles') },
      opponents,
      users: usersMap()
    });
  }

  /* 录入比赛 */
  if (pathname === '/record') {
    if (!req.user) {
      setFlash(res, 'err', '登录后才能录入比赛');
      return redirect(res, '/login');
    }
    if (req.method === 'GET') {
      const preset = url.searchParams.get('type') === 'doubles' ? 'doubles' : 'singles';
      const detail = url.searchParams.get('detail') === '1';
      return renderPage(req, res, views.recordPage, {
        players: activePlayers(),
        values: { type: preset, detail }
      });
    }
    if (req.method === 'POST') {
      const body = await readForm(req);
      const parsed = parseMatch(body);
      if (parsed.error) {
        return renderPage(req, res, views.recordPage, {
          players: activePlayers(),
          error: parsed.error,
          values: parsed.data
        }, 400);
      }

      const needsReview = db.settings.requireApproval !== false;
      if (needsReview) {
        const limit = Math.max(1, Number(db.settings.maxPendingPerUser) || 20);
        const waiting = db.matches.filter((m) => m.createdBy === req.user.id && m.status === 'pending').length;
        if (waiting >= limit) {
          return renderPage(req, res, views.recordPage, {
            players: activePlayers(),
            error: `你还有 ${waiting} 场在等审核，超过上限（${limit} 场），等审核完再录新的。`,
            values: parsed.data
          }, 429);
        }
      }

      const data = parsed.data;
      const now = Date.now();
      const created = {
        id: store.randomId('m_'),
        type: data.type,
        team1: data.team1,
        team2: data.team2,
        winner: data.winner,
        detail: data.detail,
        score1: data.score1,
        score2: data.score2,
        note: data.note,
        playedAt: data.playedAt,
        status: needsReview ? 'pending' : 'active',
        disputed: false,
        dispute: null,
        createdBy: req.user.id,
        createdAt: now,
        changes: [],
        review: {
          by: needsReview ? null : req.user.id,
          at: needsReview ? null : now,
          note: '',
          self: false,
          legacy: false,
          history: needsReview ? [] : [{ action: 'approve', by: req.user.id, at: now, note: '未开启审核，录入即生效', self: true }]
        }
      };
      db.matches.push(created);

      if (needsReview) {
        logAction(req.user, '提交比赛（待审核）', `${data.type} ${created.id}`);
        store.save(db); // 待审核不计分，不需要重算 Elo
        setFlash(res, 'ok', '已提交，管理员审核通过后才计入排名。');
      } else {
        logAction(req.user, '录入比赛', `${data.type} ${created.id}`);
        commit();
        setFlash(res, 'ok', '比赛已录入，Elo 已更新。');
      }
      return redirect(res, `/matches/${encodeURIComponent(created.id)}`);
    }
  }

  /* 我的 */
  if (pathname === '/me' && req.method === 'GET') {
    if (!req.user) {
      setFlash(res, 'err', '请先登录');
      return redirect(res, '/login');
    }
    const history = [];
    for (const m of db.matches) {
      if (![...(m.team1 || []), ...(m.team2 || [])].includes(req.user.id)) continue;
      const change = (m.changes || []).find((c) => c.userId === req.user.id);
      if (change) history.push({ match: m, delta: change.delta });
    }
    history.sort((a, b) => (b.match.playedAt || 0) - (a.match.playedAt || 0));
    const mySubmissions = db.matches
      .filter((m) => m.createdBy === req.user.id && (m.status === 'pending' || m.status === 'rejected'))
      .sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0))
      .slice(0, 20);
    return renderPage(req, res, views.mePage, {
      ratings: {
        singles: ratingOf(req.user.id, 'singles'),
        doubles: ratingOf(req.user.id, 'doubles')
      },
      history: history.slice(0, 20),
      pending: db.matches.filter((m) => m.disputed && m.dispute && m.dispute.by === req.user.id),
      submissions: mySubmissions
    });
  }

  /* ---------- 小游戏 ---------- */

  if (pathname === '/game' && req.method === 'GET') {
    const mine = req.user ? db.gameScores.find((s) => s.userId === req.user.id) : null;
    return renderPage(req, res, views.gamePage, {
      best: mine ? mine.best : 0,
      plays: mine ? mine.plays : 0,
      top: gameTop(10, req.user ? req.user.id : null)
    });
  }

  if (pathname === '/game/start' && req.method === 'POST') {
    if (!req.user) return sendJson(res, 401, { ok: false, error: '请先登录' });
    if (!rateLimit('game-start:' + req.user.id, 120, 3600 * 1000)) {
      return sendJson(res, 429, { ok: false, error: '开得有点勤，歇一会儿' });
    }
    return sendJson(res, 200, { ok: true, token: makeGameToken(req.user) });
  }

  if (pathname === '/game/score' && req.method === 'POST') {
    if (!req.user) return sendJson(res, 401, { ok: false, error: '登录后才能上榜' });
    if (!rateLimit('game-score:' + req.user.id, 80, 3600 * 1000)) {
      return sendJson(res, 429, { ok: false, error: '提交太频繁了，先歇会儿' });
    }

    const body = await readForm(req, 4000);
    const token = String(body.get('token') || '');
    const score = Math.round(Number(body.get('score')));
    // 客户端上报的本局时长，没传就当未知（NaN），不要当成 0
    const rawMs = body.get('ms');
    const elapsed = rawMs === null || rawMs === '' ? NaN : Math.round(Number(rawMs));

    const payload = readGameToken(token);
    if (!payload || payload.uid !== req.user.id) {
      return sendJson(res, 400, { ok: false, error: '对局凭证无效，刷新页面再来一局' });
    }
    const age = Date.now() - payload.iat;
    if (age > GAME_TOKEN_TTL) {
      return sendJson(res, 400, { ok: false, error: '这一局放太久，凭证过期了' });
    }
    if (age < GAME_MIN_MS || (Number.isFinite(elapsed) && elapsed < GAME_MIN_MS)) {
      return sendJson(res, 400, { ok: false, error: '这局结束得太快，成绩不算数' });
    }
    if (!consumeGameToken(payload.n)) {
      return sendJson(res, 409, { ok: false, error: '这局的成绩已经提交过了' });
    }
    if (!Number.isFinite(score) || score <= 0 || score > GAME_MAX_SCORE) {
      return sendJson(res, 400, { ok: false, error: '分数不太对，这局没记上' });
    }

    let row = db.gameScores.find((s) => s.userId === req.user.id);
    if (!row) {
      row = { userId: req.user.id, best: 0, bestAt: 0, plays: 0, lastScore: 0, lastAt: 0 };
      db.gameScores.push(row);
    }
    const isNewBest = score > (row.best || 0);
    row.plays = (row.plays || 0) + 1;
    row.lastScore = score;
    row.lastAt = Date.now();
    if (isNewBest) {
      row.best = score;
      row.bestAt = Date.now();
    }
    store.save(db);

    return sendJson(res, 200, {
      ok: true,
      score,
      best: row.best,
      plays: row.plays,
      isNewBest,
      top: gameTop(10, req.user.id)
    });
  }

  /* ---------- 管理后台 ---------- */

  if (pathname.startsWith('/admin')) {
    if (!req.user) {
      setFlash(res, 'err', '请先登录');
      return redirect(res, '/login');
    }
    if (!isReviewer(req.user)) {
      return renderPage(req, res, views.errorPage, {
        errorTitle: '没有权限',
        errorMessage: '这一块只有管理员和审核员能进。'
      }, 403);
    }
    // 成员管理、比赛管理、规则设置、导出、重算仍然只属于管理员
    if (/^\/admin\/(users|matches|settings|export\.csv|recompute)(\/|$)/.test(pathname) && !isAdmin(req.user)) {
      return renderPage(req, res, views.errorPage, {
        errorTitle: '没有权限',
        errorMessage: '这一步只有管理员能做，审核员只能处理和审核相关的操作。'
      }, 403);
    }
  }

  if (pathname === '/admin' && req.method === 'GET') {
    return renderPage(req, res, views.adminHome, {
      counts: {
        pending: db.users.filter((u) => u.status === 'pending').length,
        active: db.users.filter((u) => u.status === 'active').length,
        matches: db.matches.filter((m) => m.status === 'active').length,
        disputes: db.matches.filter((m) => m.disputed).length,
        pendingMatches: db.matches.filter((m) => m.status === 'pending').length,
        rejectedMatches: db.matches.filter((m) => m.status === 'rejected').length
      },
      logs: db.logs.slice(-8)
    });
  }

  /* ---------- 比赛审核队列 ---------- */

  if (pathname === '/admin/review' && req.method === 'GET') {
    const rawTab = url.searchParams.get('tab');
    const tab = ['pending', 'active', 'rejected', 'all'].includes(rawTab) ? rawTab : 'pending';
    const list = db.matches
      .filter((m) => (tab === 'all' ? true : m.status === tab))
      .sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0))
      .slice(0, 100);
    return renderPage(req, res, views.adminReview, {
      tab,
      items: list,
      users: usersMap(),
      counts: {
        pending: db.matches.filter((m) => m.status === 'pending').length,
        active: db.matches.filter((m) => m.status === 'active').length,
        rejected: db.matches.filter((m) => m.status === 'rejected').length,
        all: db.matches.length
      },
      // 审核员看到自己录的比赛，但按钮会是禁用状态
      reviewerId: req.user.id,
      adminMode: isAdmin(req.user)
    });
  }

  // 排除 batch，否则 /admin/review/batch 会被当成单场 id
  let reviewAction = pathname.match(/^\/admin\/review\/(?!batch$)([^/]+)$/);
  if (reviewAction && req.method === 'POST') {
    const id = decodeURIComponent(reviewAction[1]);
    const item = db.matches.find((m) => m.id === id);
    if (!item) return notFound(req, res);
    if (item.status !== 'pending') {
      setFlash(res, 'err', '这场比赛不在待审核状态');
      return redirect(res, '/admin/review');
    }
    if (!canReview(req.user, item)) {
      setFlash(res, 'err', '这场是你自己录入的，需要另一位审核者或管理员通过');
      return redirect(res, '/admin/review');
    }

    const body = await readForm(req);
    const action = String(body.get('action') || '');
    const note = String(body.get('note') || '').trim().slice(0, 200);

    if (action === 'approve') {
      approveMatch(item, req.user, note);
      commit();
      setFlash(res, 'ok', '已通过，Elo 已重算。');
    } else if (action === 'reject') {
      if (note.length < 2) {
        setFlash(res, 'err', '驳回请写一句原因，方便录入人修改');
        return redirect(res, '/admin/review');
      }
      const at = Date.now();
      item.status = 'rejected';
      item.review = {
        ...(item.review || {}),
        by: req.user.id,
        at,
        note,
        self: item.createdBy === req.user.id,
        legacy: false,
        history: [...((item.review && item.review.history) || []), { action: 'reject', by: req.user.id, at, note, self: item.createdBy === req.user.id }]
      };
      logAction(req.user, '驳回比赛', `${item.id}：${note}`);
      store.save(db); // 驳回不影响 Elo
      setFlash(res, 'ok', '已驳回，录入人可以修改后重新提交。');
    } else {
      setFlash(res, 'err', '无效的操作');
    }
    return redirect(res, '/admin/review');
  }

  /* 改后通过：审核者可以直接修正比分再放行 */
  let reviewEdit = pathname.match(/^\/admin\/review\/([^/]+)\/edit$/);
  if (reviewEdit) {
    const id = decodeURIComponent(reviewEdit[1]);
    const item = db.matches.find((m) => m.id === id);
    if (!item) return notFound(req, res);
    if (!canReview(req.user, item)) {
      setFlash(res, 'err', item.status !== 'pending' ? '这场比赛不在待审核状态' : '这场是你自己录入的，需要另一位审核者或管理员处理');
      return redirect(res, '/admin/review');
    }
    if (req.method === 'GET') {
      return renderPage(req, res, views.adminReviewEdit, {
        match: item,
        players: activePlayers()
      });
    }
    if (req.method === 'POST') {
      const body = await readForm(req);
      const parsed = parseMatch(body);
      if (parsed.error) {
        return renderPage(req, res, views.adminReviewEdit, {
          match: item,
          players: activePlayers(),
          error: parsed.error
        }, 400);
      }
      const data = parsed.data;
      Object.assign(item, {
        type: data.type,
        team1: data.team1,
        team2: data.team2,
        winner: data.winner,
        detail: data.detail,
        score1: data.score1,
        score2: data.score2,
        note: data.note,
        playedAt: data.playedAt
      });
      approveMatch(item, req.user, "审核时修正后通过");
      commit();
      setFlash(res, 'ok', '已按修正后的结果通过，Elo 已重算。');
      return redirect(res, `/matches/${encodeURIComponent(item.id)}`);
    }
  }

  if (pathname === '/admin/review/batch' && req.method === 'POST') {
    const body = await readForm(req);
    const ids = body.getAll('ids').slice(0, 50);
    let done = 0;
    let skipped = 0;
    for (const raw of ids) {
      const item = db.matches.find((m) => m.id === raw);
      if (!item || !canReview(req.user, item)) {
        skipped += 1;
        continue;
      }
      approveMatch(item, req.user, '批量通过');
      done += 1;
    }
    if (done) commit(); else store.save(db);
    if (done) {
      setFlash(res, 'ok', `已通过 ${done} 场${skipped ? `，${skipped} 场没有权限已跳过` : ''}。`);
    } else {
      setFlash(res, 'err', skipped ? '选中的比赛都没有权限处理' : '没有选中任何比赛');
    }
    return redirect(res, '/admin/review');
  }

  /* 参赛者修改被驳回的比赛后重新提交 */
  let resubmit = pathname.match(/^\/matches\/([^/]+)\/resubmit$/);
  if (resubmit && req.method === 'POST') {
    if (!req.user) return redirect(res, '/login');
    const id = decodeURIComponent(resubmit[1]);
    const item = db.matches.find((m) => m.id === id);
    if (!item) return notFound(req, res);
    if (item.createdBy !== req.user.id && !isAdmin(req.user)) {
      setFlash(res, 'err', '只能重新提交自己录入的比赛');
      return redirect(res, `/matches/${encodeURIComponent(id)}`);
    }
    if (item.status !== 'rejected') {
      setFlash(res, 'err', '只有被驳回的比赛可以重新提交');
      return redirect(res, `/matches/${encodeURIComponent(id)}`);
    }
    const at = Date.now();
    item.status = 'pending';
    item.review = {
      ...(item.review || {}),
      by: null,
      at: null,
      note: '',
      self: false,
      legacy: false,
      history: [...((item.review && item.review.history) || []), { action: 'resubmit', by: req.user.id, at, note: '' }]
    };
    logAction(req.user, '重新提交比赛', item.id);
    store.save(db);
    setFlash(res, 'ok', '已重新提交，等待审核。');
    return redirect(res, `/matches/${encodeURIComponent(id)}`);
  }

  /* 待审比赛也可以由录入人自己撤销（录错了） */
  let withdraw = pathname.match(/^\/matches\/([^/]+)\/withdraw$/);
  if (withdraw && req.method === 'POST') {
    if (!req.user) return redirect(res, '/login');
    const id = decodeURIComponent(withdraw[1]);
    const item = db.matches.find((m) => m.id === id);
    if (!item) return notFound(req, res);
    if (item.createdBy !== req.user.id && !isAdmin(req.user)) {
      setFlash(res, 'err', '只能撤销自己录入的比赛');
      return redirect(res, '/matches');
    }
    if (item.status !== 'pending' && item.status !== 'rejected') {
      setFlash(res, 'err', '已经生效的比赛不能撤销，请联系管理员作废');
      return redirect(res, `/matches/${encodeURIComponent(id)}`);
    }
    const index = db.matches.indexOf(item);
    if (index >= 0) db.matches.splice(index, 1);
    logAction(req.user, '撤销待审比赛', item.id);
    store.save(db);
    setFlash(res, 'ok', '已撤销这场提交。');
    return redirect(res, '/me');
  }

  if (pathname === '/admin/users' && req.method === 'GET') {
    return renderPage(req, res, views.adminUsers, {
      users: db.users,
      ratings: db.ratings
    });
  }

  if (pathname === '/admin/users' && req.method === 'POST') {
    const body = await readForm(req);
    const nickname = normalizeNickname(body.get('nickname'));
    const password = String(body.get('password') || '');
    let error = nicknameError(nickname);
    if (!error && findUserByNickname(nickname)) error = '这个昵称已经被使用了';
    if (!error && password.length < 6) error = '密码至少 6 位';
    if (error) {
      setFlash(res, 'err', error);
      return redirect(res, '/admin/users');
    }
    const user = createUser({ nickname, password, role: 'member', status: 'active' });
    logAction(req.user, '创建成员', nickname);
    commit();
    setFlash(res, 'ok', `成员 ${nickname} 已创建，可以直接登录。`);
    return redirect(res, '/admin/users');
  }

  let adminUserMatch = pathname.match(/^\/admin\/users\/([^/]+)$/);
  if (adminUserMatch && req.method === 'POST') {
    const id = decodeURIComponent(adminUserMatch[1]);
    const target = db.users.find((u) => u.id === id);
    if (!target) return notFound(req, res);
    const body = await readForm(req);
    const action = String(body.get('action') || '');
    if (target.role === 'admin' && ['ban', 'reset'].includes(action)) {
      setFlash(res, 'err', '不能封禁或重置管理员账号');
      return redirect(res, '/admin/users');
    }
    if (action === 'approve' && target.status === 'pending') {
      target.status = 'active';
      logAction(req.user, '审核通过', target.nickname);
      setFlash(res, 'ok', `${target.nickname} 已通过审核`);
    } else if (action === 'ban' && target.status !== 'banned') {
      target.status = 'banned';
      target.sessionEpoch = (target.sessionEpoch || 0) + 1;
      logAction(req.user, '封禁成员', target.nickname);
      setFlash(res, 'ok', `${target.nickname} 已封禁`);
    } else if (action === 'unban' && target.status === 'banned') {
      target.status = 'active';
      logAction(req.user, '解封成员', target.nickname);
      setFlash(res, 'ok', `${target.nickname} 已解封`);
    } else if (action === 'reset') {
      const temp = store.randomPassword(10);
      target.passwordHash = auth.hashPassword(temp);
      target.sessionEpoch = (target.sessionEpoch || 0) + 1;
      logAction(req.user, '重置密码', target.nickname);
      setFlash(res, 'ok', `${target.nickname} 的新密码：${temp}（请立即转告本人）`);
    } else if (action === 'setRole') {
      const role = String(body.get('role') || '');
      if (!store.USER_ROLES.includes(role)) {
        setFlash(res, 'err', '无效的角色');
      } else if (target.id === req.user.id) {
        setFlash(res, 'err', '不能修改自己的角色，请让另一位管理员操作');
      } else if (target.role === role) {
        setFlash(res, 'ok', `${target.nickname} 已经是${roleLabel(role)}`);
      } else if (target.role === 'admin' && db.users.filter((u) => u.role === 'admin').length <= 1) {
        setFlash(res, 'err', '至少要保留一个管理员');
      } else {
        // 角色每次请求都从库里读，改完立即生效，不用踢下线
        target.role = role;
        logAction(req.user, '调整角色', `${target.nickname} → ${roleLabel(role)}`);
        setFlash(res, 'ok', `${target.nickname} 现在是${roleLabel(role)}`);
      }
    } else {
      setFlash(res, 'err', '无效的操作');
    }
    commit();
    return redirect(res, '/admin/users');
  }

  if (pathname === '/admin/matches' && req.method === 'GET') {
    return renderPage(req, res, views.adminMatches, {
      matches: db.matches,
      users: usersMap()
    });
  }

  let adminEditMatch = pathname.match(/^\/admin\/matches\/([^/]+)\/edit$/);
  if (adminEditMatch) {
    const id = decodeURIComponent(adminEditMatch[1]);
    const item = db.matches.find((m) => m.id === id);
    if (!item) return notFound(req, res);
    if (req.method === 'GET') {
      return renderPage(req, res, views.adminMatchEdit, {
        match: item,
        players: activePlayers()
      });
    }
    if (req.method === 'POST') {
      const body = await readForm(req);
      const parsed = parseMatch(body, { allowStatus: true });
      if (parsed.error) {
        return renderPage(req, res, views.adminMatchEdit, {
          match: item,
          players: activePlayers(),
          error: parsed.error
        }, 400);
      }
      const data = parsed.data;
      Object.assign(item, {
        type: data.type,
        team1: data.team1,
        team2: data.team2,
        winner: data.winner,
        detail: data.detail,
        score1: data.score1,
        score2: data.score2,
        note: data.note,
        playedAt: data.playedAt,
        status: data.status
      });
      logAction(req.user, '修改比赛', item.id);
      commit();
      setFlash(res, 'ok', '比赛已更新，Elo 已重算。');
      return redirect(res, `/matches/${encodeURIComponent(item.id)}`);
    }
  }

  let adminVoidMatch = pathname.match(/^\/admin\/matches\/([^/]+)\/void$/);
  if (adminVoidMatch && req.method === 'POST') {
    const id = decodeURIComponent(adminVoidMatch[1]);
    const item = db.matches.find((m) => m.id === id);
    if (!item) return notFound(req, res);
    item.status = item.status === 'void' ? 'active' : 'void';
    logAction(req.user, item.status === 'void' ? '作废比赛' : '恢复比赛', item.id);
    commit();
    setFlash(res, 'ok', item.status === 'void' ? '比赛已作废，Elo 已重算。' : '比赛已恢复，Elo 已重算。');
    return redirect(res, `/admin/matches/${encodeURIComponent(item.id)}/edit`);
  }

  if (pathname === '/admin/disputes' && req.method === 'GET') {
    return renderPage(req, res, views.adminDisputes, {
      matches: db.matches.filter((m) => m.disputed),
      users: usersMap()
    });
  }

  let resolveDispute = pathname.match(/^\/admin\/disputes\/([^/]+)\/resolve$/);
  if (resolveDispute && req.method === 'POST') {
    const id = decodeURIComponent(resolveDispute[1]);
    const item = db.matches.find((m) => m.id === id);
    if (!item) return notFound(req, res);
    // 审核员不能裁决跟自己有关的申诉
    if (!isAdmin(req.user)) {
      const involved = [...(item.team1 || []), ...(item.team2 || [])].includes(req.user.id) ||
        (item.dispute && item.dispute.by === req.user.id);
      if (involved) {
        setFlash(res, 'err', '这场申诉涉及你自己，需要管理员处理');
        return redirect(res, '/admin/disputes');
      }
    }
    const body = await readForm(req);
    const action = String(body.get('action') || '');
    if (action === 'uphold') {
      item.disputed = false;
      item.dispute = { ...(item.dispute || {}), resolution: '管理员核实后维持原判，比分和 Elo 不变。', resolvedAt: Date.now(), resolvedBy: req.user.id };
      logAction(req.user, '处理申诉', `${item.id} 维持原判`);
      setFlash(res, 'ok', '已维持原判');
    } else if (action === 'void') {
      item.status = 'void';
      item.disputed = false;
      item.dispute = { ...(item.dispute || {}), resolution: '管理员核实后作废本场比赛。', resolvedAt: Date.now(), resolvedBy: req.user.id };
      logAction(req.user, '处理申诉', `${item.id} 作废`);
      setFlash(res, 'ok', '比赛已作废，Elo 已重算');
    } else {
      setFlash(res, 'err', '无效的操作');
      return redirect(res, '/admin/disputes');
    }
    commit();
    return redirect(res, '/admin/disputes');
  }

  if (pathname === '/admin/settings') {
    if (req.method === 'GET') {
      return renderPage(req, res, views.adminSettings, { settings: db.settings });
    }
    if (req.method === 'POST') {
      const body = await readForm(req);
      const number = (key, fallback, min, max) => {
        const value = Number(body.get(key));
        if (!Number.isFinite(value)) return fallback;
        return Math.min(max, Math.max(min, value));
      };
      db.settings.clubName = String(body.get('clubName') || db.settings.clubName).trim().slice(0, 40) || '匹克球社';
      db.settings.announcement = String(body.get('announcement') || '').trim().slice(0, 200);
      db.settings.kProvisional = Math.round(number('kProvisional', db.settings.kProvisional, 1, 100));
      db.settings.kNormal = Math.round(number('kNormal', db.settings.kNormal, 1, 100));
      db.settings.kHigh = Math.round(number('kHigh', db.settings.kHigh, 1, 100));
      db.settings.highThreshold = Math.round(number('highThreshold', db.settings.highThreshold, 500, 4000));
      db.settings.provisionalMatches = Math.round(number('provisionalMatches', db.settings.provisionalMatches, 0, 100));
      db.settings.minWinDelta = Math.round(number('minWinDelta', db.settings.minWinDelta ?? 10, 0, 100));
      db.settings.disputeHours = Math.round(number('disputeHours', db.settings.disputeHours, 0, 720));
      db.settings.antiFarmHours = Math.round(number('antiFarmHours', db.settings.antiFarmHours, 0, 720));
      db.settings.antiFarmFactor = number('antiFarmFactor', db.settings.antiFarmFactor, 0, 1);
      db.settings.antiFarm = body.get('antiFarm') === '1';
      db.settings.requireApproval = body.get('requireApproval') === '1';
      db.settings.maxPendingPerUser = Math.round(number('maxPendingPerUser', db.settings.maxPendingPerUser ?? 20, 1, 200));
      logAction(req.user, '修改规则', 'K 值 / 申诉时限 / 审核设置');
      commit();
      setFlash(res, 'ok', '设置已保存，历史 Elo 已重算。');
      return redirect(res, '/admin/settings');
    }
  }

  if (pathname === '/admin/recompute' && req.method === 'POST') {
    commit();
    logAction(req.user, '全量重算', '手动触发');
    store.save(db);
    setFlash(res, 'ok', '所有 Elo 已从头重算完成。');
    return redirect(res, '/admin');
  }

  if (pathname === '/admin/export.csv' && req.method === 'GET') {
    return exportCsv(req, res, url);
  }

  return notFound(req, res);
}

function csvCell(value) {
  const text = String(value ?? '');
  return '"' + text.replace(/"/g, '""') + '"';
}

function exportCsv(req, res, url) {
  const type = url.searchParams.get('type') === 'matches' ? 'matches' : 'players';
  let lines;
  if (type === 'players') {
    lines = ['昵称,角色,状态,单打Elo,单打场次,单打胜,单打负,双打Elo,双打场次,双打胜,双打负,注册时间'];
    for (const u of db.users) {
      const s = ratingOf(u.id, 'singles');
      const d = ratingOf(u.id, 'doubles');
      lines.push([
        views.esc(u.nickname).replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'"),
        roleLabel(u.role),
        u.status === 'active' ? '正常' : u.status === 'pending' ? '待审核' : '封禁',
        Math.round(s.rating), s.matches, s.wins, s.losses,
        Math.round(d.rating), d.matches, d.wins, d.losses,
        views.fmtDate(u.createdAt)
      ].map(csvCell).join(','));
    }
  } else {
    lines = ['时间,类型,队伍A,队伍B,比分A,比分B,胜方,状态,审核状态,审核人,争议,录入人,备注,Elo变化'];
    const users = usersMap();
    for (const m of db.matches) {
      const name = (id) => users[id]?.nickname || '已删除';
      const changes = (m.changes || []).map((c) => `${name(c.userId)} ${c.delta > 0 ? '+' : ''}${c.delta}`).join('; ');
      lines.push([
        views.fmtDate(m.playedAt),
        m.type === 'doubles' ? '双打' : '单打',
        (m.team1 || []).map(name).join(' / '),
        (m.team2 || []).map(name).join(' / '),
        m.detail ? m.score1 : '',
        m.detail ? m.score2 : '',
        Number(m.winner) === 1 ? 'A' : 'B',
        m.status === 'void' ? '作废' : m.status === 'active' ? '有效' : m.status === 'pending' ? '待审核' : '已驳回',
        reviewLabel(m),
        m.review && m.review.by ? name(m.review.by) : '',
        m.disputed ? '争议中' : '',
        name(m.createdBy),
        m.note || '',
        changes
      ].map(csvCell).join(','));
    }
  }
  const csv = '\uFEFF' + lines.join('\r\n') + '\r\n';
  const filename = type === 'players' ? 'players.csv' : 'matches.csv';
  send(res, 200, csv, 'text/csv; charset=utf-8', {
    'Content-Disposition': `attachment; filename="${filename}"`
  });
}

function serveStatic(res, pathname) {
  const relative = decodeURIComponent(pathname.replace(/^\/static\//, ''));
  if (!relative || relative.includes('..') || relative.includes('\\')) {
    return send(res, 404, 'Not found', 'text/plain; charset=utf-8');
  }
  const file = path.join(PUBLIC_DIR, relative);
  if (!file.startsWith(PUBLIC_DIR)) {
    return send(res, 404, 'Not found', 'text/plain; charset=utf-8');
  }
  fs.readFile(file, (err, buffer) => {
    if (err) return send(res, 404, 'Not found', 'text/plain; charset=utf-8');
    const ext = path.extname(file).toLowerCase();
    send(res, 200, buffer, MIME[ext] || 'application/octet-stream', {
      'Cache-Control': 'public, max-age=3600'
    });
  });
}

const server = http.createServer((req, res) => {
  handle(req, res).catch((err) => {
    console.error('[server]', err);
    if (res.headersSent) {
      try { res.end(); } catch { /* ignore */ }
      return;
    }
    try {
      renderPage(req, res, views.errorPage, {
        errorTitle: '服务器出错了',
        errorMessage: '请稍后刷新重试。'
      }, 500);
    } catch {
      res.writeHead(500);
      res.end('Internal Server Error');
    }
  });
});

server.listen(PORT, HOST, () => {
  console.log(`欢乐匹克球社 Elo 已启动：http://${HOST}:${PORT}`);
  if (db.users.length === 0) console.log('首次启动，请打开 /setup 创建管理员账号。');
  else console.log(`已有 ${db.users.length} 名成员。`);
});

function shutdown() {
  try { store.save(db); } catch { /* ignore */ }
  server.close(() => process.exit(0));
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
