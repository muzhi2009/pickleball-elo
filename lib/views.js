'use strict';

const esc = (value) => String(value ?? '').replace(/[&<>"']/g, (c) => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
}[c]));

const pad = (n) => String(n).padStart(2, '0');

function fmtDate(ts) {
  if (!ts) return '—';
  const d = new Date(Number(ts));
  return `${d.getFullYear()}/${pad(d.getMonth() + 1)}/${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function fmtShort(ts) {
  if (!ts) return '—';
  const d = new Date(Number(ts));
  return `${pad(d.getMonth() + 1)}/${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function toLocalInput(ts) {
  const d = new Date(Number(ts) || Date.now());
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function ratingText(value) {
  return String(Math.round(Number(value) || 0));
}

function deltaHtml(delta) {
  const n = Math.round(Number(delta) || 0);
  const cls = n > 0 ? 'up' : n < 0 ? 'down' : 'flat';
  return `<span class="delta ${cls}">${n > 0 ? '+' : ''}${n}</span>`;
}

function typeLabel(type) {
  return type === 'doubles' ? '双打' : '单打';
}

function statusBadges(match, settings) {
  const out = [];
  if (match.status === 'pending') out.push('<span class="badge badge-pending">待审核</span>');
  if (match.status === 'rejected') out.push('<span class="badge badge-rejected">已驳回</span>');
  if (match.status === 'void') out.push('<span class="badge badge-void">已作废</span>');
  if (match.disputed) out.push('<span class="badge badge-warn">争议中</span>');
  return out.join('');
}

function provisionalBadge(played, settings) {
  return played > 0 && played < settings.provisionalMatches ? '<span class="badge">定级中</span>' : '';
}

function layout(ctx) {
  const { settings, user, title, active = '', body = '', flash = null } = ctx;
  const club = esc(settings.clubName || '匹克球社');
  const navItems = [
    ['/', '排行榜', 'home'],
    ['/matches', '比赛', 'matches'],
    ['/game', '小游戏', 'game']
  ];
  if (user && user.status === 'active') navItems.push(['/record', '录入', 'record']);
  if (user) navItems.push(['/me', '我的', 'me']);
  const canEnterAdmin = user && (user.role === 'admin' || user.role === 'reviewer');
  if (canEnterAdmin) {
    const waiting = Number(ctx.pendingReviews) || 0;
    const dot = waiting > 0 ? `<span class="nav-badge">${waiting}</span>` : '';
    navItems.push(['/admin', '管理' + dot, 'admin']);
  }

  const nav = navItems.map(([href, label, key]) =>
    `<a class="nav-link ${active === key ? 'on' : ''}" href="${href}">${label}</a>`
  ).join('');

  const account = user
    ? `<a class="nav-link nav-user" href="/me">${esc(user.nickname)}</a>
       <form class="inline" method="post" action="/logout"><button class="linkbtn" type="submit">退出</button></form>`
    : `<a class="nav-link ${active === 'login' ? 'on' : ''}" href="/login">登录</a>
       <a class="nav-link ${active === 'register' ? 'on' : ''}" href="/register">注册</a>`;

  const flashHtml = flash
    ? `<div class="flash flash-${esc(flash.type || 'ok')}" role="status">${esc(flash.msg)}</div>`
    : '';

  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="theme-color" content="#0a0a0a">
<title>${esc(title || club)} · ${club}</title>
<link rel="icon" href="/static/icon.svg" type="image/svg+xml">
<link rel="stylesheet" href="/static/style.css?v=7">
${ctx.extraHead || ''}
</head>
<body data-logged-in="${user ? '1' : '0'}">
<header class="topbar">
  <div class="wrap topbar-inner">
    <a class="brand" href="/">${club}<span class="brand-tag">ELO</span></a>
    <nav class="nav">${nav}</nav>
    <div class="account">${account}</div>
  </div>
</header>
<main class="wrap main">
${flashHtml}
${body}
</main>
<footer class="footer">
  <div class="wrap footer-inner">
    <span>${club} · Elo 排位</span>
    <span class="muted">胜负有数，快乐无价</span>
  </div>
</footer>
<script src="/static/app.js?v=5" defer></script>
${ctx.extraScripts || ''}
</body>
</html>`;
}

function statCard(label, value, sub = '') {
  return `<div class="stat"><div class="stat-value">${esc(value)}</div><div class="stat-label">${esc(label)}</div>${sub ? `<div class="stat-sub">${esc(sub)}</div>` : ''}</div>`;
}

function emptyState(text, action = '') {
  return `<div class="empty"><p>${esc(text)}</p>${action}</div>`;
}

function leaderboardPage(ctx) {
  const { settings, user, type, rows, stats, announcement } = ctx;
  const tabs = `
    <div class="tabs" role="tablist">
      <a class="tab ${type === 'singles' ? 'on' : ''}" href="/?type=singles">单打</a>
      <a class="tab ${type === 'doubles' ? 'on' : ''}" href="/?type=doubles">双打</a>
    </div>`;

  const head = `
    <div class="lb-head">
      <div class="rank">#</div>
      <div class="who">球员</div>
      <div class="rating">Elo</div>
      <div class="meta">场次</div>
      <div class="trend">近 7 天</div>
    </div>`;

  const body = rows.length ? rows.map((row, i) => {
    const name = user
      ? `<a href="/players/${encodeURIComponent(row.id)}">${esc(row.nickname)}</a>`
      : `<span>${esc(row.nickname)}</span>`;
    return `
      <div class="lb-row ${i < 3 ? 'top top-' + (i + 1) : ''}">
        <div class="rank" data-label="排名">${i + 1}</div>
        <div class="who" data-label="球员">
          <span class="rank-dot"></span>${name}
          ${provisionalBadge(row.matches, settings)}
        </div>
        <div class="rating" data-label="Elo">${ratingText(row.rating)}</div>
        <div class="meta" data-label="场次">${row.matches}</div>
        <div class="trend" data-label="近 7 天">${row.delta7 ? deltaHtml(row.delta7) : '<span class="delta flat">0</span>'}</div>
      </div>`;
  }).join('') : emptyState('还没有比赛记录，等第一场开打。');

  ctx.body = `
    <section class="hero">
      <div class="hero-top">
        <div>
          <p class="eyebrow">CLUB RANKING</p>
          <h1>${esc(settings.clubName)}</h1>
          <p class="hero-sub">${type === 'doubles' ? '双打' : '单打'} Elo 排行榜 · 从 ${ratingText(settings.startRating)} 分起步</p>
        </div>
        ${tabs}
      </div>
      ${announcement ? `<div class="notice"><span class="notice-dot"></span>${esc(announcement)}</div>` : ''}
      <div class="stats">
        ${statCard('活跃成员', stats.members)}
        ${statCard('有效比赛', stats.matches)}
        ${statCard('最高分', rows.length ? ratingText(rows[0].rating) : '—', rows.length ? rows[0].nickname : '')}
      </div>
    </section>

    <section class="panel">
      ${head}
      <div class="lb-body">${body}</div>
    </section>

    <p class="hint">${user ? '点击球员查看详细战绩。' : '排行榜公开；点击球员详情需要登录。'}</p>
  `;
  ctx.title = '排行榜';
  ctx.active = 'home';
  return layout(ctx);
}

function matchCard(match, users, { link = false } = {}) {
  const name = (id) => esc(users[id] ? users[id].nickname : '已删除');
  const t1 = (match.team1 || []).map(name).join(' / ') || '—';
  const t2 = (match.team2 || []).map(name).join(' / ') || '—';
  const notCounted = match.status === 'void' || match.status === 'rejected';
  const score = notCounted
    ? '<span class="score score-void">—</span>'
    : match.detail && match.score1 != null && match.score2 != null
      ? `<span class="score">${esc(match.score1)} : ${esc(match.score2)}</span>`
      : '<span class="score score-win">胜</span>';
  const winner1 = Number(match.winner) === 1;
  const status = match.status === 'pending'
    ? '<span class="badge badge-pending">待审核</span>'
    : match.status === 'rejected'
      ? '<span class="badge badge-rejected">已驳回</span>'
      : match.status === 'void'
        ? '<span class="badge badge-void">作废</span>'
        : match.disputed ? '<span class="badge badge-warn">争议</span>' : '';
  const inner = `
    <div class="match-meta">
      <span class="tag">${typeLabel(match.type)}</span>
      <span class="muted">${fmtShort(match.playedAt)}</span>
      ${status}
    </div>
    <div class="match-line">
      <span class="side ${winner1 ? 'win' : ''}">${t1}</span>
      ${score}
      <span class="side ${!winner1 ? 'win' : ''}">${t2}</span>
    </div>
    ${match.changes && match.changes.length ? `<div class="chips">${match.changes.map((c) =>
      `<span class="chip">${esc(users[c.userId] ? users[c.userId].nickname : '?')} ${deltaHtml(c.delta)}</span>`
    ).join('')}</div>` : ''}
  `;
  const flag = match.status === 'pending' ? ' is-pending' : match.status === 'rejected' ? ' is-rejected' : '';
  return link
    ? `<a class="match-card link${flag}" href="/matches/${encodeURIComponent(match.id)}">${inner}</a>`
    : `<div class="match-card${flag}">${inner}</div>`;
}

function matchesPage(ctx) {
  const { user, items, users, page, pages, total, type } = ctx;
  const filter = `
    <div class="tabs">
      <a class="tab ${!type ? 'on' : ''}" href="/matches">全部</a>
      <a class="tab ${type === 'singles' ? 'on' : ''}" href="/matches?type=singles">单打</a>
      <a class="tab ${type === 'doubles' ? 'on' : ''}" href="/matches?type=doubles">双打</a>
    </div>`;

  const list = items.length
    ? items.map((m) => matchCard(m, users, { link: !!user })).join('')
    : emptyState('这个分类下还没有比赛。');

  const pager = pages > 1 ? `
    <div class="pager">
      ${page > 1 ? `<a class="btn btn-ghost" href="/matches?page=${page - 1}${type ? '&type=' + type : ''}">上一页</a>` : '<span></span>'}
      <span class="muted">第 ${page} / ${pages} 页</span>
      ${page < pages ? `<a class="btn btn-ghost" href="/matches?page=${page + 1}${type ? '&type=' + type : ''}">下一页</a>` : '<span></span>'}
    </div>` : '';

  ctx.body = `
    <div class="page-head">
      <div>
        <p class="eyebrow">MATCHES</p>
        <h1>比赛记录</h1>
        <p class="muted">共 ${total} 场${user ? '' : ' · 登录后可查看单场详情'}</p>
      </div>
      ${filter}
    </div>
    <section class="match-list">${list}</section>
    ${pager}
  `;
  ctx.title = '比赛记录';
  ctx.active = 'matches';
  return layout(ctx);
}

function matchPage(ctx) {
  const { match, users, canDispute, isAdmin, user } = ctx;
  const name = (id) => esc(users[id] ? users[id].nickname : '已删除');
  const t1 = (match.team1 || []).map(name);
  const t2 = (match.team2 || []).map(name);
  const winner1 = Number(match.winner) === 1;
  const score = match.detail && match.score1 != null
    ? `${esc(match.score1)} : ${esc(match.score2)}`
    : (winner1 ? 'A 胜' : 'B 胜');

  const changes = (match.changes || []).map((c) => {
    const u = users[c.userId];
    return `<div class="change-row">
      <span>${esc(u ? u.nickname : '已删除')}</span>
      <span class="muted">${ratingText(c.before)} → ${ratingText(c.after)}</span>
      ${deltaHtml(c.delta)}
    </div>`;
  }).join('');

  const dispute = match.disputed && match.dispute ? `
    <div class="notice notice-warn">
      <strong>争议中</strong>
      <p>${esc(match.dispute.reason || '')}</p>
      <p class="muted">提交于 ${fmtDate(match.dispute.at)}</p>
    </div>` : '';

  const resolved = !match.disputed && match.dispute && match.dispute.resolution ? `
    <div class="notice">
      <strong>争议已处理</strong>
      <p>${esc(match.dispute.resolution)}</p>
    </div>` : '';

  const disputeForm = canDispute ? `
    <section class="panel">
      <h2>对结果有异议？</h2>
      <p class="muted">比赛录入后 <strong>${ctx.settings.disputeHours}</strong> 小时内可以发起申诉，管理员会核实处理。</p>
      <form method="post" action="/matches/${encodeURIComponent(match.id)}/dispute" class="form">
        <label>异议理由
          <textarea name="reason" rows="3" maxlength="300" required placeholder="例如：比分记错了，实际是 11-8"></textarea>
        </label>
        <button class="btn" type="submit">提交申诉</button>
      </form>
    </section>` : '';

  /* ---------- 审核相关 ---------- */
  const mid = encodeURIComponent(match.id);
  const reviewInfo = match.review || {};
  const who = (id) => esc(users[id] ? users[id].nickname : '—');
  const isOwner = !!user && user.id === match.createdBy;

  const pendingBox = match.status === 'pending' ? `
    <div class="notice notice-pending">
      <strong>等待审核</strong>
      <p>这场由${who(match.createdBy)} 于 ${fmtDate(match.createdAt)} 提交，通过后才计入排名，现在不影响任何人的 Elo。</p>
    </div>` : '';

  const selfBlocked = match.status === 'pending' && user && user.role === 'reviewer' && user.id === match.createdBy ? `
    <div class="notice">
      <strong>自己录的，不能自己审</strong>
      <p>这场需要管理员或另一位审核员通过才算生效。</p>
    </div>` : '';

  const rejectedBox = match.status === 'rejected' ? `
    <div class="notice notice-warn">
      <strong>已驳回</strong>
      <p>${esc(reviewInfo.note || '审核者没有填写原因')}</p>
      <p class="muted">由${who(reviewInfo.by)} 于 ${fmtDate(reviewInfo.at)} 驳回</p>
    </div>` : '';

  const approvedLine = match.status === 'active' && reviewInfo.by ? `
    <p class="muted small">审核：${who(reviewInfo.by)} 于 ${fmtDate(reviewInfo.at)} 通过${reviewInfo.self ? '（自己录入、自行通过）' : ''}</p>` : '';

  const reviewPanel = ctx.canReview ? `
    <section class="panel">
      <h2>审核这场</h2>
      <p class="muted">通过后立即计入 Elo。驳回会保留记录、不计分，录入人可以改完再提交。</p>
      <div class="btn-row">
        <form method="post" action="/admin/review/${mid}" class="inline">
          <input type="hidden" name="action" value="approve">
          <button class="btn" type="submit">通过</button>
        </form>
        <a class="btn btn-ghost" href="/admin/review/${mid}/edit">改后通过</a>
      </div>
      <details class="reject-box reject-panel">
        <summary class="btn btn-ghost">驳回，并说明原因</summary>
        <form method="post" action="/admin/review/${mid}" class="form">
          <input type="hidden" name="action" value="reject">
          <label>原因
            <textarea name="note" rows="2" maxlength="200" required placeholder="例如：比分记反了，实际 A 队 8 分"></textarea>
          </label>
          <button class="btn btn-ghost" type="submit">确认驳回</button>
        </form>
      </details>
    </section>` : '';

  const ownerPanel = isOwner && (match.status === 'pending' || match.status === 'rejected') ? `
    <section class="panel">
      <h2>这场是我录的</h2>
      <div class="btn-row">
        ${match.status === 'rejected' ? `<form method="post" action="/matches/${mid}/resubmit" class="inline">
          <button class="btn" type="submit">改好了，重新提交</button>
        </form>` : ''}
        <form method="post" action="/matches/${mid}/withdraw" class="inline" data-confirm="确定撤销这场提交吗？记录会被删除。">
          <button class="btn btn-ghost" type="submit">撤销这场提交</button>
        </form>
      </div>
    </section>` : '';

  ctx.body = `
    <p class="crumb"><a href="/matches">← 返回比赛列表</a></p>
    ${pendingBox}
    ${selfBlocked}
    ${rejectedBox}
    <section class="panel match-detail">
      <div class="match-meta">
        <span class="tag">${typeLabel(match.type)}</span>
        <span class="muted">${fmtDate(match.playedAt)}</span>
        ${statusBadges(match, ctx.settings)}
      </div>
      <div class="versus">
        <div class="team ${winner1 ? 'win' : ''}">
          <span class="team-label">队伍 A</span>
          ${t1.map((n) => `<strong>${n}</strong>`).join('')}
        </div>
        <div class="vs-score">${score}</div>
        <div class="team ${!winner1 ? 'win' : ''}">
          <span class="team-label">队伍 B</span>
          ${t2.map((n) => `<strong>${n}</strong>`).join('')}
        </div>
      </div>
      ${match.note ? `<p class="note">备注：${esc(match.note)}</p>` : ''}
      <h2>Elo 变化</h2>
      <div class="changes">${match.status === 'pending'
        ? '<p class="muted">还没通过审核，暂不计算 Elo。</p>'
        : match.status === 'rejected'
          ? '<p class="muted">这场被驳回了，不计分。</p>'
          : (changes || '<p class="muted">本场没有产生分数变化。</p>')}</div>
      ${approvedLine}
      ${isAdmin ? `<p><a class="btn btn-ghost" href="/admin/matches/${mid}/edit">编辑这场比赛</a></p>` : ''}
    </section>
    ${dispute}
    ${resolved}
    ${disputeForm}
    ${reviewPanel}
    ${ownerPanel}
    <p class="muted small">录入人：${who(match.createdBy)} · 录入时间 ${fmtDate(match.createdAt)}</p>
  `;
  ctx.title = '比赛详情';
  ctx.active = 'matches';
  return layout(ctx);
}

function chartSvg(points) {
  if (!points || points.length < 2) return '<p class="muted small">至少两场比赛后显示走势。</p>';
  const w = 640;
  const h = 170;
  const padX = 10;
  const padY = 14;
  const values = points.map((p) => p.rating);
  const min = Math.min(...values);
  const max = Math.max(...values);
  const span = max - min || 1;
  const coords = points.map((p, i) => {
    const x = padX + (i / (points.length - 1)) * (w - padX * 2);
    const y = h - padY - ((p.rating - min) / span) * (h - padY * 2);
    return `${x.toFixed(1)},${y.toFixed(1)}`;
  }).join(' ');
  const area = `${padX},${h - padY} ${coords} ${w - padX},${h - padY}`;
  return `<svg class="chart" viewBox="0 0 ${w} ${h}" role="img" aria-label="Elo 走势">
    <polygon points="${area}" class="chart-area"></polygon>
    <polyline points="${coords}" class="chart-line"></polyline>
  </svg>
  <div class="chart-range"><span>${ratingText(min)}</span><span>${ratingText(max)}</span></div>`;
}

function playerPage(ctx) {
  const { player, ratings, history, opponents } = ctx;
  const isSelf = ctx.user && ctx.user.id === player.id;

  const historyRows = history.length ? history.map((hitem) => {
    const m = hitem.match;
    const win = (Number(m.winner) === 1) === (m.team1 || []).includes(player.id);
    const opp = (m.team1 || []).includes(player.id) ? m.team2 : m.team1;
    return `<div class="hist-row ${m.status === 'void' ? 'void' : ''}">
      <span class="hist-date">${fmtShort(m.playedAt)}</span>
      <span class="hist-type">${typeLabel(m.type)}</span>
      <span class="hist-opp">vs ${(opp || []).map((id) => esc(ctx.users[id] ? ctx.users[id].nickname : '?')).join(' / ')}</span>
      <span class="hist-result ${win ? 'win' : 'lose'}">${m.status === 'void' ? '作废' : win ? '胜' : '负'}</span>
      ${deltaHtml(hitem.delta)}
    </div>`;
  }).join('') : emptyState('还没有比赛记录。');

  const h2h = opponents.length ? opponents.map((o) => `
    <div class="h2h-row">
      <span>${esc(o.nickname)}</span>
      <span class="muted">${o.wins} 胜 ${o.losses} 负</span>
      <span class="h2h-bar"><i style="width:${o.total ? Math.round((o.wins / o.total) * 100) : 0}%"></i></span>
    </div>`).join('') : '<p class="muted">还没有交手记录。</p>';

  ctx.body = `
    <div class="page-head">
      <div>
        <p class="eyebrow">PLAYER</p>
        <h1>${esc(player.nickname)} ${isSelf ? '<span class="badge">我</span>' : ''}</h1>
        <p class="muted">加入于 ${fmtDate(player.createdAt)}</p>
      </div>
      ${isSelf ? '<a class="btn btn-ghost" href="/record">录入比赛</a>' : ''}
    </div>

    <div class="rating-cards">
      <div class="rating-card">
        <span class="rating-label">单打 Elo</span>
        <strong class="rating-big">${ratingText(ratings.singles.rating)}</strong>
        <span class="muted">${ratings.singles.matches} 场 · ${ratings.singles.wins} 胜 ${ratings.singles.losses} 负</span>
        ${provisionalBadge(ratings.singles.matches, ctx.settings)}
      </div>
      <div class="rating-card">
        <span class="rating-label">双打 Elo</span>
        <strong class="rating-big">${ratingText(ratings.doubles.rating)}</strong>
        <span class="muted">${ratings.doubles.matches} 场 · ${ratings.doubles.wins} 胜 ${ratings.doubles.losses} 负</span>
        ${provisionalBadge(ratings.doubles.matches, ctx.settings)}
      </div>
    </div>

    <section class="panel">
      <div class="panel-head"><h2>单打走势</h2><span class="muted">最近 20 场</span></div>
      ${chartSvg(ctx.charts.singles)}
      <div class="panel-head spaced"><h2>双打走势</h2><span class="muted">最近 20 场</span></div>
      ${chartSvg(ctx.charts.doubles)}
    </section>

    <section class="panel">
      <div class="panel-head"><h2>最近战绩</h2><span class="muted">${history.length} 场</span></div>
      <div class="hist">${historyRows}</div>
    </section>

    <section class="panel">
      <div class="panel-head"><h2>交手记录</h2></div>
      <div class="h2h">${h2h}</div>
    </section>
  `;
  ctx.title = player.nickname;
  ctx.active = 'me';
  return layout(ctx);
}

function playerOptions(players, selected) {
  return players.map((p) =>
    `<option value="${esc(p.id)}" ${selected === p.id ? 'selected' : ''}>${esc(p.nickname)}（${ratingText(p.rating)}）</option>`
  ).join('');
}

function matchForm(ctx, { action, players, values = {}, submitLabel = '提交比赛', admin = false }) {
  let v = { ...values };
  if (!v.id) {
    v.t1p1 = v.t1p1 || (players[0] && players[0].id) || '';
    v.t2p1 = v.t2p1 || (players[1] && players[1].id) || '';
    v.t1p2 = v.t1p2 || (players[2] && players[2].id) || '';
    v.t2p2 = v.t2p2 || (players[3] && players[3].id) || '';
  }
  const type = v.type || 'singles';
  const detail = v.detail === true || v.detail === '1';
  const winner = String(v.winner || '1');

  return `
  <form method="post" action="${action}" class="form" data-match-form>
    <div class="field">
      <span class="field-label">比赛类型</span>
      <div class="seg">
        <label><input type="radio" name="type" value="singles" ${type === 'singles' ? 'checked' : ''}> 单打</label>
        <label><input type="radio" name="type" value="doubles" ${type === 'doubles' ? 'checked' : ''}> 双打</label>
      </div>
    </div>

    <div class="team-grid">
      <fieldset class="team-card">
        <legend>队伍 A</legend>
        <label>选手 1
          <select name="t1p1" required>${playerOptions(players, v.t1p1)}</select>
        </label>
        <label class="doubles-only">选手 2
          <select name="t1p2">${playerOptions(players, v.t1p2)}</select>
        </label>
      </fieldset>
      <fieldset class="team-card">
        <legend>队伍 B</legend>
        <label>选手 1
          <select name="t2p1" required>${playerOptions(players, v.t2p1)}</select>
        </label>
        <label class="doubles-only">选手 2
          <select name="t2p2">${playerOptions(players, v.t2p2)}</select>
        </label>
      </fieldset>
    </div>

    <div class="field">
      <span class="field-label">获胜队伍</span>
      <div class="seg">
        <label><input type="radio" name="winner" value="1" ${winner === '1' ? 'checked' : ''}> 队伍 A 获胜</label>
        <label><input type="radio" name="winner" value="2" ${winner === '2' ? 'checked' : ''}> 队伍 B 获胜</label>
      </div>
    </div>

    <label class="check"><input type="checkbox" name="detail" value="1" data-detail-toggle ${detail ? 'checked' : ''}> 记录详细比分（可选，赢得多加分也多）</label>
    <div class="score-box" data-score-box ${detail ? '' : 'hidden'}>
      <label>队伍 A 得分 <input type="number" name="score1" min="0" max="99" value="${v.score1 != null ? esc(v.score1) : ''}" inputmode="numeric"></label>
      <label>队伍 B 得分 <input type="number" name="score2" min="0" max="99" value="${v.score2 != null ? esc(v.score2) : ''}" inputmode="numeric"></label>
    </div>

    <label>比赛时间
      <input type="datetime-local" name="playedAt" value="${esc(toLocalInput(v.playedAt))}" ${admin ? '' : ''}>
    </label>

    <label>备注（可选）
      <input type="text" name="note" maxlength="200" value="${esc(v.note || '')}" placeholder="例如：社团活动日第三场">
    </label>

    ${admin ? `<label>状态
      <select name="status">
        <option value="active" ${v.status !== 'void' ? 'selected' : ''}>有效</option>
        <option value="void" ${v.status === 'void' ? 'selected' : ''}>作废</option>
      </select>
    </label>` : ''}

    <button class="btn btn-block" type="submit">${esc(submitLabel)}</button>
  </form>`;
}

function recordPage(ctx) {
  const { players, error, values } = ctx;
  ctx.body = `
    <div class="page-head">
      <div>
        <p class="eyebrow">RECORD</p>
        <h1>录入比赛</h1>
        <p class="muted">比赛结束后回来填一下，${ctx.settings.requireApproval !== false ? '管理员审核通过后才计入排名。' : '分数立即生效。'}</p>
      </div>
    </div>
    ${error ? `<div class="flash flash-err">${esc(error)}</div>` : ''}
    ${players.length < 2 ? emptyState('至少需要 2 名已审核成员才能录入比赛。', '<a class="btn" href="/admin/users">去审核成员</a>') : `
      <section class="panel">
        ${matchForm(ctx, { action: '/record', players, values })}
      </section>
      <p class="hint">双打时队伍内两人不能重复。${ctx.settings.requireApproval !== false
        ? '提交后进入待审核，通过前不影响任何人的分数。'
        : `提交后对方 ${ctx.settings.disputeHours} 小时内可申诉。`}</p>
    `}
  `;
  ctx.title = '录入比赛';
  ctx.active = 'record';
  return layout(ctx);
}

function mePage(ctx) {
  const { ratings, history, pending, submissions = [] } = ctx;
  const rows = history.length ? history.map((hitem) => {
    const m = hitem.match;
    const win = (Number(m.winner) === 1) === (m.team1 || []).includes(ctx.user.id);
    return `<a class="hist-row link" href="/matches/${encodeURIComponent(m.id)}">
      <span class="hist-date">${fmtShort(m.playedAt)}</span>
      <span class="hist-type">${typeLabel(m.type)}</span>
      <span class="hist-opp">${win ? '胜' : '负'}</span>
      ${deltaHtml(hitem.delta)}
    </a>`;
  }).join('') : emptyState('还没有比赛，去录第一场吧。', '<a class="btn" href="/record">录入比赛</a>');

  const pendingHtml = pending.length ? pending.map((m) =>
    `<a class="hist-row link" href="/matches/${encodeURIComponent(m.id)}">
      <span class="hist-date">${fmtShort(m.playedAt)}</span>
      <span class="hist-type">${typeLabel(m.type)}</span>
      <span class="hist-opp">争议处理中</span>
    </a>`).join('') : '<p class="muted">没有待处理的申诉。</p>';

  const submissionHtml = submissions.length ? submissions.map((m) =>
    `<a class="hist-row link" href="/matches/${encodeURIComponent(m.id)}">
      <span class="hist-date">${fmtShort(m.playedAt)}</span>
      <span class="hist-type">${typeLabel(m.type)}</span>
      <span class="hist-opp">${m.status === 'pending' ? '等审核' : '被驳回'}</span>
      ${m.status === 'pending' ? '<span class="badge badge-pending">待审核</span>' : '<span class="badge badge-rejected">已驳回</span>'}
    </a>`).join('') : '';

  const roleText = ctx.user.role === 'admin' ? '管理员' : ctx.user.role === 'reviewer' ? '审核员' : '成员';

  ctx.body = `
    <div class="page-head">
      <div>
        <p class="eyebrow">ME</p>
        <h1>${esc(ctx.user.nickname)}</h1>
        <p class="muted">${roleText} · 加入于 ${fmtDate(ctx.user.createdAt)}</p>
      </div>
      <a class="btn" href="/record">录入比赛</a>
    </div>
    <div class="rating-cards">
      <div class="rating-card">
        <span class="rating-label">单打 Elo</span>
        <strong class="rating-big">${ratingText(ratings.singles.rating)}</strong>
        <span class="muted">${ratings.singles.matches} 场 · ${ratings.singles.wins} 胜 ${ratings.singles.losses} 负</span>
      </div>
      <div class="rating-card">
        <span class="rating-label">双打 Elo</span>
        <strong class="rating-big">${ratingText(ratings.doubles.rating)}</strong>
        <span class="muted">${ratings.doubles.matches} 场 · ${ratings.doubles.wins} 胜 ${ratings.doubles.losses} 负</span>
      </div>
    </div>
    ${submissions.length ? `<section class="panel">
      <div class="panel-head"><h2>我提交的</h2><span class="muted">等待审核 ${submissions.filter((m) => m.status === 'pending').length} 场</span></div>
      <div class="hist">${submissionHtml}</div>
      <p class="hint">被人驳回的可以点进去修改后重新提交，或者直接撤销。</p>
    </section>` : ''}
    <section class="panel">
      <div class="panel-head"><h2>我的比赛</h2><a class="muted small" href="/players/${encodeURIComponent(ctx.user.id)}">查看详情 →</a></div>
      <div class="hist">${rows}</div>
    </section>
    <section class="panel">
      <div class="panel-head"><h2>待处理申诉</h2></div>
      <div class="hist">${pendingHtml}</div>
    </section>
  `;
  ctx.title = '我的';
  ctx.active = 'me';
  return layout(ctx);
}

function gamePage(ctx) {
  const { user, best = 0, top = [], plays = 0 } = ctx;

  const rows = top.length
    ? top.map((item, i) => {
      const medal = i < 3 ? ['🥇', '🥈', '🥉'][i] : String(i + 1);
      return `<tr class="${item.me ? 'rank-me' : ''}">
          <td class="rank-no">${medal}</td>
          <td class="rank-name">${esc(item.name)}</td>
          <td class="rank-score">${item.best}</td>
        </tr>`;
    }).join('')
    : '<tr><td colspan="3" class="rank-empty">还没有人上榜，来做第一个</td></tr>';

  const guest = user
    ? ''
    : `<div class="guest-note">
        还没登录，可以随便玩，但成绩不会上榜。
        <a href="/login">登录</a> 后再来一局就能记分。
      </div>`;

  ctx.body = `
    <div class="game-wrap">
      <div class="game-main">
        <div class="game-head">
          <div>
            <p class="eyebrow">SAME BALL MERGE</p>
            <h1>合成大匹克球</h1>
          </div>
          <div class="game-stats">
            <div class="stat-pill"><span>本局</span><strong id="gameScore">0</strong></div>
            <div class="stat-pill"><span>我的最高</span><strong id="gameBest" data-best="${best}">${best}</strong></div>
          </div>
        </div>

        <div class="board-shell">
          <canvas id="gameCanvas" width="360" height="560" aria-label="游戏区"></canvas>
          <div class="game-over" id="gameOver" hidden>
            <div class="over-card">
              <h2>这局结束</h2>
              <div class="over-score" id="overScore">0</div>
              <div class="over-sub">最高分 <strong id="overBest">0</strong></div>
              <div class="over-note" id="overNote"></div>
              <button class="btn-primary" id="restartBtn" type="button">再来一局</button>
            </div>
          </div>
        </div>

        <div class="game-hint">
          <span class="hint-touch">按住移动，松手落球</span>
          <span class="hint-keys">移动鼠标瞄准，点击落球（← → 移动，空格落下）</span>
          <div class="next-box">
            <span>下一个</span>
            <canvas id="nextBall" width="40" height="40" aria-label="下一个球"></canvas>
            <button class="iconbtn" id="soundBtn" type="button" aria-label="音效开关">🔊</button>
          </div>
        </div>
      </div>

      <aside class="game-side">
        <div class="panel">
          <div class="panel-head">
            <h2>最高分榜</h2>
            <span class="muted small">${user ? '已玩 ' + plays + ' 局' : '全部时间'}</span>
          </div>
          <table class="rank-table">
            <thead><tr><th>#</th><th>成员</th><th>最高分</th></tr></thead>
            <tbody id="rankBody">${rows}</tbody>
          </table>
        </div>

        <div class="panel">
          <div class="panel-head"><h2>怎么玩</h2></div>
          <ul class="rules">
            <li>点击或按住屏幕左右移动，松手落球</li>
            <li>两只<b>同色同级</b>的球撞上，会合成高一级</li>
            <li>合出的球等级越高，单次加分越多</li>
            <li>球堆过虚线并停稳约 2 秒，这局就结束了</li>
            <li>每人只记<b>历史最高分</b>，可以无限重来</li>
          </ul>
        </div>

        ${guest}
      </aside>
    </div>`;

  ctx.title = '合成大匹克球';
  ctx.active = 'game';
  ctx.extraHead = '<link rel="stylesheet" href="/static/game.css?v=6">';
  ctx.extraScripts = '<script src="/static/matter.min.js" defer></script>\n<script src="/static/game.js?v=6" defer></script>';
  return layout(ctx);
}

function authPage(ctx, opts = {}) {
  const isSetup = opts.mode === 'setup';
  const isLogin = opts.mode === 'login';
  const title = isSetup ? '初始化站点' : isLogin ? '登录' : '注册';
  // 错误与回填值可能来自调用参数，也可能直接挂在 ctx 上，两处都兼容
  const error = opts.error || ctx.error || '';
  const values = opts.values || ctx.values || {};
  ctx.body = `
    <div class="auth-wrap">
      <section class="panel auth-panel">
        <p class="eyebrow">${isSetup ? 'FIRST RUN' : isLogin ? 'SIGN IN' : 'JOIN'}</p>
        <h1>${title}</h1>
        ${isSetup ? '<p class="muted">第一次启动，请创建管理员账号。创建后这个页面会自动关闭。</p>' : ''}
        ${isLogin ? '<p class="muted">用昵称和密码登录。</p>' : ''}
        ${!isSetup && !isLogin ? '<p class="muted">注册后需要管理员审核通过才能录入比赛。</p>' : ''}
        ${error ? `<div class="flash flash-err" role="alert">${esc(error)}</div>` : ''}
        <form method="post" action="${isSetup ? '/setup' : isLogin ? '/login' : '/register'}" class="form">
          <label>昵称
            <input type="text" name="nickname" required minlength="2" maxlength="16" autocomplete="username" value="${esc(values.nickname || '')}" placeholder="2-16 个字符">
          </label>
          <label>密码
            <input type="password" name="password" required minlength="6" maxlength="72" autocomplete="${isLogin ? 'current-password' : 'new-password'}" placeholder="至少 6 位">
          </label>
          ${isLogin ? '' : `<label>确认密码
            <input type="password" name="password2" required minlength="6" maxlength="72" autocomplete="new-password" placeholder="再输一次">
          </label>`}
          <button class="btn btn-block" type="submit">${isSetup ? '创建管理员' : isLogin ? '登录' : '注册'}</button>
        </form>
        ${isLogin ? '<p class="muted small">还没有账号？<a href="/register">注册</a></p>' : ''}
        ${!isLogin && !isSetup ? '<p class="muted small">已有账号？<a href="/login">登录</a></p>' : ''}
      </section>
    </div>
  `;
  ctx.title = title;
  ctx.active = isLogin ? 'login' : !isSetup ? 'register' : '';
  return layout(ctx);
}

function adminNav(active, user) {
  const isAdmin = !!user && user.role === 'admin';
  const items = [
    ['/admin', '概览', 'home'],
    ['/admin/review', '比赛审核', 'review']
  ];
  if (isAdmin) items.push(['/admin/users', '成员', 'users'], ['/admin/matches', '比赛管理', 'matches']);
  items.push(['/admin/disputes', '申诉', 'disputes']);
  if (isAdmin) items.push(['/admin/settings', '设置', 'settings']);
  return `<div class="subnav">${items.map(([href, label, key]) =>
    `<a class="subnav-link ${active === key ? 'on' : ''}" href="${href}">${label}</a>`
  ).join('')}</div>`;
}

function adminHome(ctx) {
  const { counts, logs } = ctx;
  const isAdmin = !!ctx.user && ctx.user.role === 'admin';
  const logRows = logs.slice(-8).reverse().map((l) =>
    `<div class="log-row"><span class="muted">${fmtDate(l.at)}</span><span>${esc(l.by)}</span><span>${esc(l.action)}</span><span class="muted">${esc(l.detail || '')}</span></div>`
  ).join('') || '<p class="muted">还没有操作记录。</p>';

  const stats = [
    statCard('待审核比赛', counts.pendingMatches),
    statCard('有效比赛', counts.matches)
  ];
  if (isAdmin) stats.push(statCard('待审核成员', counts.pending));
  stats.push(statCard('待处理申诉', counts.disputes));

  const cards = [
    `<a class="admin-card${counts.pendingMatches ? ' has-todo' : ''}" href="/admin/review"><strong>比赛审核</strong><span>${counts.pendingMatches ? counts.pendingMatches + ' 场等你通过' : '没有待审的比赛'}</span></a>`
  ];
  if (isAdmin) {
    cards.push(`<a class="admin-card" href="/admin/users"><strong>成员管理</strong><span>审核注册、分配审核员、重置密码</span></a>`);
    cards.push(`<a class="admin-card" href="/admin/matches"><strong>比赛管理</strong><span>改比分、改时间、作废</span></a>`);
  }
  cards.push(`<a class="admin-card" href="/admin/disputes"><strong>申诉处理</strong><span>${counts.disputes} 条待处理</span></a>`);
  if (isAdmin) {
    cards.push(`<a class="admin-card" href="/admin/settings"><strong>规则设置</strong><span>K 值、审核开关、公告</span></a>`);
  }

  ctx.body = `
    <div class="page-head">
      <div><p class="eyebrow">ADMIN</p><h1>管理后台</h1></div>
    </div>
    ${adminNav('home', ctx.user)}
    <div class="stats stats-4">${stats.join('')}</div>
    <div class="admin-grid">${cards.join('')}</div>
    ${isAdmin ? `<section class="panel">
      <div class="panel-head"><h2>数据</h2></div>
      <div class="btn-row">
        <a class="btn btn-ghost" href="/admin/export.csv?type=players">导出成员 CSV</a>
        <a class="btn btn-ghost" href="/admin/export.csv?type=matches">导出比赛 CSV</a>
        <form method="post" action="/admin/recompute" class="inline" data-confirm="确定要从头重算所有 Elo 吗？">
          <button class="btn btn-ghost" type="submit">全量重算 Elo</button>
        </form>
      </div>
    </section>` : ''}
    <section class="panel">
      <div class="panel-head"><h2>最近操作</h2></div>
      <div class="logs">${logRows}</div>
    </section>
  `;
  ctx.title = '管理后台';
  ctx.active = 'admin';
  return layout(ctx);
}

function adminUsers(ctx) {
  const { users, ratings } = ctx;
  const sorted = [...users].sort((a, b) => {
    const rank = { pending: 0, active: 1, banned: 2 };
    if (rank[a.status] !== rank[b.status]) return rank[a.status] - rank[b.status];
    return (a.createdAt || 0) - (b.createdAt || 0);
  });
  const rows = sorted.map((u) => {
    const r = ratings[u.id] || { singles: { rating: 1500 }, doubles: { rating: 1500 } };
    const status = u.status === 'pending' ? '<span class="badge badge-warn">待审核</span>'
      : u.status === 'banned' ? '<span class="badge badge-void">已封禁</span>'
      : '<span class="badge">正常</span>';
    const actions = [];
    if (u.status === 'pending') actions.push(['approve', '通过']);
    if (u.status === 'active' && u.role !== 'admin') actions.push(['ban', '封禁']);
    if (u.status === 'banned') actions.push(['unban', '解封']);
    if (u.role !== 'admin') actions.push(['reset', '重置密码']);
    const isSelf = !!ctx.user && ctx.user.id === u.id;
    const roleCell = `<form method="post" action="/admin/users/${encodeURIComponent(u.id)}" class="role-form">
      <input type="hidden" name="action" value="setRole">
      <select name="role"${isSelf ? ' disabled' : ''}>
        <option value="member" ${u.role === 'member' ? 'selected' : ''}>成员</option>
        <option value="reviewer" ${u.role === 'reviewer' ? 'selected' : ''}>审核员</option>
        <option value="admin" ${u.role === 'admin' ? 'selected' : ''}>管理员</option>
      </select>
      ${isSelf ? '<span class="muted small">自己</span>' : '<button class="linkbtn" type="submit">改</button>'}
    </form>`;
    return `<tr>
      <td><strong>${esc(u.nickname)}</strong></td>
      <td>${roleCell}</td>
      <td>${status}</td>
      <td>${ratingText(r.singles.rating)} / ${ratingText(r.doubles.rating)}</td>
      <td class="muted">${fmtDate(u.createdAt)}</td>
      <td class="actions">${actions.map(([action, label]) =>
        `<form method="post" action="/admin/users/${encodeURIComponent(u.id)}" class="inline">
          <input type="hidden" name="action" value="${action}">
          <button class="linkbtn" type="submit">${label}</button>
        </form>`).join('')}</td>
    </tr>`;
  }).join('');

  ctx.body = `
    <div class="page-head"><div><p class="eyebrow">ADMIN</p><h1>成员管理</h1></div></div>
    ${adminNav('users', ctx.user)}
    <section class="panel">
      <div class="panel-head"><h2>全部成员</h2><span class="muted">${users.length} 人</span></div>
      <div class="table-wrap"><table class="table">
        <thead><tr><th>昵称</th><th>角色</th><th>状态</th><th>单打 / 双打</th><th>注册时间</th><th>操作</th></tr></thead>
        <tbody>${rows || '<tr><td colspan="6" class="muted">还没有成员。</td></tr>'}</tbody>
      </table></div>
      <p class="hint"><strong>审核员</strong>能审别人录入的比赛、能处理跟自己无关的申诉，但改不了比分记录、成员和规则。<strong>管理员</strong>不受这些限制。</p>
    </section>
    <section class="panel">
      <div class="panel-head"><h2>手动创建成员</h2></div>
      <p class="muted small">适合帮不会注册的社团成员建号，创建后直接可用。</p>
      <form method="post" action="/admin/users" class="form form-inline">
        <label>昵称 <input type="text" name="nickname" required minlength="2" maxlength="16"></label>
        <label>初始密码 <input type="text" name="password" required minlength="6" maxlength="72" value=""></label>
        <button class="btn" type="submit">创建</button>
      </form>
    </section>
  `;
  ctx.title = '成员管理';
  ctx.active = 'admin';
  return layout(ctx);
}

function adminMatches(ctx) {
  const { matches, users } = ctx;
  const rows = matches.slice(0, 100).map((m) => {
    const name = (id) => esc(users[id] ? users[id].nickname : '已删除');
    const stateCell = m.status === 'pending' ? '<span class="badge badge-pending">待审核</span>'
      : m.status === 'rejected' ? '<span class="badge badge-rejected">已驳回</span>'
      : m.status === 'void' ? '<span class="badge badge-void">作废</span>'
      : m.disputed ? '<span class="badge badge-warn">争议</span>' : '有效';
    return `<tr class="${m.status === 'void' || m.status === 'rejected' ? 'row-void' : ''}${m.status === 'pending' ? ' row-pending' : ''}">
      <td class="muted">${fmtShort(m.playedAt)}</td>
      <td>${typeLabel(m.type)}</td>
      <td>${(m.team1 || []).map(name).join(' / ')}</td>
      <td>${(m.team2 || []).map(name).join(' / ')}</td>
      <td>${m.detail ? `${esc(m.score1)}:${esc(m.score2)}` : '—'}</td>
      <td>${Number(m.winner) === 1 ? 'A' : 'B'}</td>
      <td>${stateCell}</td>
      <td><a class="linkbtn" href="/admin/matches/${encodeURIComponent(m.id)}/edit">编辑</a></td>
    </tr>`;
  }).join('');
  ctx.body = `
    <div class="page-head"><div><p class="eyebrow">ADMIN</p><h1>比赛管理</h1></div><a class="btn" href="/record">录入新比赛</a></div>
    ${adminNav('matches', ctx.user)}
    <section class="panel">
      <div class="panel-head"><h2>最近 100 场</h2><span class="muted">共 ${matches.length} 场</span></div>
      <div class="table-wrap"><table class="table">
        <thead><tr><th>时间</th><th>类型</th><th>队伍 A</th><th>队伍 B</th><th>比分</th><th>胜</th><th>状态</th><th></th></tr></thead>
        <tbody>${rows || '<tr><td colspan="8" class="muted">还没有比赛。</td></tr>'}</tbody>
      </table></div>
    </section>
  `;
  ctx.title = '比赛管理';
  ctx.active = 'admin';
  return layout(ctx);
}

function adminReview(ctx) {
  const { tab, items, users, counts, reviewerId, adminMode } = ctx;
  const tabs = [
    ['pending', '待审核', counts.pending],
    ['active', '已通过', counts.active],
    ['rejected', '已驳回', counts.rejected],
    ['all', '全部', counts.all]
  ].map(([key, label, n]) =>
    `<a class="tab ${tab === key ? 'on' : ''}" href="/admin/review?tab=${key}">${label}<span class="tab-n">${n}</span></a>`
  ).join('');

  const cards = items.length ? items.map((m) => {
    const name = (id) => esc(users[id] ? users[id].nickname : '已删除');
    const mine = m.createdBy === reviewerId;
    const canAct = m.status === 'pending' && (adminMode || !mine);
    const mid = encodeURIComponent(m.id);
    const winner1 = Number(m.winner) === 1;
    const score = m.detail && m.score1 != null && m.score2 != null
      ? `${esc(m.score1)} : ${esc(m.score2)}`
      : (winner1 ? 'A 胜' : 'B 胜');
    const badge = m.status === 'pending' ? '<span class="badge badge-pending">待审核</span>'
      : m.status === 'rejected' ? '<span class="badge badge-rejected">已驳回</span>'
      : m.status === 'void' ? '<span class="badge badge-void">已作废</span>'
      : '<span class="badge">已通过</span>';

    const review = m.review || {};
    const auditLine = review.by
      ? `<span class="muted small">${review.self ? '自审' : '审核'}：${name(review.by)} · ${fmtDate(review.at)}</span>`
      : '';

    const actions = canAct ? `
      <form method="post" action="/admin/review/${mid}" class="inline">
        <input type="hidden" name="action" value="approve">
        <button class="btn btn-sm" type="submit">通过</button>
      </form>
      <a class="btn btn-ghost btn-sm" href="/admin/review/${mid}/edit">改后通过</a>
      <details class="reject-box">
        <summary class="linkbtn">驳回</summary>
        <form method="post" action="/admin/review/${mid}" class="reject-form">
          <input type="hidden" name="action" value="reject">
          <textarea name="note" rows="2" maxlength="200" required placeholder="写一句原因，方便对方改"></textarea>
          <button class="btn btn-ghost btn-sm" type="submit">确认驳回</button>
        </form>
      </details>`
      : m.status === 'pending'
        ? '<span class="badge badge-warn">自己录的，需管理员审</span>'
        : '';

    return `<article class="review-card${m.status === 'pending' ? ' is-pending' : ''}">
      <div class="review-head">
        ${m.status === 'pending' ? `<input type="checkbox" class="pick" name="ids" value="${esc(m.id)}" form="batchForm" aria-label="选择这场比赛">` : ''}
        <span class="tag">${typeLabel(m.type)}</span>
        <span class="muted">${fmtDate(m.playedAt)}</span>
        ${badge}
      </div>
      <div class="review-line">
        <span class="side ${winner1 ? 'win' : ''}">${(m.team1 || []).map(name).join(' / ')}</span>
        <span class="score">${score}</span>
        <span class="side ${!winner1 ? 'win' : ''}">${(m.team2 || []).map(name).join(' / ')}</span>
      </div>
      ${m.note ? `<p class="muted small">备注：${esc(m.note)}</p>` : ''}
      ${m.status === 'rejected' && review.note ? `<p class="reject-note">驳回原因：${esc(review.note)}</p>` : ''}
      <div class="review-foot">
        <span class="muted small">${name(m.createdBy)} 提交于 ${fmtDate(m.createdAt)}</span>
        <div class="review-actions">${actions}${auditLine}</div>
      </div>
    </article>`;
  }).join('') : emptyState(tab === 'pending' ? '没有待审核的比赛，清爽。' : '这里还没有记录。');

  const batchBar = tab === 'pending' && counts.pending > 0 ? `
    <div class="review-bar">
      <label class="check"><input type="checkbox" data-check-all> 全选本页</label>
      <button class="btn" type="submit" form="batchForm">通过选中的</button>
    </div>` : '';

  ctx.body = `
    <div class="page-head">
      <div><p class="eyebrow">ADMIN</p><h1>比赛审核</h1>
        <p class="muted">${adminMode ? '你录入的比赛也可以自己通过，操作会留痕。' : '别人录入的比赛你可以直接通过；自己录的要等管理员。'}</p>
      </div>
    </div>
    ${adminNav('review', ctx.user)}
    <form id="batchForm" method="post" action="/admin/review/batch"></form>
    <div class="tabs review-tabs">${tabs}</div>
    ${batchBar}
    <section class="review-list">${cards}</section>
  `;
  ctx.title = '比赛审核';
  ctx.active = 'admin';
  return layout(ctx);
}

function adminReviewEdit(ctx) {
  const { match, players } = ctx;
  const values = {
    ...match,
    t1p1: (match.team1 || [])[0],
    t1p2: (match.team1 || [])[1],
    t2p1: (match.team2 || [])[0],
    t2p2: (match.team2 || [])[1],
    playedAt: match.playedAt
  };
  ctx.body = `
    <div class="page-head">
      <div><p class="eyebrow">ADMIN</p><h1>改后通过</h1></div>
    </div>
    ${adminNav('review', ctx.user)}
    ${ctx.error ? `<div class="flash flash-err">${esc(ctx.error)}</div>` : ''}
    <section class="panel">
      <p class="muted">把不对的地方直接改掉，保存后这场就通过审核并计入 Elo。</p>
      ${matchForm(ctx, {
        action: `/admin/review/${encodeURIComponent(match.id)}/edit`,
        players,
        values,
        submitLabel: '保存并通过'
      })}
    </section>
    <p class="hint"><a href="/admin/review">← 返回审核列表</a></p>
  `;
  ctx.title = '改后通过';
  ctx.active = 'admin';
  return layout(ctx);
}

function adminMatchEdit(ctx) {
  const { match, players } = ctx;
  const values = {
    ...match,
    team1: match.team1,
    t1p1: (match.team1 || [])[0],
    t1p2: (match.team1 || [])[1],
    t2p1: (match.team2 || [])[0],
    t2p2: (match.team2 || [])[1],
    playedAt: match.playedAt
  };
  ctx.body = `
    <div class="page-head"><div><p class="eyebrow">ADMIN</p><h1>编辑比赛</h1></div></div>
    ${adminNav('matches', ctx.user)}
    ${ctx.error ? `<div class="flash flash-err">${esc(ctx.error)}</div>` : ''}
    <section class="panel">
      ${matchForm(ctx, { action: `/admin/matches/${encodeURIComponent(match.id)}/edit`, players, values, submitLabel: '保存修改', admin: true })}
    </section>
    <section class="panel">
      <div class="panel-head"><h2>其他操作</h2></div>
      <div class="btn-row">
        <form method="post" action="/admin/matches/${encodeURIComponent(match.id)}/void" class="inline" data-confirm="确定作废这场比赛吗？分数会立即重算。">
          <button class="btn btn-ghost" type="submit">${match.status === 'void' ? '恢复比赛' : '作废比赛'}</button>
        </form>
        <a class="btn btn-ghost" href="/matches/${encodeURIComponent(match.id)}">查看详情</a>
      </div>
    </section>
  `;
  ctx.title = '编辑比赛';
  ctx.active = 'admin';
  return layout(ctx);
}

function adminDisputes(ctx) {
  const { matches, users } = ctx;
  const isAdmin = !!ctx.user && ctx.user.role === 'admin';
  const cards = matches.length ? matches.map((m) => {
    const name = (id) => esc(users[id] ? users[id].nickname : '已删除');
    return `<div class="dispute-card">
      <div class="match-meta">
        <span class="tag">${typeLabel(m.type)}</span>
        <span class="muted">${fmtDate(m.playedAt)}</span>
        <span class="badge badge-warn">争议中</span>
      </div>
      <div class="match-line">
        <span class="side">${(m.team1 || []).map(name).join(' / ')}</span>
        <span class="score">${m.detail ? `${esc(m.score1)} : ${esc(m.score2)}` : (Number(m.winner) === 1 ? 'A 胜' : 'B 胜')}</span>
        <span class="side">${(m.team2 || []).map(name).join(' / ')}</span>
      </div>
      <p class="dispute-reason"><strong>理由：</strong>${esc(m.dispute?.reason || '')}</p>
      <p class="muted small">由 ${esc(users[m.dispute?.by] ? users[m.dispute.by].nickname : '—')} 提交于 ${fmtDate(m.dispute?.at)}</p>
      <div class="btn-row">
        ${isAdmin ? `<a class="btn btn-ghost" href="/admin/matches/${encodeURIComponent(m.id)}/edit">改判 / 作废</a>` : ''}
        <form method="post" action="/admin/disputes/${encodeURIComponent(m.id)}/resolve" class="inline">
          <input type="hidden" name="action" value="uphold">
          <button class="btn" type="submit">维持原判</button>
        </form>
      </div>
    </div>`;
  }).join('') : emptyState('没有待处理的申诉。');
  ctx.body = `
    <div class="page-head"><div><p class="eyebrow">ADMIN</p><h1>申诉处理</h1></div></div>
    ${adminNav('disputes', ctx.user)}
    <section class="match-list">${cards}</section>
  `;
  ctx.title = '申诉处理';
  ctx.active = 'admin';
  return layout(ctx);
}

function adminSettings(ctx) {
  const s = ctx.settings;
  ctx.body = `
    <div class="page-head"><div><p class="eyebrow">ADMIN</p><h1>规则设置</h1></div></div>
    ${adminNav('settings', ctx.user)}
    <section class="panel">
      <form method="post" action="/admin/settings" class="form">
        <label>社团名称 <input type="text" name="clubName" value="${esc(s.clubName)}" maxlength="40" required></label>
        <label>首页公告（留空则不显示） <textarea name="announcement" rows="2" maxlength="200">${esc(s.announcement || '')}</textarea></label>
        <div class="form-grid">
          <label>定级期 K 值 <input type="number" name="kProvisional" value="${esc(s.kProvisional)}" min="1" max="100" required></label>
          <label>常规 K 值 <input type="number" name="kNormal" value="${esc(s.kNormal)}" min="1" max="100" required></label>
          <label>高分段 K 值 <input type="number" name="kHigh" value="${esc(s.kHigh)}" min="1" max="100" required></label>
          <label>高分段门槛 <input type="number" name="highThreshold" value="${esc(s.highThreshold)}" min="500" max="4000" required></label>
          <label>定级场次 <input type="number" name="provisionalMatches" value="${esc(s.provisionalMatches)}" min="0" max="100" required></label>
          <label>单场最少变动 <input type="number" name="minWinDelta" value="${esc(s.minWinDelta ?? 10)}" min="0" max="100" required></label>
          <label>申诉时限（小时） <input type="number" name="disputeHours" value="${esc(s.disputeHours)}" min="0" max="720" required></label>
          <label>防刷分窗口（小时） <input type="number" name="antiFarmHours" value="${esc(s.antiFarmHours)}" min="0" max="720" required></label>
          <label>防刷分系数 <input type="number" name="antiFarmFactor" value="${esc(s.antiFarmFactor)}" min="0" max="1" step="0.1" required></label>
        </div>
        <label class="check"><input type="checkbox" name="antiFarm" value="1" ${s.antiFarm ? 'checked' : ''}> 启用防刷分（短时间内重复对阵减少变化）</label>
        <h2>比赛审核</h2>
        <label class="check"><input type="checkbox" name="requireApproval" value="1" ${s.requireApproval !== false ? 'checked' : ''}> 录入的比赛要先审核通过才计入排名</label>
        <label>每人最多待审核场次 <input type="number" name="maxPendingPerUser" value="${esc(s.maxPendingPerUser ?? 20)}" min="1" max="200" required></label>
        <p class="muted small">关掉开关后回到「录入即生效」。改动不会影响已经通过的历史比赛。</p>
        <button class="btn" type="submit">保存设置</button>
        <p class="muted small">修改 K 值或门槛后，系统会立即从头重算全部历史比赛。</p>
      </form>
    </section>
  `;
  ctx.title = '规则设置';
  ctx.active = 'admin';
  return layout(ctx);
}

function errorPage(ctx) {
  ctx.body = `
    <div class="empty big">
      <p class="eyebrow">ERROR</p>
      <h1>${esc(ctx.errorTitle || '出错了')}</h1>
      <p class="muted">${esc(ctx.errorMessage || '请稍后再试。')}</p>
      <p><a class="btn" href="/">回到排行榜</a></p>
    </div>
  `;
  ctx.title = '出错了';
  return layout(ctx);
}

module.exports = {
  esc,
  fmtDate,
  fmtShort,
  deltaHtml,
  leaderboardPage,
  matchesPage,
  matchPage,
  playerPage,
  recordPage,
  mePage,
  gamePage,
  authPage,
  adminHome,
  adminUsers,
  adminMatches,
  adminReview,
  adminReviewEdit,
  adminMatchEdit,
  adminDisputes,
  adminSettings,
  errorPage
};
