'use strict';

// 中转（换乘）方案：把「出发站→换乘站」与「换乘站→到达站」两段余票拼成可换乘组合。
//
// 为什么不用官方中转接口（/lcquery/queryG，实测可用）：
//   它只返回官方自己挑选的短换乘推荐——「北京南→上海虹桥 经济南西」共 26 条、
//   等待时间全部落在 2–4 分钟，既表达不了「20–40 分钟」这种自定义窗口，
//   也不保证列出全部组合。因此改为两段余票拼接，本地求交。
//
// 时刻语义（2026-10 实测确认）：12306 的 train_date 是「在上车站乘车」的日期。
//   查询「济南西→上海虹桥 @10-20」会返回 start_train_date=10-19 的夜车行，
//   即该车在 10-20 凌晨经过济南西。因此跨午夜换乘（第一程 23:50 到、
//   次日 00:20 发）必须单独加查次日的第二程，不能靠「发车时刻 +24h」去凑。
//
// 请求量：常规 2 次上游请求；仅当第一程有「到达时刻 + 最长换乘 ≥ 24:00」的
//   车次时才加查 1 次次日（共 3 次）。经停站接口绝不在此调用（每车次一请求）。

const client = require('./client');

const DEFAULT_MIN_WAIT_MINUTES = 20;
const DEFAULT_MAX_WAIT_MINUTES = 40;
const MIN_WAIT_FLOOR_MINUTES = 1;
const MAX_WAIT_MINUTES = 720; // 换乘等待上限 12 小时：再长就不叫换乘了
const MAX_OPTIONS = 300;      // 返回条数上限：命中数再大也不刷爆响应

// 风控节流默认值：一次中转查询要打 2–3 个上游请求，间隔下限 30 秒且不可调低
const DEFAULT_MIN_INTERVAL_SECONDS = 30;

function minIntervalFromEnv() {
  const raw = Number(process.env.TRANSFER_MIN_INTERVAL_SECONDS || DEFAULT_MIN_INTERVAL_SECONDS);
  const seconds = Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_MIN_INTERVAL_SECONDS;
  return Math.max(DEFAULT_MIN_INTERVAL_SECONDS, seconds) * 1000;
}

// ---------- 时刻推算 ----------

// 由「发车时刻 + 历时」推算到达日的天偏移。
// 余票行只有 HH:MM，不带跨天标记，但恒有 arrive = (start + lishi) mod 1440；
// 该式已用官方中转接口的 day_difference 独立校验（52/52 一致）。
// 非整数或明显异常时退回启发式（到达早于发车即跨天），并标记不确定。
function dayOffsetOf(train) {
  const dep = client.toMinutes(train.startTime);
  const arr = client.toMinutes(train.arriveTime);
  if (dep === null || arr === null) return null;
  const dur = client.toDurationMinutes(train.duration);
  if (dur !== null) {
    const raw = (dep + dur - arr) / 1440;
    const days = Math.round(raw);
    if (Math.abs(raw - days) < 1e-6 && days >= 0 && days <= 3) {
      return { days, known: true };
    }
  }
  return { days: arr < dep ? 1 : 0, known: false };
}

// 把一段余票结果转成带绝对时刻（相对乘车日 0 点，单位分钟）的候选。
// dayBase：该段上车日期相对乘车日的偏移（第二程查次日时为 1）。
// 注意 dayBase 只平移上车时刻；arrAbs 还要叠加该车自身的跨天数。
function legEntries(trains, dayBase) {
  const out = [];
  for (const train of trains || []) {
    const dep = client.toMinutes(train.startTime);
    const arr = client.toMinutes(train.arriveTime);
    if (dep === null || arr === null) continue;
    const off = dayOffsetOf(train);
    if (!off) continue;
    out.push({
      train,
      dayBase,
      depAbs: dayBase * 1440 + dep,
      arrAbs: (dayBase + off.days) * 1440 + arr,
      arrDayOffset: off.days,
      arrKnown: off.known,
    });
  }
  return out;
}

