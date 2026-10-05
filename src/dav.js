'use strict';

/**
 * 零依赖 WebDAV 客户端 + 配置备份/恢复。
 *
 * 设计取舍：
 * - 只做「配置备份与恢复」，不做双向实时同步。双向同步会在多端同时改配置时
 *   产生冲突与静默覆盖，而本工具的配置里含推送密钥，覆盖错的代价很实在。
 * - 恢复前必须校验文件是我们导出的结构，并支持「先本地备份再恢复」。
 * - 凭据只存在服务端 config.json，API 一律掩码；不写进日志。
 */

const logger = require('./logger');
const store = require('./store');

const REQUEST_TIMEOUT_MS = 20000;
const MAX_BACKUPS = 20;

class DavError extends Error {
  constructor(message, opts = {}) {
    super(message);
    this.name = 'DavError';
    this.status = opts.status;
    this.hint = opts.hint;
  }
}

/* ---------- 基础请求 ---------- */

function basicAuth(user, pass) {
  return `Basic ${Buffer.from(`${user}:${pass}`).toString('base64')}`;
}

function normalizeBase(url) {
  const trimmed = String(url || '').trim();
  if (!trimmed) throw new DavError('未填写 WebDAV 地址');
  let parsed;
  try {
    parsed = new URL(trimmed);
  } catch (err) {
    throw new DavError('WebDAV 地址不是合法 URL', { hint: '示例：https://dav.jianguoyun.com/dav/' });
  }
  if (!/^https?:$/.test(parsed.protocol)) {
    throw new DavError('WebDAV 地址必须以 http:// 或 https:// 开头');
  }
  // SSRF 防护：备份地址由用户填写却由服务端发起请求，默认拦住回环、
  // 链路本地与云元数据等内网目标。
  // 但本项目的典型部署是群晖 NAS —— WebDAV 服务往往就在局域网里，
  // 一刀切会误杀真实场景，因此提供显式开关 DAV_ALLOW_PRIVATE_NET（默认关）。
  const host = (parsed.hostname || '').toLowerCase().replace(/^\[|\]$/g, '');
  if (!host) throw new DavError('WebDAV 地址缺少主机名');

  // 云元数据端点：即使开着局域网开关也永远拒绝 —— 这类地址能直接换取云凭证，
  // 与「备份到家里的 NAS」无关，没有任何放行理由。
  const METADATA = [
    '169.254.169.254', '169.254.170.2', 'fd00:ec2::254',
    'metadata.google.internal', 'metadata.goog', 'metadata',
    'instance-data', 'instance-data.ec2.internal',
  ];
  if (METADATA.includes(host) || host.endsWith('.internal')) {
    throw new DavError('不允许把云元数据地址作为 WebDAV 备份目标');
  }
  if (process.env.DAV_ALLOW_PRIVATE_NET === '1') return trimmed.replace(/\/+$/, '');
  if (blockedHost(host)) {
    throw new DavError('不允许把内网地址作为 WebDAV 备份目标', { hint: '若备份目标确在局域网（如群晖 NAS），请设置环境变量 DAV_ALLOW_PRIVATE_NET=1' });
  }
  return trimmed.replace(/\/+$/, '');
}

// 拼路径时逐段编码，避免目录名里的空格/中文导致 404
// 是否内网/不可路由地址（loopback、私有网段、链路本地、组播、本机名）
function blockedHost(host) {
  if (['localhost'].includes(host) || host.endsWith('.localhost') || host.endsWith('.local')) return true;
  if (/^\d+\.\d+\.\d+\.\d+$/.test(host)) {
    const v = host.split('.').map(Number);
    return v[0] === 10 || v[0] === 127 || v[0] === 0
      || (v[0] === 169 && v[1] === 254)
      || (v[0] === 172 && v[1] >= 16 && v[1] <= 31)
      || (v[0] === 192 && v[1] === 168)
      || (v[0] === 100 && v[1] >= 64 && v[1] <= 127)
      || v[0] >= 224;
  }
  if (host.includes(':')) {
    return host === '::1' || host === '::'
      || /^f[ec][0-9a-f]{2}:/.test(host)
      || /^fe[89ab][0-9a-f]:/.test(host)
      || /^ff[0-9a-f]{2}:/.test(host);
  }
  return false;
}

