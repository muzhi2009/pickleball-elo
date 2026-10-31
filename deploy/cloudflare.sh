#!/usr/bin/env bash
# 安装 Cloudflare Tunnel 并连接本机服务
# 用法：sudo bash deploy/cloudflare.sh <TUNNEL_TOKEN>
# 先在 Cloudflare 后台 Zero Trust -> Networks -> Tunnels 创建隧道，复制安装命令里的 token。
set -euo pipefail

TOKEN="${1:-}"
if [ -z "$TOKEN" ]; then
  echo "用法：sudo bash deploy/cloudflare.sh <TUNNEL_TOKEN>"
  echo "token 在 Cloudflare Zero Trust -> Networks -> Tunnels 创建隧道后获得。"
  exit 1
fi

if [ "$(id -u)" -ne 0 ]; then
  echo "请用 root 运行：sudo bash deploy/cloudflare.sh <TUNNEL_TOKEN>"
  exit 1
fi

if ! command -v cloudflared >/dev/null 2>&1; then
  echo "==> 下载 cloudflared"
  ARCH="$(dpkg --print-architecture)"
  curl -fsSL -o /tmp/cloudflared.deb \
    "https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-${ARCH}.deb"
  dpkg -i /tmp/cloudflared.deb
fi

echo "==> 安装为系统服务"
cloudflared service install "$TOKEN"
systemctl enable cloudflared
systemctl restart cloudflared
sleep 2
systemctl --no-pager --lines=5 status cloudflared || true

echo
echo "隧道已启动。"
echo "回到 Cloudflare 后台：Tunnels -> 你的隧道 -> Public Hostname -> Add"
echo "  Subdomain: pb（或你喜欢的）"
echo "  Domain: 你的域名"
echo "  Type: HTTP"
echo "  URL: localhost:3000"
echo "保存后即可用 https://pb.你的域名 访问。"