function seatHits(train, seats) {
  const out = {};
  const tickets = train.tickets || {};
  // 未勾选席别时回传全部余票状态，否则前端「余票」列无数据可渲染
  const labels = seats && seats.length ? seats : Object.keys(tickets);
  for (const s of labels) {
    const v = tickets[s];
    if (v === '有' || (/^\d+$/.test(String(v)) && Number.parseInt(v, 10) > 0)) out[s] = v;
  }
  return out;
}

function legView(entry, hits) {
  const t = entry.train;
  return {
    trainCode: t.trainCode,
    trainNo: t.trainNo,
    startTime: t.startTime,
    arriveTime: t.arriveTime,
    duration: t.duration,
    fromCode: t.fromCode,
    toCode: t.toCode,
    dayBase: entry.dayBase,
    nextDayArrival: entry.arrDayOffset > 0,
    hits,
    prices: t.prices || {},
  };
}

// 两段求交：等待 = 第二程发车绝对时刻 − 第一程到达绝对时刻。
// 窗口边界闭区间（20 与 40 都算命中）；同车次（trainNo 相同）是直达车停站，不算换乘。
function matchTransfers(legA, legB, { minWait, maxWait, seats = [], onlyAvailable = false } = {}) {
  const items = [];
  let sameTrainSkipped = 0;
  for (const a of legA || []) {
    for (const b of legB || []) {
      if (a.train.trainNo && a.train.trainNo === b.train.trainNo) { sameTrainSkipped += 1; continue; }
      const wait = b.depAbs - a.arrAbs;
      if (wait < minWait || wait > maxWait) continue;
      const hits1 = seatHits(a.train, seats);
      const hits2 = seatHits(b.train, seats);
      const bothOk = seats.length
        ? (Object.keys(hits1).length > 0 && Object.keys(hits2).length > 0)
        : null;
      if (onlyAvailable && bothOk === false) continue;
      items.push({
        waitMinutes: wait,
        nextDayBoarding: b.dayBase > 0,
        // 历时缺失的车次靠启发式推算跨天，等待时间可能不准，明确标记
        waitUncertain: !a.arrKnown || !b.arrKnown,
        totalMinutes: b.arrAbs - a.depAbs,
        bothAvailable: bothOk,
        leg1: legView(a, hits1),
        leg2: legView(b, hits2),
      });
    }
  }
  items.sort((x, y) =>
    x.waitMinutes - y.waitMinutes ||
    x.totalMinutes - y.totalMinutes ||
    String(x.leg1.startTime).localeCompare(String(y.leg1.startTime)) ||
    String(x.leg2.startTime).localeCompare(String(y.leg2.startTime)));
  return { items, sameTrainSkipped };
}

function shiftDate(iso, days) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(iso || ''));
  if (!m) return null;
  const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]) + days);
  if (Number.isNaN(d.getTime())) return null;
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

// ---------- 查询编排 ----------

