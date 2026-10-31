#!/usr/bin/env bash
# 每日备份：复制 JSON 数据库，保留 7 天
set -euo pipefail

DATA_DIR="${DATA_DIR:-/opt/pickleball/data}"
BACKUP_DIR="${BACKUP_DIR:-/opt/pickleball/backup}"

mkdir -p "$BACKUP_DIR"
STAMP="$(date +%Y%m%d-%H%M%S)"

if [ -f "$DATA_DIR/db.json" ]; then
  cp "$DATA_DIR/db.json" "$BACKUP_DIR/db-$STAMP.json"
  find "$BACKUP_DIR" -name 'db-*.json' -mtime +7 -delete
  echo "[$(date '+%F %T')] 备份完成：db-$STAMP.json"
else
  echo "[$(date '+%F %T')] 没有找到 $DATA_DIR/db.json"
  exit 1
fi
