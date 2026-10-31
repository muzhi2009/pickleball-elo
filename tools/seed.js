'use strict';

/**
 * 生成一份演示数据，方便本机看效果（不影响线上 data/）
 * 用法：node tools/seed.js          只生成数据到 ./demo-data
 *       node tools/seed.js --serve  生成数据并直接启动服务（http://127.0.0.1:3000）
 */

const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const DATA_DIR = path.join(ROOT, 'demo-data');
process.env.DATA_DIR = DATA_DIR;

fs.rmSync(DATA_DIR, { recursive: true, force: true });

const store = require(path.join(ROOT, 'lib', 'store'));
const elo = require(path.join(ROOT, 'lib', 'elo'));
const auth = require(path.join(ROOT, 'lib', 'auth'));

const PASSWORD = 'test1234';

// 固定种子的伪随机，保证每次生成的榜单一模一样
let seed = 20261031;
function rnd() {
  seed = (seed * 1103515245 + 12345) % 2147483648;
  return seed / 2147483648;
}
function pick(arr, exclude = []) {
  const pool = arr.filter((x) => !exclude.includes(x));
  return pool[Math.floor(rnd() * pool.length)];
}

const db = store.load();
db.users = [];
db.matches = [];
db.logs = [];

const people = [
  ['社长', 'admin'],
  ['阿杰', 'member'],
  ['小林', 'member'],
  ['阿伟', 'member'],
  ['婷婷', 'member'],
  ['老周', 'member'],
  ['阿豪', 'member'],
  ['小美', 'member']
];

for (const [nickname, role] of people) {
  db.users.push({
    id: store.randomId('u_'),
    nickname,
    passwordHash: auth.hashPassword(PASSWORD),
    role,
    status: 'active',
    createdAt: Date.now() - 30 * 24 * 3600 * 1000,
    lastLogin: null,
    sessionEpoch: 0
  });
}

const ids = db.users.map((u) => u.id);
const members = ids.slice(1);

function makeMatch({ type, team1, team2, winner, score1, score2, daysAgo, hour }) {
  const playedAt = new Date();
  playedAt.setDate(playedAt.getDate() - daysAgo);
  playedAt.setHours(hour, Math.floor(rnd() * 50), 0, 0);
  const detail = score1 != null;
  return {
    id: store.randomId('m_'),
    type,
    team1,
    team2,
    winner,
    detail,
    score1: detail ? score1 : null,
    score2: detail ? score2 : null,
    note: '',
    playedAt: playedAt.getTime(),
    status: 'active',
    disputed: false,
    dispute: null,
    createdBy: ids[0],
    createdAt: playedAt.getTime() + 3600 * 1000,
    changes: []
  };
}

// 单打：实力强的阿杰多赢
const singlesSkill = { 阿杰: 0.72, 小林: 0.55, 阿伟: 0.48, 婷婷: 0.6, 老周: 0.4, 阿豪: 0.5, 小美: 0.35 };
let day = 20;
for (let i = 0; i < 22; i++) {
  const a = pick(members);
  const b = pick(members, [a]);
  const na = db.users.find((u) => u.id === a).nickname;
  const nb = db.users.find((u) => u.id === b).nickname;
  const sa = singlesSkill[na] ?? 0.5;
  const sb = singlesSkill[nb] ?? 0.5;
  const aWins = rnd() < sa / (sa + sb);
  const loser = 4 + Math.floor(rnd() * 7);
  const winnerScore = 11;
  day -= rnd() < 0.3 ? 1 : 0;
  db.matches.push(makeMatch({
    type: 'singles',
    team1: [a],
    team2: [b],
    winner: aWins ? 1 : 2,
    score1: aWins ? winnerScore : loser,
    score2: aWins ? loser : winnerScore,
    daysAgo: Math.max(0, day),
    hour: 18 + Math.floor(rnd() * 3)
  }));
}

// 双打
for (let i = 0; i < 18; i++) {
  const a1 = pick(members);
  const a2 = pick(members, [a1]);
  const b1 = pick(members, [a1, a2]);
  const b2 = pick(members, [a1, a2, b1]);
  const aWins = rnd() < 0.5;
  const loser = 3 + Math.floor(rnd() * 8);
  day = Math.max(0, day - (rnd() < 0.4 ? 1 : 0));
  db.matches.push(makeMatch({
    type: 'doubles',
    team1: [a1, a2],
    team2: [b1, b2],
    winner: aWins ? 1 : 2,
    score1: aWins ? 11 : loser,
    score2: aWins ? loser : 11,
    daysAgo: day,
    hour: 19 + Math.floor(rnd() * 2)
  }));
}

elo.recompute(db);
store.save(db);

const ranked = db.users
  .map((u) => ({ n: u.nickname, s: db.ratings[u.id].singles.rating, d: db.ratings[u.id].doubles.rating }))
  .sort((a, b) => b.s - a.s);

console.log(`演示数据已生成：${DATA_DIR}`);
console.log(`成员 ${db.users.length} 人，比赛 ${db.matches.length} 场，登录密码统一为 ${PASSWORD}`);
console.log('\n单打榜单：');
for (const [i, r] of ranked.entries()) console.log(`  ${i + 1}. ${r.n}  单打 ${r.s}  双打 ${r.d}`);

if (process.argv.includes('--serve')) {
  const port = Number(process.env.PORT || 3000);
  console.log(`\n启动演示服务：http://127.0.0.1:${port}  （管理员：社长 / ${PASSWORD}）`);
  const child = spawn(process.execPath, ['server.js'], {
    cwd: ROOT,
    env: { ...process.env, DATA_DIR, PORT: String(port) },
    stdio: 'inherit'
  });
  child.on('exit', (code) => process.exit(code ?? 0));
}
