'use strict';

const fs = require('fs');
const path = require('path');
const logger = require('./logger');

// 随镜像打包的车站表（可选）：网络不通时用它兜底，避免启动即失败
const BUNDLED_STATION_FILE = process.env.STATION_FILE || path.join(__dirname, '..', 'assets', 'station_name.js');

const BASE = 'https://kyfw.12306.cn';
const STATION_JS_URL = `${BASE}/otn/resources/js/framework/station_name.js`;
const REFERER = `${BASE}/otn/leftTicket/init`;

// 只用通用桌面浏览器 UA：目标是「看起来像普通用户刷网页」，不做指纹伪装。
const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

// 席别代码 → 界面席别名。
// 来源：官方 queryLeftTicket_end_js.js 中的权威字典
//   {P:"特等座","9":"商务座",A:"高级动卧",D:"优选一等座",M:"一等座",O:"二等座",
//    "6":"高级软卧",I:"一等卧",J:"二等卧","4":"软卧","3":"硬卧",F:"动卧",
//    "2":"软座","1":"硬座",H:"其他",WZ/W:"无座"}
// 注意：'1' 同时被硬座与无座复用，官方靠 yp_info_new 分组顺序区分，这里按席别代号优先
// 映射到硬座；无座票价与硬座相同，用于「按票价筛选」不会算错。
const SEAT_CODE_TO_LABEL = {
  1: '硬座',
  2: '软座',
  3: '硬卧',
  4: '软卧',
  6: '高级软卧',
  9: '商务座',
  A: '高级动卧',
  D: '优选一等座',
  F: '动卧',
  H: '其他',
  I: '一等卧',
  J: '二等卧',
  M: '一等座',
  O: '二等座',
  P: '特等座',
  W: '无座',
};

const SEAT_FIELDS = [
  ['business', '商务座'],
  ['premium', '优选一等座'],
  ['first', '一等座'],
  ['second', '二等座'],
  ['deluxe', '特等座'],
  ['softSleeper', '软卧'],
  ['hardSleeper', '硬卧'],
  ['softSeat', '软座'],
  ['hardSeat', '硬座'],
  ['standing', '无座'],
  ['highSoftSleeper', '高级软卧'],
  ['other', '其他'],
];

const REQUIRED_SEAT_KEYS = SEAT_FIELDS.map(([k]) => k);

class QueryError extends Error {
  constructor(message, opts = {}) {
    super(message);
    this.name = 'QueryError';
    this.retryable = Boolean(opts.retryable);
    this.status = opts.status;
  }
}

let stationCache = null;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function httpGet(url, { timeoutMs = 15000, followRedirect = false } = {}) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    // 注意：必须先赋值再交给 guardBodyTimeout，不能 `return await fetch(...)`
    // —— 那样下面这行永远不可达，body 超时保护形同虚设，且响应头到达后
    // timer 不会被清掉，正常请求也会平白多等一个 timeoutMs。
    const res = await fetch(url, {
      signal: ctrl.signal,
      // 必须用 manual：官方对「超出预售期/参数非法」返回 302 到
      // https://www.12306.cn/mormhweb/logFiles/error.html。
      // follow 会把这个 302 跟成 200 + HTML，于是错误被误报成
      // 「响应不是 JSON」并被当成瞬时故障反复重试 —— 既误导又白白多发请求。
      redirect: followRedirect ? 'follow' : 'manual',
      headers: {
        'User-Agent': UA,
        Referer: REFERER,
        Accept: 'application/json, text/javascript, */*; q=0.01',
        'Accept-Language': 'zh-CN,zh;q=0.9',
        // 无登录态：明确发送空 Cookie，避免复用任何本地会话
        Cookie: 'JSESSIONID=',
      },
    });
    return guardBodyTimeout(res, timer);
  } catch (err) {
    clearTimeout(timer);
    throw err;
  }
}

