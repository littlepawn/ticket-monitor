'use strict';

const logger = require('./logger');
const client = require('./client');
const notifier = require('./notifier');

const EVENT_LIMIT = 200;
// 排队等待上限：超过则拒绝本次请求，避免请求堆积
const QUEUE_WAIT_MAX_MS = 60 * 1000;
// 12306 预售期（与 server.js 保持一致，可用环境变量覆盖）
const PRESALE_DAYS = Number(process.env.PRESALE_DAYS || 14);
const MAX_BACKOFF_MS = 30 * 60 * 1000;

// 本地时间（容器 TZ=Asia/Shanghai）；toISOString 是 UTC，会差 8 小时
function fmtTime(ms) {
  const d = new Date(ms);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

function inQuietHours(quiet, now = new Date()) {
  if (!quiet || !quiet.enabled) return false;
  const [sh, sm] = String(quiet.start || '23:00').split(':').map(Number);
  const [eh, em] = String(quiet.end || '07:00').split(':').map(Number);
  const cur = now.getHours() * 60 + now.getMinutes();
  const start = (sh || 0) * 60 + (sm || 0);
  const end = (eh || 0) * 60 + (em || 0);
  if (start === end) return false;
  return start < end ? cur >= start && cur < end : cur >= start || cur < end;
}

function percentile(values, p) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[idx];
}

class Monitor {
  constructor({ getConfig, onEvent }) {
    this.getConfig = getConfig;
    this.onEvent = onEvent || (() => {});
    this.timer = null;
    this.running = false;
    this.stopping = false;
    this.stations = null;
    this.stationError = null;
    this.states = new Map();
    this.events = [];
    this.durations = [];
    this.metrics = { queries: 0, errors: 0, hits: 0, pushes: 0, pushFailures: 0, lastRunAt: null };
    this.nextRunAt = null;
    // 互斥：保证任何时刻只有一个任务查询在飞。
    // 没有它时「调度 tick」与页面「立即检查」会并发，同一任务被重复请求，
    // 直接放大对 12306 的请求量 —— 与低打扰的核心约束冲突。
    this.inFlight = false;
    this.queued = false;
  }

  // 仅广播最新状态，不产生事件。供调度循环每轮结束后调用。
  // onEvent 可能未被赋值（如测试或嵌入场景），这里要容错。
  emitState() {
    if (typeof this.onState === 'function') {
      try { this.onState(this.snapshot()); } catch (err) { /* 推送失败不影响调度 */ }
    }
  }

  createEvent(kind, message, extra = {}) {
    const item = { id: `${Date.now()}_${Math.random().toString(36).slice(2, 7)}`, at: Date.now(), kind, message, ...extra };
    this.events.push(item);
    if (this.events.length > EVENT_LIMIT) this.events.splice(0, this.events.length - EVENT_LIMIT);
    this.onEvent(item);
    return item;
  }

  stateFor(watchId) {
    if (!this.states.has(watchId)) {
      this.states.set(watchId, {
        watchId,
        status: 'idle',
        lastCheckAt: null,
        lastSuccessAt: null,
        lastDurationMs: null,
        lastError: null,
        errorStreak: 0,
        backoffUntil: null,
        hits: [],
        hitSignature: '',
        hitsSince: null,
        boostUntil: null,
        lastResult: [],
        seatSummary: {},
        filterInfo: null,
      });
    }
    return this.states.get(watchId);
  }

  async loadStations() {
    try {
      this.stations = await client.getStations();
      this.stationError = null;
      return true;
    } catch (err) {
      this.stationError = err.message;
      logger.error(`车站表加载失败：${err.message}`);
      return false;
    }
  }

  stationName(code) {
    if (!this.stations) return code;
    const hit = this.stations.find((s) => s.code === code);
    return hit ? hit.name : code;
  }

