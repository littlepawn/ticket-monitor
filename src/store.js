'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
const MASKED = '******';
const FILE = path.join(DATA_DIR, 'config.json');

const DEFAULT_CONFIG = {
  version: 1,
  settings: {
    intervalSeconds: 900,
    jitterSeconds: 120,
    minIntervalSeconds: 300,
    quietHours: { enabled: false, start: '23:30', end: '06:30' },
    notifyOnHit: true,
    retryOnHitSeconds: 60,
    retryOnHitMaxMinutes: 10,
    notifyRecovery: true,
    historyDays: 30,
    token: '',
    // WebDAV 配置备份（默认关闭；开启后需填地址与账号）
    webdav: {
      enabled: false,
      url: '',
      username: '',
      password: '',
      path: 'ticket-monitor',
      autoBackup: false,
      keep: 20,
    },
  },
  watches: [],
  channels: [],
};

function ensureDir() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

// 旧版任务只有 timeFrom/timeTo、priceMin/priceMax，没有独立的启用开关。
// 新版按开关判断是否过滤，因此必须把「填过值」迁移成「已启用」，
// 否则升级后老任务的筛选会静默失效（用户不会收到任何提示）。
function migrateWatch(watch) {
  if (!watch || typeof watch !== 'object') return watch;
  const w = { ...watch };
  if (w.timeEnabled === undefined) {
    w.timeEnabled = Boolean(w.timeFrom || w.timeTo);
  }
  if (w.priceEnabled === undefined) {
    // 不能直接用 Number.isFinite：表单值历史上可能是字符串（"100"），
    // Number.isFinite('100') 为 false，会被误判成「没填过价格」而静默关掉筛选。
    // 注意 Number(null)===0、Number('')===0 都不算「填过」，需先排除空值。
    const hasNum = (v) => v !== null && v !== undefined && v !== '' && Number.isFinite(Number(v));
    w.priceEnabled = hasNum(w.priceMin) || hasNum(w.priceMax);
    if (w.priceEnabled) {
      if (hasNum(w.priceMin)) w.priceMin = Number(w.priceMin);
      if (hasNum(w.priceMax)) w.priceMax = Number(w.priceMax);
    }
  }
  // 未启用的维度清掉残留值，避免页面上显示着却不起作用
  if (!w.timeEnabled) { w.timeFrom = null; w.timeTo = null; }
  if (!w.priceEnabled) { w.priceMin = null; w.priceMax = null; }
  // 历时：老配置没有该字段，默认关闭；字符串数值同样要能识别
  if (w.durationEnabled === undefined) {
    const hasNum = (v) => v !== null && v !== undefined && v !== '' && Number.isFinite(Number(v));
    w.durationEnabled = hasNum(w.durationMin) || hasNum(w.durationMax);
    if (w.durationEnabled) {
      if (hasNum(w.durationMin)) w.durationMin = Number(w.durationMin);
      if (hasNum(w.durationMax)) w.durationMax = Number(w.durationMax);
    }
  }
  if (!w.durationEnabled) { w.durationMin = null; w.durationMax = null; }
  // 站点匹配：默认精确（true）。老配置没有该字段，迁移时置 true。
  if (w.exactStation === undefined) w.exactStation = true;
  else w.exactStation = Boolean(w.exactStation);
  return w;
}