// fetch() 只等到响应头就 resolve，此时若清掉定时器，后续 res.text() 就没有超时保护：
// 服务器发完响应头后挂住不结束，读取会无限等待（实测可挂死）。
// 这里把 text/json 包一层，读完再清定时器，让超时真正覆盖整个请求。
function guardBodyTimeout(res, timer) {
  if (timer.unref) timer.unref();
  // 兜底：调用方若不读 body 就直接 throw（如 302/429 分支），body 方法不会被触发，
  // timer 也就永远不会被清。给一个独立的清理入口，调用方在异常分支显式调用。
  res.cancelBodyTimer = () => clearTimeout(timer);
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

// 车站表：只依赖官方公开的 station_name.js，本地内存缓存 + 磁盘缓存
function parseStations(js) {
  const body = js.slice(js.indexOf("'") + 1, js.lastIndexOf("'"));
  const out = [];
  for (const chunk of body.split('@')) {
    if (!chunk) continue;
    const f = chunk.split('|');
    if (f.length < 8 || !f[2]) continue;
    out.push({
      abbr: f[0],
      name: f[1],
      code: f[2],
      pinyin: f[3],
      short: f[4],
      city: f[7] || '',
    });
  }
  return out;
}

async function getStations({ force = false } = {}) {
  if (stationCache && !force) return stationCache;
  // 离线模式（测试/内网无外网出口时）：只用本地车站表
  if (process.env.STATION_OFFLINE === '1') {
    const local = loadBundledStations();
    if (!local) throw new QueryError(`离线模式但本地车站表不可用：${BUNDLED_STATION_FILE}`, { retryable: false });
    stationCache = local;
    logger.info(`车站表已加载：${local.length} 个车站（本地离线）`);
    return local;
  }
  try {
    // 静态资源走 CDN，可能有多级跳转，这里允许跟随
    const res = await httpGet(STATION_JS_URL, { timeoutMs: 20000, followRedirect: true });
    if (!res.ok) throw new QueryError(`车站表下载失败 HTTP ${res.status}`, { retryable: true, status: res.status });
    const text = await res.text();
    const list = parseStations(text);
    if (list.length < 1000) throw new QueryError(`车站表解析异常，仅 ${list.length} 条`, { retryable: true });
    stationCache = list;
    logger.info(`车站表已加载：${list.length} 个车站（在线）`);
    return list;
  } catch (err) {
    const fallback = loadBundledStations();
    if (fallback) {
      stationCache = fallback;
      logger.warn(`在线获取车站表失败（${err.message}），已使用镜像内置车站表：${fallback.length} 个车站`);
      return fallback;
    }
    throw err;
  }
}

// 内置车站表：随镜像打包，离线可用（不会访问网络）
function loadBundledStations() {
  try {
    if (!fs.existsSync(BUNDLED_STATION_FILE)) return null;
    const list = parseStations(fs.readFileSync(BUNDLED_STATION_FILE, 'utf8'));
    return list.length >= 1000 ? list : null;
  } catch (err) {
    logger.warn(`内置车站表读取失败：${err.message}`);
    return null;
  }
}

// 简拼极易撞车（北京 / 白涧 / 宝鸡 / 北滘 的简拼都是 bj），
// 同分时优先主要城市站点，符合直觉且结果稳定。
const MAJOR_CITIES = new Set([
  '北京', '上海', '广州', '深圳', '天津', '重庆', '成都', '杭州', '武汉', '西安',
  '南京', '长沙', '郑州', '沈阳', '哈尔滨', '长春', '济南', '青岛', '大连', '宁波',
  '厦门', '福州', '合肥', '南昌', '昆明', '贵阳', '南宁', '海口', '三亚', '太原',
  '石家庄', '呼和浩特', '兰州', '西宁', '银川', '乌鲁木齐', '拉萨', '苏州', '无锡', '佛山',
]);

// 站名解析：精确名 > 三字码 > 拼音/简拼 > 名称包含
function searchStations(query, stations, limit = 10) {
  const q = String(query || '').trim();
  if (!q) return [];
  const lower = q.toLowerCase();
  const scored = [];
  for (const s of stations) {
    let score = 0;
    if (s.name === q) score = 100;
    else if (s.code === q.toUpperCase()) score = 95;
    else if (s.pinyin === lower || s.short === lower) score = 90;
    else if (s.name.startsWith(q) || s.abbr === lower) score = 80;
    else if (s.pinyin.startsWith(lower)) score = 70;
    // 拼音/简拼含在中间也要能搜到（如 hongqiao → 上海虹桥）。
    // 只对 4 字符以上生效，否则单字母查询会把结果冲散。
    else if (lower.length >= 4 && s.pinyin.includes(lower)) score = 46;
    else if (lower.length >= 4 && s.short.includes(lower)) score = 44;
    else if (s.city === q) score = 60;
    else if (s.name.includes(q)) score = 50;
    else if (s.city && s.city.includes(q)) score = 40;
    if (score > 0) {
      if (MAJOR_CITIES.has(s.name)) score += 5;
      scored.push({ ...s, score });
    }
  }
  scored.sort((a, b) =>
    b.score - a.score ||
    a.name.length - b.name.length ||
    // 简拼会撞车（北京 / 白涧 都是 BJ），同分时优先地名与输入同源的站
    Number(b.pinyin.startsWith(lower)) - Number(a.pinyin.startsWith(lower)) ||
    Number(b.abbr === lower) - Number(a.abbr === lower) ||
    a.name.localeCompare(b.name, 'zh'));
  return scored.slice(0, limit);
}

function resolveStation(input, stations) {
  const list = searchStations(input, stations, 1);
  if (!list.length) return null;
  return list[0];
}

function emptyTickets() {
  const t = {};
  for (const [, label] of SEAT_FIELDS) t[label] = '';
  return t;
}

function normalizeStatus(value) {
  if (value === undefined || value === null) return '';
  const v = String(value).trim();
  if (!v) return '';
  if (v === '有') return '有';
  if (v === '无' || v === '--' || v === '禁售') return '无';
  if (v === '候补') return '候补';
  if (/^\d+$/.test(v)) return v;
  return v;
}

// 解析 yp_info_new 得到各席别票价（单位：元）。
// 格式：每 10 字符一组 —— 1 位席别代号 + 5 位票价（单位：角）+ 4 位余票相关字段。
// 实测与官方 queryTicketPrice 接口逐项一致，因此票价筛选不需要任何额外请求。
function parsePrices(ypInfoNew) {
  const prices = {};
  if (!ypInfoNew) return prices;
  const s = String(ypInfoNew);
  for (let i = 0; i + 10 <= s.length; i += 10) {
    const code = s[i];
    const tenths = Number.parseInt(s.slice(i + 1, i + 6), 10);
    if (!Number.isFinite(tenths) || tenths <= 0) continue;
    const label = SEAT_CODE_TO_LABEL[code];
    if (!label) continue;
    // 同一席别可能重复出现（如 O 出现两次），保留首次出现的有效值
    if (prices[label] === undefined) prices[label] = tenths / 10;
  }
  return prices;
}

// 余票行最少需要到 39 号字段（yp_info_new）才能解析票价
const MIN_FIELDS = 40;

function parseTrainLine(line) {
  const a = String(line).split('|');
  if (a.length < MIN_FIELDS) {
    // 字段布局变化是上游改版的信号，宁可标记异常也不要静默产出错值
    logger.warn(`余票行字段数异常（${a.length} < ${MIN_FIELDS}），上游布局可能已变更`);
  }
  const g = (i) => (a[i] === undefined ? '' : a[i]);
  // 下标严格对齐官方 queryLeftTicket_end_js.js 的解构：
  //   c9[20]gg_num  c9[21]gr_num  c9[22]qt_num  c9[23]rw_num  c9[24]rz_num
  //   c9[25]tz_num(特等座)  c9[26]wz_num  c9[27]yb_num  c9[28]yw_num
  //   c9[29]yz_num  c9[30]ze_num  c9[31]zy_num  c9[32]swz_num  c9[33]srrb_num(动卧)
  const seats = {
    business: g(32),        // swz_num 商务座
    premium: g(20),         // gg_num 优选一等座（席别代码 D；原先错取 25）
    first: g(31),           // zy_num 一等座
    second: g(30),          // ze_num 二等座
    deluxe: g(25),          // tz_num 特等座（席别代码 P；原先错取 33）
    softSleeper: g(23),     // rw_num 软卧
    hardSleeper: g(28),     // yw_num 硬卧
    softSeat: g(24),        // rz_num 软座
    hardSeat: g(29),        // yz_num 硬座
    standing: g(26),        // wz_num 无座
    highSoftSleeper: g(21), // gr_num 高级软卧
    other: g(22),           // qt_num 其他
  };
  const tickets = {};
  for (const [key, label] of SEAT_FIELDS) tickets[label] = normalizeStatus(seats[key]);
  return {
    // 不保留 secretStr：它是提交订单用的凭证。本产品明确不下单，
    // 留着一份用不到的订票凭证没有收益，只有被误用或泄露的风险。
    canWebBuy: g(11),
    trainNo: g(2),
    trainCode: g(3),
    fromCode: g(6),
    toCode: g(7),
    startTime: g(8),
    arriveTime: g(9),
    duration: g(10),
    startDate: g(13),
    fromStationNo: g(16),
    toStationNo: g(17),
    seatTypes: g(35),
    tickets,
    prices: parsePrices(g(39)),
  };
}

function statusValue(status) {
  if (status === '有') return Number.POSITIVE_INFINITY;
  if (/^\d+$/.test(status)) return Number.parseInt(status, 10);
  if (status === '候补') return 0.5;
  return 0; // 无 / 未知 / 禁售
}

// 查询余票。无登录、无 cookie，只调用公开只读接口。
// retries 保持很小：单次检查内的重试会与引擎层的退避叠加，
// 默认只重试 1 次（最多 2 个请求），避免瞬时故障时放大请求量。
async function queryTickets({ date, fromCode, toCode, retries = 1, timeoutMs = 15000 }) {
  const dto = `leftTicketDTO.train_date=${encodeURIComponent(date)}` +
    `&leftTicketDTO.from_station=${encodeURIComponent(fromCode)}` +
    `&leftTicketDTO.to_station=${encodeURIComponent(toCode)}` +
    '&purpose_codes=ADULT';

  let lastErr = null;
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    if (attempt > 0) {
      const backoff = 1000 * 2 ** (attempt - 1);
      logger.warn(`查询重试 ${attempt}/${retries}（${backoff}ms 后）：${fromCode}→${toCode} ${date}`);
      await sleep(backoff);
    }
    try {
      let url = `${BASE}/otn/leftTicket/queryG?${dto}`;
      let res = await httpGet(url, { timeoutMs });

      // 302 有两种含义，必须区分：
      //  a) 302 + JSON 体 {"c_url":"leftTicket/xxx"} → 查询入口改名，跟随一次
      //  b) 302 → 官方 error.html（超出预售期 / 参数非法）→ 不可重试，重试只会白发请求
      if (res.status === 301 || res.status === 302) {
        const location = res.headers.get('location') || '';
        const hinted = await readRedirectHint(res);
        if (hinted) {
          logger.warn(`官方查询入口变更为 ${hinted}，本次跟随`);
          res = await httpGet(`${BASE}/otn/${hinted}?${dto}`, { timeoutMs });
        } else if (location.includes('error.html')) {
          if (res.cancelBodyTimer) res.cancelBodyTimer();
          throw new QueryError(
            `官方拒绝该查询（302 → ${location}）。最常见原因是日期超出预售期，或车站/日期参数非法。` +
            `预售期约 15 天，请确认日期在可售范围内。`,
            { retryable: false, status: 302 },
          );
        } else {
          throw new QueryError(`意外重定向到 ${location || '(无 Location)'}`, { retryable: false, status: 302 });
        }
      }

      if (res.status === 429 || res.status === 403 || res.status === 412) {
        throw new QueryError(`被限流 HTTP ${res.status}`, { retryable: false, status: res.status });
      }
      if (!res.ok) {
        throw new QueryError(`HTTP ${res.status}`, { retryable: res.status >= 500, status: res.status });
      }

      const text = await res.text();
      let json;
      try {
        json = JSON.parse(text);
      } catch (err) {
        // 走到这里说明返回了 HTML 而不是 JSON，通常是官方错误页或风控页
        const isHtml = /^\s*<(!DOCTYPE|html)/i.test(text);
        throw new QueryError(
          isHtml
            ? `官方返回 HTML 错误页而非 JSON（${text.replace(/\s+/g, ' ').slice(0, 80)}）`
            : `响应不是 JSON（${text.slice(0, 80)}）`,
          { retryable: false },
        );
      }
      if (json && json.c_url) {
        throw new QueryError(`官方查询入口提示 ${json.c_url}，需要更新路径`, { retryable: false });
      }
      if (!json || json.status === false) {
        const msg = (json && (json.messages || json.message)) || 'status=false';
        throw new QueryError(`接口返回失败：${JSON.stringify(msg).slice(0, 120)}`, { retryable: true });
      }
      if (!json.data) {
        // status=true 但没有 data：正常无车次与上游结构变化都可能这样，
        // 记一条日志以便区分，不静默当成「无票」
        logger.warn(`响应缺少 data 字段（${fromCode}→${toCode} ${date}），按无车次处理`);
        return { trains: [], stationMap: {}, checkedAt: Date.now() };
      }
      const map = json.data.map || {};
      if (json.data.result !== undefined && !Array.isArray(json.data.result)) {
        throw new QueryError('响应 result 字段不是数组，上游结构可能已变更', { retryable: false });
      }
      const rows = Array.isArray(json.data.result) ? json.data.result : [];
      const trains = rows.map(parseTrainLine).filter((t) => t.trainCode);
      if (rows.length > 0 && trains.length === 0) {
        throw new QueryError(`解析出 0 个车次（原始 ${rows.length} 行），字段布局可能已变更`, { retryable: false });
      }
      return { trains, stationMap: map, checkedAt: Date.now() };
    } catch (err) {
      lastErr = err;
      if (err instanceof QueryError && !err.retryable) break;
      if (err.name === 'AbortError') lastErr = new QueryError('请求超时', { retryable: true });
    }
  }
  throw lastErr || new QueryError('未知查询失败');
}

