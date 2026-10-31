'use strict';

/**
 * Elo 规则
 * - 单打：双方平均 K，期望胜率由分差决定，胜负分对称（零和）
 * - 双打：队伍分 = 两人平均分；四人平均 K；队内两人各加减同样分数
 * - 前 N 场用定级 K（默认 40），之后 24，1800 分以上 16
 * - 详细比分时按分差放大，最多 1.5 倍
 * - 24 小时内重复同一对阵，变化减半（防刷分）
 */

function kFor(rating, played, settings) {
  if (played < settings.provisionalMatches) return settings.kProvisional;
  if (rating >= settings.highThreshold) return settings.kHigh;
  return settings.kNormal;
}

function expected(a, b) {
  return 1 / (1 + Math.pow(10, (b - a) / 400));
}

function marginMultiplier(score1, score2) {
  const total = Number(score1) + Number(score2);
  if (!total) return 1;
  const diff = Math.abs(Number(score1) - Number(score2));
  return Math.min(1.5, 1 + 0.5 * (diff / total));
}

function teamKey(ids) {
  return [...ids].sort().join(',');
}

function matchKey(match) {
  const a = teamKey(match.team1 || []);
  const b = teamKey(match.team2 || []);
  return match.type + ':' + [a, b].sort().join('|');
}

function isRepeat(matches, index, windowMs) {
  const current = matches[index];
  const key = matchKey(current);
  for (let i = index - 1; i >= 0; i--) {
    const prev = matches[i];
    if (current.playedAt - prev.playedAt > windowMs) break;
    if (prev.status === 'active' && matchKey(prev) === key) return true;
  }
  return false;
}

function emptyRating(startRating) {
  return { rating: startRating, matches: 0, wins: 0, losses: 0 };
}

function sortMatches(matches) {
  return [...matches].sort((a, b) => {
    const t = (a.playedAt || 0) - (b.playedAt || 0);
    if (t !== 0) return t;
    return (a.createdAt || 0) - (b.createdAt || 0);
  });
}

/**
 * 从零重算所有 Elo。任何改判、作废、补录都会调用它。
 * 结果写回 db.ratings 和每场比赛的 changes。
 */
function recompute(db) {
  const s = db.settings;
  const ratings = {};
  for (const user of db.users) {
    ratings[user.id] = {
      singles: emptyRating(Number(s.startRating) || 1500),
      doubles: emptyRating(Number(s.startRating) || 1500)
    };
  }

  const matches = sortMatches(db.matches);

  for (let i = 0; i < matches.length; i++) {
    const match = matches[i];
    const changes = [];

    if (match.status === 'active') {
      const team1 = (match.team1 || []).filter((id) => ratings[id]);
      const team2 = (match.team2 || []).filter((id) => ratings[id]);
      const need = match.type === 'doubles' ? 2 : 1;

      if (team1.length === need && team2.length === need) {
        const r1 = team1.map((id) => ratings[id][match.type]);
        const r2 = team2.map((id) => ratings[id][match.type]);
        const avg1 = r1.reduce((sum, r) => sum + r.rating, 0) / r1.length;
        const avg2 = r2.reduce((sum, r) => sum + r.rating, 0) / r2.length;
        const all = [...r1, ...r2];
        const k = all.reduce((sum, r) => sum + kFor(r.rating, r.matches, s), 0) / all.length;

        let multiplier = match.detail ? marginMultiplier(match.score1, match.score2) : 1;
        if (s.antiFarm && isRepeat(matches, i, (Number(s.antiFarmHours) || 24) * 3600 * 1000)) {
          multiplier *= Number(s.antiFarmFactor) || 0.5;
        }

        const exp1 = expected(avg1, avg2);
        const score1 = Number(match.winner) === 1 ? 1 : 0;
        let delta = Math.round(k * multiplier * (score1 - exp1));
        // 保底：胜方至少 +minWinDelta，负方对称扣同样的分数
        const minDelta = Math.abs(Number(s.minWinDelta) || 0);
        if (minDelta > 0) {
          if (score1 === 1) {
            if (delta < minDelta) delta = minDelta;
          } else if (delta > -minDelta) {
            delta = -minDelta;
          }
        }
        if (delta === 0) delta = score1 === 1 ? 1 : -1;

        const before = new Map();
        for (const id of [...team1, ...team2]) before.set(id, ratings[id][match.type].rating);

        for (const id of team1) {
          const r = ratings[id][match.type];
          r.rating = Math.max(100, r.rating + delta);
          r.matches += 1;
          if (score1 === 1) r.wins += 1; else r.losses += 1;
          changes.push({ userId: id, before: before.get(id), after: r.rating, delta: r.rating - before.get(id) });
        }
        for (const id of team2) {
          const r = ratings[id][match.type];
          r.rating = Math.max(100, r.rating - delta);
          r.matches += 1;
          if (score1 === 1) r.losses += 1; else r.wins += 1;
          changes.push({ userId: id, before: before.get(id), after: r.rating, delta: r.rating - before.get(id) });
        }
      }
    }

    match.changes = changes;
  }

  db.ratings = ratings;
  db.matches = matches;
  return db;
}

module.exports = {
  recompute,
  sortMatches,
  kFor,
  expected,
  marginMultiplier,
  matchKey
};
