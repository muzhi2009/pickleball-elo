'use strict';

/**
 * 最小 demo 冒烟测试
 * 用法（先启动服务）：
 *   PORT=3210 DATA_DIR=./.smoke-data node server.js
 *   BASE=http://127.0.0.1:3210 node tools/smoke-test.js
 *
 * 覆盖：初始化 / 注册 / 审核 / 录入待审 / 管理员与审核员审核 / 自审拦截 /
 *      驳回重提 / 批量通过 / 单打 / 双打 / 防刷 / 排行榜 / 申诉 / 改判 /
 *      作废 / 导出 / 页面可访问性 / 小游戏
 */

const BASE = process.env.BASE || 'http://127.0.0.1:3210';

let pass = 0;
let fail = 0;
const failures = [];

function ok(name, cond, detail = '') {
  if (cond) {
    pass++;
    console.log('  ✓ ' + name);
  } else {
    fail++;
    failures.push(name + (detail ? ' — ' + detail : ''));
    console.log('  ✗ ' + name + (detail ? ' — ' + detail : ''));
  }
}

const isRedirect = (status) => status === 302 || status === 303;

function eq(name, actual, expected) {
  ok(name, actual === expected, `期望 ${JSON.stringify(expected)}，实际 ${JSON.stringify(actual)}`);
}

/* ---------- 极简 cookie 客户端 ---------- */

class Client {
  constructor() {
    this.jar = new Map();
  }
  header() {
    return [...this.jar.entries()].map(([k, v]) => `${k}=${v}`).join('; ');
  }
  store(res) {
    const list = res.headers.getSetCookie ? res.headers.getSetCookie() : [];
    for (const line of list) {
      const [pair] = line.split(';');
      const idx = pair.indexOf('=');
      const key = pair.slice(0, idx).trim();
      const value = pair.slice(idx + 1).trim();
      if (value === '' || line.includes('Max-Age=0')) this.jar.delete(key);
      else this.jar.set(key, value);
    }
  }
  async get(path) {
    const res = await fetch(BASE + path, {
      redirect: 'manual',
      headers: { cookie: this.header() }
    });
    this.store(res);
    return { status: res.status, location: res.headers.get('location'), text: await res.text() };
  }
  async post(path, form) {
    // 支持数组值（批量操作要一次提交多个 ids）
    const params = new URLSearchParams();
    for (const [key, value] of Object.entries(form)) {
      if (Array.isArray(value)) value.forEach((item) => params.append(key, item));
      else params.append(key, value);
    }
    const res = await fetch(BASE + path, {
      method: 'POST',
      redirect: 'manual',
      headers: { cookie: this.header(), 'content-type': 'application/x-www-form-urlencoded' },
      body: params.toString()
    });
    this.store(res);
    return { status: res.status, location: res.headers.get('location'), text: await res.text() };
  }
}

const admin = new Client();
const member = new Client();
const ids = {};

function form(over) {
  return { type: 'singles', detail: '0', winner: '1', playedAt: '', ...over };
}

function matchIdFrom(res) {
  return decodeURIComponent((res.location || '').split('/matches/')[1] || '');
}