async function readRedirectHint(res) {
  try {
    const text = await res.text();
    const json = JSON.parse(text);
    return json && json.c_url ? json.c_url : null;
  } catch (err) {
    return null;
  }
}

// 命中判定：只看用户勾选的席别是否有票（有 / 数字>0）
function pickHits(trains, seatLabels) {
  const hits = [];
  for (const t of trains) {
    const matched = {};
    for (const label of seatLabels) {
      const st = t.tickets[label];
      if (st === '有' || (/^\d+$/.test(st) && Number.parseInt(st, 10) > 0)) matched[label] = st;
    }
    if (Object.keys(matched).length) {
      hits.push({
        trainCode: t.trainCode,
        trainNo: t.trainNo,
        startTime: t.startTime,
        arriveTime: t.arriveTime,
        duration: t.duration,
        matched,
        // 命中席别的票价，用于推送正文（无则不显示）
        prices: Object.fromEntries(Object.keys(matched).map((k) => [k, (t.prices || {})[k]]).filter(([, v]) => typeof v === 'number')),
      });
    }
  }
  return hits;
}


/* ---------- 经停站（用户点击车次时按需查询） ---------- */

// 经停站接口是「每个车次一次请求」，绝不能放进轮询循环：
// 一次查询 55 个车次就会变成 55 倍请求量。这里只在用户点击时按需拉取，
// 并做内存缓存，避免反复点同一个车次重复请求。
// NaN 会让 `now - at > NaN` 恒为 false → 缓存永不失效，TTL 静默丢失
const STOPS_TTL_MS = Number.isFinite(Number(process.env.STOPS_TTL_MS)) && process.env.STOPS_TTL_MS
  ? Number(process.env.STOPS_TTL_MS) : 6 * 60 * 60 * 1000;
