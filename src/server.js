'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const logger = require('./logger');
const store = require('./store');
const client = require('./client');
const notifier = require('./notifier');
const dav = require('./dav');
const { Monitor } = require('./engine');

const PORT = Number(process.env.PORT || 8080);
const HOST = process.env.HOST || '0.0.0.0';
const PUBLIC_DIR = path.join(__dirname, '..', 'public');

// 12306 预售期（约 15 天，含当天）。超出必定被 302 拒绝，本地提前拦下。
const PRESALE_DAYS = Number(process.env.PRESALE_DAYS || 14);

function fmtDay(d) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

let config = store.load();
const monitor = new Monitor({ getConfig: () => config });

const sseClients = new Set();
const MAX_SSE_CLIENTS = Number(process.env.MAX_SSE_CLIENTS || 50);
const MAX_BODY_BYTES = 2 * 1024 * 1024;

monitor.onEvent = (event) => {
  broadcast('event', event);
  broadcast('state', monitor.snapshot());
};
// 每轮调度结束后无条件推一次状态：无票是正常结果、不产生事件，
// 只靠 onEvent 广播会让页面倒计时停在 0、余票概览不再更新。
monitor.onState = (snap) => broadcast('state', snap);

function broadcast(type, data) {
  const payload = `event: ${type}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const res of sseClients) {
    try {
      res.write(payload);
    } catch (err) {
      sseClients.delete(res);
    }
  }
}

function persist() {
  // 保存失败只告警不抛出：只读挂载下服务应继续可用（只是不持久化）
  const ok = store.save(config);
  if (!ok) {
    logger.warn('配置写入失败，本次改动未持久化（检查数据目录权限）');
  }
  scheduleAutoBackup();
  return ok;
}

// 自动备份去抖：连续改动只上传一次，避免把云端刷满、也避免请求放大
let autoBackupTimer = null;
const AUTO_BACKUP_DEBOUNCE_MS = Number(process.env.AUTO_BACKUP_DEBOUNCE_MS || 60000);

function scheduleAutoBackup() {
  const w = config.settings.webdav || {};
  if (!w.enabled || !w.autoBackup) return;
  if (autoBackupTimer) clearTimeout(autoBackupTimer);
  autoBackupTimer = setTimeout(async () => {
    autoBackupTimer = null;
    try {
      const payload = dav.buildExportPayload(config, notifier.MASKED);
      const result = await dav.upload(
        { url: w.url, username: w.username, password: w.password, path: w.path },
        payload,
        { keep: Number(w.keep) || dav.MAX_BACKUPS },
      );
      config.settings.webdav.lastBackupAt = Date.now();
      config.settings.webdav.lastBackupName = result.name;
      store.save(config); // 直接落盘，避免再次触发 persist 形成递归
      logger.info(`自动备份完成：${result.name}`);
    } catch (err) {
      logger.warn(`自动备份失败：${err.message}${err.hint ? `（${err.hint}）` : ''}`);
    }
  }, AUTO_BACKUP_DEBOUNCE_MS);
  if (autoBackupTimer.unref) autoBackupTimer.unref();
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

function sendJson(res, status, body) {
  const text = JSON.stringify(body);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(text);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let aborted = false;
    let size = 0;
    req.on('data', (chunk) => {
      if (aborted) return; // 已超限：不再累加，避免内存被持续撑大
      // 按 Buffer 累加、最后一次性解码：直接字符串相加会按 chunk 边界各自解码，
      // 中文站名等多字节字符被 TCP 分片切断时会变成乱码。
      chunks.push(chunk);
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        aborted = true;
        chunks.length = 0;
        req.destroy();
        reject(Object.assign(new Error('请求体过大'), { statusCode: 413 }));
      }
    });
    req.on('end', () => {
      if (aborted) return;
      const raw = Buffer.concat(chunks).toString('utf8');
      if (!raw) return resolve({});
      try {
        const parsed = JSON.parse(raw);
        // JSON 顶层可以是 "null" / "123" / ""x""，调用方直接取属性会 TypeError；
        // 统一在这里拒绝，避免每个处理函数各自防御。
        if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
          reject(Object.assign(new Error('请求体必须是 JSON 对象'), { statusCode: 400 }));
          return;
        }
        resolve(parsed);
      } catch (err) {
        reject(new Error('JSON 解析失败'));
      }
    });
    req.on('error', reject);
  });
}

// 常量时间比较，避免通过响应时间逐字节猜出令牌
function timingSafeEqualStr(a, b) {
  const ba = Buffer.from(String(a || ''), 'utf8');
  const bb = Buffer.from(String(b || ''), 'utf8');
  if (ba.length !== bb.length) {
    // 长度不同也要走一次比较，避免长度差异造成明显的计时差
    crypto.timingSafeEqual(ba, ba);
    return false;
  }
  return crypto.timingSafeEqual(ba, bb);
}

function authorized(req, url) {
  const token = config.settings.token;
  if (!token) return true;
  const provided = req.headers['x-token'];
  if (provided) return timingSafeEqualStr(provided, token);
  // EventSource 无法自定义请求头，只有它走查询串；
  // 其余情况不接受查询串传令牌，避免令牌进入反代访问日志。
  const qs = url.searchParams.get('token');
  if (!qs) return false;
  // 仅允许 SSE 端点用查询串传令牌
  const isSse = url.pathname === '/api/stream' || url.pathname === '/api/events/stream';
  return isSse && timingSafeEqualStr(qs, token);
}

function channelsForClient() {
  return (config.channels || []).map(notifier.mask);
}

// 对外一律掩码：令牌与 WebDAV 密码都不能明文回传
function publicSettings() {
  const s = { ...config.settings };
  if (s.token) s.token = notifier.MASKED; else s.token = '';
  if (s.webdav) {
    s.webdav = { ...s.webdav, password: s.webdav.password ? notifier.MASKED : '' };
  }
  return s;
}


// 设置校验：/api/settings 与 /api/import 共用，防止导入绕过间隔下限
// （intervalSeconds=0 会变成请求风暴，直接破坏低打扰约束）
function validateSettings(input, existing = store.DEFAULT_CONFIG.settings) {
  const next = { ...existing };
  const numeric = ['intervalSeconds', 'jitterSeconds', 'minIntervalSeconds', 'retryOnHitSeconds', 'retryOnHitMaxMinutes', 'historyDays'];
  for (const key of numeric) {
    if (input[key] === undefined) continue;
    const v = Number(input[key]);
    if (!Number.isFinite(v) || v < 0) return { error: `${key} 必须是非负数字` };
    next[key] = v;
  }
  if (!Number.isFinite(next.intervalSeconds) || next.intervalSeconds < 60) {
    return { error: '查询间隔不得小于 60 秒（避免高频请求触发风控）' };
  }
  if (next.minIntervalSeconds > next.intervalSeconds) next.minIntervalSeconds = next.intervalSeconds;
  for (const key of ['notifyOnHit', 'notifyRecovery']) {
    if (input[key] !== undefined) next[key] = Boolean(input[key]);
  }
  if (input.quietHours && typeof input.quietHours === 'object') {
    next.quietHours = {
      enabled: Boolean(input.quietHours.enabled),
      start: String(input.quietHours.start || '23:30'),
      end: String(input.quietHours.end || '06:30'),
    };
  }
  if (input.token !== undefined && input.token !== notifier.MASKED) next.token = String(input.token || '');

  // WebDAV：单独校验，密码用与渠道一致的掩码语义（提交掩码=保留原值）
  if (input.webdav !== undefined) {
    if (typeof input.webdav !== 'object' || input.webdav === null) {
      return { error: 'webdav 配置格式不正确' };
    }
    const prev = (existing && existing.webdav) || store.DEFAULT_CONFIG.settings.webdav;
    const w = { ...prev, ...input.webdav };
    w.enabled = Boolean(w.enabled);
    w.autoBackup = Boolean(w.autoBackup);
    w.url = String(w.url || '').trim();
    w.username = String(w.username || '').trim();
    w.path = String(w.path || 'ticket-monitor').trim().replace(/^\/+|\/+$/g, '') || 'ticket-monitor';
    const keep = Number(w.keep);
    w.keep = Number.isFinite(keep) ? Math.min(100, Math.max(1, Math.floor(keep))) : 20;
    if (w.password === notifier.MASKED) w.password = prev.password || '';
    else w.password = String(w.password || '');
    if (w.enabled) {
      if (!w.url) return { error: '启用 WebDAV 需填写地址' };
      try {
        dav.normalizeBase(w.url);
      } catch (err) {
        return { error: `WebDAV 地址无效：${err.message}` };
      }
      if (!w.username) return { error: '启用 WebDAV 需填写用户名' };
      if (!w.password) return { error: '启用 WebDAV 需填写密码（留空会无法连接）' };
      // 路径不能含 .. ，避免写到用户目录之外
      if (w.path.split('/').some((seg) => seg === '..')) return { error: 'WebDAV 路径不能包含 ..' };
    }
    next.webdav = w;
  }
  return { settings: next };
}

// lenient=true 用于「导入 / 从备份恢复」：日期不合法（已过期、超预售期）不阻断整份恢复，
// 而是降级为警告并跳过该任务。备份往往在数天后才恢复，硬阻断会让整个功能不可用。
function validateWatch(input, { lenient = false } = {}) {
  const errors = [];
  const warnings = [];
  const date = String(input.date || '').trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) errors.push('日期格式应为 YYYY-MM-DD');
  else {
    // 本地先挡住超出预售期的日期：这种请求官方必定 302 拒绝，
    // 提前拦下既省一次无谓请求，也给用户明确原因。
    const day = new Date(`${date}T00:00:00`);
    if (Number.isNaN(day.getTime())) errors.push('日期无效');
    else {
      const now = new Date();
      const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate());
      const diffDays = Math.round((day - todayStart) / 86400000);
      if (diffDays < 0) {
        if (lenient) warnings.push('日期已过期，已跳过该任务');
        else errors.push('不能监控已过去的日期');
      } else if (diffDays > PRESALE_DAYS) {
        const latest = new Date(todayStart.getTime() + PRESALE_DAYS * 86400000);
        if (lenient) warnings.push(`日期超出预售期（最远 ${fmtDay(latest)}），已跳过该任务`);
        else errors.push(`日期超出预售期：12306 一般只售 ${PRESALE_DAYS} 天内的车票，最远可查 ${fmtDay(latest)}`);
      }
    }
  }
  if (!input.from) errors.push('出发站必填');
  if (!input.to) errors.push('到达站必填');
  const seats = Array.isArray(input.seats) ? input.seats.filter(Boolean) : [];
  if (!seats.length) errors.push('至少选择一个席别');
  const known = client.emptyTickets();
  const unknown = seats.filter((s) => !(s in known));
  if (unknown.length) errors.push(`未知席别：${unknown.join('、')}`);

  // 三个筛选维度彼此独立、可任选启用，也可全部不启用；启用后互相叠加（AND）
  const trains = (Array.isArray(input.trains) ? input.trains : []).map((t) => String(t).trim()).filter(Boolean);

  const timeEnabled = Boolean(input.timeEnabled);
  const timeFrom = normalizeHhmm(input.timeFrom);
  const timeTo = normalizeHhmm(input.timeTo);
  if (input.timeFrom && timeFrom === null) errors.push('出发时段起始时间格式应为 HH:MM');
  if (input.timeTo && timeTo === null) errors.push('出发时段结束时间格式应为 HH:MM');
  if (timeEnabled && timeFrom === null && timeTo === null) {
    errors.push('已启用「出发时段」筛选，请至少填写起始或结束时间');
  }
  if (timeEnabled && timeFrom !== null && timeTo !== null && timeFrom === timeTo) {
    errors.push('出发时段的起始与结束时间相同，这会把所有车次都排除，请修改');
  }

  const priceMin = input.priceMin === '' || input.priceMin === undefined || input.priceMin === null ? null : Number(input.priceMin);
  const priceMax = input.priceMax === '' || input.priceMax === undefined || input.priceMax === null ? null : Number(input.priceMax);
  const priceEnabled = Boolean(input.priceEnabled);
  if (priceMin !== null && (!Number.isFinite(priceMin) || priceMin < 0)) errors.push('最低票价应为非负数字');
  if (priceMax !== null && (!Number.isFinite(priceMax) || priceMax < 0)) errors.push('最高票价应为非负数字');
  if (priceMin !== null && priceMax !== null && priceMin > priceMax) errors.push('最低票价不能大于最高票价');
  if (priceEnabled && priceMin === null && priceMax === null) {
    errors.push('已启用「票价」筛选，请至少填写最低或最高票价');
  }

  // 站点匹配方式：默认「精确」（只保留所选站点的车次）。
  // 上游按城市返回，选「盐城」会带出「盐城大丰」的车次，同一车次出现两次。
  const exactStation = input.exactStation === undefined ? true : Boolean(input.exactStation);

  // 历时：用分钟存，前端填「4:30」这样的 HH:MM，也允许纯数字小时（"4" == 4 小时）
  const durationEnabled = Boolean(input.durationEnabled);
  const durationMin = normalizeDuration(input.durationMin);
  const durationMax = normalizeDuration(input.durationMax);
  if (input.durationMin && durationMin === null) errors.push('最短历时格式应为 HH:MM（如 4:30）');
  if (input.durationMax && durationMax === null) errors.push('最长历时格式应为 HH:MM（如 10:00）');
  if (durationEnabled && durationMin === null && durationMax === null) {
    errors.push('已启用「历时」筛选，请至少填写最短或最长历时');
  }
  if (durationMin !== null && durationMax !== null && durationMin > durationMax) {
    errors.push('最短历时不能大于最长历时');
  }
  if (durationMin !== null && durationMax !== null && durationMin === durationMax) {
    errors.push('最短与最长历时相同，这会把所有车次都排除，请修改');
  }

  return {
    errors, warnings, date, seats, trains,
    timeEnabled, timeFrom, timeTo, priceEnabled, priceMin, priceMax,
    durationEnabled, durationMin, durationMax,
    exactStation,
  };
}

// 历时输入解析：支持 "4:30"、"4"（4 小时）、"270"（分钟）
function normalizeDuration(value) {
  if (value === undefined || value === null || value === '') return null;
  const raw = String(value).trim();
  if (/^\d{1,3}$/.test(raw)) {
    // 纯数字：<= 24 视为小时，否则视为分钟（用户写 270 通常指分钟）
    const n = Number(raw);
    return n <= 24 ? n * 60 : n;
  }
  const m = /^(\d{1,3}):(\d{1,2})$/.exec(raw);
  if (!m) return null;
  const min = Number(m[2]);
  if (min > 59) return null;
  const total = Number(m[1]) * 60 + min;
  if (total <= 0 || total > 72 * 60) return null;
  return total;
}

function normalizeHhmm(value) {
  if (value === undefined || value === null || value === '') return null;
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(value).trim());
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (h > 23 || min > 59) return null;
  return `${String(h).padStart(2, '0')}:${String(min).padStart(2, '0')}`;
}

async function buildWatch(input, existing = {}, { lenient = false } = {}) {
  const {
    errors, warnings, date, seats, trains,
    timeEnabled, timeFrom, timeTo, priceEnabled, priceMin, priceMax,
    durationEnabled, durationMin, durationMax,
    exactStation,
  } = validateWatch(input, { lenient });
  if (errors.length) return { errors };
  if (lenient && warnings && warnings.length) {
    // 日期不可用：跳过该任务，但让调用方知道原因
    return { skipped: warnings[0], errors: [] };
  }
  if (!monitor.stations && !(await monitor.loadStations())) {
    return { errors: ['车站表尚未加载成功，请稍后重试'] };
  }
  const fromStation = client.resolveStation(input.from, monitor.stations);
  const toStation = client.resolveStation(input.to, monitor.stations);
  if (!fromStation) errors.push(`无法识别的出发站：${input.from}`);
  if (!toStation) errors.push(`无法识别的到达站：${input.to}`);
  if (fromStation && toStation && fromStation.code === toStation.code) errors.push('出发站与到达站不能相同');
  if (errors.length) return { errors };

  return {
    watch: {
      id: existing.id || store.newId('w'),
      from: fromStation.name,
      to: toStation.name,
      fromCode: fromStation.code,
      toCode: toStation.code,
      fromName: fromStation.name,
      toName: toStation.name,
      date,
      trains: trains.map((t) => t.toUpperCase()),
      seats,
      // 三个维度独立生效、互相叠加；不启用时存 null，避免残留值造成误解
      timeEnabled: timeEnabled && (timeFrom !== null || timeTo !== null),
      timeFrom: timeEnabled ? timeFrom : null,
      timeTo: timeEnabled ? timeTo : null,
      priceEnabled: priceEnabled && (priceMin !== null || priceMax !== null),
      priceMin: priceEnabled ? priceMin : null,
      priceMax: priceEnabled ? priceMax : null,
      durationEnabled: durationEnabled && (durationMin !== null || durationMax !== null),
      durationMin: durationEnabled ? durationMin : null,
      durationMax: durationEnabled ? durationMax : null,
      exactStation,
      enabled: input.enabled !== false,
      createdAt: existing.createdAt || Date.now(),
      updatedAt: Date.now(),
    },
  };
}

function mergeChannel(input, existing = {}, { allowMissingSecret = false } = {}) {
  const type = input.type || existing.type;
  const def = notifier.TYPES.find((t) => t.type === type);
  if (!def) return { errors: [`不支持的渠道类型：${type}`] };
  const channel = { id: existing.id || store.newId('c'), type, name: input.name || existing.name || def.label, enabled: input.enabled !== false };
  const errors = [];
  const missingSecrets = [];
  for (const field of def.fields) {
    let value = input[field.key];
    const wasMasked = value === notifier.MASKED;
    if (value === undefined) value = existing[field.key];
    // 掩码 = 「保持原值」。导入时若匹配不到原值，记为缺失而不是直接报错，
    // 这样「导出（掩码）→ 导入」在同一个实例上仍能还原渠道。
    if (wasMasked) value = existing[field.key];
    if (value === undefined || value === '') value = field.default || '';
    if (field.required && !value) {
      if (allowMissingSecret) missingSecrets.push(`${def.label}：${field.label}`);
      else errors.push(`${def.label}：${field.label} 必填`);
    }
    channel[field.key] = value;
  }
  return { errors, channel, missingSecrets };
}

const routes = [
  ['GET', /^\/api\/state$/, async (req, res) => {
    sendJson(res, 200, { state: monitor.snapshot(), events: monitor.recentEvents(100), logs: logger.recent(60) });
  }],

  ['GET', /^\/api\/events$/, async (req, res) => {
    sendJson(res, 200, { events: monitor.recentEvents(150) });
  }],

  ['GET', /^\/api\/stream$/, async (req, res) => {
    if (sseClients.size >= MAX_SSE_CLIENTS) {
      return sendJson(res, 503, { error: '事件流连接数已达上限' });
    }
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    res.write(`event: state\ndata: ${JSON.stringify(monitor.snapshot())}\n\n`);
    sseClients.add(res);
    const keepAlive = setInterval(() => {
      try {
        res.write(': ping\n\n');
      } catch (err) {
        clearInterval(keepAlive);
      }
    }, 25000);
    const cleanup = () => {
      clearInterval(keepAlive);
      sseClients.delete(res);
    };
    req.on('close', cleanup);
    // 半关闭/写失败也必须清理，否则 sseClients 会持续泄漏
    res.on('error', cleanup);
    res.on('close', cleanup);
  }],

  ['GET', /^\/api\/config$/, async (req, res) => {
    sendJson(res, 200, {
      settings: publicSettings(),
      watches: config.watches,
      channels: channelsForClient(),
      meta: {
        seatOptions: Object.keys(client.emptyTickets()),
        channelTypes: notifier.TYPES,
        stationCount: monitor.stations ? monitor.stations.length : 0,
      },
    });
  }],

  ['GET', /^\/api\/stations$/, async (req, res, m, url) => {
    const q = url.searchParams.get('q') || '';
    if (!monitor.stations && !(await monitor.loadStations())) {
      return sendJson(res, 503, { error: monitor.stationError || '车站表未加载' });
    }
    sendJson(res, 200, { items: client.searchStations(q, monitor.stations, 12) });
  }],

  ['POST', /^\/api\/watches$/, async (req, res) => {
    const body = await readBody(req);
    const { errors, watch } = await buildWatch(body);
    if (errors && errors.length) return sendJson(res, 400, { errors });
    config.watches.push(watch);
    persist();
    monitor.createEvent('info', `新增监控任务：${watch.fromName}→${watch.toName} ${watch.date}`);
    // 走 checkNow 而非 checkWatch：前者经过 inFlight 串行闸门，
    // 避免新建任务与正在进行的调度轮次并发请求上游
    monitor.checkNow(watch.id).catch((err) => logger.error(`新建后查询失败：${err.message}`));
    sendJson(res, 200, { watch });
  }],

  ['PUT', /^\/api\/watches\/([\w-]+)$/, async (req, res, m) => {
    const idx = config.watches.findIndex((w) => w.id === m[1]);
    if (idx < 0) return sendJson(res, 404, { error: '任务不存在' });
    const body = await readBody(req);
    const existing = config.watches[idx];
    const { errors, watch } = await buildWatch({ ...existing, ...body }, existing);
    if (errors && errors.length) return sendJson(res, 400, { errors });

    // 目的地/日期/席别/筛选变了，旧结果就不再对应当前条件，
    // 必须清掉并立即重查，否则页面会把上一个目的地的车次显示在新标题下。
    const conditionChanged = ['fromCode', 'toCode', 'date', 'trains', 'seats', 'exactStation',
      'timeEnabled', 'timeFrom', 'timeTo', 'priceEnabled', 'priceMin', 'priceMax',
      'durationEnabled', 'durationMin', 'durationMax']
      .some((k) => JSON.stringify(existing[k]) !== JSON.stringify(watch[k]));

    config.watches[idx] = watch;
    persist();

    if (conditionChanged) {
      // 清掉过期结果，避免“新标题 + 旧数据”的错配窗口
      monitor.states.delete(watch.id);
      monitor.createEvent('info', `监控条件已更新：${watch.fromName}→${watch.toName} ${watch.date}，重新查询中`);
      if (watch.enabled !== false) {
        monitor.checkNow(watch.id).catch((err) => logger.error(`更新后重查失败：${err.message}`));
      }
    }
    sendJson(res, 200, { watch, requerying: conditionChanged });
  }],

  ['DELETE', /^\/api\/watches\/([\w-]+)$/, async (req, res, m) => {
    const before = config.watches.length;
    const removed = config.watches.find((w) => w.id === m[1]);
    config.watches = config.watches.filter((w) => w.id !== m[1]);
    if (config.watches.length === before) return sendJson(res, 404, { error: '任务不存在' });
    monitor.states.delete(m[1]);
    persist();
    monitor.createEvent('info', `删除监控任务：${removed.fromName}→${removed.toName} ${removed.date}`);
    sendJson(res, 200, { ok: true });
  }],

  ['POST', /^\/api\/watches\/([\w-]+)\/check$/, async (req, res, m) => {
    try {
      const snapshot = await monitor.checkNow(m[1]);
      sendJson(res, 200, { result: snapshot });
    } catch (err) {
      // 退避中被拒：用 429 明确语义，并带 Retry-After 让前端能提示等待时间
      if (err && err.code === 'BACKOFF') {
        res.setHeader('Retry-After', String(err.retryAfterSeconds || 60));
        return sendJson(res, 429, { error: err.message, retryAfterSeconds: err.retryAfterSeconds });
      }
      sendJson(res, 400, { error: err.message });
    }
  }],

  ['POST', /^\/api\/check-all$/, async (req, res) => {
    const results = await monitor.checkNow(null);
    sendJson(res, 200, { results });
  }],

  ['POST', /^\/api\/settings$/, async (req, res) => {
    const body = await readBody(req);
    const { settings, error } = validateSettings({ ...config.settings, ...body }, config.settings);
    if (error) return sendJson(res, 400, { error });
    config.settings = settings;
    persist();
    // 间隔/抖动改了要立刻重排，否则新值要等当前这一轮旧间隔走完才生效
    monitor.reschedule();
    sendJson(res, 200, { settings: publicSettings() });
  }],

  ['POST', /^\/api\/channels$/, async (req, res) => {
    const body = await readBody(req);
    const { errors, channel } = mergeChannel(body);
    if (errors && errors.length) return sendJson(res, 400, { errors });
    config.channels.push(channel);
    persist();
    sendJson(res, 200, { channel: notifier.mask(channel) });
  }],

  ['PUT', /^\/api\/channels\/([\w-]+)$/, async (req, res, m) => {
    const idx = config.channels.findIndex((c) => c.id === m[1]);
    if (idx < 0) return sendJson(res, 404, { error: '渠道不存在' });
    const body = await readBody(req);
    const { errors, channel } = mergeChannel({ ...config.channels[idx], ...body }, config.channels[idx]);
    if (errors && errors.length) return sendJson(res, 400, { errors });
    config.channels[idx] = channel;
    persist();
    sendJson(res, 200, { channel: notifier.mask(channel) });
  }],

  ['DELETE', /^\/api\/channels\/([\w-]+)$/, async (req, res, m) => {
    const before = config.channels.length;
    config.channels = config.channels.filter((c) => c.id !== m[1]);
    if (config.channels.length === before) return sendJson(res, 404, { error: '渠道不存在' });
    persist();
    sendJson(res, 200, { ok: true });
  }],

  ['POST', /^\/api\/channels\/([\w-]+)\/test$/, async (req, res, m) => {
    const channel = config.channels.find((c) => c.id === m[1]);
    if (!channel) return sendJson(res, 404, { error: '渠道不存在' });
    const r = await monitor.testChannel(channel);
    if (!r.ok) monitor.createEvent('pushfail', `测试推送失败 [${channel.name || channel.type}]：${r.error}`);
    else monitor.createEvent('info', `测试推送成功 [${channel.name || channel.type}]`);
    sendJson(res, 200, r);
  }],

  ['POST', /^\/api\/channels\/test-draft$/, async (req, res) => {
    const body = await readBody(req);
    const existing = config.channels.find((c) => c.id === body.id) || {};
    const { errors, channel } = mergeChannel(body, existing);
    if (errors && errors.length) return sendJson(res, 400, { errors });
    const r = await monitor.testChannel(channel);
    sendJson(res, 200, r);
  }],

  ['POST', /^\/api\/monitor\/(start|stop)$/, async (req, res, m) => {
    if (m[1] === 'start') await monitor.start();
    else monitor.stop();
    sendJson(res, 200, { running: monitor.running });
  }],

  ['POST', /^\/api\/stations\/refresh$/, async (req, res) => {
    const ok = await monitor.loadStations();
    sendJson(res, ok ? 200 : 502, { ok, count: monitor.stations ? monitor.stations.length : 0, error: monitor.stationError });
  }],

  // 经停站：按需查询（用户点击车次时触发），不进轮询，避免请求放大
  ['POST', /^\/api\/trains\/stops$/, async (req, res) => {
    const body = await readBody(req);
    const { watchId, trainNo } = body;
    if (!trainNo) return sendJson(res, 400, { error: '缺少车次内部编号' });

    // 日期与站点码优先从任务本身取：前端不必（也不应该）自己拼这些参数，
    // 顺带避免把任意区间传给官方接口。
    let f = body.fromCode;
    let t = body.toCode;
    let date = body.date;
    if (watchId) {
      const watch = (config.watches || []).find((w) => w.id === watchId);
      if (!watch) return sendJson(res, 404, { error: '任务不存在' });
      date = date || watch.date;
      if (!monitor.stations && !(await monitor.loadStations())) {
        return sendJson(res, 503, { error: '车站表未加载，无法解析站点' });
      }
      const resolved = monitor.resolveCodes(watch);
      f = resolved.fromCode || f;
      t = resolved.toCode || t;
    }
    if (!date) return sendJson(res, 400, { error: '缺少乘车日期' });
    if (!f || !t) return sendJson(res, 400, { error: '缺少出发/到达站点' });

    try {
      const result = await client.queryTrainStops({ trainNo, date, fromCode: f, toCode: t });
      sendJson(res, 200, { ok: true, ...result });
    } catch (err) {
      sendJson(res, 200, { ok: false, error: err.message });
    }
  }],

  // ---- WebDAV 配置备份 ----
  ['POST', /^\/api\/webdav\/test$/, async (req, res) => {
    const body = await readBody(req);
    const target = resolveDavTarget(body);
    if (target.error) return sendJson(res, 400, { error: target.error });
    try {
      const info = await dav.testConnection(target.conn);
      let backups = null;
      try {
        backups = await dav.listBackups(target.conn);
      } catch (err) {
        // 目录还不存在属正常，不算连接失败
        backups = null;
      }
      sendJson(res, 200, { ok: true, dav: info.dav, backups });
    } catch (err) {
      sendJson(res, 200, { ok: false, error: err.message, hint: err.hint });
    }
  }],

  ['POST', /^\/api\/webdav\/backup$/, async (req, res) => {
    const body = await readBody(req);
    const target = resolveDavTarget(body);
    if (target.error) return sendJson(res, 400, { error: target.error });
    try {
      const payload = dav.buildExportPayload(config, notifier.MASKED);
      const result = await dav.upload(target.conn, payload, { keep: target.keep });
      const when = new Date().toLocaleString('zh-CN', { hour12: false });
      config.settings.webdav.lastBackupAt = Date.now();
      config.settings.webdav.lastBackupName = result.name;
      persist();
      monitor.createEvent('info', `配置已备份到 WebDAV：${result.name}`);
      sendJson(res, 200, { ok: true, ...result, at: when });
    } catch (err) {
      monitor.createEvent('pushfail', `WebDAV 备份失败：${err.message}`);
      sendJson(res, 200, { ok: false, error: err.message, hint: err.hint });
    }
  }],

  ['GET', /^\/api\/webdav\/backups$/, async (req, res) => {
    const target = resolveDavTarget({});
    if (target.error) return sendJson(res, 400, { error: target.error });
    try {
      const items = await dav.listBackups(target.conn);
      sendJson(res, 200, { ok: true, items });
    } catch (err) {
      sendJson(res, 200, { ok: false, error: err.message, hint: err.hint });
    }
  }],

  ['POST', /^\/api\/webdav\/restore$/, async (req, res) => {
    const body = await readBody(req);
    const target = resolveDavTarget(body);
    if (target.error) return sendJson(res, 400, { error: target.error });
    if (!body.name) return sendJson(res, 400, { error: '缺少要恢复的备份文件名' });

    // 恢复会整体替换本地配置，风险高：先把当前配置落一份本地备份
    const snapshotName = `config-before-restore-${Date.now()}.json`;
    let snapshotPath = null;
    try {
      snapshotPath = path.join(store.DATA_DIR, snapshotName);
      // 快照含令牌与 WebDAV 密码明文，与 config.json 同样收紧为 0600
      fs.writeFileSync(snapshotPath, JSON.stringify(config, null, 2), { mode: 0o600 });
      fs.chmodSync(snapshotPath, 0o600);
    } catch (err) {
      logger.warn(`恢复前的本地快照写入失败：${err.message}`);
      snapshotPath = null;
    }

    try {
      const payload = await dav.download(target.conn, body.name);

      // 任务逐条走校验，避免把坏数据灌进运行时
      const watches = [];
      const watchErrors = [];
      const skippedWatches = [];
      // 同 import：坏元素（null/字符串）直接进 buildWatch 会抛 TypeError 变成 500
      for (const raw of payload.watches.filter((x) => x && typeof x === 'object')) {
        const { errors, watch, skipped } = await buildWatch(raw, {}, { lenient: true });
        const label = `任务「${raw.from || '?'}→${raw.to || '?'}」`;
        if (skipped) skippedWatches.push(`${label}：${skipped}`);
        else if (errors && errors.length) watchErrors.push(`${label}：${errors.join('；')}`);
        else watches.push(watch);
      }
      // 结构性错误（缺站名等）仍中止；日期过期的任务跳过，不拖累其余配置
      if (watchErrors.length) {
        return sendJson(res, 400, { error: '备份中的任务未通过校验，已中止恢复', errors: watchErrors.slice(0, 10) });
      }
      if (!watches.length && payload.watches.length) {
        return sendJson(res, 400, {
          error: '备份中的任务全部不可用（日期均已过期或超出预售期），恢复没有意义',
          errors: skippedWatches.slice(0, 10),
        });
      }

      const sv = validateSettings({ ...store.DEFAULT_CONFIG.settings, ...(payload.settings || {}) }, config.settings);
      if (sv.error) return sendJson(res, 400, { error: `备份中的设置非法，已中止恢复：${sv.error}` });

      // 渠道：恢复本地已有密钥（备份里的密钥是掩码）
      const channels = [];
      const channelErrors = [];
      for (const raw of dav.mergeSecretsFromLocal(payload, config.channels || [])) {
        const { errors, channel } = mergeChannel(raw, {}, { allowMissingSecret: true });
        if (errors && errors.length) channelErrors.push(`${raw && raw.type}：${errors.join('；')}`);
        else channels.push(channel);
      }
      if (channelErrors.length) {
        return sendJson(res, 400, { error: '备份中的渠道未通过校验，已中止恢复', errors: channelErrors.slice(0, 10) });
      }

      config = { version: 1, settings: { ...sv.settings, webdav: config.settings.webdav }, watches, channels };
      persist();
      monitor.states.clear();
      monitor.createEvent('info', `已从 WebDAV 恢复配置：${body.name}（${watches.length} 个任务）`);
      sendJson(res, 200, {
        ok: true,
        watches: watches.length,
        channels: channels.length,
        localSnapshot: snapshotPath ? snapshotName : null,
        warnings: skippedWatches,
      });
    } catch (err) {
      sendJson(res, 200, { ok: false, error: err.message, hint: err.hint });
    }
  }],

  ['GET', /^\/api\/export$/, async (req, res) => {
    // 导出用于备份/迁移，但绝不能把密钥与令牌原样回给调用方：
    // 与 /api/config 保持同一口径，一律掩码。
    sendJson(res, 200, {
      version: config.version,
      settings: publicSettings(),
      watches: config.watches,
      channels: channelsForClient(),
    });
  }],

  ['POST', /^\/api\/import$/, async (req, res) => {
    const body = await readBody(req);
    if (!body || typeof body !== 'object' || !Array.isArray(body.watches)) {
      return sendJson(res, 400, { error: '配置文件格式不正确（缺少 watches 数组）' });
    }
    // 导入不能绕过校验：settings 走 /api/settings 同一套约束（否则 0 秒间隔
    // 会直接变成请求风暴），watches 与 channels 逐条重建。
    const nextSettings = { ...store.DEFAULT_CONFIG.settings, ...(body.settings || {}) };
    // 基线必须是「当前生效的配置」而非默认值：导出文件里令牌/WebDAV 密码是 ******，
    // 只有以当前设置为基线才能把掩码解析回真实值；传默认值会静默清空令牌。
    const sv = validateSettings(nextSettings, config.settings);
    if (sv.error) return sendJson(res, 400, { error: `settings 非法：${sv.error}` });

    const importedWatches = [];
    const watchErrors = [];
    const skipped = [];
    // 备份文件可能被手工改坏：元素为 null/字符串时不能直接进 buildWatch（会 500）
    const rawWatches = body.watches.filter((raw) => raw && typeof raw === 'object');
    if (rawWatches.length !== body.watches.length) {
      watchErrors.push(`备份中有 ${body.watches.length - rawWatches.length} 条任务不是对象，已忽略`);
    }
    for (const raw of rawWatches) {
      const { errors, watch, skipped: skipReason } = await buildWatch(raw, {}, { lenient: true });
      const label = `任务「${raw && (raw.fromName || raw.from)}→${raw && (raw.toName || raw.to)}」`;
      if (skipReason) skipped.push(`${label}：${skipReason}`);
      else if (errors && errors.length) watchErrors.push(`${label}：${errors.join('；')}`);
      else importedWatches.push(watch);
    }
    // 结构性错误仍要拒绝；只是「日期不可用」这类的任务被跳过
    if (watchErrors.length) return sendJson(res, 400, { errors: watchErrors.slice(0, 10) });
    // 备份里的任务全部不可用：不要静默清空用户配置，明确报错
    if (!importedWatches.length && body.watches.length) {
      return sendJson(res, 400, {
        errors: ['导入的任务全部不可用（日期均已过期或超出预售期），已取消导入以免清空现有配置'],
        warnings: skipped.slice(0, 10),
      });
    }

    const importedChannels = [];
    const channelErrors = [];
    const warnings = [];
    for (const raw of (Array.isArray(body.channels) ? body.channels : [])) {
      // 掩码密钥要还原：优先按 id 找原渠道，其次按 type+name
      const sameId = (config.channels || []).find((c) => c.id === raw.id);
      const sameName = (config.channels || []).find((c) => c.type === raw.type && c.name === raw.name);
      const { errors, channel, missingSecrets } = mergeChannel(raw, sameId || sameName || {}, { allowMissingSecret: true });
      if (errors && errors.length) { channelErrors.push(`${raw && raw.type}：${errors.join('；')}`); continue; }
      if (missingSecrets && missingSecrets.length) {
        warnings.push(`渠道「${channel.name}」缺少密钥（${missingSecrets.join('、')}），已导入但需手工补填后才能推送`);
      }
      importedChannels.push(channel);
    }
    if (channelErrors.length) return sendJson(res, 400, { errors: channelErrors.slice(0, 10) });

    config = {
      version: 1,
      settings: sv.settings,
      watches: importedWatches,
      channels: importedChannels,
    };
    persist();
    // 清空运行时状态后按新任务重建，避免残留旧任务的命中/退避状态
    monitor.states.clear();
    if (monitor.running) {
      for (const w of importedWatches) monitor.stateFor(w.id);
    }
    monitor.createEvent('info', `导入配置：${importedWatches.length} 个任务 / ${importedChannels.length} 个渠道`
      + (skipped.length ? `，跳过 ${skipped.length} 个不可用任务` : ''));
    sendJson(res, 200, {
      ok: true,
      watches: config.watches.length,
      channels: config.channels.length,
      warnings: [...warnings, ...skipped],
    });
  }],
];

// 组装 WebDAV 连接参数：请求体给了就用请求体的（便于保存前先测试），
// 密码为掩码或未提供时回落到已保存的值。
function resolveDavTarget(body = {}) {
  const saved = config.settings.webdav || store.DEFAULT_CONFIG.settings.webdav;
  const input = body.webdav || {};
  const merged = { ...saved, ...input };
  if (!merged.password || merged.password === notifier.MASKED) merged.password = saved.password || '';
  if (!merged.url) return { error: '未配置 WebDAV 地址' };
  if (!merged.username) return { error: '未配置 WebDAV 用户名' };
  if (!merged.password) return { error: '未配置 WebDAV 密码' };
  const keep = Number(merged.keep);
  return {
    conn: {
      url: merged.url,
      username: merged.username,
      password: merged.password,
      path: merged.path,
    },
    keep: Number.isFinite(keep) ? Math.min(100, Math.max(1, Math.floor(keep))) : 20,
  };
}

async function handleApi(req, res, url) {
  for (const [method, pattern, handler] of routes) {
    if (req.method !== method) continue;
    const m = url.pathname.match(pattern);
    if (m) {
      await handler(req, res, m, url);
      return true;
    }
  }
  return false;
}

function serveStatic(req, res, url) {
  let rel = url.pathname === '/' ? '/index.html' : url.pathname;
  rel = path.normalize(rel).replace(/^(\.\.[/\\])+/, '');
  const file = path.join(PUBLIC_DIR, rel);
  // 用「目录 + 分隔符」比较：裸前缀会让 /app/public2 这类同前缀兄弟目录通过
  if (file !== PUBLIC_DIR && !file.startsWith(PUBLIC_DIR + path.sep)) {
    res.writeHead(403);
    return res.end('forbidden');
  }
  fs.readFile(file, (err, data) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      return res.end('not found');
    }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
    res.end(data);
  });
}

const server = http.createServer((req, res) => {
  // 整个处理链都在 try 里：new URL 会因畸形请求行或 Host（如 "a b"）
  // 抛 ERR_INVALID_URL。若在 try 之外抛出，async 处理器会变成未处理 rejection，
  // Node 默认直接终止进程 —— 一个请求头就能打崩服务。
  handleRequest(req, res).catch((err) => {
    // 带 statusCode 的是「已识别的客户端错误」（如请求体不是 JSON 对象），
    // 不该被记成 500：既误导排查，也让客户端无法区分该不该重试。
    const code = Number(err && err.statusCode) || 0;
    if (code >= 400 && code < 500) {
      logger.warn(`请求被拒绝 ${req.method} ${req.url}：${err.message}`);
      if (!res.headersSent) sendJson(res, code, { error: err.message });
      return;
    }
    logger.error(`请求处理失败 ${req.method} ${req.url}：${err.message}`);
    if (!res.headersSent) sendJson(res, 500, { error: '服务器内部错误' });
    else res.end();
  });
});

async function handleRequest(req, res) {
  let url;
  try {
    url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  } catch (err) {
    // 非法请求行 / Host：直接 400，不进入业务逻辑
    sendJson(res, 400, { error: '请求地址或 Host 头不合法' });
    return;
  }

  if (url.pathname === '/health') {
    return sendJson(res, 200, {
      ok: true,
      running: monitor.running,
      watches: (config.watches || []).length,
      stations: monitor.stations ? monitor.stations.length : 0,
      time: new Date().toISOString(),
    });
  }
  if (url.pathname.startsWith('/api/')) {
    if (!authorized(req, url)) return sendJson(res, 401, { error: '访问令牌无效' });
    const handled = await handleApi(req, res, url);
    if (!handled) sendJson(res, 404, { error: '接口不存在' });
    return;
  }
  serveStatic(req, res, url);
}

async function bootstrap() {
  const autoStart = String(process.env.AUTO_START || 'true') !== 'false';
  const stationsOk = await monitor.loadStations().catch(() => false);
  if (!stationsOk) logger.warn('启动时车站表加载失败，将在首次查询时重试');
  server.listen(PORT, HOST, () => {
    logger.info(`火车票余票监控已启动：http://${HOST}:${PORT}`);
    logger.info(`数据目录：${store.DATA_DIR}`);
    // 容器里必须监听 0.0.0.0 才能端口映射；这属于有意为之，
    // 但若同时没设访问令牌，等于整个局域网都能改配置，必须明说。
    if (HOST === '0.0.0.0' && !config.settings.token) {
      logger.warn('当前未设置访问令牌，且监听所有网卡：同一网络内任何人都能访问与修改配置。');
      logger.warn('仅建议在可信内网使用；如需防护请在「设置」页填写访问令牌。');
    }
    if (autoStart) {
      monitor.start().catch((err) => logger.error(`启动监控失败：${err.message}`));
    } else {
      logger.info('AUTO_START=false，监控未自动启动');
    }
  });
}

if (require.main === module) {
  bootstrap();
}

module.exports = { server, monitor, bootstrap, getConfig: () => config };