  async start() {
    if (this.running) return;
    this.running = true;
    this.stopping = false;
    await this.loadStations();
    this.createEvent('system', '监控已启动');
    this.scheduleNext(2000);
  }

  stop() {
    this.stopping = true;
    this.running = false;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.nextRunAt = null;
    this.createEvent('system', '监控已停止');
  }

  scheduleNext(delayMs) {
    if (!this.running) return;
    if (this.timer) clearTimeout(this.timer);
    const jitter = Math.max(0, Number(this.getConfig().settings.jitterSeconds || 0)) * 1000;
    const extra = jitter ? Math.floor(Math.random() * jitter) : 0;
    const delay = Math.max(1000, delayMs + extra);
    this.nextRunAt = Date.now() + delay;
    this.timer = setTimeout(() => {
      this.tick().catch((err) => {
        logger.error(`调度循环异常：${err.message}`);
        // 兜底重排，避免一次意外异常让监控永久静默
        this.scheduleNext(this.computeIntervalMs());
      });
    }, delay);
  }

  // 设置（间隔/抖动）变更后立即按新值重排。
  // 不重排的话，新间隔要等当前这一轮旧间隔走完才生效，
  // 用户会看到「改了间隔但下次查询还是十几分钟后」。
  reschedule() {
    if (!this.running) return;
    const { settings } = this.getConfig();
    if (settings.jitterSeconds === undefined && settings.intervalSeconds === undefined) return;
    this.scheduleNext(this.computeIntervalMs());
    this.emitState();
  }

  computeIntervalMs() {
    const { settings } = this.getConfig();
    const base = Math.max(Number(settings.minIntervalSeconds || 300), Number(settings.intervalSeconds || 900)) * 1000;
    return base;
  }

  // 任务日期的可用性：expired（已过期）/ beyond（超预售期）/ ok
  dateStateOf(dateIso) {
    const iso = String(dateIso || '');
    if (!/^\d{4}-\d{2}-\d{2}$/.test(iso)) return 'ok';
    const pad = (n) => String(n).padStart(2, '0');
    const fmt = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
    const today = fmt(new Date());
    if (iso < today) return 'expired';
    const max = fmt(new Date(Date.now() + PRESALE_DAYS * 86400000));
    if (iso > max) return 'beyond';
    return 'ok';
  }

  // 某个任务自身是否处于命中后的快速复查窗口
  isBoosting(watchId) {
    const st = this.states.get(watchId);
    return Boolean(st && st.boostUntil && st.boostUntil > Date.now());
  }

  // 是否有任一任务在复查窗口（仅用于界面展示）
  boostActive() {
    const now = Date.now();
    for (const st of this.states.values()) {
      if (st.boostUntil && st.boostUntil > now) return true;
    }
    return false;
  }

  async tick() {
    const config = this.getConfig();
    const all = (config.watches || []).filter((w) => w.enabled !== false);

    // 只挑「本轮该查」的任务：命中过的任务按复查间隔，其余按常规间隔。
    // 之前只要有任意一个任务命中，就把**所有**任务提到 60 秒一轮 ——
    // 10 个任务时请求量会翻 15 倍，直接冲击低打扰约束。
    const now = Date.now();
    const regularDue = this.computeIntervalMs();
    const boostMs = Math.max(30, Number(config.settings.retryOnHitSeconds || 60)) * 1000;
    const due = all.filter((w) => {
      const st = this.states.get(w.id);
      const interval = (st && st.boostUntil && st.boostUntil > now) ? boostMs : regularDue;
      const last = st && st.lastSuccessAt ? st.lastSuccessAt : 0;
      return now - last >= interval;
    });

    if (due.length) {
      // 若上一轮还没跑完（例如手动检查正在进行），跳过本轮而不是并发叠加
      if (this.inFlight) {
        logger.warn('上一轮查询尚未结束，跳过本次调度（避免并发请求）');
        this.scheduleNext(regularDue);
        return;
      }
      await this.runOnce(due, { source: 'schedule' });
      // 每轮结束都要推一次状态，不能只靠事件驱动：
      // 「无票」是正常结果、不产生任何事件，若只在 createEvent 里广播，
      // 页面上的倒计时会停在 0、余票概览与车次数也永远不更新。
      this.emitState();
    }

    // 下一轮按「最近需要复查的那个任务」来定，最短 30 秒
    const anyBoost = this.boostActive();
    this.scheduleNext(anyBoost ? boostMs : regularDue);
    // scheduleNext 会重算 nextRunAt，必须在这之后再推一次，否则前端拿到的是上一轮的旧值
    this.emitState();
  }