// q: { date, fromCode, middleCode, toCode, minWait, maxWait, seats,
//      exactStation, onlyAvailable, nameOf, maxDate }
async function findTransfers(q) {
  const exact = q.exactStation !== false;
  const nameOf = q.nameOf || ((c) => c);

  let first;
  try {
    first = await client.queryTickets({ date: q.date, fromCode: q.fromCode, toCode: q.middleCode });
  } catch (err) {
    throw wrapLegError(`第一程（${nameOf(q.fromCode)}→${nameOf(q.middleCode)}）查询失败`, err);
  }
  const legA = client.filterByExactStation(first.trains, {
    fromCode: q.fromCode, toCode: q.middleCode, exactFrom: exact, exactTo: exact,
  });

  let second;
  try {
    second = await client.queryTickets({ date: q.date, fromCode: q.middleCode, toCode: q.toCode });
  } catch (err) {
    throw wrapLegError(`第二程（${nameOf(q.middleCode)}→${nameOf(q.toCode)}）查询失败`, err);
  }
  const legB = client.filterByExactStation(second.trains, {
    fromCode: q.middleCode, toCode: q.toCode, exactFrom: exact, exactTo: exact,
  });

  // 跨午夜换乘：第一程存在「到达 + 最长换乘 ≥ 24:00」的车次时，
  // 次日凌晨从换乘站发车的车也可能接上。train_date 是上车站当天，
  // 这类车只存在于次日的查询结果里，必须加查一段。
  let nextDayQueried = false;
  let nextDayNote = null;
  let entriesB = legEntries(legB, 0);
  const mayNeedNextDay = legA.some((t) => {
    const off = dayOffsetOf(t);
    const arr = client.toMinutes(t.arriveTime);
    return Boolean(off && arr !== null && off.days * 1440 + arr + q.maxWait >= 1440);
  });
  if (mayNeedNextDay) {
    const nextDate = shiftDate(q.date, 1);
    if (!nextDate || (q.maxDate && nextDate > q.maxDate)) {
      nextDayNote = '第一程有临近午夜到达的车次，但次日已超出可查日期范围，结果可能不含跨午夜换乘';
    } else {
      try {
        const secondNext = await client.queryTickets({ date: nextDate, fromCode: q.middleCode, toCode: q.toCode });
        const legBNext = client.filterByExactStation(secondNext.trains, {
          fromCode: q.middleCode, toCode: q.toCode, exactFrom: exact, exactTo: exact,
        });
        entriesB = entriesB.concat(legEntries(legBNext, 1));
        nextDayQueried = true;
      } catch (err) {
        nextDayNote = `次日第二程查询失败（${err.message}），结果可能不含跨午夜换乘`;
      }
    }
  }

  const entriesA = legEntries(legA, 0);
  const { items, sameTrainSkipped } = matchTransfers(entriesA, entriesB, {
    minWait: q.minWait,
    maxWait: q.maxWait,
    seats: q.seats,
    onlyAvailable: q.onlyAvailable,
  });

  for (const it of items) {
    it.leg1.fromName = nameOf(it.leg1.fromCode);
    it.leg1.toName = nameOf(it.leg1.toCode);
    it.leg1.boardingDate = q.date;
    it.leg2.fromName = nameOf(it.leg2.fromCode);
    it.leg2.toName = nameOf(it.leg2.toCode);
    it.leg2.boardingDate = shiftDate(q.date, it.leg2.dayBase || 0) || q.date;
  }

  // 时间段筛选（可选，可只填一端）：第一程发车 / 第二程到达的 HH:MM 字符串比较
  const hm = (t) => String(t || '').slice(0, 5);
  const inRange = (v, from, to) => (!from || v >= from) && (!to || v <= to);
  const timeFiltered = items.filter((it) =>
    inRange(hm(it.leg1.startTime), q.depFrom, null) &&
    inRange(hm(it.leg2.arriveTime), null, q.arrTo));

  return {
    ok: true,
    at: Date.now(),
    query: {
      date: q.date,
      fromName: nameOf(q.fromCode), fromCode: q.fromCode,
      middleName: nameOf(q.middleCode), middleCode: q.middleCode,
      toName: nameOf(q.toCode), toCode: q.toCode,
      minWait: q.minWait,
      maxWait: q.maxWait,
      seats: q.seats || [],
      exactStation: exact,
      onlyAvailable: Boolean(q.onlyAvailable),
      depFrom: q.depFrom || null,
      arrTo: q.arrTo || null,
    },
    stats: {
      leg1Total: first.trains.length,
      leg1Kept: legA.length,
      leg1Usable: entriesA.length,
      leg2Total: second.trains.length,
      leg2Kept: legB.length,
      leg2Usable: entriesB.length,
      nextDayQueried,
      nextDayNote,
      sameTrainSkipped,
      matched: items.length,
      returned: Math.min(timeFiltered.length, MAX_OPTIONS),
      requests: 2 + (nextDayQueried ? 1 : 0),
    },
    items: timeFiltered.slice(0, MAX_OPTIONS),
  };
}

