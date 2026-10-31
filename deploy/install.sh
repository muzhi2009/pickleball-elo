#!/usr/bin/env bash
# 欢乐匹克球社 Elo 一键部署脚本（Ubuntu / Debian）
# 用法：
#   sudo bash deploy/install.sh              # 通过 Cloudflare Tunnel 访问（推荐）
#   sudo MODE=ip bash deploy/install.sh      # 直接用 IP:8080 访问（未备案临时方案）
set -euo pipefail

APP_DIR=/opt/pickleball
SERVICE_USER=pickleball
MODE="${MODE:-tunnel}"

if [ "$(id -u)" -ne 0 ]; then
  echo "请用 root 运行：sudo bash deploy/install.sh"
  exit 1
fi

if [ "$MODE" = "ip" ]; then
  APP_HOST=0.0.0.0
  APP_PORT=8080
else
  APP_HOST=127.0.0.1
  APP_PORT=3000
fi

SRC_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

echo "==> 1/6 安装基础依赖"
export DEBIAN_FRONTEND=noninteractive
apt-get update -y
apt-get install -y curl ca-certificates rsync

echo "==> 2/6 检查 Node.js"
NODE_MAJOR=0
if command -v node >/dev/null 2>&1; then
  NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
fi
if [ "$NODE_MAJOR" -lt 20 ]; then
  echo "当前 Node.js 版本过低，安装 Node.js 22 LTS..."
  if apt-get install -y nodejs && [ "$(node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0)" -ge 20 ]; then
    :
  else
    curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
    apt-get install -y nodejs
  fi
fi
node -v

echo "==> 3/6 创建运行用户和目录"
if ! id "$SERVICE_USER" >/dev/null 2>&1; then
  useradd --system --home "$APP_DIR" --shell /usr/sbin/nologin "$SERVICE_USER"
fi
mkdir -p "$APP_DIR/data" "$APP_DIR/backup"

echo "==> 4/6 复制程序文件"
if [ "$SRC_DIR" != "$APP_DIR" ]; then
  rsync -a --delete \
    --exclude data \
    --exclude backup \
    --exclude demo-data \
    --exclude .smoke-data \
    --exclude .test-data \
    --exclude .shots \
    --exclude node_modules \
    --exclude .git \
    "$SRC_DIR"/ "$APP_DIR"/
fi
chown -R "$SERVICE_USER:$SERVICE_USER" "$APP_DIR"
chmod 700 "$APP_DIR/data" "$APP_DIR/backup"

echo "==> 5/6 注册 systemd 服务"
cat > /etc/systemd/system/pickleball.service <<EOF
[Unit]
Description=Happy Pickleball Elo
After=network.target

[Service]
Type=simple
User=$SERVICE_USER
WorkingDirectory=$APP_DIR
Environment=NODE_ENV=production
Environment=HOST=$APP_HOST
Environment=PORT=$APP_PORT
Environment=DATA_DIR=$APP_DIR/data
ExecStart=$(command -v node) $APP_DIR/server.js
Restart=always
RestartSec=3
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=full
ProtectHome=true
ReadWritePaths=$APP_DIR/data $APP_DIR/backup

[Install]
WantedBy=multi-user.target
EOF

systemctl daemon-reload
systemctl enable pickleball
systemctl restart pickleball

echo "==> 6/6 配置每日备份"
cat > /etc/cron.d/pickleball-backup <<EOF
0 3 * * * $SERVICE_USER /bin/bash $APP_DIR/deploy/backup.sh >> $APP_DIR/backup/backup.log 2>&1
EOF
chmod 644 /etc/cron.d/pickleball-backup

if command -v ufw >/dev/null 2>&1; then
  ufw allow 22/tcp >/dev/null 2>&1 || true
  if [ "$MODE" = "ip" ]; then
    ufw allow "$APP_PORT"/tcp >/dev/null 2>&1 || true
  fi
  ufw --force enable >/dev/null 2>&1 || true
fi

sleep 1
if curl -fsS "http://127.0.0.1:$APP_PORT/healthz" >/dev/null 2>&1; then
  echo
  echo "部署成功！"
  if [ "$MODE" = "ip" ]; then
    echo "访问地址：http://<服务器公网IP>:$APP_PORT/setup"
    echo "注意：还需要在百度云控制台的安全组里放行 TCP $APP_PORT 端口。"
  else
    echo "服务已在 127.0.0.1:$APP_PORT 运行。"
    echo "下一步：配置 Cloudflare Tunnel，把域名指向 http://localhost:$APP_PORT"
    echo "命令：sudo bash $APP_DIR/deploy/cloudflare.sh <TUNNEL_TOKEN>"
  fi
  echo "首次打开页面会进入 /setup，创建管理员账号。"
else
  echo "服务没有正常启动，请查看日志：journalctl -u pickleball -n 50 --no-pager"
  exit 1
fi