function joinUrl(base, ...segments) {
  const parts = segments
    .filter((s) => s !== undefined && s !== null && s !== '')
    .map((s) => String(s));
  // 逐段校验：encodeURIComponent('..') 仍是 '..'，编码挡不住穿越。
  // 备份路径由用户配置却在远端生效，必须显式拒绝，否则能跳出备份目录读写任意文件。
  for (const p of parts) {
    if (p === '' || p === '.' || p === '..') throw new DavError(`备份路径含非法段：${p}`);
    if (/^[a-zA-Z]:/.test(p) || p.startsWith('/') || p.startsWith('\\')) throw new DavError(`备份路径含非法段：${p}`);
    if (/[\u0000-\u001f]/.test(p)) throw new DavError('备份路径含控制字符');
  }
  return `${base}${parts.length ? `/${parts.map((s) => encodeURIComponent(s)).join('/')}` : ''}`;
}

async function davRequest(dav, method, path, { body, headers = {}, depth, expect = [] } = {}) {
  const base = normalizeBase(dav.url);
  const url = path ? joinUrl(base, ...path) : base;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), REQUEST_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      method,
      signal: ctrl.signal,
      redirect: 'manual',
      headers: {
        Authorization: basicAuth(dav.username, dav.password),
        ...(depth !== undefined ? { Depth: String(depth) } : {}),
        ...headers,
      },
      body,
    });
    if (expect.length && !expect.includes(res.status)) {
      const text = await res.text().catch(() => '');
      throw new DavError(`WebDAV ${method} 返回 HTTP ${res.status}`, {
        status: res.status,
        hint: davHintFor(res.status, text),
      });
    }
    return guardBodyTimeout(res, timer);
  } catch (err) {
    clearTimeout(timer);
    if (err instanceof DavError) throw err;
    if (err.name === 'AbortError') throw new DavError('WebDAV 请求超时', { hint: '检查地址与网络连通性' });
    throw new DavError(`WebDAV 请求失败：${err.message}`, { hint: '检查地址、账号与网络' });
  }
}

// 超时必须覆盖 body 读取：fetch 只等到响应头就 resolve，
// 若此时就清定时器，服务器随后挂住不结束数据，res.text() 会无限等待。
function guardBodyTimeout(res, timer) {
  if (timer.unref) timer.unref();
  const done = () => clearTimeout(timer);
  for (const method of ['text', 'json', 'arrayBuffer']) {
    const orig = res[method] && res[method].bind(res);
    if (!orig) continue;
    res[method] = async (...args) => {
      try {
        return await orig(...args);
      } finally {
        done();
      }
    };
  }
  return res;
}

function davHintFor(status, body) {
  const snippet = String(body || '').replace(/\s+/g, ' ').slice(0, 100);
  if (status === 401) return '账号或密码不正确（部分服务需使用「应用密码」而非登录密码）';
  if (status === 403) return '账号无权限，或该服务禁止此操作';
  if (status === 404) return '路径不存在，请检查地址与目录';
  if (status === 405) return '该服务不允许此操作（部分网盘仅支持有限方法）';
  if (status === 409) return '父目录不存在（部分服务不会自动创建多级目录）';
  if (status === 507) return '空间不足';
  if (status >= 500) return '服务端错误，稍后再试';
  return snippet || undefined;
}

/* ---------- 目录与文件操作 ---------- */

// 逐级创建目录：多数 WebDAV 服务的 MKCOL 不会递归建父目录
async function ensureDir(dav, segments) {
  for (let i = 1; i <= segments.length; i += 1) {
    const res = await davRequest(dav, 'MKCOL', segments.slice(0, i), { expect: [201, 405] });
    // 405 = 已存在，属正常
    if (res.status !== 201 && res.status !== 405) {
      throw new DavError(`创建目录失败：HTTP ${res.status}`, { status: res.status });
    }
  }
}

async function testConnection(dav) {
  const base = normalizeBase(dav.url);
  // OPTIONS 是最轻的探测；有些服务不返回 DAV 头，所以不强制要求
  const res = await davRequest({ ...dav, url: base }, 'OPTIONS', null, { expect: [200, 204] });
  const davHeader = res.headers.get('dav') || '';
  return {
    ok: true,
    dav: davHeader,
    supportsPropfind: davHeader.includes('1') || davHeader.includes('2') || davHeader === '',
  };
}

