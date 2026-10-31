'use strict';

/**
 * Elo 规则单元测试（不启动服务，纯函数）
 * 重点覆盖「单场最少变动」保底规则，以及它与零和、防刷分的交互。
 * 用法：node tools/test-elo.js
 */

const elo = require('../lib/elo');

let pass = 0;
let fail = 0;

function ok(name, cond, detail = '') {
  if (cond) {
    pass++;
    console.log(`  ✓ ${name}`);
  } else {
    fail++;
    console.log(`  ✗ ${name}${detail ? '  → ' + detail : ''}`);
  }
}

function eq(name, actual, expected) {
  ok(name, actual === expected, `期望 ${expected}，实际 ${actual}`);
}

const BASE = {
  startRating: 1500,
  kProvisional: 40,
  kNormal: 24,
  kHigh: 16,
  highThreshold: 1800,
  provisionalMatches: 0,
  minWinDelta: 10,
  disputeHours: 48,
  antiFarm: false,
  antiFarmFactor: 0.5,
  antiFarmHours: 24
};

/** 构造成员 + 一场比赛，返回每个人的 delta 列表 */
function simulate({ settings = {}, type = 'singles', matches } = {}) {
  const ids = type === 'doubles' ? ['a', 'b', 'c', 'd'] : ['a', 'b'];
  const list = matches || [
    {
      id: 'm1',
      type,
      status: 'active',
      team1: type === 'doubles' ? ['a', 'b'] : ['a'],
      team2: type === 'doubles' ? ['c', 'd'] : ['b'],
      winner: '1',
      playedAt: 1,
      createdAt: 1
    }
  ];
  const db = {
    users: ids.map((id) => ({ id })),
    settings: { ...BASE, ...settings },
    matches: list,
    ratings: {}
  };
  elo.recompute(db);
  return {
    db,
    deltas: db.matches.map((m) => m.changes.map((c) => c.delta))
  };
}

console.log('\n== A. 保底规则本身 ==');

// K=16 且双方同分：理论值 16 * 0.5 = 8，应被抬到 10
let r = simulate({ settings: { kNormal: 16 } });
eq('K=16 同分对局：胜方 +10（理论 8 被抬到 10）', r.deltas[0][0], 10);
eq('K=16 同分对局：负方 -10（对称）', r.deltas[0][1], -10);

r = simulate({ settings: { kNormal: 16, minWinDelta: 0 } });
eq('minWinDelta=0 时关闭保底，K=16 同分仍为 +8', r.deltas[0][0], 8);

r = simulate({ settings: { kNormal: 24 } });
eq('K=24 同分对局理论 +12，高于保底不压缩', r.deltas[0][0], 12);

r = simulate({ settings: { kProvisional: 40, provisionalMatches: 10 } });
eq('定级期 K=40 理论 +20，不受保底影响', r.deltas[0][0], 20);

r = simulate({ settings: { kNormal: 16, minWinDelta: 20 } });
eq('保底值可调：设为 20 时 K=16 同分得 +20', r.deltas[0][0], 20);

console.log('\n== B. 零和守恒 ==');

r = simulate({ settings: { kNormal: 16 } });
eq('单打触发保底后仍零和', r.deltas[0][0] + r.deltas[0][1], 0);

r = simulate({ settings: { kNormal: 16 }, type: 'doubles' });
eq('双打四人总和为零', r.deltas[0].reduce((s, d) => s + d, 0), 0);
ok('双打队友获得同样分数', r.deltas[0][0] === r.deltas[0][1], JSON.stringify(r.deltas[0]));
ok('双打对手扣同样分数', r.deltas[0][2] === -r.deltas[0][0], JSON.stringify(r.deltas[0]));

console.log('\n== C. 与胜负方向的交互 ==');

r = simulate({
  settings: { kNormal: 16 },
  matches: [
    {
      id: 'm1', type: 'singles', status: 'active',
      team1: ['a'], team2: ['b'], winner: '2', playedAt: 1, createdAt: 1
    }
  ]
});
eq('2 号队获胜时，1 号队扣满 10 分', r.deltas[0][0], -10);
eq('2 号队获胜时得 +10', r.deltas[0][1], 10);

console.log('\n== D. 与防刷分的交互 ==');

// 24 小时内重复同一对阵：倍率减半，K=24 → 理论 12*0.5=6，保底抬到 10
r = simulate({
  settings: { kNormal: 24, antiFarm: true, antiFarmHours: 24, antiFarmFactor: 0.5 },
  matches: [
    { id: 'm1', type: 'singles', status: 'active', team1: ['a'], team2: ['b'], winner: '1', playedAt: 1000, createdAt: 1000 },
    { id: 'm2', type: 'singles', status: 'active', team1: ['a'], team2: ['b'], winner: '1', playedAt: 2000, createdAt: 2000 }
  ]
});
eq('重复对阵第一场：+12（不触发防刷）', r.deltas[0][0], 12);
eq('重复对阵第二场：防刷减半后 6 被保底抬到 10', r.deltas[1][0], 10);

r = simulate({
  settings: { kNormal: 24, antiFarm: true, antiFarmHours: 24, antiFarmFactor: 0.5, minWinDelta: 0 },
  matches: [
    { id: 'm1', type: 'singles', status: 'active', team1: ['a'], team2: ['b'], winner: '1', playedAt: 1000, createdAt: 1000 },
    { id: 'm2', type: 'singles', status: 'active', team1: ['a'], team2: ['b'], winner: '1', playedAt: 2000, createdAt: 2000 }
  ]
});
eq('关闭保底时，防刷第二场为 +6（说明保底确实会抵消一半防刷）', r.deltas[1][0], 6);

console.log('\n== E. 作废比赛不产生变化 ==');
r = simulate({
  matches: [
    { id: 'm1', type: 'singles', status: 'void', team1: ['a'], team2: ['b'], winner: '1', playedAt: 1, createdAt: 1 }
  ]
});
eq('作废比赛 changes 为空', r.deltas[0].length, 0);
eq('作废后分数回到起点', r.db.ratings.a.singles.rating, 1500);

console.log('\n========== 结果 ==========');
console.log(`通过 ${pass} 项，失败 ${fail} 项`);
if (fail === 0) console.log('全部通过 ✅');
process.exit(fail === 0 ? 0 : 1);