const STOPS_CACHE_MAX = 300;
const stopsCache = new Map();

function stopsCacheKey(trainNo, date, fromCode, toCode) {
  return `${trainNo}|${date}|${fromCode}|${toCode}`;
}

function readStopsCache(key) {
  const hit = stopsCache.get(key);
  if (!hit) return null;
  if (Date.now() - hit.at > STOPS_TTL_MS) {
    stopsCache.delete(key);
    return null;
  }
  // LRU：命中后挪到末尾
  stopsCache.delete(key);
  stopsCache.set(key, hit);
  return hit.data;
}

function writeStopsCache(key, data) {
  if (stopsCache.size >= STOPS_CACHE_MAX) {
    const oldest = stopsCache.keys().next().value;
    stopsCache.delete(oldest);
  }
  stopsCache.set(key, { at: Date.now(), data });
}

// 查询某车次的经停站。date 用于接口参数，站点码决定返回的区间。
async function queryTrainStops({ trainNo, date, fromCode, toCode, timeoutMs = 15000 }) {
  if (!trainNo || !date || !fromCode || !toCode) {
    throw new QueryError('缺少查询经停站所需的参数', { retryable: false });
  }
  const key = stopsCacheKey(trainNo, date, fromCode, toCode);
  const cached = readStopsCache(key);
  if (cached) return { ...cached, cached: true };

  const url = `${BASE}/otn/czxx/queryByTrainNo?train_no=${encodeURIComponent(trainNo)}` +
    `&from_station_telecode=${encodeURIComponent(fromCode)}` +
    `&to_station_telecode=${encodeURIComponent(toCode)}` +
    `&depart_date=${encodeURIComponent(date)}`;

  let res;
  try {
    res = await httpGet(url, { timeoutMs });
  } catch (err) {
    throw new QueryError(`经停站查询失败：${err.message}`, { retryable: true });
  }
  if (res.status === 302 || res.status === 301) {
    throw new QueryError('官方拒绝了经停站查询（302），可能是参数不合法', { retryable: false, status: res.status });
  }
  if (res.status === 429 || res.status === 403 || res.status === 412) {
    throw new QueryError(`经停站查询被限流 HTTP ${res.status}`, { retryable: false, status: res.status });
  }
  if (!res.ok) {
    throw new QueryError(`经停站查询 HTTP ${res.status}`, { retryable: res.status >= 500, status: res.status });
  }

  const text = await res.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch (err) {
    const isHtml = /^\s*<(!DOCTYPE|html)/i.test(text);
    throw new QueryError(isHtml ? '官方返回 HTML 错误页而非 JSON' : '经停站响应不是 JSON', { retryable: false });
  }
  if (!json || json.status === false) {
    throw new QueryError('经停站接口返回失败', { retryable: true });
  }
  const rows = (json.data && json.data.data) || [];
  const stops = rows.map((r) => ({
    no: r.station_no,
    name: r.station_name,
    arriveTime: r.arrive_time,
    startTime: r.start_time,
    stopover: r.stopover_time,
    isStart: r.arrive_time === '----',
    isEnd: r.start_time === r.arrive_time && r.arrive_time !== '----',
  }));
  if (!stops.length) {
    throw new QueryError('该车次暂无经停站数据', { retryable: false });
  }
  const data = { trainNo, trainCode: rows[0].station_train_code || '', stops };
  writeStopsCache(key, data);
  logger.info(`经停站已加载：${data.trainCode} 共 ${stops.length} 站`);
  return { ...data, cached: false };
}