  // 全局串行闸门：同一时刻只允许一轮查询在飞（手动与调度共用）
  async runOnce(watches, { source = 'manual', watchId = null } = {}) {
    const list = watchId ? watches.filter((w) => w.id === watchId) : watches;
    const need = new Set(list.map((w) => w.id));

    if (this.inFlight) {
      // 已有查询在飞：本轮排队等待，而不是并发发请求
      logger.warn(`已有查询进行中，${source} 本轮排队等待`);
      const deadline = Date.now() + QUEUE_WAIT_MAX_MS;
      while (this.inFlight) {
        if (Date.now() > deadline) {
          // 无上限等待会让请求无限堆积（界面连点「立即检查」时尤其明显）
          const err = new Error('已有查询长时间未结束，本次已取消以免请求堆积');
          err.code = 'BUSY';
          throw err;
        }
        await client.sleep(200);
      }
      // 刚结束的那一轮如果已经覆盖了本次要查的任务，直接复用其结果。
      // 否则每次点击都会再跑一整轮，10 次点击 = 10 倍请求量 —— 正是串行闸门要防的。
      if (this.coversScope(need)) {
        logger.info(`复用刚完成的查询结果（${source}），未重复请求上游`);
        return list.map((w) => this.snapshotWatch(w));
      }
    }

    this.inFlight = true;
    try {
      for (const watch of list) {
        // 串行执行，避免并发请求叠加触发风控
        await this.checkWatch(watch, source);
      }
      this.metrics.lastRunAt = Date.now();
      this.lastRunScope = need;
      return list.map((w) => this.snapshotWatch(w));
    } finally {
      this.inFlight = false;
    }
  }

  // 上一轮已完成的任务集合是否覆盖本次所需范围
  coversScope(need) {
    const scope = this.lastRunScope;
    if (!scope || !need || !need.size) return false;
    for (const id of need) if (!scope.has(id)) return false;
    return true;
  }

