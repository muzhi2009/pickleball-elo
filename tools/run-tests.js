'use strict';

/**
 * 一键跑冒烟测试：自动拉起临时服务 → 跑断言 → 关掉服务
 * 用法：npm test
 */

const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const PORT = Number(process.env.TEST_PORT || 3211);
const DATA_DIR = path.join(ROOT, '.smoke-data');

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function waitHealthy(times = 60) {
  for (let i = 0; i < times; i++) {
    try {
      const res = await fetch(`http://127.0.0.1:${PORT}/healthz`);
      if (res.ok) return true;
    } catch {}
    await sleep(200);
  }
  return false;
}

function run(cmd, args, env) {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { cwd: ROOT, env: { ...process.env, ...env }, stdio: 'inherit' });
    child.on('exit', (code) => resolve(code ?? 1));
  });
}

async function main() {
  // 先跑纯函数单元测试（Elo 规则），不依赖服务
  const unitCode = await run(process.execPath, ['tools/test-elo.js'], {});
  if (unitCode !== 0) {
    console.error('\nElo 单元测试未通过，跳过接口测试');
    process.exit(unitCode);
  }
  console.log('\n');

  fs.rmSync(DATA_DIR, { recursive: true, force: true });

  const server = spawn(process.execPath, ['server.js'], {
    cwd: ROOT,
    env: { ...process.env, PORT: String(PORT), DATA_DIR, TEST_HOOK: '1' },
    stdio: 'ignore'
  });

  const cleanup = () => {
    try {
      server.kill();
    } catch {}
  };
  process.on('exit', cleanup);
  process.on('SIGINT', () => {
    cleanup();
    process.exit(130);
  });

  if (!(await waitHealthy())) {
    cleanup();
    console.error('服务没有启动起来，测试中止');
    process.exit(1);
  }

  const code = await run(process.execPath, ['tools/smoke-test.js'], { BASE: `http://127.0.0.1:${PORT}` });
  cleanup();
  fs.rmSync(DATA_DIR, { recursive: true, force: true });
  process.exit(code);
}

main();
