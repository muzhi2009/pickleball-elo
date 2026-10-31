/* 合成大匹克球 —— 前端逻辑
 * 物理：Matter.js 0.19（MIT，见 /static/matter.min.js）
 * 规则：两只同级球相撞合成为高一级，越合成越稀有，堆过警戒线即结束。
 */
(function () {
  'use strict';

  const Matter = window.Matter;
  if (!Matter) return;
  const { Engine, World, Bodies, Body, Composite, Events } = Matter;

  /* ---------- 常量 ---------- */
  const W = 360;               // 逻辑宽
  const H = 560;               // 逻辑高
  const LINE_Y = 96;           // 警戒线
  const DROP_Y = 52;           // 待落球悬停高度
  const STEP = 1000 / 60;      // 固定物理步长
  const DROP_COOLDOWN = 380;   // 两球之间最小间隔
  const DANGER_LIMIT = 1900;   // 越线静止多久算结束
  const SETTLE_GRACE = 1100;   // 新球落地宽限期

  // 等级：半径、主色、暗色（描边/孔洞）、合成得分（三角数）
  const LEVELS = [
    { r: 14,  color: '#f7e06b', dark: '#c2a419', score: 1 },
    { r: 19,  color: '#a9e05f', dark: '#6f9b28', score: 3 },
    { r: 25,  color: '#4ecdc4', dark: '#218f88', score: 6 },
    { r: 32,  color: '#4fa8e0', dark: '#1f6f9f', score: 10 },
    { r: 40,  color: '#7b7bf0', dark: '#4343b8', score: 15 },
    { r: 50,  color: '#b06ae8', dark: '#7433a8', score: 21 },
    { r: 61,  color: '#ee6bb0', dark: '#ae3174', score: 28 },
    { r: 74,  color: '#f4615d', dark: '#b12c29', score: 36 },
    { r: 88,  color: '#f7993e', dark: '#b3651a', score: 45 },
    { r: 104, color: '#2f2f38', dark: '#111',    score: 55 },
    { r: 122, color: '#f6c945', dark: '#a37c07', score: 66 }
  ];
  const MAX_LEVEL = LEVELS.length - 1;
  const NAMES = ['小黄', '青柠', '薄荷', '天蓝', '靛蓝', '紫晶', '樱粉', '珊瑚', '琥珀', '墨玉', '金杯'];

  /* ---------- DOM ---------- */
  const canvas = document.getElementById('gameCanvas');
  if (!canvas) return;
  const ctx = canvas.getContext('2d');
  const scoreEl = document.getElementById('gameScore');
  const bestEl = document.getElementById('gameBest');
  const overEl = document.getElementById('gameOver');
  const overScoreEl = document.getElementById('overScore');
  const overBestEl = document.getElementById('overBest');
  const overNoteEl = document.getElementById('overNote');
  const nextCanvas = document.getElementById('nextBall');
  const nextCtx = nextCanvas ? nextCanvas.getContext('2d') : null;
  const restartBtn = document.getElementById('restartBtn');
  const soundBtn = document.getElementById('soundBtn');
  const rankBody = document.getElementById('rankBody');
  const loggedIn = document.body.dataset.loggedIn === '1';

  /* ---------- 画布尺寸（跟随 DPR） ---------- */
  let scale = 1;
  function resize() {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const cssW = canvas.clientWidth || W;
    const ratio = cssW / W;
    canvas.width = Math.round(W * ratio * dpr);
    canvas.height = Math.round(H * ratio * dpr);
    scale = canvas.width / W;
    ctx.setTransform(scale, 0, 0, scale, 0, 0);
  }

  /* ---------- 球体贴图（预渲染，避免每帧画渐变） ---------- */
  const sprites = [];
  const SPRITE_SCALE = 2;

  function buildSprites() {
    for (let level = 0; level < LEVELS.length; level++) {
      const { r, color, dark } = LEVELS[level];
      const pad = 2;
      const size = Math.ceil((r + pad) * 2);
      const cv = document.createElement('canvas');
      cv.width = size * SPRITE_SCALE;
      cv.height = size * SPRITE_SCALE;
      const g = cv.getContext('2d');
      g.scale(SPRITE_SCALE, SPRITE_SCALE);
      const c = size / 2;

      // 球体
      const grad = g.createRadialGradient(c - r * 0.34, c - r * 0.36, r * 0.12, c, c, r);
      grad.addColorStop(0, lighten(color, 0.34));
      grad.addColorStop(0.55, color);
      grad.addColorStop(1, darken(color, 0.16));
      g.beginPath();
      g.arc(c, c, r, 0, Math.PI * 2);
      g.fillStyle = grad;
      g.fill();

      // 球面孔洞：沿两圈极坐标分布，模仿匹克球
      const holes = Math.max(5, Math.min(12, 4 + level));
      const rings = [
        { radius: r * 0.44, count: holes, offset: 0.4 },
        { radius: r * 0.74, count: Math.max(4, Math.round(holes * 0.7)), offset: 1.15 }
      ];
      const dotR = Math.max(1.1, r * 0.082);
      g.fillStyle = 'rgba(0,0,0,0.26)';
      for (const ring of rings) {
        for (let i = 0; i < ring.count; i++) {
          const a = (i / ring.count) * Math.PI * 2 + ring.offset;
          const hx = c + Math.cos(a) * ring.radius;
          const hy = c + Math.sin(a) * ring.radius;
          g.beginPath();
          g.arc(hx, hy, dotR, 0, Math.PI * 2);
          g.fill();
          // 孔洞内壁高光，显得有厚度
          g.beginPath();
          g.arc(hx - dotR * 0.22, hy - dotR * 0.26, dotR * 0.5, 0, Math.PI * 2);
          g.fillStyle = 'rgba(255,255,255,0.13)';
          g.fill();
          g.fillStyle = 'rgba(0,0,0,0.26)';
        }
      }

      // 顶部高光
      const hl = g.createRadialGradient(c - r * 0.3, c - r * 0.42, 0, c - r * 0.3, c - r * 0.42, r * 0.68);
      hl.addColorStop(0, 'rgba(255,255,255,0.55)');
      hl.addColorStop(1, 'rgba(255,255,255,0)');
      g.beginPath();
      g.arc(c, c, r, 0, Math.PI * 2);
      g.fillStyle = hl;
      g.fill();

      // 描边
      g.beginPath();
      g.arc(c, c, r - 0.5, 0, Math.PI * 2);
      g.strokeStyle = dark;
      g.lineWidth = Math.min(2, Math.max(1, r * 0.045));
      g.stroke();

      // 等级数字
      if (r >= 18) {
        g.font = `700 ${Math.round(r * 0.82)}px ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif`;
        g.textAlign = 'center';
        g.textBaseline = 'middle';
        g.fillStyle = 'rgba(0,0,0,0.16)';
        g.fillText(String(level + 1), c, c + r * 0.06 + 1);
        g.fillStyle = 'rgba(255,255,255,0.92)';
        g.fillText(String(level + 1), c, c + r * 0.04);
      }

      sprites[level] = { canvas: cv, size, r };
    }
  }

  function hexToRgb(hex) {
    const v = hex.replace('#', '');
    const full = v.length === 3 ? v.split('').map((x) => x + x).join('') : v;
    return {
      r: parseInt(full.slice(0, 2), 16),
      g: parseInt(full.slice(2, 4), 16),
      b: parseInt(full.slice(4, 6), 16)
    };
  }
  function mix(hex, target, amount) {
    const a = hexToRgb(hex);
    return `rgb(${Math.round(a.r + (target - a.r) * amount)},${Math.round(a.g + (target - a.g) * amount)},${Math.round(a.b + (target - a.b) * amount)})`;
  }
  const lighten = (hex, amount) => mix(hex, 255, amount);
  const darken = (hex, amount) => mix(hex, 0, amount);

  /* ---------- 状态 ---------- */
  let engine, world;
  let running = false;
  let score = 0;
  let best = Number(bestEl && bestEl.dataset.best) || 0;
  let currentLevel = 0;
  let nextLevel = 0;
  let aimX = W / 2;
  let canDrop = true;
  let lastDropAt = 0;
  let dangerTime = 0;
  let pendingMerges = [];
  let effects = [];
  let lastTime = 0;
  let acc = 0;
  let gameStartAt = 0;
  let submitted = false;

  function pickLevel() {
    // 只出前 5 级，权重从高到低，保证节奏和原版一致
    const pool = [0, 0, 0, 0, 1, 1, 1, 2, 2, 3, 4];
    return pool[(Math.random() * pool.length) | 0];
  }

  function makeBall(x, y, level) {
    const { r } = LEVELS[level];
    const body = Bodies.circle(x, y, r, {
      restitution: 0.14,
      friction: 0.055,
      frictionStatic: 0.35,
      frictionAir: 0.002,
      density: 0.0012,
      slop: 0.02,
      label: 'ball'
    });
    body.plugin = { ball: true, level, born: performance.now(), merged: false };
    return body;
  }

  function reset() {
    engine = Engine.create({ gravity: { x: 0, y: 1.15, scale: 0.001 } });
    world = engine.world;
    engine.positionIterations = 8;
    engine.velocityIterations = 6;

    // 地板与墙体都做厚，避免高速下落时穿墙
    const wallOpt = { isStatic: true, restitution: 0.16, friction: 0.08, label: 'wall' };
    // 三面墙都往画布内侧收 4px，球贴墙时留一点空隙，不会压在边框上
    Composite.add(world, [
      Bodies.rectangle(W / 2, H + 34, W + 600, 80, wallOpt),
      Bodies.rectangle(-36, H / 2, 80, H * 4, wallOpt),
      Bodies.rectangle(W + 36, H / 2, 80, H * 4, wallOpt)
    ]);

    Events.on(engine, 'collisionStart', onCollision);

    score = 0;
    dangerTime = 0;
    pendingMerges = [];
    effects = [];
    canDrop = true;
    lastDropAt = 0;
    submitted = false;
    running = true;
    currentLevel = pickLevel();
    nextLevel = pickLevel();
    aimX = W / 2;
    gameStartAt = Date.now();
    acc = 0;
    lastTime = 0;
    renderScore();
    drawNext();
    if (overEl) overEl.hidden = true;
  }

  function onCollision(event) {
    for (const pair of event.pairs) {
      const a = pair.bodyA;
      const b = pair.bodyB;
      if (!a.plugin || !a.plugin.ball || !b.plugin || !b.plugin.ball) continue;
      if (a.plugin.merged || b.plugin.merged) continue;
      if (a.plugin.level !== b.plugin.level) continue;
      if (a.plugin.level >= MAX_LEVEL) continue;
      a.plugin.merged = true;
      b.plugin.merged = true;
      pendingMerges.push([a, b]);
    }
  }

  function resolveMerges() {
    if (!pendingMerges.length) return;
    const list = pendingMerges;
    pendingMerges = [];
    for (const [a, b] of list) {
      const level = a.plugin.level + 1;
      let x = (a.position.x + b.position.x) / 2;
      let y = (a.position.y + b.position.y) / 2;
      Composite.remove(world, a);
      Composite.remove(world, b);
      // 两球几乎重叠时给点随机偏移，避免合体瞬间被物理引擎弹飞
      if (Math.abs(a.position.x - b.position.x) < 1 && Math.abs(a.position.y - b.position.y) < 1) {
        x += (Math.random() - 0.5) * 2;
        y += (Math.random() - 0.5) * 2;
      }
      const r = LEVELS[level].r;
      x = Math.max(r + 1, Math.min(W - r - 1, x));
      y = Math.min(H - r - 1, y);
      const fresh = makeBall(x, y, level);
      Composite.add(world, fresh);
      Body.setVelocity(fresh, { x: 0, y: -1.2 });
      score += LEVELS[level].score;
      effects.push({ x, y, r, born: performance.now(), level });
      beep(level);
    }
    renderScore();
  }

  // 兜底：极少数情况下球会被挤出边界，直接回收，避免越滚越远
  function cullStrays() {
    const all = Composite.allBodies(world);
    for (let i = 0; i < all.length; i++) {
      const b = all[i];
      if (!b.plugin || !b.plugin.ball) continue;
      if (b.position.y > H + 260 || b.position.x < -160 || b.position.x > W + 160) {
        Composite.remove(world, b);
      }
    }
  }

  function renderScore() {
    if (scoreEl) scoreEl.textContent = String(score);
    if (bestEl) bestEl.textContent = String(Math.max(best, score));
  }

  function drawNext() {
    if (!nextCtx) return;
    const s = sprites[nextLevel];
    const cssSize = nextCanvas.clientWidth || 56;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    nextCanvas.width = Math.round(cssSize * dpr);
    nextCanvas.height = Math.round(cssSize * dpr);
    const k = (cssSize * dpr) / 56;
    nextCtx.setTransform(k, 0, 0, k, 0, 0);
    nextCtx.clearRect(0, 0, 56, 56);
    const ballW = LEVELS[nextLevel].r * 2;
    const target = Math.min(46, ballW);
    const drawW = s.size * (target / ballW);
    nextCtx.drawImage(s.canvas, (56 - drawW) / 2, (56 - drawW) / 2, drawW, drawW);
  }

  /* ---------- 掉落 ---------- */
  function drop() {
    if (!running || !canDrop) return;
    canDrop = false;
    const level = currentLevel;
    const { r } = LEVELS[level];
    const x = Math.max(r + 2, Math.min(W - r - 2, aimX));
    const ball = makeBall(x, DROP_Y, level);
    ball.plugin.born = performance.now() + SETTLE_GRACE;
    Composite.add(world, ball);
    currentLevel = nextLevel;
    nextLevel = pickLevel();
    drawNext();
    lastDropAt = performance.now();
    setTimeout(() => { canDrop = true; }, DROP_COOLDOWN);
  }

  /* ---------- 结束判定 ---------- */
  function checkDanger(dt) {
    let danger = false;
    const now = performance.now();
    const balls = Composite.allBodies(world);
    for (const b of balls) {
      if (!b.plugin || !b.plugin.ball) continue;
      if (now < b.plugin.born) continue;                     // 宽限期
      const top = b.position.y - LEVELS[b.plugin.level].r;
      if (top < LINE_Y && b.speed < 2.2) { danger = true; break; }
    }
    if (danger) {
      dangerTime += dt;
      if (dangerTime > DANGER_LIMIT) gameOver();
    } else {
      dangerTime = Math.max(0, dangerTime - dt * 1.6);
    }
  }

  function gameOver() {
    if (!running) return;
    running = false;
    const elapsed = Date.now() - gameStartAt;
    if (overScoreEl) overScoreEl.textContent = String(score);
    if (overBestEl) overBestEl.textContent = String(Math.max(best, score));
    if (overEl) overEl.hidden = false;
    if (overNoteEl) {
      overNoteEl.textContent = loggedIn ? '正在保存成绩…' : '未登录，本局不计入排行榜';
      overNoteEl.className = 'over-note';
    }
    if (score > best) best = score;
    renderScore();
    if (loggedIn && score > 0) submitScore(score, elapsed);
  }

  function submitScore(value, elapsed) {
    if (submitted) return;
    submitted = true;
    const body = new URLSearchParams({ token: window.__gameToken || '', score: String(value), ms: String(elapsed) });
    fetch('/game/score', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: body.toString()
    })
      .then((r) => r.json())
      .then((data) => {
        if (!data.ok) {
          if (overNoteEl) {
            overNoteEl.textContent = data.error || '成绩未能保存';
            overNoteEl.className = 'over-note over-note-err';
          }
          return;
        }
        best = Math.max(best, data.best || 0);
        if (bestEl) { bestEl.textContent = String(best); bestEl.dataset.best = String(best); }
        if (overBestEl) overBestEl.textContent = String(best);
        if (overNoteEl) {
          overNoteEl.textContent = data.isNewBest ? '🎉 新纪录！已上榜' : '成绩已保存';
          overNoteEl.className = 'over-note ' + (data.isNewBest ? 'over-note-new' : '');
        }
        if (data.top) renderRank(data.top);
      })
      .catch(() => {
        if (overNoteEl) {
          overNoteEl.textContent = '网络异常，成绩未保存';
          overNoteEl.className = 'over-note over-note-err';
        }
      })
      .finally(() => refreshToken());
  }

  function refreshToken() {
    if (!loggedIn) return;
    fetch('/game/start', { method: 'POST' })
      .then((r) => r.json())
      .then((d) => { if (d.token) window.__gameToken = d.token; })
      .catch(() => {});
  }

  /* ---------- 排行榜 ---------- */
  function rankRow(item, index) {
    const medal = index < 3 ? ['🥇', '🥈', '🥉'][index] : String(index + 1);
    const me = item.me ? ' class="rank-me"' : '';
    return `<tr${me}><td class="rank-no">${medal}</td><td class="rank-name">${item.name}</td><td class="rank-score">${item.best}</td></tr>`;
  }

  function renderRank(list) {
    if (!rankBody) return;
    if (!list.length) {
      rankBody.innerHTML = '<tr><td colspan="3" class="rank-empty">还没有人上榜，来做第一个</td></tr>';
      return;
    }
    rankBody.innerHTML = list.map((item, i) => rankRow(item, i)).join('');
  }

  /* ---------- 音效（WebAudio 合成，无外部文件） ---------- */
  let audioCtx = null;
  let soundOn = true;
  function beep(level) {
    if (!soundOn) return;
    try {
      if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
      const t = audioCtx.currentTime;
      const osc = audioCtx.createOscillator();
      const gain = audioCtx.createGain();
      osc.type = 'sine';
      osc.frequency.setValueAtTime(300 + level * 62, t);
      osc.frequency.exponentialRampToValueAtTime(520 + level * 88, t + 0.09);
      gain.gain.setValueAtTime(0.0001, t);
      gain.gain.exponentialRampToValueAtTime(0.16, t + 0.012);
      gain.gain.exponentialRampToValueAtTime(0.0001, t + 0.19);
      osc.connect(gain).connect(audioCtx.destination);
      osc.start(t);
      osc.stop(t + 0.2);
    } catch { /* 静默失败 */ }
  }

  /* ---------- 渲染 ---------- */
  function draw() {
    ctx.clearRect(0, 0, W, H);

    // 背景交给 .board-shell 的 var(--soft)，深色模式下自动跟随主题

    // 警戒线
    const hot = dangerTime > 200;
    ctx.save();
    ctx.setLineDash([7, 7]);
    ctx.lineWidth = 2;
    ctx.strokeStyle = hot ? `rgba(230,70,70,${0.45 + Math.min(0.5, dangerTime / DANGER_LIMIT)})` : 'rgba(140,140,150,0.42)';
    ctx.beginPath();
    ctx.moveTo(0, LINE_Y);
    ctx.lineTo(W, LINE_Y);
    ctx.stroke();
    ctx.restore();

    // 球
    for (const b of Composite.allBodies(world)) {
      if (!b.plugin || !b.plugin.ball) continue;
      const s = sprites[b.plugin.level];
      const half = s.size / 2;
      ctx.drawImage(s.canvas, b.position.x - half, b.position.y - half, s.size, s.size);
    }

    // 待落球 + 瞄准线
    if (running) {
      const s = sprites[currentLevel];
      const half = s.size / 2;
      const x = Math.max(LEVELS[currentLevel].r + 2, Math.min(W - LEVELS[currentLevel].r - 2, aimX));
      ctx.save();
      ctx.globalAlpha = 0.28;
      ctx.strokeStyle = LEVELS[currentLevel].dark;
      ctx.lineWidth = 1.5;
      ctx.setLineDash([4, 8]);
      ctx.beginPath();
      ctx.moveTo(x, DROP_Y + LEVELS[currentLevel].r);
      ctx.lineTo(x, H - 6);
      ctx.stroke();
      ctx.restore();
      ctx.drawImage(s.canvas, x - half, DROP_Y - half, s.size, s.size);
    }

    // 合成特效
    const now = performance.now();
    effects = effects.filter((e) => now - e.born < 460);
    for (const e of effects) {
      const p = (now - e.born) / 460;
      const r = e.r * (1 + p * 1.5);
      ctx.beginPath();
      ctx.arc(e.x, e.y, r, 0, Math.PI * 2);
      ctx.strokeStyle = `rgba(255,255,255,${(1 - p) * 0.55})`;
      ctx.lineWidth = 3 * (1 - p) + 0.5;
      ctx.stroke();
    }
  }

  function tick(now) {
    if (!lastTime) lastTime = now;
    let dt = now - lastTime;
    lastTime = now;
    if (dt > 120) dt = 120;

    if (running) {
      acc += dt;
      let guard = 0;
      while (acc >= STEP && guard < 6) {
        Engine.update(engine, STEP);
        resolveMerges();
        acc -= STEP;
        guard++;
      }
      checkDanger(dt);
      cullStrays();
    }
    draw();
    requestAnimationFrame(tick);
  }

  /* ---------- 输入 ---------- */
  function pointerToX(clientX) {
    const rect = canvas.getBoundingClientRect();
    return ((clientX - rect.left) / rect.width) * W;
  }

  let dragging = false;
  canvas.addEventListener('pointerdown', (e) => {
    dragging = true;
    canvas.setPointerCapture?.(e.pointerId);
    aimX = pointerToX(e.clientX);
    e.preventDefault();
  });
  canvas.addEventListener('pointermove', (e) => {
    if (!dragging) return;
    aimX = pointerToX(e.clientX);
    e.preventDefault();
  });
  canvas.addEventListener('pointerup', (e) => {
    if (!dragging) return;
    dragging = false;
    aimX = pointerToX(e.clientX);
    drop();
    e.preventDefault();
  });
  canvas.addEventListener('pointercancel', () => { dragging = false; });
  canvas.addEventListener('contextmenu', (e) => e.preventDefault());

  // 键盘：左右移动 + 空格/回车落下（桌面调试与无障碍）
  window.addEventListener('keydown', (e) => {
    if (!running) {
      if (e.key === 'Enter' || e.key === ' ') { restartBtn?.click(); }
      return;
    }
    if (e.key === 'ArrowLeft') { aimX = Math.max(20, aimX - 18); e.preventDefault(); }
    if (e.key === 'ArrowRight') { aimX = Math.min(W - 20, aimX + 18); e.preventDefault(); }
    if (e.key === ' ' || e.key === 'ArrowDown' || e.key === 'Enter') { drop(); e.preventDefault(); }
  });

  if (restartBtn) {
    restartBtn.addEventListener('click', () => {
      reset();
      if (overEl) overEl.hidden = true;
    });
  }

  if (soundBtn) {
    soundOn = localStorage.getItem('pb-sound') !== '0';
    soundBtn.textContent = soundOn ? '🔊' : '🔇';
    soundBtn.addEventListener('click', () => {
      soundOn = !soundOn;
      localStorage.setItem('pb-sound', soundOn ? '1' : '0');
      soundBtn.textContent = soundOn ? '🔊' : '🔇';
    });
  }

  window.addEventListener('resize', () => { resize(); });

  /* ---------- 启动 ---------- */
  buildSprites();
  resize();
  reset();
  requestAnimationFrame(tick);
  refreshToken();

  // 暴露给测试脚本
  window.__pbGame = {
    get score() { return score; },
    get running() { return running; },
    get balls() { return Composite.allBodies(world).filter((b) => b.plugin && b.plugin.ball).length; },
    get token() { return window.__gameToken || ''; },
    get info() {
      return Composite.allBodies(world)
        .filter((b) => b.plugin && b.plugin.ball)
        .map((b) => ({
          x: Math.round(b.position.x),
          y: Math.round(b.position.y),
          r: LEVELS[b.plugin.level].r,
          level: b.plugin.level,
          sprite: !!sprites[b.plugin.level]
        }));
    },
    finish() { gameOver(); },
    drop(count) {
      let n = 0;
      const timer = setInterval(() => {
        if (!running || n >= (count || 10)) { clearInterval(timer); return; }
        aimX = 60 + Math.random() * (W - 120);
        canDrop = true;
        drop();
        n++;
      }, DROP_COOLDOWN + 40);
      return timer;
    }
  };
})();