  async checkWatch(watch, source) {
    const st = this.stateFor(watch.id);
    // 日期已过期或超出预售期：查了也永远拿不到结果，
    // 只会白白增加对上游的请求量。直接跳过并标注原因。
    const dayState = this.dateStateOf(watch.date);
    if (dayState !== 'ok') {
      st.status = 'inactive';
      st.lastError = dayState === 'expired'
        ? '乘车日期已过期，请修改日期后重新启用'
        : '乘车日期超出预售期，请修改日期';
      st.filterInfo = null;
      return st;
    }
    let { fromCode, toCode } = watch;
    if (!fromCode || !toCode) {
      if (!(await this.ensureStationCodes(watch))) {
        st.status = 'error';
        st.lastError = '车站名无法识别，请重新选择出发/到达站';
        return st;
      }
      ({ fromCode, toCode } = this.resolveCodes(watch));
    }
    const now = Date.now();
    // 退避对所有来源生效（含手动）：否则用户连点「立即检查」就能绕过 429/403 退避，
    // 反而放大请求量 —— 这正是低打扰约束要防的。手动只是想立刻看结果，
    // 因此返回当前状态并附上剩余退避时间，由调用方告知用户。
    if (st.backoffUntil && st.backoffUntil > now) {
      st.status = 'backoff';
      st.lastError = st.lastError || '上游限流中，退避中';
      st.backoffRemainMs = st.backoffUntil - now;
      return st;
    }

    st.status = 'checking';
    st.lastCheckAt = now;
    const started = Date.now();
    this.metrics.queries += 1;

    // 只把「取数 + 解析」放进 try：后处理（统计、命中判定、推送）出错不应被
    // 计成查询失败，否则会给任务加上无谓的退避抑制，并把 bug 伪装成风控。
    let trains;
    let stationMap;
    try {
      const result = await client.queryTickets({
        date: watch.date,
        fromCode,
        toCode,
      });
      trains = result.trains;
      stationMap = result.stationMap;
    } catch (err) {
      const duration = Date.now() - started;
      st.lastDurationMs = duration;
      st.errorStreak += 1;
      st.lastError = err.message;
      st.status = 'error';
      // 出错时同时清掉命中加速窗口，否则会在无票数据上继续高频复查
      st.boostUntil = null;
      this.metrics.errors += 1;
      const backoff = Math.min(MAX_BACKOFF_MS, 60 * 1000 * 2 ** Math.min(st.errorStreak - 1, 5));
      st.backoffUntil = Date.now() + backoff;
      logger.warn(`查询失败（${watch.fromName}→${watch.toName} ${watch.date}）：${err.message}；${Math.round(backoff / 1000)}s 后重试`);
      if (st.errorStreak === 1 || st.errorStreak % 5 === 0) {
        this.createEvent('error', `查询失败：${watch.fromName}→${watch.toName} ${watch.date}`, {
          watchId: watch.id,
          detail: err.message,
          streak: st.errorStreak,
        });
      }
      return st;
    }

    const duration = Date.now() - started;
    this.durations.push(duration);
    if (this.durations.length > 200) this.durations.shift();
    st.lastDurationMs = duration;
    st.lastSuccessAt = Date.now();
    st.lastError = null;
    st.errorStreak = 0;
    st.backoffUntil = null;
    st.status = 'ok';

    // 以下后处理独立于查询成败：异常只记录，不改变任务状态与退避
    try {
      const nameOf = (code) => (stationMap && stationMap[code]) || this.stationName(code);
      const seatLabels = (watch.seats && watch.seats.length) ? watch.seats : Object.keys(client.emptyTickets());

      // 三个筛选维度各自独立、可任意组合；启用的维度同时生效（AND）。
      // 未启用的维度不参与过滤 —— 之前「填了车次就丢掉时段/票价」是错的，
      // 用户明确要求框内筛选必须生效。
      const { fromCode: wf, toCode: wt } = this.resolveCodes(watch);
      // 默认严格匹配站点：上游按城市返回，会把同城的其它站（如盐城大丰）也带出来，
      // 同一个车次出现两次（到站与历时都不同），会让用户误以为重复。
      const exactFrom = watch.exactStation !== false;
      const exactTo = watch.exactStation !== false;
      const byStation = client.filterByExactStation(trains, {
        fromCode: wf, toCode: wt, exactFrom, exactTo,
      });
      const stationSkipped = trains.length - byStation.length;

      const codeFilter = (watch.trains && watch.trains.length) ? watch.trains.map((c) => String(c).toUpperCase()) : null;
      const byCode = codeFilter ? byStation.filter((t) => codeFilter.includes(t.trainCode.toUpperCase())) : byStation;
      const byTimePrice = client.filterTrains(byCode, {
        timeEnabled: watch.timeEnabled,
        timeFrom: watch.timeFrom,
        timeTo: watch.timeTo,
        priceEnabled: watch.priceEnabled,
        priceMin: watch.priceMin,
        priceMax: watch.priceMax,
        durationEnabled: watch.durationEnabled,
        durationMin: watch.durationMin,
        durationMax: watch.durationMax,
      }, seatLabels);

      const filtered = byTimePrice.trains;
      st.filterInfo = {
        total: trains.length,
        // 严格站点匹配时剔除了同城其它站的车次
        stationSkipped,
        exactStation: exactFrom || exactTo,
        afterCode: byCode.length,
        kept: filtered.length,
        byCode: Boolean(codeFilter),
        byTime: Boolean(watch.timeEnabled),
        byPrice: Boolean(watch.priceEnabled),
        byDuration: Boolean(watch.durationEnabled),
        // 指定了车次但一个都没匹配上：通常意味着车次号写错，或该车次当天不运行。
        // 这跟「无票」是两回事，必须区分，否则用户会以为只是没票。
        emptiedByCode: Boolean(codeFilter) && byCode.length === 0,
        // 车次匹配上了，但没有一个满足时段/票价
        emptiedByTimePrice: byCode.length > 0 && filtered.length === 0,
        skippedByPrice: byTimePrice.skippedByPrice,
      };

      st.lastResult = filtered.map((t) => ({
        trainCode: t.trainCode,
        // 经停站接口需要 train_no（内部编号），不是车次号 G2；这里带上供前端按需查询
        trainNo: t.trainNo,
        startTime: t.startTime,
        arriveTime: t.arriveTime,
        duration: t.duration,
        fromName: nameOf(t.fromCode),
        toName: nameOf(t.toCode),
        tickets: t.tickets,
        prices: t.prices,
        canWebBuy: t.canWebBuy,
      }));
      st.seatSummary = this.seatSummary(filtered, watch.seats || []);

      const hits = client.pickHits(filtered, seatLabels);
      await this.applyHits(watch, st, hits, nameOf);
    } catch (err) {
      // 查询本身是成功的：这里只报告后处理异常，不改状态、不加退避
      logger.error(`结果处理失败（${watch.fromName}→${watch.toName} ${watch.date}）：${err.message}`);
      this.createEvent('error', `结果处理失败：${watch.fromName}→${watch.toName}（查询本身正常）`, {
        watchId: watch.id,
        detail: err.message,
      });
    }
    return st;
  }