function load() {
  // 只读挂载 / 父目录不可写时 mkdirSync 会抛 EACCES。
  // 这里必须兜住：设计目标是「只读挂载下仍能查询，只是不持久化」，而不是启动即崩。
  try {
    ensureDir();
  } catch (err) {
    console.warn(`[store] 数据目录不可写（${err.code || err.message}）：本次以只读方式运行，改动不会持久化`);
  }
  // 不用 existsSync 判断：在绑定挂载（群晖 / Docker Desktop / OrbStack）下
  // stat 缓存与读取可能不一致，出现「存在但读不到」会让进程直接崩掉。
  // 一律以 readFileSync 的结果为准，读不到就当作首次启动。
  let raw;
  try {
    raw = fs.readFileSync(FILE, 'utf8');
  } catch (err) {
    // 只有「文件不存在」才算首次启动，可以安全落一份默认配置。
    // EACCES / EBUSY / EAGAIN 等是瞬时故障，此时磁盘上很可能有一份有效配置 ——
    // 若照样写默认值就会把用户的全部任务与渠道永久覆盖掉。
    if (err.code !== 'ENOENT') {
      readDegraded = true;
      console.error(`[store] 读取 config.json 失败（${err.code || err.message}），本次使用默认配置；`
        + '在重启前不会写盘，以免覆盖磁盘上可能仍有效的配置');
      return JSON.parse(JSON.stringify(DEFAULT_CONFIG));
    }
    const fresh = JSON.parse(JSON.stringify(DEFAULT_CONFIG));
    save(fresh);
    return fresh;
  }
  try {
    const data = JSON.parse(raw);
    return {
      version: 1,
      settings: Object.assign({}, DEFAULT_CONFIG.settings, data.settings || {}, {
        webdav: Object.assign({}, DEFAULT_CONFIG.settings.webdav, (data.settings && data.settings.webdav) || {}),
      }),
      watches: (Array.isArray(data.watches) ? data.watches : []).map(migrateWatch),
      channels: Array.isArray(data.channels) ? data.channels : [],
    };
  } catch (err) {
    // 备份失败也不能阻断启动
    try {
      const bak = `${FILE}.broken-${Date.now()}`;
      // 损坏备份同样含密钥，一并收紧权限
      fs.writeFileSync(bak, raw, { mode: 0o600 });
      console.error(`[store] config.json 解析失败，已备份到 ${bak}：${err.message}`);
    } catch (copyErr) {
      console.error(`[store] config.json 解析失败且备份失败：${err.message} / ${copyErr.message}`);
    }
    const fresh = JSON.parse(JSON.stringify(DEFAULT_CONFIG));
    save(fresh);
    return fresh;
  }
}

// 保存失败不能让进程退出：只读挂载 / 权限不足时，仍应能查询，
// 只是配置不持久化。这里把失败降级成告警，并让调用方能感知返回值。
let lastSaveError = null;
// 读配置失败（非 ENOENT）时置位：说明磁盘上可能有一份读不到的**有效**配置。
// 此时任何写入都可能把它覆盖掉，因此本次进程内一律拒绝写盘，
// 而不是只在 load() 那一次不写（后续 API 改动仍会 persist 覆盖）。
let readDegraded = false;

function isReadDegraded() {
  return readDegraded;
}

let degradedSaveLogged = false;

function save(config) {
  if (readDegraded) {
    lastSaveError = new Error('配置处于只读降级状态：启动时读取失败，禁止写盘以免覆盖磁盘上的有效配置');
    // 注意：_logged 必须挂在模块级变量上。挂在新建的 Error 上每次都是新对象，
    // 判断恒为 true，只读挂载时每条写入都会刷一遍多行日志。
    if (!degradedSaveLogged) {
      degradedSaveLogged = true;
      console.error('[store] 已拒绝写入：启动时读取 config.json 失败，本次运行不持久化任何改动，'
        + '以免覆盖磁盘上可能仍有效的配置。请检查数据目录权限后重启。');
    }
    return false;
  }
  try {
    ensureDir();
    // 带上 pid：万一有第二个实例挂同一个数据卷，也不会互相踩临时文件
    const tmp = `${FILE}.${process.pid}.tmp`;
    // 该文件含访问令牌与 WebDAV 密码明文，必须显式收紧权限：
    // writeFileSync 默认受 umask 影响（通常 0644），同主机其他用户可读。
    fs.writeFileSync(tmp, JSON.stringify(config, null, 2), { mode: 0o600 });
    fs.chmodSync(tmp, 0o600);
    fs.renameSync(tmp, FILE);
    lastSaveError = null;
    readDegraded = false;
    return true;
  } catch (err) {
    lastSaveError = err;
    if (lastSaveError && !lastSaveError._logged) {
      lastSaveError._logged = true;
      console.error(
        `[store] 配置写入失败（${err.code || err.message}）：${FILE}\n` +
        '[store] 服务会继续运行，但改动不会持久化。请检查数据目录的挂载与属主' +
        '（群晖示例：sudo chown -R 1000:1000 /volume1/docker/ticket-monitor/data）。',
      );
    }
    return false;
  }
}

function newId(prefix) {
  return `${prefix}_${crypto.randomBytes(4).toString('hex')}`;
}

module.exports = { DATA_DIR, FILE, DEFAULT_CONFIG, MASKED, load, save, newId, ensureDir, migrateWatch, isReadDegraded, getLastSaveError: () => lastSaveError };
