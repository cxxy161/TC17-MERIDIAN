#!/usr/bin/env bash
set -euo pipefail

# Meridian 一键推送 + 本地增量打包 + 服务器热更新脚本
# 用法：
#   ./scripts/deploy.sh              # git push + docker build + 上传部署
#   ./scripts/deploy.sh --no-push    # 跳过 git push，仅打包部署
#   MERIDIAN_SSH_HOST=cxxy ./scripts/deploy.sh

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

SSH_HOST="${MERIDIAN_SSH_HOST:-cxxy}"
REMOTE_DIR="${MERIDIAN_REMOTE_DIR:-~/web/meridian}"
IMAGE_TAG="${MERIDIAN_IMAGE:-meridian:latest}"
DO_PUSH=1

for arg in "$@"; do
  case "$arg" in
    --no-push) DO_PUSH=0 ;;
    *)
      echo "Unknown option: $arg" >&2
      exit 1
      ;;
  esac
done

if [ "$DO_PUSH" -eq 1 ] && git remote get-url origin >/dev/null 2>&1; then
  echo "[1/4] Pushing current branch to origin..."
  git push origin HEAD
else
  echo "[1/4] Skipping git push"
fi

echo "[2/4] Building Docker image ($IMAGE_TAG)..."
docker build -t "$IMAGE_TAG" .

echo "[3/4] Uploading compose & streaming image to $SSH_HOST..."
ssh -o BatchMode=yes "$SSH_HOST" "mkdir -p $REMOTE_DIR/data"
scp -q deploy/docker-compose.yml "$SSH_HOST:$REMOTE_DIR/docker-compose.yml"
docker save "$IMAGE_TAG" | gzip | ssh -o BatchMode=yes "$SSH_HOST" "gunzip | docker load"

echo "[4/4] Restarting container and checking health..."
ssh -o BatchMode=yes "$SSH_HOST" "cd $REMOTE_DIR && docker compose up -d && sleep 3 && curl -fsS http://127.0.0.1:18420/api/health && echo ''"
echo "Deploy finished."