function backupDirSegments(dav) {
  const raw = String(dav.path || 'ticket-monitor').trim().replace(/^\/+|\/+$/g, '');
  return raw ? raw.split('/').filter(Boolean) : ['ticket-monitor'];
}

// 文件名精确到秒；同一秒内多次备份会撞名并互相覆盖（实测确认），
// 因此追加 3 位毫秒，保证「刚上传的那份」与旧份可区分，轮转才有意义。
function backupName(date = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  const ms = String(date.getMilliseconds()).padStart(3, '0');
  return `config-${date.getFullYear()}${p(date.getMonth() + 1)}${p(date.getDate())}`
    + `-${p(date.getHours())}${p(date.getMinutes())}${p(date.getSeconds())}${ms}.json`;
}

function parseStatXml(xml) {
  const out = [];
  // 命名空间前缀不固定：有的服务端发 <D:response>，也有 <ns0:response>、<lp1:response>。
  // 只认 D:/d: 会让整个列表解析成空，备份列表直接不可用。
  const responses = String(xml).split(/<[A-Za-z0-9_.-]*:?response[\s>]/i).slice(1);
  const chunks = responses.length ? responses : String(xml).split(/<response[\s>]/i).slice(1);
  for (const raw of chunks) {
    const hrefMatch = /<[A-Za-z0-9_.-]*:?href[^>]*>([\s\S]*?)<\/[A-Za-z0-9_.-]*:?href>/i.exec(raw);
    if (!hrefMatch) continue;
    let href;
    try {
      href = decodeURIComponent(hrefMatch[1].trim());
    } catch (err) {
      // 非法百分号编码会让 decodeURIComponent 抛错，跳过该条目而不是整份失败
      href = hrefMatch[1].trim();
    }
    href = href.replace(/\/+$/, '');
    const name = href.split('/').filter(Boolean).pop() || '';
    const sizeMatch = /<D?:?getcontentlength[^>]*>(\d+)</i.exec(raw);
    const timeMatch = /<D?:?getlastmodified[^>]*>([^<]+)</i.exec(raw);
    const isDir = /<D?:?collection\s*\/?>/i.test(raw) || /<D?:?resourcetype\s*>\s*<D?:?collection/i.test(raw);
    if (isDir || !name.endsWith('.json')) continue;
    out.push({
      name,
      size: sizeMatch ? Number(sizeMatch[1]) : null,
      modifiedAt: timeMatch ? new Date(timeMatch[1].trim()).getTime() || null : null,
    });
  }
  return out;
}

async function listBackups(dav) {
  const res = await davRequest(dav, 'PROPFIND', backupDirSegments(dav), {
    headers: { 'Content-Type': 'application/xml; charset=utf-8' },
    body: '<?xml version="1.0"?><D:propfind xmlns:D="DAV:"><D:prop><D:getcontentlength/><D:getlastmodified/><D:resourcetype/></D:prop></D:propfind>',
    depth: 1,
    expect: [207],
  });
  const xml = await res.text();
  return parseStatXml(xml).sort((a, b) => (b.modifiedAt || 0) - (a.modifiedAt || 0) || b.name.localeCompare(a.name));
}

// 构造要上传的内容：与 /api/export 同口径（密钥掩码），避免把密钥放上云端
function buildExportPayload(config, mask) {
  // settings 里同时含访问令牌与 WebDAV 密码，两者都不能上传：
  // 直接把整个 settings 拷过去会把 WebDAV 密码原样写到云端。
  const settings = { ...config.settings };
  settings.token = settings.token ? mask : '';
  if (settings.webdav) {
    settings.webdav = { ...settings.webdav, password: settings.webdav.password ? mask : '' };
  }
  return {
    version: 1,
    exportedAt: new Date().toISOString(),
    settings,
    watches: config.watches,
    // 渠道密钥掩码后上传：恢复时若本地已有同 id 渠道则保留其密钥
    channels: (config.channels || []).map((c) => maskChannel(c, mask)),
  };
}

function maskChannel(channel, mask) {
  const SECRET_KEYS = ['sendkey', 'deviceKey', 'webhook', 'secret', 'botToken', 'token'];
  const out = { ...channel };
  for (const k of SECRET_KEYS) if (out[k]) out[k] = mask;
  return out;
}