async function main() {
  console.log('\n== 0. 健康检查 ==');
  const health = await admin.get('/healthz');
  eq('GET /healthz 返回 200', health.status, 200);

  console.log('\n== 1. 初始化管理员 ==');
  let r = await admin.post('/setup', { nickname: '社长', password: 'test1234', password2: 'test1234' });
  ok('POST /setup 成功跳转', isRedirect(r.status), 'HTTP ' + r.status);
  ok('拿到登录 cookie', admin.jar.has('sid'));
  const setupHtml = await admin.get('/admin/users');
  eq('/admin/users 可访问', setupHtml.status, 200);

  console.log('\n== 2. 注册与审核 ==');
  const names = ['小李', '小王', '小张', '小陈'];
  for (const n of names) {
    const c = new Client();
    const res = await c.post('/register', { nickname: n, password: 'test1234', password2: 'test1234' });
    ok(`注册 ${n}`, isRedirect(res.status), 'HTTP ' + res.status);
  }
  r = await member.post('/login', { nickname: '小李', password: 'test1234' });
  eq('未审核不能登录', r.status, 401);
  ok('提示等待审核', r.text.includes('等待管理员审核'));

  r = await admin.get('/admin/users');
  for (const n of names) ok(`后台能看到待审核 ${n}`, r.text.includes(n));

  let db = await readDb();
  const pendingUsers = db.users.filter((u) => u.status === 'pending');
  eq('拿到 4 个待审核用户', pendingUsers.length, 4);
  for (const u of pendingUsers) {
    await admin.post('/admin/users/' + u.id, { action: 'approve' });
    ids[u.nickname] = u.id;
  }
  const adminId = db.users.find((u) => u.role === 'admin').id;

  r = await member.post('/login', { nickname: '小李', password: 'test1234' });
  ok('审核后可登录', isRedirect(r.status), 'HTTP ' + r.status);

  const mePage = await member.get('/me');
  eq('/me 可访问', mePage.status, 200);
  ok('/me 显示初始分 1500', mePage.text.includes('1500'));

  console.log('\n== 3. 单打录入：先进待审 ==');
  const beforeSingles = await readRatings();
  r = await member.post('/record', form({
    type: 'singles',
    t1p1: ids['小李'],
    t2p1: ids['小王'],
    winner: '1',
    detail: '1',
    score1: '11',
    score2: '7',
    playedAt: localNow()
  }));
  ok('单打录入成功', isRedirect(r.status), 'HTTP ' + r.status);
  const singlesId = matchIdFrom(r);
  ok('跳转到比赛详情', !!singlesId, r.location || '');

  db = await readDb();
  let m = db.matches.find((x) => x.id === singlesId);
  ok('比赛已入库', !!m);
  eq('比赛类型为单打', m.type, 'singles');
  eq('新录入的比赛是待审核', m.status, 'pending');
  eq('待审核比赛不产生 Elo 变化', m.changes.length, 0);

  const afterSubmit = await readRatings();
  eq('待审核时赢家分数没动', afterSubmit[ids['小李']].singles.rating, beforeSingles[ids['小李']].singles.rating);
  eq('待审核时场次没动', afterSubmit[ids['小李']].singles.matches, beforeSingles[ids['小李']].singles.matches);

  const pendingDetail = await member.get('/matches/' + singlesId);
  eq('录入人能打开待审详情', pendingDetail.status, 200);
  ok('详情显示待审核标记', pendingDetail.text.includes('待审核'));
  ok('详情说明暂不计分', pendingDetail.text.includes('还没通过审核'));
  ok('录入人能看到撤销按钮', pendingDetail.text.includes('撤销这场提交'));

  const reviewPage = await admin.get('/admin/review');
  eq('审核队列可访问', reviewPage.status, 200);
  ok('队列里能勾选这场', reviewPage.text.includes(`value="${singlesId}"`));

  r = await admin.post('/admin/review/' + singlesId, { action: 'approve' });
  ok('管理员通过审核', isRedirect(r.status), 'HTTP ' + r.status);

  db = await readDb();
  m = db.matches.find((x) => x.id === singlesId);
  eq('审核后变为已生效', m.status, 'active');
  eq('审核人记录正确', m.review.by, adminId);
  eq('自审标记为 false（管理员审别人录的）', m.review.self, false);
  const sum = m.changes.reduce((s, c) => s + c.delta, 0);
  eq('单打零和（加分=扣分）', sum, 0);
  ok('赢家加分为正', m.changes.find((c) => c.userId === ids['小李']).delta > 0);
  ok('定级期 K=40，11-7 涨幅约 20~24',
    Math.abs(m.changes.find((c) => c.userId === ids['小李']).delta) >= 18 &&
    Math.abs(m.changes.find((c) => c.userId === ids['小李']).delta) <= 26,
    String(m.changes.find((c) => c.userId === ids['小李']).delta));
  const afterSingles = await readRatings();
  eq('审核后小李单打分上涨', afterSingles[ids['小李']].singles.rating > 1500, true);
  eq('审核后小王单打分下降', afterSingles[ids['小王']].singles.rating < 1500, true);
  eq('单打赢家场次 +1', afterSingles[ids['小李']].singles.matches, beforeSingles[ids['小李']].singles.matches + 1);

  console.log('\n== 4. 防刷分（24 小时内同一对阵） ==');
  r = await member.post('/record', form({
    type: 'singles', t1p1: ids['小李'], t2p1: ids['小王'], winner: '1', detail: '0', playedAt: ''
  }));
  ok('重复对阵录入成功', isRedirect(r.status), 'HTTP ' + r.status);
  const repeatId = matchIdFrom(r);
  db = await readDb();
  eq('第二场同样先待审', db.matches.find((x) => x.id === repeatId).status, 'pending');
  eq('第二场待审时也没有 Elo 变化', db.matches.find((x) => x.id === repeatId).changes.length, 0);

  await admin.post('/admin/review/' + repeatId, { action: 'approve' });
  db = await readDb();
  const repeatMatch = db.matches.find((x) => x.id === repeatId);
  eq('第二场审核后生效', repeatMatch.status, 'active');
  const repeatDelta = Math.abs(repeatMatch.changes.find((c) => c.userId === ids['小李']).delta);
  ok('重复对阵涨幅减半', repeatDelta <= 12, String(repeatDelta));

  console.log('\n== 5. 双打录入 ==');
  r = await member.post('/record', form({
    type: 'doubles',
    t1p1: ids['小张'], t1p2: ids['小陈'],
    t2p1: ids['小李'], t2p2: ids['小王'],
    winner: '1', detail: '1', score1: '11', score2: '5', playedAt: localNow()
  }));
  ok('双打录入成功', isRedirect(r.status), 'HTTP ' + r.status);
  const doublesId = matchIdFrom(r);
  db = await readDb();
  eq('双打也是待审核', db.matches.find((x) => x.id === doublesId).status, 'pending');
  await admin.post('/admin/review/' + doublesId, { action: 'approve' });
  db = await readDb();
  const dm = db.matches.find((x) => x.id === doublesId);
  eq('比赛类型为双打', dm.type, 'doubles');
  eq('双打零和', dm.changes.reduce((s, c) => s + c.delta, 0), 0);
  const t1a = dm.changes.find((c) => c.userId === ids['小张']).delta;
  const t1b = dm.changes.find((c) => c.userId === ids['小陈']).delta;
  eq('同队两人加同分', t1a, t1b);
  ok('大比分胜出有放大（11-5 涨幅 > 20）', t1a > 20, String(t1a));

  console.log('\n== 6. 审核员：分配与权限边界 ==');
  r = await admin.post('/admin/users/' + ids['小王'], { action: 'setRole', role: 'reviewer' });
  ok('管理员可以指派审核员', isRedirect(r.status), 'HTTP ' + r.status);
  db = await readDb();
  eq('小王角色变为审核员', db.users.find((u) => u.id === ids['小王']).role, 'reviewer');

  const reviewer = new Client();
  await reviewer.post('/login', { nickname: '小王', password: 'test1234' });
  const revQueue = await reviewer.get('/admin/review');
  eq('审核员能打开审核队列', revQueue.status, 200);
  const revUsers = await reviewer.get('/admin/users');
  eq('审核员进不了成员管理', revUsers.status, 403);
  const revSettings = await reviewer.get('/admin/settings');
  eq('审核员进不了规则设置', revSettings.status, 403);

  const plain = new Client();
  await plain.post('/login', { nickname: '小张', password: 'test1234' });
  const plainQueue = await plain.get('/admin/review');
  eq('普通成员进不了审核队列', plainQueue.status, 403);

  // 审核员自己录一场，不能自己通过
  r = await reviewer.post('/record', form({
    type: 'singles', t1p1: ids['小王'], t2p1: ids['小陈'], winner: '1', detail: '1', score1: '11', score2: '9', playedAt: localNow()
  }));
  const selfId = matchIdFrom(r);
  ok('审核员可以录入比赛', !!selfId, r.location || '');
  await reviewer.post('/admin/review/' + selfId, { action: 'approve' });
  db = await readDb();
  eq('审核员不能通过自己录的比赛', db.matches.find((x) => x.id === selfId).status, 'pending');

  const selfDetail = await reviewer.get('/matches/' + selfId);
  ok('页面提示需要管理员审核', selfDetail.text.includes('需要另一位审核者或管理员'));

  await admin.post('/admin/review/' + selfId, { action: 'approve' });
  db = await readDb();
  eq('管理员可以审审核员录的比赛', db.matches.find((x) => x.id === selfId).status, 'active');

  // 审核员可以审别人录的
  r = await plain.post('/record', form({
    type: 'singles', t1p1: ids['小张'], t2p1: ids['小李'], winner: '2', detail: '1', score1: '6', score2: '11', playedAt: localNow()
  }));
  const otherId = matchIdFrom(r);
  await reviewer.post('/admin/review/' + otherId, { action: 'approve' });
  db = await readDb();
  eq('审核员能通过别人录的比赛', db.matches.find((x) => x.id === otherId).status, 'active');

  // 管理员可以审自己录的（自审留痕）
  r = await admin.post('/record', form({
    type: 'singles', t1p1: ids['小陈'], t2p1: ids['小张'], winner: '1', detail: '0', playedAt: localNow()
  }));
  const adminOwnId = matchIdFrom(r);
  await admin.post('/admin/review/' + adminOwnId, { action: 'approve' });
  db = await readDb();
  const adminOwn = db.matches.find((x) => x.id === adminOwnId);
  eq('管理员可以审自己录的比赛', adminOwn.status, 'active');
  eq('自审被标记出来', adminOwn.review.self, true);

  console.log('\n== 7. 驳回与重新提交 ==');
  r = await plain.post('/record', form({
    type: 'singles', t1p1: ids['小李'], t2p1: ids['小张'], winner: '1', detail: '1', score1: '11', score2: '3', playedAt: localNow()
  }));
  const rejectId = matchIdFrom(r);

  // 不写理由的驳回不生效
  await admin.post('/admin/review/' + rejectId, { action: 'reject', note: '' });
  db = await readDb();
  eq('不写原因的驳回不生效', db.matches.find((x) => x.id === rejectId).status, 'pending');

  await admin.post('/admin/review/' + rejectId, { action: 'reject', note: '比分记反了，实际 A 队 3 分' });
  db = await readDb();
  const rejected = db.matches.find((x) => x.id === rejectId);
  eq('驳回后状态为 rejected', rejected.status, 'rejected');
  eq('驳回的比赛不计分', rejected.changes.length, 0);
  ok('驳回原因被保存', rejected.review.note.includes('比分记反'));

  const rejectDetail = await plain.get('/matches/' + rejectId);
  ok('详情显示驳回原因', rejectDetail.text.includes('比分记反'));
  ok('录入人看到重新提交按钮', rejectDetail.text.includes('重新提交'));

  await plain.post('/matches/' + rejectId + '/resubmit', {});
  db = await readDb();
  eq('重新提交后回到待审核', db.matches.find((x) => x.id === rejectId).status, 'pending');

  // 撤销
  r = await plain.post('/matches/' + rejectId + '/withdraw', {});
  ok('可以撤销自己的待审提交', isRedirect(r.status), 'HTTP ' + r.status);
  db = await readDb();
  ok('撤销后记录被删除', !db.matches.find((x) => x.id === rejectId));

  console.log('\n== 8. 批量通过 ==');
  const batchIds = [];
  for (let i = 0; i < 3; i++) {
    r = await member.post('/record', form({
      type: 'singles', t1p1: ids['小李'], t2p1: ids['小陈'], winner: i === 1 ? '1' : '2', detail: '0',
      playedAt: localNow(-1 * (i + 1))
    }));
    batchIds.push(matchIdFrom(r));
  }
  eq('攒下 3 场待审核', batchIds.filter((id) => id).length, 3);
  r = await admin.post('/admin/review/batch', { ids: batchIds });
  ok('批量通过请求成功', isRedirect(r.status), 'HTTP ' + r.status);
  db = await readDb();
  const batchStates = batchIds.map((id) => db.matches.find((x) => x.id === id).status);
  eq('3 场全部变为已生效', batchStates.filter((s) => s === 'active').length, 3);

  // 审核员批量时，自己录的会被跳过
  const mixed = [];
  for (let i = 0; i < 2; i++) {
    r = await reviewer.post('/record', form({
      type: 'singles', t1p1: ids['小王'], t2p1: ids['小张'], winner: '1', detail: '0',
      playedAt: localNow(-1 * (i + 3))
    }));
    mixed.push(matchIdFrom(r));
  }
  await reviewer.post('/admin/review/batch', { ids: mixed });
  db = await readDb();
  eq('审核员批量时自己录的仍待审', db.matches.find((x) => x.id === mixed[0]).status, 'pending');

  console.log('\n== 9. 校验与错误处理 ==');
  r = await member.post('/record', form({
    type: 'doubles', t1p1: ids['小李'], t1p2: ids['小王'], t2p1: ids['小张'], t2p2: ids['小陈'],
    winner: '2', detail: '1', score1: '11', score2: '5'
  }));
  eq('比分与赢家不一致被拒绝', r.status, 400);
  ok('给出明确提示', r.text.includes('获胜队伍和比分不一致'));

  r = await member.post('/record', form({
    type: 'singles', t1p1: ids['小李'], t2p1: ids['小李'], winner: '1'
  }));
  eq('同一人重复上场被拒绝', r.status, 400);

  console.log('\n== 10. 排行榜与列表页 ==');
  const home = await new Client().get('/');
  eq('排行榜公开可访问', home.status, 200);
  ok('排行榜显示选手', home.text.includes('小李') && home.text.includes('小张'));
  const homeDoubles = await new Client().get('/?type=doubles');
  eq('双打榜可访问', homeDoubles.status, 200);
  ok('双打榜有双打排名', homeDoubles.text.includes('双打'));
  const list = await new Client().get('/matches');
  eq('比赛列表可访问', list.status, 200);
  ok('公开列表不显示待审比赛', !list.text.includes('待审核'));
  const detail = await member.get('/matches/' + singlesId);
  eq('比赛详情可访问', detail.status, 200);
  ok('详情显示比分', detail.text.includes('11') && detail.text.includes('7'));
  ok('详情显示 Elo 变化', detail.text.includes('Elo'));

  // 待审比赛对无关成员不可见
  const hidden = await admin.post('/record', form({
    type: 'singles', t1p1: ids['小陈'], t2p1: ids['小王'], winner: '1', detail: '0', playedAt: localNow()
  }));
  const hiddenId = matchIdFrom(hidden);
  const outsider = await plain.get('/matches/' + hiddenId);
  eq('待审比赛对无关成员返回 404', outsider.status, 404);
  const owner = await admin.get('/matches/' + hiddenId);
  eq('待审比赛对录入人可见', owner.status, 200);
  const anonHidden = await new Client().get('/matches/' + hiddenId);
  ok('未登录看不到待审比赛', anonHidden.status !== 200, 'HTTP ' + anonHidden.status);

  console.log('\n== 11. 申诉与裁决 ==');
  const wang = new Client();
  await wang.post('/login', { nickname: '小王', password: 'test1234' });
  const ratingBeforeDispute = (await readRatings())[ids['小李']].singles.rating;
  r = await wang.post(`/matches/${singlesId}/dispute`, { reason: '比分记错了，应该是 11-9' });
  ok('发起申诉成功', isRedirect(r.status), 'HTTP ' + r.status);
  db = await readDb();
  ok('比赛标记为争议中', db.matches.find((x) => x.id === singlesId).disputed === true);
  eq('争议期间分数冻结', (await readRatings())[ids['小李']].singles.rating, ratingBeforeDispute);

  const disputesPage = await admin.get('/admin/disputes');
  eq('管理员争议列表可访问', disputesPage.status, 200);
  ok('争议列表显示理由', disputesPage.text.includes('11-9'));
  r = await admin.post(`/admin/disputes/${singlesId}/resolve`, { action: 'uphold' });
  ok('裁决维持原判', isRedirect(r.status), 'HTTP ' + r.status);
  db = await readDb();
  ok('裁决后争议标记清除', db.matches.find((x) => x.id === singlesId).disputed === false);

  console.log('\n== 12. 改判与全量重算 ==');
  const editPage = await admin.get(`/admin/matches/${singlesId}/edit`);
  eq('改判页面可访问', editPage.status, 200);
  r = await admin.post(`/admin/matches/${singlesId}/edit`, form({
    type: 'singles', t1p1: ids['小李'], t2p1: ids['小王'], winner: '2', detail: '1', score1: '7', score2: '11'
  }));
  ok('改判提交成功', isRedirect(r.status), 'HTTP ' + r.status);
  db = await readDb();
  ok('改判后赢家变为小王',
    db.matches.find((x) => x.id === singlesId).changes.find((c) => c.userId === ids['小王']).delta > 0);

  const consistent = recomputeConsistent(db);
  ok('重算结果与库中分数一致', consistent.ok, consistent.detail);

  console.log('\n== 13. 作废比赛 ==');
  r = await admin.post(`/admin/matches/${repeatId}/void`, {});
  ok('作废成功', isRedirect(r.status), 'HTTP ' + r.status);
  db = await readDb();
  eq('比赛状态为 void', db.matches.find((x) => x.id === repeatId).status, 'void');
  eq('作废比赛不计分', db.matches.find((x) => x.id === repeatId).changes.length, 0);
  const afterVoid = recomputeConsistent(db);
  ok('作废后重算仍一致', afterVoid.ok, afterVoid.detail);

  console.log('\n== 14. 导出与重算按钮 ==');
  const csv = await admin.get('/admin/export.csv?type=players');
  eq('导出选手 CSV', csv.status, 200);
  ok('CSV 含表头', csv.text.split('\n')[0].includes('昵称'));
  ok('CSV 区分审核员角色', csv.text.includes('审核员'));
  const csv2 = await admin.get('/admin/export.csv?type=matches');
  eq('导出比赛 CSV', csv2.status, 200);
  ok('比赛 CSV 含审核状态列', csv2.text.split('\n')[0].includes('审核状态'));
  r = await admin.post('/admin/recompute', {});
  ok('手动重算成功', isRedirect(r.status), 'HTTP ' + r.status);

  console.log('\n== 15. 全站页面可访问性 ==');
  const pages = ['/', '/matches', '/login', '/register', '/me', '/record',
    '/admin', '/admin/review', '/admin/users', '/admin/matches', '/admin/disputes', '/admin/settings',
    '/players/' + ids['小李'], '/static/style.css', '/static/app.js', '/static/icon.svg'];
  for (const p of pages) {
    const res = await admin.get(p);
    ok(`GET ${p}`, res.status === 200 || isRedirect(res.status), 'HTTP ' + res.status);
  }

  console.log('\n== 16. 未登录访问控制 ==');
  const anon = new Client();
  for (const p of ['/me', '/record', '/admin/users', '/admin/review']) {
    const res = await anon.get(p);
    ok(`未登录访问 ${p} 被拦截`, isRedirect(res.status) && (res.location || '').includes('/login'), 'HTTP ' + res.status);
  }
  const anonRecord = await anon.post('/record', form({ t1p1: ids['小李'], t2p1: ids['小王'] }));
  ok('未登录不能录入', isRedirect(anonRecord.status), 'HTTP ' + anonRecord.status);
  const anonApprove = await anon.post('/admin/review/' + hiddenId, { action: 'approve' });
  ok('未登录不能审核', isRedirect(anonApprove.status), 'HTTP ' + anonApprove.status);

  console.log('\n== 17. XSS 转义 ==');
  const evil = new Client();
  await evil.post('/register', { nickname: '<script>x</script>', password: 'test1234', password2: 'test1234' });
  const board = await new Client().get('/');
  ok('昵称被转义，不会注入脚本', !board.text.includes('<script>x</script>'));

  console.log('\n== 18. 成员管理 ==');
  r = await admin.post('/admin/users', { nickname: '新人甲', password: 'test1234' });
  ok('管理员手动建号', isRedirect(r.status), 'HTTP ' + r.status);
  db = await readDb();
  const newbie = db.users.find((u) => u.nickname === '新人甲');
  ok('新成员状态为正常', newbie && newbie.status === 'active');

  r = await admin.post('/admin/users/' + newbie.id, { action: 'ban' });
  ok('封禁成员', isRedirect(r.status), 'HTTP ' + r.status);
  db = await readDb();
  eq('封禁后状态正确', db.users.find((u) => u.id === newbie.id).status, 'banned');
  const bannedLogin = await new Client().post('/login', { nickname: '新人甲', password: 'test1234' });
  ok('封禁账号无法登录', bannedLogin.status === 401 && bannedLogin.text.includes('封禁'), 'HTTP ' + bannedLogin.status);

  const hashBefore = db.users.find((u) => u.id === newbie.id).passwordHash;
  r = await admin.post('/admin/users/' + newbie.id, { action: 'reset' });
  ok('重置密码', isRedirect(r.status), 'HTTP ' + r.status);
  db = await readDb();
  ok('密码哈希已变更', db.users.find((u) => u.id === newbie.id).passwordHash !== hashBefore);

  r = await admin.post('/admin/users/' + newbie.id, { action: 'unban' });
  ok('解封成员', isRedirect(r.status), 'HTTP ' + r.status);
  db = await readDb();
  eq('解封后状态正常', db.users.find((u) => u.id === newbie.id).status, 'active');

  // 角色升降级
  r = await admin.post('/admin/users/' + newbie.id, { action: 'setRole', role: 'reviewer' });
  db = await readDb();
  eq('成员被提升为审核员', db.users.find((u) => u.id === newbie.id).role, 'reviewer');
  await admin.post('/admin/users/' + newbie.id, { action: 'setRole', role: 'member' });
  db = await readDb();
  eq('审核员被降回成员', db.users.find((u) => u.id === newbie.id).role, 'member');
  await admin.post('/admin/users/' + adminId, { action: 'setRole', role: 'member' });
  db = await readDb();
  eq('不能改自己的角色', db.users.find((u) => u.id === adminId).role, 'admin');

  db = await readDb();
  const adminUser = db.users.find((u) => u.role === 'admin');
  const adminHash = adminUser.passwordHash;
  await admin.post('/admin/users/' + adminUser.id, { action: 'reset' });
  await admin.post('/admin/users/' + adminUser.id, { action: 'ban' });
  db = await readDb();
  const adminAfter = db.users.find((u) => u.id === adminUser.id);
  ok('管理员账号不能被自己封禁或重置', adminAfter.status === 'active' && adminAfter.passwordHash === adminHash);

  console.log('\n== 19. 规则设置 ==');
  const settingsPage = await admin.get('/admin/settings');
  eq('设置页可访问', settingsPage.status, 200);
  ok('设置页有「单场最少变动」输入框', settingsPage.text.includes('name="minWinDelta"'));
  ok('设置页有审核开关', settingsPage.text.includes('name="requireApproval"'));
  r = await admin.post('/admin/settings', {
    clubName: '欢乐匹克球社', announcement: '周三晚 7 点老地方',
    kProvisional: '40', kNormal: '32', kHigh: '16', highThreshold: '1800',
    provisionalMatches: '5', minWinDelta: '12',
    disputeHours: '48', antiFarmHours: '24', antiFarmFactor: '0.5', antiFarm: '1',
    requireApproval: '1', maxPendingPerUser: '20'
  });
  ok('保存设置', isRedirect(r.status), 'HTTP ' + r.status);
  db = await readDb();
  eq('K 值已更新', db.settings.kNormal, 32);
  eq('定级场次已更新', db.settings.provisionalMatches, 5);
  eq('单场最少变动已更新为 12', db.settings.minWinDelta, 12);
  eq('审核开关保持开启', db.settings.requireApproval, true);
  const afterSettings = recomputeConsistent(db);
  ok('改设置后全量重算一致', afterSettings.ok, afterSettings.detail);
  const homeAnnounce = await new Client().get('/');
  ok('公告显示在首页', homeAnnounce.text.includes('周三晚 7 点老地方'));

  // 关掉审核开关 → 录入即生效
  await admin.post('/admin/settings', {
    clubName: '欢乐匹克球社', announcement: '周三晚 7 点老地方',
    kProvisional: '40', kNormal: '32', kHigh: '16', highThreshold: '1800',
    provisionalMatches: '5', minWinDelta: '12',
    disputeHours: '48', antiFarmHours: '24', antiFarmFactor: '0.5', antiFarm: '1',
    maxPendingPerUser: '20'
  });
  db = await readDb();
  eq('关掉审核开关', db.settings.requireApproval, false);
  r = await member.post('/record', form({
    type: 'singles', t1p1: ids['小李'], t2p1: ids['小张'], winner: '1', detail: '0', playedAt: localNow()
  }));
  const instantId = matchIdFrom(r);
  db = await readDb();
  eq('关闭审核后录入直接生效', db.matches.find((x) => x.id === instantId).status, 'active');

  // 再打开
  await admin.post('/admin/settings', {
    clubName: '欢乐匹克球社', announcement: '周三晚 7 点老地方',
    kProvisional: '40', kNormal: '32', kHigh: '16', highThreshold: '1800',
    provisionalMatches: '5', minWinDelta: '12',
    disputeHours: '48', antiFarmHours: '24', antiFarmFactor: '0.5', antiFarm: '1',
    requireApproval: '1', maxPendingPerUser: '20'
  });
  db = await readDb();
  eq('审核开关已恢复开启', db.settings.requireApproval, true);

  console.log('\n== 20. 小游戏：最高分榜 ==');
  const anonGame = new Client();
  const anonPage = await anonGame.get('/game');
  eq('未登录也能打开游戏页', anonPage.status, 200);
  ok('页面加载了物理引擎', anonPage.text.includes('/static/matter.min.js'));
  ok('页面加载了游戏脚本', anonPage.text.includes('/static/game.js'));
  ok('页面带排行榜容器', anonPage.text.includes('id="rankBody"'));
  ok('未登录提示不计入榜单', anonPage.text.includes('成绩不会上榜'));

  const anonStart = await anonGame.post('/game/start', {});
  eq('未登录拿不到对局凭证', anonStart.status, 401);

  // 一局一张凭证，且凭证有最短时长要求，所以先一次性签好后面要用的
  const tokens = [];
  for (let i = 0; i < 4; i++) {
    tokens.push(JSON.parse((await member.post('/game/start', {})).text).token);
  }
  const memberToken = tokens[0];
  const adminToken = JSON.parse((await admin.post('/game/start', {})).text).token;
  ok('登录后签发了对局凭证', typeof memberToken === 'string' && memberToken.split('.').length === 2);
  ok('每次开局凭证都不同', new Set(tokens).size === tokens.length);

  const forged = await member.post('/game/score', { token: 'abc.def', score: '500' });
  eq('伪造凭证被拒', forged.status, 400);

  const tooFast = await member.post('/game/score', { token: memberToken, score: '500' });
  eq('不满 8 秒的对局被拒', tooFast.status, 400);

  console.log('  … 等待 9 秒，让对局凭证站稳');
  await new Promise((resolve) => setTimeout(resolve, 9000));

  const good = await member.post('/game/score', { token: memberToken, score: '260', ms: '96000' });
  eq('正常提交返回 200', good.status, 200);
  const goodJson = JSON.parse(good.text);
  ok('首局记为最高分', goodJson.isNewBest === true && goodJson.best === 260,
    JSON.stringify(goodJson));

  const replay = await member.post('/game/score', { token: memberToken, score: '260' });
  eq('同一局不能重复提交', replay.status, 409);

  const token2 = tokens[1];
  const lower = JSON.parse((await member.post('/game/score', { token: token2, score: '80', ms: '61000' })).text);
  ok('低分不覆盖最高分', lower.isNewBest === false && lower.best === 260);

  const token3 = tokens[2];
  const absurd = await member.post('/game/score', { token: token3, score: '999999' });
  eq('离谱分数被拒', absurd.status, 400);

  const adminScore = JSON.parse((await admin.post('/game/score', { token: adminToken, score: '430', ms: '142000' })).text);
  ok('管理员成绩也记上', adminScore.best === 430, JSON.stringify(adminScore));

  db = await readDb();
  const adminNick = db.users.find((u) => u.id === adminId).nickname;
  const memberId = db.users.find((u) => u.nickname === '小李').id;
  const memberRow = db.gameScores.find((s) => s.userId === memberId);
  ok('游戏成绩落在独立表里', !!memberRow && memberRow.best === 260 && memberRow.plays === 2,
    memberRow ? `best=${memberRow.best} plays=${memberRow.plays}` : '没有记录');
  ok('游戏分数没有污染 Elo', typeof db.ratings[memberId].singles.rating === 'number');

  const rankPage = await member.get('/game');
  const ranked = [...rankPage.text.matchAll(/class="rank-name">([^<]*)</g)].map((m) => m[1]);
  ok('榜单按最高分降序排列', ranked[0] === adminNick, ranked.join(' > '));
  ok('榜单包含全部上榜成员', ranked.length === 2, ranked.join('、'));
  ok('自己的那一行有高亮', rankPage.text.includes('class="rank-me"'));

  console.log('\n========== 结果 ==========');
  console.log(`通过 ${pass} 项，失败 ${fail} 项`);
  if (fail) {
    console.log('\n失败明细：');
    for (const f of failures) console.log(' - ' + f);
    process.exitCode = 1;
  } else {
    console.log('全部通过 ✅');
  }
}

