'use strict';

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };
const THRESHOLD = LEVELS[(process.env.LOG_LEVEL || 'info').toLowerCase()] || LEVELS.info;
const MAX_LOGS = 500;
const RING = [];

// 本地时间（容器 TZ=Asia/Shanghai）。不用 toISOString——那是 UTC，会让日志与静默时段差 8 小时。
function ts(d = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

function push(level, msg, extra) {
  if (!Object.prototype.hasOwnProperty.call(LEVELS, level)) level = 'info';
  // 直接 String(obj) 会得到 "[object Object]"，丢掉排查所需的细节
  let text;
  // 保留 stack：error 级日志里调用栈是排查的关键信息，只留 name+message 会丢掉它
  if (msg instanceof Error) {
    text = msg.stack ? `${msg.name}: ${msg.message}\n${msg.stack.split('\n').slice(1, 4).join('\n')}` : `${msg.name}: ${msg.message}`;
    if (msg.cause) text += `\n  caused by: ${msg.cause.message || msg.cause}`;
  }
  else if (msg && typeof msg === 'object') {
    try { text = JSON.stringify(msg); } catch (err) { text = String(msg); }
  } else text = String(msg);
  const entry = { time: Date.now(), level, msg: text };
  if (extra !== undefined && extra !== null) entry.extra = extra;
  RING.push(entry);
  if (RING.length > MAX_LOGS) RING.splice(0, RING.length - MAX_LOGS);
  if (LEVELS[level] >= THRESHOLD) {
    let line = `[${ts()}] ${level.toUpperCase()} ${entry.msg}`;
    // extra 此前只进 ring 不进控制台，导致 docker logs 里看不到任务 id 等上下文
    if (entry.extra !== undefined) {
      let ex;
      try { ex = typeof entry.extra === 'string' ? entry.extra : JSON.stringify(entry.extra); } catch (e) { ex = String(entry.extra); }
      line += ` ${ex}`;
    }
    if (level === 'error') console.error(line);
    else console.log(line);
  }
}

module.exports = {
  // 必须透传 extra：只写 (m) => push(level, m) 会把调用方传的上下文静默丢掉
  debug: (m, extra) => push('debug', m, extra),
  info: (m, extra) => push('info', m, extra),
  warn: (m, extra) => push('warn', m, extra),
  error: (m, extra) => push('error', m, extra),
  entry: push,
  // slice(-0) === slice(0) 会返回整段日志，负数也会给出错误区间，必须夹紧
  recent: (limit = 200) => {
    const n = Number(limit);
    if (!Number.isFinite(n) || n <= 0) return [];
    // 必须先 floor 再判正：0.5 能过 n<=0，但 floor 后是 0，slice(-0)===slice(0) 会返回整段
    const count = Math.floor(n);
    if (count <= 0) return [];
    return RING.slice(-count);
  },
};