  // 只读解析站名，不直接改写传入对象：watch 是 config 的引用，
  // 就地写入会让「未保存的配置」被静默修改。
  resolveCodes(watch) {
    const fromCode = watch.fromCode || (watch.from && client.resolveStation(watch.from, this.stations) || {}).code;
    const toCode = watch.toCode || (watch.to && client.resolveStation(watch.to, this.stations) || {}).code;
    return { fromCode, toCode };
  }

  async ensureStationCodes(watch) {
    if (!this.stations && !(await this.loadStations())) return false;
    // 解析结果只用于本次查询，不回写 config
    const { fromCode, toCode } = this.resolveCodes(watch);
    return Boolean(fromCode && toCode);
  }

  seatSummary(trains, seatLabels) {
    const labels = seatLabels.length ? seatLabels : Object.keys(client.emptyTickets());
    const summary = {};
    for (const label of labels) {
      let available = 0;
      let waiting = 0;
      for (const t of trains) {
        const v = t.tickets[label];
        if (v === '有' || (/^\d+$/.test(v) && Number.parseInt(v, 10) > 0)) available += 1;
        else if (v === '候补') waiting += 1;
      }
      summary[label] = { available, waiting, total: trains.length };
    }
    return summary;
  }

  signatureOf(hits) {
    // 把席别与余票状态都纳入签名：否则「二等座 无 → 有」而车次集合不变时会漏推
    return hits
      .map((h) => `${h.trainCode}:${Object.entries(h.matched).sort().map(([k, v]) => `${k}=${v}`).join(',')}`)
      .sort()
      .join('|');
  }

