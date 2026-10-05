#!/usr/bin/env bash
# 打包离线镜像：在能联网的电脑上导出 tar，拷到 NAS 后直接 docker load。
# NAS（尤其 DSM 7 的 Container Manager）在国内拉 Docker Hub 常常失败，这是推荐路径。
set -euo pipefail

TAG="${1:-ticket-monitor:1.0.0}"
OUT="${2:-ticket-monitor-1.0.0.tar}"
BUILDER="${BUILDER:-docker}"

cd "$(dirname "$0")/.."

echo "==> 构建 ${TAG} (使用经典构建器，避免 buildx 在受限环境写缓存失败)"
DOCKER_BUILDKIT=0 "$BUILDER" build -t "$TAG" .

echo "==> 导出到 ${OUT}"
"$BUILDER" save -o "$OUT" "$TAG"

SIZE=$(du -h "$OUT" | cut -f1)
echo "==> 完成：$(pwd)/${OUT} (${SIZE})"
echo
echo "在 NAS 上执行："
echo "  1) 把 ${OUT} 传到 NAS，例如 /volume1/docker/"
echo "  2) SSH 登录 NAS 后："
echo "       cd /volume1/docker"
echo "       sudo docker load -i ${OUT}"
echo "  3) 建数据目录并放行容器用户写权限（容器内 node 用户 uid=1000）："
echo "       sudo mkdir -p /volume1/docker/ticket-monitor/data"
echo "       sudo chown -R 1000:1000 /volume1/docker/ticket-monitor/data"
echo "  4) 用 docker-compose.yml (把 image 设为 ${TAG}、注释掉 build) 启动，"
echo "     或 Container Manager → 映像 → 启动 → 映射端口 8080 与数据目录。"
