# 欢乐匹克球社 · Elo 排位系统

一个零第三方依赖的社团排位网站：单打 / 双打 Elo、比赛录入、排行榜、历史战绩、申诉与管理员改判。

- 后端：Node.js 原生 `http`（无需 npm install）
- 存储：单个 JSON 文件（`data/db.json`），备份就是复制文件
- 前端：原生 HTML / CSS / JS，移动端优先，黑白极简
- 部署：Ubuntu / Debian + systemd，可选 Cloudflare Tunnel

---

## 一、本地预览（在自己的电脑上）

需要 Node.js 20 或更高版本，不用 `npm install`（零第三方依赖）。

### 最快的方式：带演示数据直接跑

```bash
cd pickleball
npm run demo
```

会自动生成 8 名成员、40 场历史比赛（随机胜负已算好 Elo），然后启动服务。
浏览器打开 <http://127.0.0.1:3000>，用 **社长 / test1234** 登录，就能看到完整的榜单、比赛记录和管理后台。

> 演示数据写在 `demo-data/`，和真实的 `data/` 完全隔离，随便删。
> 想重新生成一份：`npm run seed`。

### 从零开始（干净的站点）

```bash
cd pickleball
node server.js
```

浏览器打开 <http://127.0.0.1:3000/setup>，创建管理员账号。
之后打开 <http://127.0.0.1:3000> 即可。

想换端口：

```bash
PORT=3100 node server.js        # macOS / Linux
$env:PORT=3100; node server.js  # Windows PowerShell
```

本地数据会写到 `data/db.json`。删掉这个文件就回到全新状态。

### 跑测试 / 重新截图

```bash
npm test          # 自动起临时服务，跑 101 项断言（注册、审核、录入、Elo、申诉、改判、作废、导出…）
npm run shots     # 用无头 Edge 截桌面 + 390px 移动端页面到 .shots/
```

> 测试用的是独立的 `.smoke-data/`，跑完自动清理，不会碰你的真实数据。

---

## 二、部署到服务器（百度云 Ubuntu）

### 方式 A：直接用 IP 访问（最快，未备案可用）

1. 在百度云控制台 → 网络与安全组 → 安全组 → 入站规则，放行 `TCP:8080`，源 `0.0.0.0/0`
2. 把整个 `pickleball` 目录上传到服务器，例如：

```bash
scp -r pickleball root@你的服务器IP:/root/
```

3. 登录服务器并运行：

```bash
ssh root@你的服务器IP
cd /root/pickleball
sudo MODE=ip bash deploy/install.sh
```

4. 浏览器打开：

```
http://你的服务器IP:8080/setup
```

创建管理员账号即可。缺点是 HTTP 明文、地址难记；域名和 HTTPS 以后随时能加，代码不用改。

### 方式 B：域名 + HTTPS（Cloudflare Tunnel，推荐长期使用）

前提：域名已接入 Cloudflare（NS 已改到 Cloudflare），并且创建了 Tunnel。

1. 服务器上先按方式 A 的脚本部署，但不要用 `MODE=ip`：

```bash
cd /root/pickleball
sudo bash deploy/install.sh
```

此时服务只监听 `127.0.0.1:3000`，外网直接访问不到，更安全。

2. 在 Cloudflare 后台创建 Tunnel，复制 token，然后：

```bash
sudo bash /opt/pickleball/deploy/cloudflare.sh <TUNNEL_TOKEN>
```

3. 回到 Cloudflare 后台，给隧道添加 Public Hostname：

| 字段 | 值 |
|---|---|
| Subdomain | `pb`（或你喜欢的） |
| Domain | 你的域名 |
| Type | `HTTP` |
| URL | `localhost:3000` |

4. 打开 `https://pb.你的域名`，完成 `/setup`。

> 未备案域名走 Cloudflare Tunnel 属于技术上的临时方案，不改变备案义务。社团内部使用风险较低，但建议尽快完成 ICP 备案；备案通过后可以平滑切换到 80/443。

---

## 三、日常使用

### 成员

1. 打开网站 → 注册（昵称 + 密码）
2. 等管理员在后台点“通过”
3. 登录 → “录入” → 选单打/双打、选人、选赢家
4. 可选填详细比分（赢得越干脆，加分越多）
5. 对方在 48 小时内可在比赛详情页发起申诉

### 管理员

后台地址：`/admin`

