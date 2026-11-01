'use strict';

/**
 * 关卡难度调参工具。
 *
 * 用真实浏览器跑一个"会看盘的机器人"：它按当前待落球的半径往下做垂直射线，
 * 找出每个横坐标的落点高度，优先挑"同色能合成 / 堆得低 / 不靠墙"的位置，
 * 再按设定的手抖幅度和失误率把瞄准打偏，模拟不同水平的玩家。
 *
 * 机器人是"零延迟反应"的上限，真人普遍比它差一档，所以看结果时要把关卡数打个折。
 *
 * 用法：
 *   BASE=http://127.0.0.1:3220 node tools/game-balance.js
 *   SKILLS=good,mid GAMES=2 BASE=... node tools/game-balance.js
 *
 * 输出：每局到达关卡 / 落球数 / 分数 / 用时，以及汇总的中位数。
 */

const { spawn, execSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');

const BASE = process.env.BASE || 'http://127.0.0.1:3220';
const PORT = Number(process.env.CDP_PORT || 9341);
const OUT = path.join(__dirname, '..', '.shots');
const GAMES = Number(process.env.GAMES || 2);
const MAX_SECONDS = Number(process.env.MAX_SECONDS || 420);
const EDGE = [
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'
].find((p) => fs.existsSync(p));

// 三档手抖：高手几乎指哪打哪，中手有 10px 偏差偶尔失误，新手偏差大且常乱扔
const SKILLS = {
  good: { jitter: 6, blunder: 0.03 },
  mid: { jitter: 16, blunder: 0.12 },
  low: { jitter: 30, blunder: 0.28 }
};
const WANTED = (process.env.SKILLS || 'good,mid,low').split(',').filter(Boolean);

if (!EDGE) {
  console.error('没找到 Edge/Chrome');
  process.exit(1);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function getJson(url) {
  return new Promise((resolve, reject) => {
    http.get(url, (res) => {
      let data = '';
      res.on('data', (c) => (data += c));
      res.on('end', () => {
        try { resolve(JSON.parse(data)); } catch (e) { reject(e); }
      });
    }).on('error', reject);
  });
}

class CDP {
  constructor(ws) {
    this.ws = ws;
    this.id = 0;
    this.pending = new Map();
    ws.addEventListener('message', (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.id && this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        msg.error ? reject(new Error(msg.error.message)) : resolve(msg.result);
      }
    });
  }
  send(method, params = {}) {
    const id = ++this.id;
    this.ws.send(JSON.stringify({ id, method, params }));
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id);
          reject(new Error('CDP 超时：' + method));
        }
      }, 30000);
    });
  }
}

async function waitFor(wsUrl) {
  for (let i = 0; i < 50; i++) {
    try {
      const ws = new WebSocket(wsUrl);
      await new Promise((resolve, reject) => {
        ws.addEventListener('open', resolve, { once: true });
        ws.addEventListener('error', reject, { once: true });
      });
      return ws;
    } catch {
      await sleep(200);
    }
  }
  throw new Error('连不上调试端口');
}

// 注入机器人的瞄准函数（跑在页面里，能直接读物理状态）
const BOT_SOURCE = `
window.__bot = {
  choose(jitter, blunder) {
    const g = window.__pbGame;
    const p = g.pending;
    const r = p.r;
    const balls = g.info;
    const W = 360;
    const floorTop = 560 - 6;
    function landing(x) {
      let y = floorTop - r;
      for (const b of balls) {
        const dx = Math.abs(b.x - x);
        const sum = r + b.r;
        if (dx >= sum) continue;
        const dy = Math.sqrt(sum * sum - dx * dx);
        if (b.y - dy < y) y = b.y - dy;
      }
      return y;
    }
    let best = null;
    for (let x = r + 2; x <= W - r - 2; x += 4) {
      const y = landing(x);
      const top = y - r;
      let score = -top * 3.2;
      score -= Math.abs(x - W / 2) * 0.12;
      let merges = 0;
      for (const b of balls) {
        if (b.level !== p.level) continue;
        const d = Math.hypot(b.x - x, b.y - y);
        if (d <= r + b.r + 3) merges++;
      }
      if (merges) score += 620 + p.level * 90 + (merges - 1) * 60;
      if (x - r < 8 || W - r - x < 8) score -= 40;
      if (top < 110) score -= 500;
      if (!best || score > best.score) best = { x, score };
    }
    let x = best ? best.x : W / 2;
    if (Math.random() < blunder) x = r + 10 + Math.random() * (W - 2 * r - 20);
    else x += (Math.random() - 0.5) * 2 * jitter;
    return Math.max(r + 2, Math.min(W - r - 2, x));
  }
};
true;
`;

function percentile(list, p) {
  if (!list.length) return 0;
  const sorted = [...list].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.round((sorted.length - 1) * p)));
  return sorted[idx];
}

