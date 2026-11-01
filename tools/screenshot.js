'use strict';

/**
 * 用无头 Edge 截图，检查桌面端与移动端渲染
 * 用法：BASE=http://127.0.0.1:3210 NICK=社长 PASS=test1234 node tools/screenshot.js
 * 前置：已用该端口启动服务；系统装了 Microsoft Edge。
 */

const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');

const BASE = process.env.BASE || 'http://127.0.0.1:3210';
const NICK = process.env.NICK || '社长';
const PASS = process.env.PASS || 'test1234';
const PORT = Number(process.env.CDP_PORT || 9333);
const OUT = path.join(__dirname, '..', '.shots');
const EDGE = [
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'
].find((p) => fs.existsSync(p));

if (!EDGE) {
  console.error('没找到 Edge/Chrome，跳过截图');
  process.exit(1);
}

const EXTRA = (process.env.EXTRA || '').split(',').filter(Boolean);
const pages = [
  ['home', '/', 'desktop'],
  ['home-doubles', '/?type=doubles', 'desktop'],
  ['matches', '/matches', 'desktop'],
  ['record', '/record', 'desktop'],
  ['record-doubles', '/record?type=doubles', 'desktop'],
  ['me', '/me', 'desktop'],
  ['admin', '/admin', 'desktop'],
  ['admin-review', '/admin/review', 'desktop'],
  ['admin-review-rejected', '/admin/review?tab=rejected', 'desktop'],
  ['admin-users', '/admin/users', 'desktop'],
  ['m-home', '/', 'mobile'],
  ['m-matches', '/matches', 'mobile'],
  ['m-record', '/record?type=doubles', 'mobile'],
  ['m-me', '/me', 'mobile'],
  ['m-review', '/admin/review', 'mobile'],
  ['m-users', '/admin/users', 'mobile'],
  // EXTRA 用逗号分隔的 name=url，name 以 m- 开头则按 390px 截图
  ...EXTRA.map((raw) => {
    const index = raw.indexOf('=');
    const name = raw.slice(0, index);
    return [name, raw.slice(index + 1), name.startsWith('m-') ? 'mobile' : 'desktop'];
  })
];

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function getJson(url) {
  return new Promise((resolve, reject) => {
    http.get(url, (res) => {
      let data = '';
      res.on('data', (c) => (data += c));
      res.on('end', () => {
        try {
          resolve(JSON.parse(data));
        } catch (e) {
          reject(e);
        }
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
  if (!sid) throw new Error('登录失败，未拿到 sid（检查昵称密码）');
  return sid.slice(4);
}

class CDP {
  constructor(ws) {
    this.ws = ws;
    this.id = 0;
    this.pending = new Map();
    this.events = [];
    ws.addEventListener('message', (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.id && this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        msg.error ? reject(new Error(msg.error.message)) : resolve(msg.result);
      } else if (msg.method) {
        this.events.push(msg.method);
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
      }, 20000);
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

  const child = spawn(EDGE, [
    '--headless=new',
    '--disable-gpu',
    '--hide-scrollbars',
    '--no-first-run',
    '--no-default-browser-check',
    '--user-data-dir=' + path.join(OUT, '.profile'),
    `--remote-debugging-port=${PORT}`,
    'about:blank'
  ], { stdio: 'ignore' });

  let ws;
  let targetId;
  try {
    let list = null;
    for (let i = 0; i < 60; i++) {
      try {
        list = await getJson(`http://127.0.0.1:${PORT}/json/list`);
        if (list && list.length) break;
      } catch {}
      await sleep(250);
    }
    if (!list || !list.length) throw new Error('浏览器没有启动起来');
    const page = list.find((t) => t.type === 'page');
    targetId = page.id;
    ws = await waitFor(page.webSocketDebuggerUrl);

    const cdp = new CDP(ws);
    await cdp.send('Page.enable');
    await cdp.send('Network.enable');
    await cdp.send('Network.setCookie', {
      name: 'sid',
      value: sid,
      domain: '127.0.0.1',
      path: '/',
      httpOnly: true
    });

    for (const [name, url, device] of pages) {
      const mobile = device === 'mobile';
      await cdp.send('Emulation.setDeviceMetricsOverride', {
        width: mobile ? 390 : 1440,
        height: mobile ? 844 : 900,
        deviceScaleFactor: mobile ? 2 : 1,
        mobile
      });
      await cdp.send('Page.navigate', { url: BASE + url });
      // 等布局稳定：readyState 完成 + 两帧渲染
      for (let i = 0; i < 40; i++) {
        const { result } = await cdp.send('Runtime.evaluate', { expression: 'document.readyState', returnByValue: true });
        if (result.value === 'complete') break;
        await sleep(150);
      }
      await cdp.send('Runtime.evaluate', {
        expression: 'new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)))',
        awaitPromise: true
      });
      await sleep(200);
      const metrics = await cdp.send('Page.getLayoutMetrics');
      const size = metrics.cssContentSize || metrics.contentSize;
      const { result: vw } = await cdp.send('Runtime.evaluate', {
        expression: 'window.innerWidth',
        returnByValue: true
      });
      const width = Math.ceil(Math.min(size.width, vw.value || size.width));
      const shot = await cdp.send('Page.captureScreenshot', {
        format: 'png',
        captureBeyondViewport: true,
        clip: {
          x: 0,
          y: 0,
          width,
          height: Math.min(Math.ceil(size.height), 3000),
          scale: 1
        }
      });
      const file = path.join(OUT, `${name}.png`);
      fs.writeFileSync(file, Buffer.from(shot.data, 'base64'));
      console.log(`  ✓ ${name.padEnd(16)} ${mobile ? '390px ' : '1440px'}  ${file}`);
    }
  } finally {
    if (ws) ws.close();
    child.kill();
    await sleep(300);
    // 关掉可能残留的浏览器进程
    try {
      require('node:child_process').execSync(`taskkill /PID ${child.pid} /T /F`, { stdio: 'ignore' });
    } catch {}
  }
  console.log('\n截图已保存到 ' + OUT);
}

main().catch((err) => {
  console.error('截图失败：', err.message);
  process.exitCode = 1;
});
