#!/bin/sh
# 启动引导：处理 DSM/NAS 共享文件夹的属主/权限问题，然后降权到 node 运行。
#
# 为什么需要它：NAS 上把 /volume1/docker/xxx 挂进容器时，该目录通常属于 DSM 用户
# （uid 不是容器里的 node=1000），容器内的 node 用户会写不进去，表现为启动报
# ENOENT/EACCES 或配置无法持久化。这里以 root 启动时先把数据目录交给 node，
# 再降权执行；拿不到权限时打印可操作的指引，而不是抛一段看不懂的堆栈。
set -e

DATA="${DATA_DIR:-/data}"
APP_USER=node

if [ "$(id -u)" = "0" ]; then
  # mkdir 在绑定挂载上偶发返回 ENOENT（virtiofs / gRPC-FUSE 的 stat 缓存问题），
  # 因此这里不看返回值，以「实际能不能写」为准。
  mkdir -p "$DATA" 2>/dev/null || true

  # 用真实写入探测，别只看权限位：只读挂载 / root-squash 下 test -w 会说谎
  if ! su-exec "$APP_USER" sh -c "touch \"$DATA/.write-test\" 2>/dev/null && rm -f \"$DATA/.write-test\"" 2>/dev/null; then
    echo "[entrypoint] 数据目录 $DATA 对容器用户 $APP_USER 不可写，尝试修正属主…"
    chown -R "$APP_USER:$APP_USER" "$DATA" 2>/dev/null || true
  fi

  # 用真实写入探测，别只看权限位：只读挂载 / root-squash 下 test -w 会说谎
  if ! su-exec "$APP_USER" sh -c "touch \"$DATA/.write-test\" 2>/dev/null && rm -f \"$DATA/.write-test\"" 2>/dev/null; then
    echo "[entrypoint] 警告：$DATA 仍不可写。容器会继续启动，但配置无法持久化。"
    echo "[entrypoint] 修复方式（NAS SSH）：sudo chown -R 1000:1000 <你挂载的共享文件夹路径>"
    echo "[entrypoint] 或在 Container Manager 里把装载路径改到一个容器用户可写的目录。"
  else
    echo "[entrypoint] 数据目录 $DATA 可写，以用户 $APP_USER 启动。"
  fi

  exec su-exec "$APP_USER" "$@"
fi

echo "[entrypoint] 已以非 root 用户 $(id -u) 启动，跳过权限修正。"
exec "$@"
