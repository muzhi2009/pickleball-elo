#!/usr/bin/env bash
# 原地升级：只替换代码，保留 data/ 和 backup/，不动 systemd 配置与端口。
#
#   sudo bash deploy/upgrade.sh                    # 默认升级 /opt/pickleball
#   sudo APP_DIR=/srv/pickleball bash deploy/upgrade.sh
#
# 想退回：备份目录会打印在输出里，cp 回来再 restart 即可。

set -euo pipefail

SRC_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
APP_DIR="${APP_DIR:-/opt/pickleball}"

if [ ! -d "$APP_DIR" ]; then
  echo "找不到 $APP_DIR。"
  echo "如果服务装在别的目录，用 APP_DIR=/你的目录 再跑一次；"
  echo "如果从来没装过，请用 deploy/install.sh 全新安装。"
  exit 1
fi

if [ ! -d "$APP_DIR/data" ]; then
  echo "警告：$APP_DIR/data 不存在，升级后站点会是空的。"
  read -r -p "确认继续？(yes/no) " answer
  [ "$answer" = "yes" ] || exit 1
fi

STAMP="$(date +%Y%m%d-%H%M%S)"
BAK="$APP_DIR.bak-$STAMP"

echo "==> 备份现有文件到 $BAK"
cp -a "$APP_DIR" "$BAK"

echo "==> 覆盖代码（保留 data、backup）"
if command -v rsync >/dev/null 2>&1; then
  rsync -a --delete \
    --exclude data \
    --exclude backup \
    --exclude demo-data \
    --exclude .smoke-data \
    --exclude .game-test \
    --exclude .test-data \
    --exclude .shots \
    --exclude node_modules \
    --exclude .git \
    "$SRC_DIR"/ "$APP_DIR"/
else
  # 没有 rsync 就退回 cp，只覆盖不删除
  for item in server.js package.json README.md lib public deploy tools; do
    [ -e "$SRC_DIR/$item" ] && cp -a "$SRC_DIR/$item" "$APP_DIR"/
  done
fi

echo "==> 语法自检"
for f in "$APP_DIR"/server.js "$APP_DIR"/lib/*.js "$APP_DIR"/public/game.js; do
  node --check "$f" || { echo "语法错误：$f，已停止（备份在 $BAK）"; exit 1; }
done

PORT_VALUE="$(systemctl show pickleball -p Environment --value 2>/dev/null \
  | tr ' ' '\n' | sed -n 's/^PORT=//p' | head -1 || true)"
PORT_VALUE="${PORT:-${PORT_VALUE:-8080}}"

if systemctl list-unit-files 2>/dev/null | grep -q '^pickleball\.service'; then
  echo "==> 重启 pickleball 服务"
  systemctl restart pickleball
  sleep 1.2
  systemctl is-active pickleball
  STATUS="$(systemctl is-active pickleball || true)"
  if [ "$STATUS" != "active" ]; then
    echo "服务没起来，最近日志："
    journalctl -u pickleball -n 30 --no-pager
    echo "要退回：mv $BAK $APP_DIR && systemctl restart pickleball"
    exit 1
  fi
else
  echo "==> 没找到 pickleball.service，请手动重启你的 node 进程"
fi

echo "==> 本地自检（端口 $PORT_VALUE）"
for path in /healthz /game /static/matter.min.js; do
  code="$(curl -fsS -o /dev/null -w '%{http_code}' "http://127.0.0.1:$PORT_VALUE$path" 2>/dev/null || echo "000")"
  echo "  $path -> $code"
done

echo
echo "升级完成。备份在：$BAK"
echo "要回退：sudo rm -rf $APP_DIR && sudo mv $BAK $APP_DIR && sudo systemctl restart pickleball"