async function upload(dav, payload, { keep = MAX_BACKUPS } = {}) {
  const segments = backupDirSegments(dav);
  await ensureDir(dav, segments);

  const name = backupName();
  const body = Buffer.from(JSON.stringify(payload, null, 2), 'utf8');
  await davRequest(dav, 'PUT', [...segments, name], {
    body,
    headers: { 'Content-Type': 'application/json; charset=utf-8' },
    expect: [200, 201, 204],
  });
  logger.info(`WebDAV 备份已上传：${name}（${body.length} 字节）`);

  // 轮转：只保留最近 keep 份，避免云端无限堆积。
  // 关键：刚上传的这份必须受保护 —— 若服务器不返回 getlastmodified，
  // 排序会退化为按文件名，极端情况下可能把它自己排到淘汰区删掉。
  let pruned = [];
  try {
    const all = (await listBackups(dav)).filter((item) => item.name !== name);
    const extra = all.slice(Math.max(0, keep - 1));
    for (const item of extra) {
      await davRequest(dav, 'DELETE', [...segments, item.name], { expect: [200, 204, 404] });
      pruned.push(item.name);
    }
    if (pruned.length) logger.info(`WebDAV 备份轮转：清理 ${pruned.length} 份旧备份`);
  } catch (err) {
    // 清理失败不影响本次备份成功，只记日志
    logger.warn(`WebDAV 备份轮转失败（备份本身已成功）：${err.message}`);
  }
  return { name, size: body.length, pruned };
}

async function download(dav, name) {
  if (!/^[\w.-]+\.json$/.test(String(name || ''))) {
    throw new DavError('备份文件名不合法');
  }
  const res = await davRequest(dav, 'GET', [...backupDirSegments(dav), name], { expect: [200] });
  const text = await res.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch (err) {
    throw new DavError('备份文件不是合法 JSON', { hint: '文件可能已损坏' });
  }
  validatePayload(json);
  return json;
}

// 恢复前严格校验：结构不对就拒绝，避免把配置改成不可用状态
function validatePayload(json) {
  if (!json || typeof json !== 'object') throw new DavError('备份内容不是对象');
  if (!Array.isArray(json.watches)) throw new DavError('备份缺少 watches 数组', { hint: '这不是本工具导出的配置' });
  if (json.channels !== undefined && !Array.isArray(json.channels)) throw new DavError('备份的 channels 字段格式不正确');
  // 渠道条目必须是对象，否则后续 mergeSecretsFromLocal 会解引用 null 抛 TypeError
  if (Array.isArray(json.channels) && json.channels.some((c) => !c || typeof c !== 'object')) {
    throw new DavError('备份中存在非法的渠道条目');
  }
  if (json.settings !== undefined && (typeof json.settings !== 'object' || json.settings === null)) {
    throw new DavError('备份的 settings 字段格式不正确');
  }
  const badWatch = json.watches.find((w) => !w || typeof w !== 'object' || !w.from || !w.to || !w.date);
  if (badWatch) throw new DavError('备份中存在缺少站点或日期的任务', { hint: '文件可能被手工改坏' });
  return true;
}

// 还原时把掩码密钥替换成本地已有渠道的真实值（同 id 优先，其次 type+name）
function mergeSecretsFromLocal(payload, localChannels) {
  // 备份可能被手工改坏：channels 里混入 null/非对象时不能让整个恢复崩掉
  return (payload.channels || []).filter((c) => c && typeof c === 'object').map((c) => {
    const same = localChannels.find((x) => x && x.id === c.id)
      || localChannels.find((x) => x && x.type === c.type && x.name === c.name);
    if (!same) return c;
    const merged = { ...c };
    for (const k of ['sendkey', 'deviceKey', 'webhook', 'secret', 'botToken', 'token']) {
      if (merged[k] === store.MASKED || merged[k] === undefined) merged[k] = same[k];
    }
    return merged;
  });
}

module.exports = {
  DavError,
  MAX_BACKUPS,
  normalizeBase,
  joinUrl,
  testConnection,
  listBackups,
  upload,
  download,
  backupName,
  parseStatXml,
  buildExportPayload,
  validatePayload,
  mergeSecretsFromLocal,
  ensureDir,
};