function wrapLegError(prefix, err) {
  const e = new Error(`${prefix}：${err.message}`);
  e.status = err.status;
  return e;
}

// ---------- 入参校验 ----------

// HH:MM 校验（允许 null/undefined/空串 = 不筛选）
function parseHm(value) {
  if (value === null || value === undefined || value === '') return null;
  const s = String(value).trim();
  if (!/^\d{2}:\d{2}$/.test(s)) return null;
  const [h, m] = s.split(':').map(Number);
  if (h > 23 || m > 59) return null;
  return s;
}

function parseWait(value, dflt) {  if (value === undefined || value === null || value === '') return dflt;
  const n = Number(value);
  if (!Number.isFinite(n) || !Number.isInteger(n) || n < MIN_WAIT_FLOOR_MINUTES || n > MAX_WAIT_MINUTES) return null;
  return n;
}

function validateTransferQuery(input, { resolveStation, now = new Date(), presaleDays = 14 } = {}) {
  const errors = [];
  const date = String((input || {}).date || '').trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    errors.push('日期格式应为 YYYY-MM-DD');
  } else {
    const day = new Date(`${date}T00:00:00`);
    if (Number.isNaN(day.getTime())) errors.push('日期无效');
    else {
      const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
      const diffDays = Math.round((day - today) / 86400000);
      if (diffDays < 0) errors.push('不能查询已过去的日期');
      else if (diffDays > presaleDays) {
        const p = (n) => String(n).padStart(2, '0');
        const max = new Date(today.getTime() + presaleDays * 86400000);
        errors.push(`日期超出预售期：最远可查 ${max.getFullYear()}-${p(max.getMonth() + 1)}-${p(max.getDate())}`);
      }
    }
  }

  const seats = Array.isArray(input.seats) ? input.seats.filter(Boolean) : [];
  const known = client.emptyTickets();
  const unknown = seats.filter((s) => !(s in known));
  if (unknown.length) errors.push(`未知席别：${unknown.join('、')}`);

  const minWait = parseWait(input.minWait, DEFAULT_MIN_WAIT_MINUTES);
  const maxWait = parseWait(input.maxWait, DEFAULT_MAX_WAIT_MINUTES);
  if (minWait === null) errors.push(`最短换乘时间应为 ${MIN_WAIT_FLOOR_MINUTES}–${MAX_WAIT_MINUTES} 的整数分钟`);
  if (maxWait === null) errors.push(`最长换乘时间应为 ${MIN_WAIT_FLOOR_MINUTES}–${MAX_WAIT_MINUTES} 的整数分钟`);
  if (minWait !== null && maxWait !== null && minWait > maxWait) errors.push('最短换乘时间不能大于最长换乘时间');

  const from = resolveStation(input.from);
  const middle = resolveStation(input.middle);
  const to = resolveStation(input.to);
  if (!from) errors.push(`无法识别的出发站：${input.from}`);
  if (!middle) errors.push(`无法识别的换乘站：${input.middle}`);
  if (!to) errors.push(`无法识别的到达站：${input.to}`);
  if (from && middle && from.code === middle.code) errors.push('换乘站不能与出发站相同');
  if (middle && to && middle.code === to.code) errors.push('换乘站不能与到达站相同');
  if (from && to && from.code === to.code) errors.push('出发站与到达站不能相同');
  // 两程都有余票的过滤依赖席别命中；不选席别时该开关静默失效，直接拦下
  if (input.onlyAvailable && !seats.length) errors.push('勾选「两程都有余票才列出」时需先选择席别');

  if (errors.length) return { errors };
  return {
    errors,
    query: {
      date,
      seats,
      minWait,
      maxWait,
      exactStation: input.exactStation === undefined ? true : Boolean(input.exactStation),
      onlyAvailable: Boolean(input.onlyAvailable),
      depFrom: parseHm(input.depFrom), arrTo: parseHm(input.arrTo),
      fromName: from.name, fromCode: from.code,
      middleName: middle.name, middleCode: middle.code,
      toName: to.name, toCode: to.code,
    },
  };
}