- **成员**：审核注册、手动建号、重置密码、封禁/解封
- **比赛**：改比分、改胜负、改时间、作废/恢复
- **申诉**：维持原判 / 作废 / 去改判
- **设置**：社团名、公告、K 值、定级场次、申诉时限、防刷分
- **数据**：导出成员/比赛 CSV、全量重算 Elo

任何修改都会从头按时间顺序重算所有 Elo，保证历史一致。

---

## 四、Elo 规则

| 项目 | 规则 |
|---|---|
| 初始分 | 1500（单打、双打分开算） |
| 定级期 | 前 10 场 K=40，榜单显示“定级中” |
| 常规 | K=24 |
| 高分段 | ≥1800 分 K=16 |
| 单打 | 期望胜率由分差决定，胜负加减对称 |
| 双打 | 队伍分=两人平均，四人平均 K，队内两人加减相同 |
| 比分修正 | 详细比分时按分差放大，最多 1.5 倍 |
| 单场最少变动 | 胜方至少 +10、负方至少 -10（默认 10，可设为 0 关闭） |
| 防刷分 | 24 小时内重复同一对阵，变化减半 |
| 申诉 | 录入后 48 小时内，分数先生效，管理员可改判 |
| 赛季 | 无，长期累积 |

> 所有参数都能在 `/admin/settings` 里改，保存后立即重算。

关于「单场最少变动」：Elo 公式算出的变化不足这个值时，直接按这个值计。它解决的是「高手赢新手只涨 1~2 分，成员觉得白打」的问题，同时也会**部分抵消防刷分**——原本重复对阵减半到 6 分，保底后被抬回 10 分。想严格防刷就把这项设为 `0`。

---

## 五、备份与恢复

自动备份：每天凌晨 3 点复制 `data/db.json` 到 `backup/db-日期.json`，保留 7 天。

手动备份：

```bash
sudo -u pickleball bash /opt/pickleball/deploy/backup.sh
```

恢复：

```bash
sudo systemctl stop pickleball
sudo cp /opt/pickleball/backup/db-20261031-030000.json /opt/pickleball/data/db.json
sudo chown pickleball:pickleball /opt/pickleball/data/db.json
sudo systemctl start pickleball
```

额外建议：每周在后台导出一次 CSV，存到网盘。

---

## 六、常用命令

```bash
systemctl status pickleball       # 查看状态
systemctl restart pickleball      # 重启
journalctl -u pickleball -n 100 --no-pager   # 查看日志
```

更新代码：

```bash
# 上传新版本后
sudo bash /opt/pickleball/deploy/install.sh
```

---

## 七、安全说明

- 密码使用 scrypt 加盐哈希，不存明文
- 会话使用 HttpOnly + SameSite=Lax Cookie，30 天有效
- 所有 POST 请求校验 Origin，防跨站提交
- 登录/注册有频率限制
- 使用 Tunnel 时只监听 127.0.0.1，公网无法直连 Web 端口
- 建议把服务器 root 密码改成强密码，并尽快改用 SSH 密钥登录
- 不要公开服务器公网 IP

---

## 八、目录结构

```
pickleball/
├── server.js              后端入口与路由
├── lib/
│   ├── store.js           JSON 存储
│   ├── elo.js             Elo 计算与全量重算
│   ├── auth.js            密码哈希与会话签名
│   └── views.js           页面模板
├── public/
│   ├── style.css          样式
│   ├── app.js             少量交互
│   └── icon.svg
├── deploy/
│   ├── install.sh         一键部署
│   ├── cloudflare.sh      Cloudflare Tunnel 安装
│   └── backup.sh          每日备份
├── tools/                 本机开发用，不会部署到服务器
│   ├── seed.js            生成演示数据（npm run seed / demo）
│   ├── run-tests.js       一键测试（npm test）
│   ├── smoke-test.js      101 项接口断言
│   └── screenshot.js      无头浏览器截图
├── demo-data/             演示数据库（可删）
├── .shots/                截图产物（可删）
└── data/                  运行时生成（真实数据库、密钥）
```

---

## 九、上线检查清单

- [ ] 安全组放行端口（`MODE=ip` 时是 8080），或配好 Cloudflare Tunnel
- [ ] 打开 `/setup` 创建管理员，**立刻改掉 demo 里的 test1234**
- [ ] 后台 → 设置，确认社团名、K 值、申诉时限
- [ ] 后台 → 成员，把社团成员拉进来（可手动建号，不用人人注册）
- [ ] 录入第一场比赛，看榜单是否正常
- [ ] 服务器 root 密码改强密码，后续换 SSH 密钥
- [ ] 确认每日备份在跑：`ls /opt/pickleball/backup`