async function main() {
  fs.mkdirSync(OUT, { recursive: true });
  const child = spawn(EDGE, [
    '--headless=new',
    '--disable-gpu',
    '--hide-scrollbars',
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-background-timer-throttling',
    '--disable-renderer-backgrounding',
    '--disable-backgrounding-occluded-windows',
    '--user-data-dir=' + path.join(OUT, '.balance-profile'),
    `--remote-debugging-port=${PORT}`,
    'about:blank'
  ], { stdio: 'ignore' });

  let ws;
  try {
    let list = null;
    for (let i = 0; i < 60; i++) {
      try {
        list = await getJson(`http://127.0.0.1:${PORT}/json/list`);
        if (list && list.length) break;
      } catch { /* retry */ }
      await sleep(250);
    }
    if (!list || !list.length) throw new Error('浏览器没有启动起来');
    ws = await waitFor(list.find((t) => t.type === 'page').webSocketDebuggerUrl);

    const cdp = new CDP(ws);
    await cdp.send('Page.enable');
    await cdp.send('Runtime.enable');
    await cdp.send('Network.enable');
    // 静态资源带 1 小时缓存，调参期间必须关掉，否则量的还是上一版代码
    await cdp.send('Network.setCacheDisabled', { cacheDisabled: true });
    await cdp.send('Emulation.setDeviceMetricsOverride', {
      width: 1280, height: 900, deviceScaleFactor: 1, mobile: false
    });
    await cdp.send('Page.navigate', { url: BASE + '/game' });
    await sleep(1500);

    const evalJs = async (expression) => {
      const { result } = await cdp.send('Runtime.evaluate', {
        expression, returnByValue: true, awaitPromise: true
      });
      if (result.subtype === 'error') throw new Error(result.description);
      return result.value;
    };

    await evalJs(BOT_SOURCE);
    await evalJs('window.__pbGame.setAuto(false); true');

    // 打印实时生效的难度表，改完参数不用两边对
    const table = await evalJs('window.__pbGame.stages');
    console.log('\n关卡  落球间隔  越线判负');
    for (const s of table) {
      const bar = '#'.repeat(Math.round((2000 - s.dropMs) / 90));
      console.log(
        `  ${String(s.stage).padStart(2)}   ${String(s.dropMs).padStart(4)}ms   ` +
        `${String(s.dangerMs).padStart(4)}ms  ${bar}`
      );
    }

    const results = [];
    for (const skillName of WANTED) {
      const skill = SKILLS[skillName];
      if (!skill) continue;
      for (let g = 1; g <= GAMES; g++) {
        await evalJs('document.getElementById("restartBtn").click(); true');
        await sleep(300);
        await evalJs('window.__pbGame.setAuto(false); true');

        const startedAt = Date.now();
        let drops = 0;
        let lastStage = 1;

        while (Date.now() - startedAt < MAX_SECONDS * 1000) {
          const st = await evalJs(
            '({running: __pbGame.running, interval: __pbGame.interval, stage: __pbGame.stage})'
          );
          if (!st.running) break;
          lastStage = st.stage;
          // 留 120ms 给"抬手"，也就是真人的反应窗口
          await sleep(Math.max(100, st.interval - 120));
          if (!(await evalJs('__pbGame.running'))) break;
          await evalJs(`__pbGame.aim = __bot.choose(${skill.jitter}, ${skill.blunder}); true`);
          await evalJs('__pbGame.dropNow(); true');
          drops += 1;
        }

        const final = await evalJs(
          '({score: __pbGame.score, stage: __pbGame.maxStage, drops: __pbGame.totalDrops, running: __pbGame.running})'
        );
        const seconds = Math.round((Date.now() - startedAt) / 1000);
        const row = {
          skill: skillName,
          game: g,
          stage: final.stage,
          drops: final.drops,
          score: final.score,
          seconds,
          dnf: final.running
        };
        results.push(row);
        console.log(
          `  [${skillName} #${g}] 到第 ${row.stage} 关 · ${row.drops} 球 · ${row.score} 分 · ${seconds}s` +
          (row.dnf ? '  (超时未结束)' : '')
        );
        if (final.running) await evalJs('__pbGame.finish(); true');
      }
    }

    console.log('\n===== 汇总 =====');
    for (const skillName of WANTED.filter((k) => SKILLS[k])) {
      const rows = results.filter((r) => r.skill === skillName);
      if (!rows.length) continue;
      const stages = rows.map((r) => r.stage);
      const scores = rows.map((r) => r.score);
      const secs = rows.map((r) => r.seconds);
      console.log(
        `${skillName.padEnd(5)} 关卡 中位 ${percentile(stages, 0.5)} (${Math.min(...stages)}~${Math.max(...stages)})` +
        `  分数 中位 ${percentile(scores, 0.5)}  用时 中位 ${percentile(secs, 0.5)}s`
      );
    }
  } finally {
    if (ws) ws.close();
    child.kill();
    await sleep(300);
    try { execSync(`taskkill /PID ${child.pid} /T /F`, { stdio: 'ignore' }); } catch { /* ignore */ }
  }
}

main().catch((err) => {
  console.error('调参失败：', err.message);
  process.exitCode = 1;
});