  async applyHits(watch, st, hits, nameOf) {
    const signature = this.signatureOf(hits);
    const prev = st.hitSignature;
    st.hits = hits;

    if (!hits.length) {
      st.hitSignature = signature;
      if (prev && prev !== '') {
        st.hitsSince = null;
        this.createEvent('clear', `余票已消失：${watch.fromName}→${watch.toName} ${watch.date}`, { watchId: watch.id });
        if (this.getConfig().settings.notifyRecovery) {
          await this.notify(watch, `余票已消失 · ${watch.fromName}→${watch.toName}`, this.formatHits(watch, [], nameOf), {
            kind: 'recovery',
          });
        }
      }
      st.boostUntil = null;
      return;
    }

    st.hitsSince = st.hitsSince || Date.now();
    const settings = this.getConfig().settings;
    if (signature !== prev) {
      this.metrics.hits += 1;
      this.createEvent('hit', `发现余票：${watch.fromName}→${watch.toName} ${watch.date}`, {
        watchId: watch.id,
        detail: hits.map((h) => `${h.trainCode} ${Object.entries(h.matched).map(([k, v]) => `${k}${v}`).join(' ')}`).join('；'),
      });
      if (settings.notifyOnHit) {
        const r = await this.notify(watch, `发现余票 · ${watch.fromName}→${watch.toName}`, this.formatHits(watch, hits, nameOf), {
          kind: 'hit',
        });
        // 只有「真的送到」或「用户没配渠道（只记事件）」才算已通知。
        // 静默时段跳过 / 全部渠道发送失败都不能记账，否则这条余票
        // 之后再也不会提醒 —— 命中被静默吞掉比多发一条严重得多。
        // 保留旧签名，等下一轮重试（boost 照常设，保证快速复查）。
        // r 为 undefined 时（例如被测试替换的 notify）按「已送达」处理，
        // 兼容未返回结构的实现；只有明确报出 failed/skippedQuiet 才重试。
        const notified = !r || r.delivered || r.skippedNoChannel;
        st.hitSignature = notified ? signature : prev;
      } else {
        st.hitSignature = signature;
      }
    } else {
      st.hitSignature = signature;
    }
    const maxMs = Math.max(1, Number(settings.retryOnHitMaxMinutes || 10)) * 60 * 1000;
    const within = Date.now() - (st.hitsSince || Date.now()) < maxMs;
    // 与 tick() 用同一个设置，否则用户在页面上调「命中后复查间隔」不生效
    const boostMs = Math.max(30, Number(settings.retryOnHitSeconds || 60)) * 1000;
    st.boostUntil = within ? Date.now() + boostMs : null;
  }

  formatHits(watch, hits, nameOf) {
    const head = `${watch.date}　${watch.fromName} → ${watch.toName}`;
    if (!hits.length) return `${head}\n\n当前无票。`;
    const lines = hits.slice(0, 15).map((h) => {
      const seats = Object.entries(h.matched)
        .map(([k, v]) => {
          const price = (h.prices || {})[k];
          return `${k} ${v}${typeof price === 'number' ? `（¥${price}）` : ''}`;
        })
        .join(' / ');
      return `${h.trainCode}　${h.startTime}-${h.arriveTime}（${h.duration}）\n　${seats}`;
    });
    const more = hits.length > 15 ? `\n\n…另有 ${hits.length - 15} 个车次有票，详见监控页面` : '';
    return `${head}\n\n${lines.join('\n')}${more}\n\n查询时间：${fmtTime(Date.now())}（北京时间）`;
  }