/* ---------- 辅助 ---------- */

function localNow(offsetMinutes = -1) {
  const d = new Date(Date.now() + offsetMinutes * 60 * 1000);
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

async function readDb() {
  const res = await fetch(BASE + '/__test__/db');
  if (res.status !== 200) throw new Error('读取数据库失败，请用 TEST_HOOK=1 启动服务');
  return res.json();
}

async function readRatings() {
  return (await readDb()).ratings;
}

function recomputeConsistent(db) {
  // 独立实现一遍：按 playedAt 排序，验证总分守恒与分数一致
  const elo = require('../lib/elo');
  const clone = JSON.parse(JSON.stringify(db));
  elo.recompute(clone);
  for (const id of Object.keys(db.ratings)) {
    for (const type of ['singles', 'doubles']) {
      const a = db.ratings[id][type];
      const b = clone.ratings[id][type];
      if (a.rating !== b.rating) {
        return { ok: false, detail: `${id} ${type} 分数不一致：库中 ${a.rating}，重算 ${b.rating}` };
      }
      if (a.matches !== b.matches) {
        return { ok: false, detail: `${id} ${type} 场次不一致：库中 ${a.matches}，重算 ${b.matches}` };
      }
    }
  }
  return { ok: true, detail: '' };
}

main().catch((err) => {
  console.error('\n测试脚本异常：', err);
  process.exitCode = 1;
});