/* ---------- 筛选（不指定车次时使用） ---------- */

function toMinutes(hhmm) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(hhmm || '').trim());
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (min > 59) return null;
  // 12306 用 24:00 表示当日末班（即午夜发车）。若不特判会被当成
  // 「时刻缺失」，从而被任何时间段放行 —— 归一到 00:00 更符合直觉。
  if (h === 24 && min === 0) return 0;
  if (h > 23) return null;
  return h * 60 + min;
}

// 出发时间段判定，支持跨午夜（如 22:00 - 次日 06:00）
// 历时解析：12306 用 HH:MM，且可能超过 24 小时（如 27:30）。
// 也接受用户只填小时数（"4" == 4 小时）。
function toDurationMinutes(text) {
  const raw = String(text == null ? '' : text).trim();
  if (!raw) return null;
  const m = /^(\d{1,3})(?::(\d{1,2}))?$/.exec(raw);
  if (!m) return null;
  const h = Number(m[1]);
  const min = m[2] === undefined ? 0 : Number(m[2]);
  if (min > 59) return null;
  const total = h * 60 + min;
  // 历时上限放宽到 72 小时：少数超长交路确实存在
  if (total > 72 * 60) return null;
  return total;
}

// 反解：分钟 → "Xh Ym" 展示
function formatDurationText(minutes) {
  const n = Number(minutes);
  if (!Number.isFinite(n) || n < 0) return '';
  const h = Math.floor(n / 60);
  const m = n % 60;
  if (!h) return `${m}分`;
  if (!m) return `${h}小时`;
  return `${h}小时${m}分`;
}