// ---------- 风控节流 ----------

// 全局单例闸门：
//   1) 同一时刻只允许一次中转查询在飞（inFlight）；
//   2) 两次真实查询之间至少间隔 minIntervalMs（先占位再执行，并发请求无法都通过）；
//   3) 窗口内同参数重复点击直接回缓存结果，不打上游也不重置间隔；
//   4) 上游 429/403/412 后追加冷却（penalty），避免持续冲接口。
// 执行失败同样消耗本次间隔：请求可能已部分打到上游，按已发生计。
class TransferService {
  constructor({ minIntervalMs = minIntervalFromEnv(), now = Date.now } = {}) {
    // 下限 30 秒是对上游的承诺，不因配置错误而失效
    this.minIntervalMs = Math.max(DEFAULT_MIN_INTERVAL_SECONDS * 1000, Number(minIntervalMs) || DEFAULT_MIN_INTERVAL_SECONDS * 1000);
    this.now = now || Date.now;
    this.inFlight = false;
    this.lastAt = 0;
    this.blockedUntil = 0;
    this.lastKey = null;
    this.lastResult = null;
  }

  remainingMs(at = this.now()) {
    const cooldown = this.lastAt ? Math.max(0, this.lastAt + this.minIntervalMs - at) : 0;
    const blocked = this.blockedUntil ? Math.max(0, this.blockedUntil - at) : 0;
    return Math.max(cooldown, blocked);
  }

  status(at = this.now()) {
    return {
      minIntervalSeconds: Math.round(this.minIntervalMs / 1000),
      waitSeconds: Math.ceil(this.remainingMs(at) / 1000),
      inFlight: this.inFlight,
    };
  }

  penalty(seconds) {
    const ms = Math.min(30 * 60 * 1000, Math.max(30, Number(seconds) || 60) * 1000);
    this.blockedUntil = Math.max(this.blockedUntil, this.now() + ms);
  }

  async run(key, execute) {
    if (this.inFlight) {
      const err = new Error('上一次中转查询尚未结束，请稍候');
      err.code = 'BUSY';
      throw err;
    }
    const remain = this.remainingMs();
    if (remain > 0) {
      if (key !== null && key !== undefined && key === this.lastKey && this.lastResult) {
        return { ...this.lastResult, cached: true, retryAfterSeconds: Math.ceil(remain / 1000) };
      }
      const err = new Error(
        `为避免触发风控，中转查询每 ${Math.round(this.minIntervalMs / 1000)} 秒只能执行一次，请 ${Math.ceil(remain / 1000)} 秒后再试`,
      );
      err.code = 'RATE_LIMIT';
      err.retryAfterSeconds = Math.ceil(remain / 1000);
      throw err;
    }
    this.inFlight = true;
    this.lastAt = this.now();
    try {
      const result = await execute();
      this.lastKey = key === undefined ? null : key;
      this.lastResult = result;
      return { ...result, cached: false };
    } finally {
      this.inFlight = false;
    }
  }
}

module.exports = {
  DEFAULT_MIN_WAIT_MINUTES,
  DEFAULT_MAX_WAIT_MINUTES,
  MAX_WAIT_MINUTES,
  MAX_OPTIONS,
  DEFAULT_MIN_INTERVAL_SECONDS,
  dayOffsetOf,
  legEntries,
  seatHits,
  matchTransfers,
  shiftDate,
  validateTransferQuery,
  findTransfers,
  TransferService,
};