  // 返回 { delivered, skippedQuiet, skippedNoChannel }：
  // 调用方据此决定是否把本次命中标记为「已通知」，避免静默时段把通知永久吞掉。
  async notify(watch, title, body, meta = {}) {
    const config = this.getConfig();
    if (inQuietHours(config.settings.quietHours)) {
      this.createEvent('info', `处于静默时段，已跳过推送：${title}`, { watchId: watch.id });
      return { delivered: false, skippedQuiet: true };
    }
    const channels = (config.channels || []).filter((c) => c.enabled !== false);
    if (!channels.length) {
      this.createEvent('info', `未配置推送渠道，仅记录：${title}`, { watchId: watch.id });
      return { delivered: false, skippedNoChannel: true };
    }
    let delivered = 0;
    for (const channel of channels) {
      let r;
      try {
        r = await notifier.send(channel, title, body, { watchId: watch.id, date: watch.date, ...meta });
      } catch (err) {
        // 单个渠道异常不应影响其他渠道，也不应冒泡打断本轮查询
        r = { ok: false, error: err.message };
      }
      if (r.ok) { this.metrics.pushes += 1; delivered += 1; }
      else {
        this.metrics.pushFailures += 1;
        this.createEvent('pushfail', `推送失败 [${channel.name || channel.type}]：${r.error}`, { watchId: watch.id });
      }
    }
    return { delivered: delivered > 0, failed: delivered === 0 };
  }

  // 手动检查也要走 runOnce 的串行闸门：否则用户连点「立即检查」或与调度撞上时
  // 会并发发请求，放大对 12306 的压力（低打扰是硬约束）。
  async checkNow(watchId) {
    const config = this.getConfig();
    const watches = (config.watches || []).filter((w) => w.enabled !== false);
    if (watchId) {
      const watch = watches.find((w) => w.id === watchId);
      if (!watch) throw new Error('任务不存在或已停用');
      const st = this.stateFor(watch.id);
      if (st.backoffUntil && st.backoffUntil > Date.now()) {
        const sec = Math.ceil((st.backoffUntil - Date.now()) / 1000);
        const err = new Error(`该任务正在退避中（上游限流或连续失败），约 ${sec} 秒后可再查`);
        err.code = 'BACKOFF';
        err.retryAfterSeconds = sec;
        throw err;
      }
      const [snap] = await this.runOnce(watches, { source: 'manual', watchId });
      return snap;
    }
    return this.runOnce(watches, { source: 'manual' });
  }

  async testChannel(channel) {
    const title = '测试推送 · 火车票余票监控';
    const body = `这是一条测试消息。\n\n如果你收到它，说明渠道配置可用。\n时间：${fmtTime(Date.now())}（北京时间）`;
    const r = await notifier.send(channel, title, body, { kind: 'test' });
    return r;
  }

  snapshotWatch(watch) {
    const st = this.stateFor(watch.id);
    return {
      watchId: watch.id,
      name: `${watch.fromName} → ${watch.toName} ${watch.date}`,
      status: st.status,
      lastCheckAt: st.lastCheckAt,
      lastSuccessAt: st.lastSuccessAt,
      lastDurationMs: st.lastDurationMs,
      lastError: st.lastError,
      errorStreak: st.errorStreak,
      hits: st.hits,
      hitCount: st.hits.length,
      hitsSince: st.hitsSince,
      boostUntil: st.boostUntil,
      seatSummary: st.seatSummary,
      resultCount: st.lastResult.length,
      lastResult: st.lastResult.slice(0, 60),
      filterInfo: st.filterInfo,
    };
  }

  snapshot() {
    const config = this.getConfig();
    const watches = (config.watches || []).map((w) => this.snapshotWatch(w));
    return {
      running: this.running,
      nextRunAt: this.nextRunAt,
      intervalSeconds: config.settings.intervalSeconds,
      boostActive: this.boostActive(),
      stationsLoaded: Boolean(this.stations),
      stationCount: this.stations ? this.stations.length : 0,
      stationError: this.stationError,
      quietNow: inQuietHours(config.settings.quietHours),
      metrics: {
        ...this.metrics,
        p50: percentile(this.durations, 50),
        p90: percentile(this.durations, 90),
        window: this.durations.length,
      },
      watches,
      localTime: fmtTime(Date.now()),
    };
  }

  recentEvents(limit = 100) {
    return this.events.slice(-limit).reverse();
  }
}

module.exports = { Monitor, inQuietHours, percentile };