function inTimeWindow(startTime, from, to) {
  const cur = toMinutes(startTime);
  if (cur === null) return true; // 时刻缺失时不因此过滤掉
  const f = toMinutes(from);
  const t = toMinutes(to);
  if (f === null && t === null) return true;
  if (f !== null && t !== null) {
    if (f === t) return true; // 配置成同一时刻视为不限
    return f < t ? cur >= f && cur <= t : cur >= f || cur <= t;
  }
  if (f !== null) return cur >= f;
  return cur <= t;
}

// 取该车次在用户勾选席别中的最低票价（元）；无任何可比价格时返回 null
function lowestPrice(train, seatLabels) {
  const prices = train.prices || {};
  const labels = seatLabels && seatLabels.length ? seatLabels : Object.keys(prices);
  let min = null;
  for (const label of labels) {
    const p = prices[label];
    if (typeof p === 'number' && p > 0 && (min === null || p < min)) min = p;
  }
  return min;
}

// 按出发时间段 + 票价区间筛选车次。
// 两个维度各自带 enabled 开关：未启用即不参与过滤（而不是「值为空就不过滤」），
// 这样「填过值但暂时关闭」与「没填过」语义清晰，且可任意组合。
// 严格站点过滤：12306 按「城市」返回，请求「盐城」也会带出「盐城大丰」的车次，
// 于是一个车次可能出现两次（到站不同）。默认按实际到站精确匹配，只保留用户选的那个站。
function filterByExactStation(trains, { fromCode, toCode, exactFrom, exactTo }) {
  return trains.filter((t) => {
    if (exactFrom && fromCode && t.fromCode && t.fromCode !== fromCode) return false;
    if (exactTo && toCode && t.toCode && t.toCode !== toCode) return false;
    return true;
  });
}

