# 只做余票查询与推送，运行时零 npm 依赖，基础镜像用官方 node:22-alpine
FROM node:22-alpine

# 时区：容器内日志与静默时段按北京时间
ENV TZ=Asia/Shanghai \
    NODE_ENV=production \
    PORT=8080 \
    HOST=0.0.0.0 \
    DATA_DIR=/data \
    LOG_LEVEL=info \
    AUTO_START=true

# alpine 默认不带时区库，缺了 tzdata 时 TZ=Asia/Shanghai 会静默退化成 UTC，
# 日志时间与「静默时段」都会错 8 小时，所以必须装上。
RUN apk add --no-cache tzdata su-exec \
  && cp /usr/share/zoneinfo/Asia/Shanghai /etc/localtime \
  && echo "Asia/Shanghai" > /etc/timezone

WORKDIR /app

COPY package.json ./
COPY entrypoint.sh ./
COPY src ./src
COPY public ./public
COPY assets ./assets

RUN chmod +x /app/entrypoint.sh \
  && mkdir -p /data \
  && chown -R node:node /data /app

VOLUME ["/data"]
EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8080)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

# 以 root 进入入口脚本：先修正挂载目录属主（群晖共享文件夹常见），再降权到 node
ENTRYPOINT ["/app/entrypoint.sh"]
CMD ["node", "src/server.js"]
