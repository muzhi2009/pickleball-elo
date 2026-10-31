'use strict';

/**
 * 小游戏端到端验证：真实浏览器里跑一局，看物理、合成、计分、提交是否正常。
 * 用法：BASE=http://127.0.0.1:3220 NICK=社长 PASS=test1234 node tools/game-test.js
 */

const { spawn, execSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');

const BASE = process.env.BASE || 'http://127.0.0.1:3220';
const NICK = process.env.NICK || '社长';
const PASS = process.env.PASS || 'test1234';
const PORT = Number(process.env.CDP_PORT || 9339);
const OUT = path.join(__dirname, '..', '.shots');
const EDGE = [
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'
].find((p) => fs.existsSync(p));

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

async function login() {
  const res = await fetch(BASE + '/login', {
    method: 'POST',
    redirect: 'manual',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ nickname: NICK, password: PASS }).toString()
  });
  const raw = res.headers.getSetCookie ? res.headers.getSetCookie() : [];
  const sid = raw.map((l) => l.split(';')[0]).find((p) => p.startsWith('sid='));
  if (!sid) throw new Error('登录失败（HTTP ' + res.status + '），检查昵称密码');
  return sid.slice(4);
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

async function main() {
  fs.mkdirSync(OUT, { recursive: true });
  const sid = await login();
  const problems = [];
  const ok = (name, cond, detail = '') => {
    if (cond) {
      console.log(`  ✓ ${name}${detail ? '  ' + detail : ''}`);
    } else {
      console.log(`  ✗ ${name}${detail ? '  ' + detail : ''}`);
      problems.push(name);
    }
  };

  const child = spawn(EDGE, [
    '--headless=new',
    '--disable-gpu',
    '--hide-scrollbars',
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-background-timer-throttling',
    '--disable-renderer-backgrounding',
    '--disable-backgrounding-occluded-windows',
    '--user-data-dir=' + path.join(OUT, '.game-profile'),
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
    const page = list.find((t) => t.type === 'page');
    ws = await waitFor(page.webSocketDebuggerUrl);

    const cdp = new CDP(ws);
    await cdp.send('Page.enable');
    await cdp.send('Runtime.enable');
    await cdp.send('Network.enable');
    await cdp.send('Network.setCookie', {
      name: 'sid', value: sid, domain: '127.0.0.1', path: '/', httpOnly: true
    });

    const errors = [];
    await cdp.send('Log.enable').catch(() => {});
    ws.addEventListener('message', (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.method === 'Runtime.exceptionThrown') {
        errors.push(msg.params.exceptionDetails.text + ' ' + (msg.params.exceptionDetails.exception?.description || ''));
      }
    });

    await cdp.send('Emulation.setDeviceMetricsOverride', {
      width: 1440, height: 900, deviceScaleFactor: 1, mobile: false
    });
    await cdp.send('Page.navigate', { url: BASE + '/game' });
    await sleep(1200);

    const evalJs = async (expression, awaitPromise = false) => {
      const { result } = await cdp.send('Runtime.evaluate', {
        expression, returnByValue: true, awaitPromise
      });
      if (result.subtype === 'error') throw new Error(result.description);
      return result.value;
    };

    console.log('\n【1】页面初始化');
    const hasApi = await evalJs('typeof window.__pbGame === "object"');
    ok('游戏脚本加载成功', hasApi);
    ok('Matter 物理引擎可用', await evalJs('typeof window.Matter === "object"'));
    ok('画布已按 DPR 放大', await evalJs('document.getElementById("gameCanvas").width > 300'),
      '宽度 ' + await evalJs('document.getElementById("gameCanvas").width') + 'px');

    console.log('\n【2】自动落球 28 次');
    await evalJs('window.__pbGame.drop(28)');
    await sleep(13500);

    const state = await evalJs('({ score: window.__pbGame.score, balls: window.__pbGame.balls, running: window.__pbGame.running, token: window.__pbGame.token })');
    console.log('    分数=' + state.score + '  场上球数=' + state.balls + '  进行中=' + state.running);
    ok('产生了合成得分', state.score > 0, '得分 ' + state.score);
    ok('场上留下了球', state.balls > 0, state.balls + ' 个');
    ok('拿到了对局凭证', state.token.length > 20);
    ok('没有 JS 异常', errors.length === 0, errors.join(' | '));

    await cdp.send('Emulation.setDeviceMetricsOverride', {
      width: 1440, height: 900, deviceScaleFactor: 1, mobile: false
    });
    let shot = await cdp.send('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(path.join(OUT, 'game-desktop.png'), Buffer.from(shot.data, 'base64'));
    console.log('    ✓ 截图 game-desktop.png');

    await cdp.send('Emulation.setDeviceMetricsOverride', {
      width: 390, height: 844, deviceScaleFactor: 2, mobile: true
    });
    await sleep(600);
    shot = await cdp.send('Page.captureScreenshot', {
      format: 'png', captureBeyondViewport: true
    });
    fs.writeFileSync(path.join(OUT, 'm-game.png'), Buffer.from(shot.data, 'base64'));
    console.log('    ✓ 截图 m-game.png');

    const overflow = await evalJs('document.documentElement.scrollWidth <= window.innerWidth + 1');
    ok('移动端没有横向溢出', overflow,
      'scrollWidth=' + await evalJs('document.documentElement.scrollWidth'));

    console.log('\n【3】结束并提交成绩');
    await cdp.send('Emulation.setDeviceMetricsOverride', {
      width: 1440, height: 900, deviceScaleFactor: 1, mobile: false
    });
    await evalJs('window.__pbGame.finish()');
    await sleep(1600);

    const note = await evalJs('document.getElementById("overNote").textContent');
    console.log('    提交结果：' + note);
    ok('成绩提交成功', /已记录|新纪录|最高分/.test(note), note);
    ok('结束遮罩已显示', await evalJs('!document.getElementById("gameOver").hidden'));

    shot = await cdp.send('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(path.join(OUT, 'game-over.png'), Buffer.from(shot.data, 'base64'));
    console.log('    ✓ 截图 game-over.png');

    console.log('\n【4】排行榜');
    const rankRows = await evalJs('document.querySelectorAll("#rankBody tr").length');
    const rankFirst = await evalJs('document.querySelector("#rankBody tr td.rank-name")?.textContent || ""');
    ok('榜单出现记录', rankRows >= 1, rankRows + ' 行，第一行：' + rankFirst);
  } finally {
    if (ws) ws.close();
    child.kill();
    await sleep(300);
    try { execSync(`taskkill /PID ${child.pid} /T /F`, { stdio: 'ignore' }); } catch { /* ignore */ }
  }

  console.log('\n' + (problems.length ? '❌ 失败项：' + problems.join('、') : '✅ 全部通过'));
  if (problems.length) process.exitCode = 1;
}

main().catch((err) => {
  console.error('测试失败：', err.message);
  process.exitCode = 1;
});