function filterTrains(trains, filters = {}, seatLabels = []) {
  const {
    timeEnabled, timeFrom, timeTo,
    priceEnabled, priceMin, priceMax,
    durationEnabled, durationMin, durationMax,
  } = filters;
  const hasTime = Boolean(timeEnabled) && ((timeFrom && toMinutes(timeFrom) !== null) || (timeTo && toMinutes(timeTo) !== null));
  const hasPrice = Boolean(priceEnabled) && (Number.isFinite(priceMin) || Number.isFinite(priceMax));
  const hasDuration = Boolean(durationEnabled) && (Number.isFinite(durationMin) || Number.isFinite(durationMax));
  // 三个条件都关时不做事，避免多余遍历
  if (!hasTime && !hasPrice && !hasDuration) return { trains, skippedByPrice: 0 };

  let skippedByPrice = 0;
  const out = trains.filter((t) => {
    if (hasTime && !inTimeWindow(t.startTime, timeFrom, timeTo)) return false;
    if (hasDuration) {
      const d = toDurationMinutes(t.duration);
      // 历时缺失时不做判断，避免把数据不全的车次误杀
      if (d !== null) {
        if (Number.isFinite(durationMin) && d < durationMin) return false;
        if (Number.isFinite(durationMax) && d > durationMax) return false;
      }
    }
    if (hasPrice) {
      const p = lowestPrice(t, seatLabels);
      // 没有票价数据的车次（如部分席别未公布）不因价格被误杀
      if (p !== null) {
        if (Number.isFinite(priceMin) && p < priceMin) { skippedByPrice += 1; return false; }
        if (Number.isFinite(priceMax) && p > priceMax) { skippedByPrice += 1; return false; }
      }
    }
    return true;
  });
  return { trains: out, skippedByPrice };
}

module.exports = {
  BASE,
  SEAT_FIELDS,
  SEAT_CODE_TO_LABEL,
  REQUIRED_SEAT_KEYS,
  QueryError,
  getStations,
  parseStations,
  searchStations,
  resolveStation,
  queryTickets,
  parseTrainLine,
  parsePrices,
  normalizeStatus,
  statusValue,
  pickHits,
  queryTrainStops,
  stopsCacheSize: () => stopsCache.size,
  httpGet,
  filterTrains,
  filterByExactStation,
  toDurationMinutes,
  formatDurationText,
  inTimeWindow,
  lowestPrice,
  toMinutes,
  emptyTickets,
  sleep,
};
