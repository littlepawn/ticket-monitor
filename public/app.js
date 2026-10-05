'use strict';

/* ---------- 基础工具 ---------- */
// 与后端 PRESALE_DAYS 保持一致（12306 约 15 天预售期）
const PRESALE_DAYS_UI = 14;
const TOKEN_KEY = 'tm_token';
const url = new URL(location.href);
const urlToken = url.searchParams.get('token');
if (urlToken) {
  localStorage.setItem(TOKEN_KEY, urlToken);
  // 令牌留在地址栏会进入历史记录与截图，落库后立即抹掉
  url.searchParams.delete('token');
  const clean = url.pathname + (url.searchParams.toString() ? '?' + url.searchParams.toString() : '') + url.hash;
  history.replaceState(null, '', clean);
}
let TOKEN = urlToken || localStorage.getItem(TOKEN_KEY) || '';

let state = null;
let config = null;
let activeTab = 'overview';

// EventSource 无法自定义请求头，只有它需要把 token 放进查询串；
// fetch 一律走 X-Token，避免令牌进入浏览器历史、地址栏与 Referer。
function withToken(path) {
  if (!TOKEN) return path;
  return path + (path.includes('?') ? '&' : '?') + 'token=' + encodeURIComponent(TOKEN);
}

// 并发 401 共享同一个输入 Promise，避免第二个请求误报「令牌无效」
let tokenRetryPromise = null;

async function api(path, options = {}) {
  const res = await fetch(path, {
    ...options,
    headers: { 'Content-Type': 'application/json', ...(TOKEN ? { 'X-Token': TOKEN } : {}), ...(options.headers || {}) },
  });
  // 401：弹出输入框要令牌（而不是让用户自己往 URL 加 ?token=），
  // 拿到后存本地并自动重试一次，用户无感。
  if (res.status === 401) {
    // 并发请求可能同时收到 401。若用单个布尔标记，第二个请求会跳过输入框
    // 直接抛「访问令牌无效」——而用户其实正要填。改为共享同一个 Promise：
    // 所有并发请求都等这一次的输入结果，拿到后各自重试。
    if (!tokenRetryPromise) {
      tokenRetryPromise = tokenDialog().finally(() => { tokenRetryPromise = null; });
    }
    const entered = await tokenRetryPromise;
    if (entered) {
      TOKEN = entered;
      localStorage.setItem(TOKEN_KEY, entered);
      return await api(path, options);
    }
    throw new Error('访问令牌无效');
  }
  const text = await res.text();
  let data = {};
  try { data = text ? JSON.parse(text) : {}; } catch (e) { data = { error: text.slice(0, 200) }; }
  if (!res.ok) {
    const msg = data.errors ? data.errors.join('\n') : (data.error || `HTTP ${res.status}`);
    throw new Error(msg);
  }
  return data;
}

function el(id) { return document.getElementById(id); }
function esc(s) {
  return String(s === undefined || s === null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
function safeState(s) {
  // 服务端字段缺失时不要整页报错
  return s && typeof s === 'object' ? s : null;
}
function fmtTime(ms) {
  if (!ms) return '--';
  const d = new Date(ms);
  const p = (n) => String(n).padStart(2, '0');
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}
function fmtDateTime(ms) {
  if (!ms) return '--';
  const d = new Date(ms);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getMonth() + 1}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}
function countdown(ms) {
  if (!ms) return '--';
  const diff = Math.max(0, Math.round((ms - Date.now()) / 1000));
  if (diff < 60) return `${diff} 秒后`;
  return `${Math.floor(diff / 60)} 分 ${diff % 60} 秒后`;
}
function toast(msg, kind = '') {
  const box = el('toast');
  const div = document.createElement('div');
  div.className = kind;
  div.textContent = msg;
  box.appendChild(div);
  setTimeout(() => div.remove(), 4200);
}
// 该任务的乘车日期是否已过期（过期后无法查询，也无法启用）
function isExpired(dateIso) {
  if (!dateIso) return false;
  return String(dateIso) < todayPlus(0);
}

// 是否超出预售期（12306 约 15 天）
function isBeyondPresale(dateIso) {
  if (!dateIso) return false;
  return String(dateIso) > todayPlus(PRESALE_DAYS_UI);
}

function todayPlus(days) {
  const d = new Date(Date.now() + days * 86400000);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/* ---------- 标签页 ---------- */
document.querySelectorAll('nav.tabs button').forEach((btn) => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('nav.tabs button').forEach((b) => b.classList.toggle('active', b === btn));
    activeTab = btn.dataset.tab;
    ['overview', 'watches', 'channels', 'events', 'settings'].forEach((t) => {
      el('tab-' + t).hidden = t !== activeTab;
    });
    if (activeTab === 'settings' && config) fillSettings();
    // 切到事件页立即拉一次，否则要等 5 秒轮询才出内容
    if (activeTab === 'events') loadEvents();
  });
});

/* ---------- 顶栏 ---------- */
el('toggleMonitor').addEventListener('click', async () => {
  try {
    const running = state && state.running;
    await api('/api/monitor/' + (running ? 'stop' : 'start'), { method: 'POST' });
    toast(running ? '监控已停止' : '监控已启动', 'ok');
    refreshState();
  } catch (err) { toast(err.message, 'err'); }
});

el('checkAll').addEventListener('click', async (e) => {
  const btn = e.currentTarget;
  btn.disabled = true;
  btn.textContent = '检查中…';
  try {
    await api('/api/check-all', { method: 'POST' });
    toast('已完成一轮检查', 'ok');
  } catch (err) { toast(err.message, 'err'); }
  btn.disabled = false;
  btn.textContent = '立即检查';
  refreshState();
});

el('refreshEvents').addEventListener('click', refreshState);

/* ---------- 日期选择器 ----------
   原生 <input type="date"> 的弹层由浏览器绘制，样式无法定制（与暗色主题格格不入，
   字号也偏小），所以自研一个：外观与站点下拉一致，桌面/移动都够大。 */
function fmtDateCn(iso) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(iso || ''));
  if (!m) return iso || '';
  const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  const week = ['日', '一', '二', '三', '四', '五', '六'][d.getDay()];
  return `${m[1]}年${Number(m[2])}月${Number(m[3])}日 周${week}`;
}

// 分钟 → 输入框文本（270 → "4:30"，整点小时 → "4:00"）
function fmtDurationInput(minutes) {
  const n = Number(minutes);
  if (!Number.isFinite(n)) return '';
  const h = Math.floor(n / 60);
  const m = n % 60;
  return `${h}:${String(m).padStart(2, '0')}`;
}

function isoOf(y, m, d) {
  const p = (n) => String(n).padStart(2, '0');
  return `${y}-${p(m)}-${p(d)}`;
}

// mount：容器元素；initial：初始 ISO 日期；minIso/maxIso：可选区间
function createDatePicker(mount, { initial, minIso, maxIso } = {}) {
  const today = todayPlus(0);
  let value = initial || todayPlus(1);
  let view = (() => {
    const m = /^(\d{4})-(\d{2})/.exec(value);
    return m ? { y: Number(m[1]), m: Number(m[2]) } : (() => { const d = new Date(); return { y: d.getFullYear(), m: d.getMonth() + 1 }; })();
  })();

  const root = document.createElement('div');
  root.className = 'dp';
  root.innerHTML = `
    <button type="button" class="dp-input" aria-haspopup="dialog" aria-expanded="false">
      <span class="dp-value"></span>
      <svg class="dp-cal" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" aria-hidden="true"><rect x="3.5" y="5" width="17" height="15.5" rx="2.5"/><path d="M3.5 9.5h17M8 3.5V6M16 3.5V6"/></svg>
    </button>
    <div class="dp-pop" role="dialog" hidden>
      <div class="dp-head">
        <button type="button" class="dp-nav" data-prev aria-label="上个月">‹</button>
        <span class="dp-title"></span>
        <button type="button" class="dp-nav" data-next aria-label="下个月">›</button>
      </div>
      <div class="dp-week">${['日', '一', '二', '三', '四', '五', '六'].map((w) => `<span>${w}</span>`).join('')}</div>
      <div class="dp-grid"></div>
      <div class="dp-foot">
        <button type="button" class="btn tiny" data-clear>清除</button>
        <button type="button" class="btn tiny primary" data-today>今天</button>
      </div>
    </div>`;
  mount.appendChild(root);

  const pop = root.querySelector('.dp-pop');
  const btn = root.querySelector('.dp-input');
  const title = root.querySelector('.dp-title');
  const grid = root.querySelector('.dp-grid');
  const valueEl = root.querySelector('.dp-value');

  const inRange = (iso) => (!minIso || iso >= minIso) && (!maxIso || iso <= maxIso);

  function render() {
    valueEl.textContent = value ? fmtDateCn(value) : '选择日期';
    btn.classList.toggle('empty', !value);
    title.textContent = `${view.y} 年 ${view.m} 月`;
    const first = new Date(view.y, view.m - 1, 1);
    const startPad = first.getDay();
    const daysInMonth = new Date(view.y, view.m, 0).getDate();
    const prevDays = new Date(view.y, view.m - 1, 0).getDate();
    const cells = [];
    for (let i = startPad - 1; i >= 0; i -= 1) cells.push({ d: prevDays - i, muted: true, y: view.m === 1 ? view.y - 1 : view.y, m: view.m === 1 ? 12 : view.m - 1 });
    for (let d = 1; d <= daysInMonth; d += 1) cells.push({ d, muted: false, y: view.y, m: view.m });
    while (cells.length % 7 !== 0) {
      const last = cells[cells.length - 1];
      const nd = new Date(last.y, last.m - 1, last.d + 1);
      cells.push({ d: nd.getDate(), muted: true, y: nd.getFullYear(), m: nd.getMonth() + 1 });
    }
    grid.innerHTML = cells.map((c) => {
      const iso = isoOf(c.y, c.m, c.d);
      const cls = ['dp-day'];
      if (c.muted) cls.push('muted');
      if (iso === value) cls.push('sel');
      if (iso === today) cls.push('today');
      const dis = !inRange(iso);
      if (dis) cls.push('dis');
      return `<button type="button" class="${cls.join(' ')}" data-iso="${iso}"${dis ? ' disabled' : ''}>${c.d}</button>`;
    }).join('');
  }

  function open() {
    if (!pop.hidden) return;
    pop.hidden = false;
    btn.setAttribute('aria-expanded', 'true');
    // 打开时定位到当前选中值所在月份
    if (value) {
      const m = /^(\d{4})-(\d{2})/.exec(value);
      if (m) view = { y: Number(m[1]), m: Number(m[2]) };
    }
    render();
    openPickers.push(close);
  }
  function close() {
    if (pop.hidden) return;
    pop.hidden = true;
    btn.setAttribute('aria-expanded', 'false');
    const i = openPickers.indexOf(close);
    if (i >= 0) openPickers.splice(i, 1);
  }

  btn.addEventListener('click', (e) => { e.stopPropagation(); if (pop.hidden) open(); else close(); });
  pop.addEventListener('click', (e) => e.stopPropagation());
  root.querySelector('[data-prev]').addEventListener('click', () => { view.m -= 1; if (view.m === 0) { view.m = 12; view.y -= 1; } render(); });
  root.querySelector('[data-next]').addEventListener('click', () => { view.m += 1; if (view.m === 13) { view.m = 1; view.y += 1; } render(); });
  root.querySelector('[data-today]').addEventListener('click', () => {
    if (inRange(today)) { value = today; render(); close(); root.dispatchEvent(new Event('change')); }
  });
  root.querySelector('[data-clear]').addEventListener('click', () => { value = ''; render(); close(); root.dispatchEvent(new Event('change')); });
  grid.addEventListener('click', (e) => {
    const b = e.target.closest('.dp-day');
    if (!b || b.disabled) return;
    value = b.dataset.iso;
    render();
    close();
    root.dispatchEvent(new Event('change'));
  });
  // 点空白处关闭
  document.addEventListener('click', close);

  render();
  return {
    get value() { return value; },
    set value(v) { value = v || ''; render(); },
    close,
    destroy() { document.removeEventListener('click', close); root.remove(); },
  };
}

// 同一时刻只允许一个日期弹层打开
const openPickers = [];
function closeAllPickers() { [...openPickers].forEach((fn) => fn()); }

/* ---------- 状态渲染 ---------- */
function renderStats() {
  if (!state) return;
  const m = state.metrics;
  const hits = state.watches.reduce((sum, w) => sum + w.hitCount, 0);
  const cards = [
    { k: '运行状态', v: state.running ? '运行中' : '已停止', cls: state.running ? '' : '' },
    { k: '监控任务', v: `${state.watches.length} 个` },
    { k: '当前有票任务', v: `${state.watches.filter((w) => w.hitCount > 0).length} 个`, cls: hits ? 'hit' : '' },
    { k: '累计查询', v: m.queries },
    { k: '累计命中', v: m.hits, cls: m.hits ? 'hit' : '' },
    { k: '推送成功 / 失败', v: `${m.pushes} / ${m.pushFailures}`, small: true },
    { k: '查询延迟 p50 / p90', v: `${m.p50 || 0} / ${m.p90 || 0} ms`, small: true },
    { k: '最近错误', v: m.errors, cls: m.errors ? '' : '' },
    { k: '车站表', v: state.stationsLoaded ? `${state.stationCount} 站` : '未加载', small: true },
    { k: '本地时间', v: localClock(), small: true, id: 'statClock' },
  ];
  el('stats').innerHTML = cards.map((c) => `
    <div class="stat ${c.cls || ''}">
      <div class="k">${esc(c.k)}</div>
      <div class="v ${c.small ? 'small' : ''}"${c.id ? ` id="${c.id}"` : ''}>${esc(c.v)}</div>
    </div>`).join('');
}

// 席别用「彩色小圆点」区分，文字保持中性色 ——
// 之前整块文字换色会让一行里出现十几个彩色字，反而更难扫读；
// 圆点只占 8px，颜色再多也不会糊成一片。
// 键名沿用官方席别代号，便于与 queryLeftTicket 的 seat_types 对照。
const SEAT_DOT_KEY = {
  商务座: 'swz', 特等座: 'tz', 优选一等座: 'gg',
  一等座: 'zy', 二等座: 'ze', 软座: 'rz',
  高级软卧: 'gr', 软卧: 'rw', 硬卧: 'yw', 动卧: 'dw', 一等卧: 'yw1', 二等卧: 'yw2',
  硬座: 'yz', 无座: 'wz', 其他: 'qt',
};

function seatDotClass(label) {
  return `dot-${SEAT_DOT_KEY[label] || 'qt'}`;
}

// 圆点：有票实心、无票空心（靠 --dot 变量上色，样式在 CSS 里）
function seatDot(label, filled) {
  return `<i class="seat-dot ${seatDotClass(label)}${filled ? ' on' : ''}" aria-hidden="true"></i>`;
}

function seatChips(summary) {
  const entries = Object.entries(summary || {});
  if (!entries.length) return '<span class="muted">尚未查询</span>';
  if (entries.every(([, s]) => s.total === 0)) return '';
  // 有票的排前面：一行里最该被看到的信息放最左
  const rank = ([, s]) => (s.available > 0 ? 0 : (s.waiting > 0 ? 1 : 2));
  return entries
    .sort((a, b) => rank(a) - rank(b))
    .map(([label, s]) => {
      const filled = s.available > 0 || s.waiting > 0;
      const dot = seatDot(label, filled);
      if (s.available > 0) {
        return `<span class="seat has" title="${s.available}/${s.total} 个车次有票">${dot}${esc(label)} <b>${s.available}</b></span>`;
      }
      if (s.waiting > 0) {
        return `<span class="seat wait" title="${s.waiting}/${s.total} 个车次可候补">${dot}${esc(label)} 候补</span>`;
      }
      return `<span class="seat" title="当前无票">${dot}${esc(label)}</span>`;
    })
    .join('');
}

function statusBadge(w, cfg) {
  // 过期优先显示：即使有历史结果也不再更新，避免误导
  if (cfg && isExpired(cfg.date)) return '<span class="badge err">日期已过期</span>';
  if (cfg && isBeyondPresale(cfg.date)) return '<span class="badge warn">超出预售期</span>';
  if (cfg && cfg.enabled === false) return '<span class="badge warn">已停用</span>';
  if (w.status === 'checking') return '<span class="badge brand">查询中</span>';
  if (w.status === 'error') return `<span class="badge err">失败 ${w.errorStreak > 1 ? '×' + w.errorStreak : ''}</span>`;
  if (w.status === 'backoff') return '<span class="badge warn">退避中</span>';
  if (w.hitCount > 0) return `<span class="badge ok">有票 ${w.hitCount}</span>`;
  if (w.status === 'ok') {
    // 三种「没结果」必须区分：车次写错 / 被筛选排除 / 确实无票
    if (w.filterInfo && w.filterInfo.emptiedByCode) return '<span class="badge err">车次不匹配</span>';
    if (w.filterInfo && w.filterInfo.emptiedByTimePrice) return '<span class="badge warn">筛选后无车次</span>';
    return '<span class="badge">无票</span>';
  }
  return '<span class="badge">待查询</span>';
}

function watchMeta(w) {
  const parts = [];
  parts.push(`上次查询：${fmtTime(w.lastCheckAt)}${w.lastDurationMs ? `（${w.lastDurationMs}ms）` : ''}`);
  parts.push(`共 ${w.resultCount} 个车次`);
  if (w.boostUntil) parts.push(`快速复查中，至 ${fmtTime(w.boostUntil)}`);
  if (w.lastError) parts.push(`错误：${w.lastError}`);
  return parts.map((p) => `<span>${esc(p)}</span>`).join('');
}

function renderOverview() {
  if (!state) return;
  const list = state.watches;
  if (!list.length) {
    el('overviewWatches').innerHTML = '<div class="empty">还没有监控任务，去「监控任务」页新增一个。</div>';
    return;
  }
  el('overviewWatches').innerHTML = list.map((w) => {
    // 有票的任务整卡可点，直接看到车次详情；无票的也给入口但弱化
    const clickable = w.hitCount > 0 ? 'clickable has-hit' : 'clickable';
    const seatHtml = seatChips(w.seatSummary);
    return `
    <div class="watch ${clickable} ${w.hitCount ? 'hit' : ''} ${w.status === 'error' ? 'err' : ''}"
         data-detail="${esc(w.watchId)}" role="button" tabindex="0"
         title="${w.hitCount > 0 ? '点击查看有票车次详情' : '点击查看最近一次查询结果'}">
      <div class="watch-head">
        <span class="title">${esc(w.name)}</span>
        ${statusBadge(w)}
        <span class="spacer"></span>
        <span class="detail-cta">${w.hitCount > 0 ? '查看详情 →' : '查看结果 →'}</span>
      </div>
      <div class="info">${watchMeta(w)}</div>
      ${seatHtml ? `<div class="seats">${seatHtml}</div>` : ''}
    </div>`;
  }).join('');

  el('overviewWatches').querySelectorAll('[data-detail]').forEach((card) => {
    const open = () => openDetailModal(card.dataset.detail);
    card.addEventListener('click', open);
    // 键盘可达：Enter / Space
    card.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); open(); }
    });
  });
}

// 表格排序：有票车次优先，其次按发车时间。余票张数多的更靠前。
function sortByAvailability(list, seatLabels) {
  if (!Array.isArray(list)) return [];
  const score = (t) => {
    const labels = (seatLabels && seatLabels.length) ? seatLabels : Object.keys(t.tickets || {});
    let best = -1; // -1 无票 / 0 有票(「有」) / N 具体张数
    for (const s of labels) {
      const v = (t.tickets || {})[s];
      if (v === '有') best = Math.max(best, 9999);
      else if (/^\d+$/.test(v || '')) best = Math.max(best, Number(v));
    }
    return best;
  };
  return [...list].sort((a, b) => {
    const sa = score(a); const sb = score(b);
    const ha = sa > 0 ? 1 : 0; const hb = sb > 0 ? 1 : 0;
    if (ha !== hb) return hb - ha;            // 有票在前
    if (sa !== sb) return sb - sa;            // 张数多的在前
    const ta = a.startTime || ''; const tb = b.startTime || '';
    if (ta !== tb) return ta < tb ? -1 : 1;   // 再按发车时间
    return String(a.trainCode).localeCompare(String(b.trainCode));
  });
}

// 取该车次在勾选席别中的最低票价（元），与后端 lowestPrice 口径一致
function lowestOf(train, seatLabels) {
  const prices = train.prices || {};
  const labels = (seatLabels && seatLabels.length) ? seatLabels : Object.keys(prices);
  let min = null;
  for (const label of labels) {
    const p = prices[label];
    if (typeof p === 'number' && p > 0 && (min === null || p < min)) min = p;
  }
  return min;
}

function renderWatches() {
  if (!state || !config) return;
  if (!state.watches.length) {
    el('watchList').innerHTML = '<div class="panel"><div class="empty">暂无任务。点击「+ 新增任务」添加出发站、到达站、日期与席别偏好。</div></div>';
    return;
  }
  el('watchList').innerHTML = state.watches.map((w) => {
    const cfg = config.watches.find((x) => x.id === w.watchId) || {};
    const seatLabels = cfg.seats || [];
    // 有票的排前面：不排序时表格按发车时间排，勾选的席别全空的车次会堆在上面，
    // 真正有票的（常是下午/夜间的普速）被埋在十几行之后，等于没看到。
    const sortedRows = sortByAvailability(w.lastResult || [], seatLabels);
    const header = ['车次', '出发', '到达', '历时', ...seatLabels, '最低价'];
    const headerHtml = ['车次', '出发', '到达', '历时']
      .map((h) => `<th>${esc(h)}</th>`).join('')
      + seatLabels.map((sl) => `<th class="seat-col">${seatDot(sl, true)}${esc(sl)}</th>`).join('')
      + '<th class="num">最低价</th>';
    const rows = sortedRows.map((t) => {
      const codeCell = `<td><button class="train-link" data-stops="${esc(t.trainNo || '')}" data-code="${esc(t.trainCode)}" data-watch="${esc(w.watchId)}" data-name="${esc(w.name)}" title="查看经停站">${esc(t.trainCode)}</button></td>`;
      const cells = [t.startTime, t.arriveTime, t.duration].map((v) => `<td>${esc(v)}</td>`).join('');
      const seatCells = seatLabels.map((s) => {
        const v = t.tickets[s] || '';
        const has = v === '有' || (/^\d+$/.test(v) && Number(v) > 0);
        const price = (t.prices || {})[s];
        // 每个席别显示自己的票价（来自余票响应的 yp_info_new，无需额外请求）
        const priceHtml = typeof price === 'number' ? `<span class="seat-price">¥${price}</span>` : '';
        return `<td class="seat-cell ${has ? 'has' : ''}"><span class="seat-status">${esc(v || '-')}</span>${priceHtml}</td>`;
      }).join('');
      const low = lowestOf(t, seatLabels);
      return `<tr>${codeCell}${cells}${seatCells}<td class="num">${low === null ? '-' : '¥' + low}</td></tr>`;
    }).join('');

    const filterChips = [];
    if (cfg.trains && cfg.trains.length) filterChips.push(`<span class="badge">车次 ${esc(cfg.trains.join('/'))}</span>`);
    if (cfg.timeEnabled) {
      filterChips.push(`<span class="badge brand">时段 ${esc(cfg.timeFrom || '00:00')}–${esc(cfg.timeTo || '24:00')}</span>`);
    }
    if (cfg.priceEnabled) {
      const lo = (cfg.priceMin === null || cfg.priceMin === undefined) ? '' : `¥${cfg.priceMin}`;
      const hi = (cfg.priceMax === null || cfg.priceMax === undefined) ? '' : `¥${cfg.priceMax}`;
      filterChips.push(`<span class="badge brand">票价 ${esc(lo || '不限')}–${esc(hi || '不限')}</span>`);
    }

    const fi = w.filterInfo;
    let filterNote = '';
    if (fi && (fi.byCode || fi.byTime || fi.byPrice)) {
      const parts = [`共 ${fi.total}`];
      if (fi.byCode) parts.push(`车次后 ${fi.afterCode}`);
      if (fi.byTime || fi.byPrice) parts.push(`筛选后 ${fi.kept}`);
      filterNote = `<span class="muted">${esc(parts.join(' → '))} 个车次</span>`;
    }
    // 关键体验：筛选把结果清空时说清原因，而不是让用户对着空白猜
    if (fi && fi.emptiedByCode) {
      filterNote += `<span class="warn-note">该区间当天没有匹配的车次，请检查车次号是否写错（或该车次当天不运行）</span>`;
    } else if (fi && fi.emptiedByTimePrice) {
      filterNote += `<span class="warn-note">当前筛选条件下没有符合条件的车次`
        + `${fi.byCode ? `（${fi.afterCode} 个车次全部被时段或票价排除）` : ''}，可在「编辑」中放宽条件</span>`;
    }

    const expired = isExpired(cfg.date);
    const beyond = isBeyondPresale(cfg.date);
    const disabled = cfg.enabled === false;
    // 过期或超出预售期：数据不会再更新，整卡置灰以免看着像在监控
    const inert = expired || beyond;
    const toggleBtn = disabled
      ? `<button class="btn" data-toggle="${w.watchId}"${inert ? ` disabled title="${expired ? '日期已过期' : '超出预售期'}，请先修改日期"` : ''}>启用</button>`
      : `<button class="btn" data-toggle="${w.watchId}">停用</button>`;
    const expireNote = expired
      ? `<span class="warn-note">乘车日期 ${esc(cfg.date)} 已过期，监控已停止。修改日期后才能重新启用。</span>`
      : (beyond ? `<span class="warn-note">乘车日期 ${esc(cfg.date)} 超出预售期（最远 ${esc(todayPlus(PRESALE_DAYS_UI))}）。修改日期后才能启用。</span>` : '');

    return `
    <div class="panel watch ${w.hitCount && !inert && !disabled ? 'hit' : ''} ${w.status === 'error' ? 'err' : ''} ${disabled ? 'off' : ''} ${inert ? 'expired' : ''}">
      <div class="watch-head">
        <span class="title">${esc(w.name)}</span>
        ${statusBadge(w, cfg)}
        ${filterChips.join('')}
        <span class="spacer"></span>
        <button class="btn" data-check="${w.watchId}"${
          inert ? ' disabled title="日期不可用，请先修改日期"' : (disabled ? ' disabled title="任务已停用，先启用后再查询"' : '')
        }>立即查询</button>
        ${toggleBtn}
        <button class="btn" data-edit="${w.watchId}">编辑</button>
        <button class="btn danger" data-del="${w.watchId}">删除</button>
      </div>
      <div class="info">${expireNote ? expireNote : ''}${watchMeta(w)}${filterNote ? '<span>' + filterNote + '</span>' : ''}</div>
      ${seatChips(w.seatSummary) ? `<div class="seats">${seatChips(w.seatSummary)}</div>` : ''}
      ${rows ? `<div class="scroll-x" style="margin-top:12px;max-height:340px;overflow:auto">
        <table><thead><tr>${headerHtml}</tr></thead><tbody>${rows}</tbody></table>
      </div>${w.lastResult.length >= 60 ? '<div class="muted" style="margin-top:6px">仅显示前 60 个车次</div>' : ''}`
      : (fi && fi.emptiedByTimePrice
        ? ''
        : '<div class="muted" style="margin-top:10px">暂无查询结果</div>')}
    </div>`;
  }).join('');

  // 统一从 dataset 取参数：渲染字符串的作用域里没有 w，闭包引用会直接报错
  bindStopsLinks(el('watchList'));
  el('watchList').querySelectorAll('[data-check]').forEach((b) => b.addEventListener('click', async () => {
    b.disabled = true; b.textContent = '查询中…';
    try { await api(`/api/watches/${b.dataset.check}/check`, { method: 'POST' }); toast('查询完成', 'ok'); }
    catch (err) { toast(err.message, 'err'); }
    b.disabled = false; b.textContent = '立即查询';
    refreshState();
  }));
  el('watchList').querySelectorAll('[data-toggle]').forEach((b) => b.addEventListener('click', async () => {
    const cfg = config.watches.find((x) => x.id === b.dataset.toggle);
    try {
      await api(`/api/watches/${b.dataset.toggle}`, { method: 'PUT', body: JSON.stringify({ ...cfg, enabled: cfg.enabled === false }) });
      await loadConfig(); refreshState();
    } catch (err) { toast(err.message, 'err'); }
  }));
  el('watchList').querySelectorAll('[data-edit]').forEach((b) => b.addEventListener('click', () => openWatchModal(b.dataset.edit)));
  el('watchList').querySelectorAll('[data-del]').forEach((b) => b.addEventListener('click', async () => {
    const cfg = config.watches.find((x) => x.id === b.dataset.del);
    const okDel = await confirmDialog({
      title: '删除监控任务',
      message: `确定删除「${cfg.fromName} → ${cfg.toName} ${cfg.date}」？删除后该任务的查询历史与命中记录一并消失，且无法恢复。`,
      confirmText: '删除',
      danger: true,
    });
    if (!okDel) return;
    try { await api(`/api/watches/${b.dataset.del}`, { method: 'DELETE' }); toast('已删除', 'ok'); await loadConfig(); refreshState(); }
    catch (err) { toast(err.message, 'err'); }
  }));
}

function renderChannels() {
  if (!config) return;
  if (!config.channels.length) {
    el('channelList').innerHTML = '<div class="panel"><div class="empty">还没有推送渠道。支持 Server 酱 / Bark / 企业微信 / 钉钉 / Telegram / PushPlus / ntfy / 自定义 Webhook。</div></div>';
    return;
  }
  const typeLabel = (t) => (config.meta.channelTypes.find((x) => x.type === t) || {}).label || t;
  el('channelList').innerHTML = config.channels.map((c) => `
    <div class="panel">
      <div class="watch-head">
        <span class="title">${esc(c.name || typeLabel(c.type))}</span>
        <span class="badge">${esc(typeLabel(c.type))}</span>
        ${c.enabled === false ? '<span class="badge warn">已停用</span>' : '<span class="badge ok">已启用</span>'}
        <span class="spacer"></span>
        <button class="btn" data-test="${c.id}">测试推送</button>
        <button class="btn" data-cedit="${c.id}">编辑</button>
        <button class="btn danger" data-cdel="${c.id}">删除</button>
      </div>
      <div class="info muted" style="margin-top:6px">${esc(channelSummary(c))}</div>
    </div>`).join('');

  el('channelList').querySelectorAll('[data-test]').forEach((b) => b.addEventListener('click', async () => {
    b.disabled = true; b.textContent = '发送中…';
    try {
      const r = await api(`/api/channels/${b.dataset.test}/test`, { method: 'POST' });
      toast(r.ok ? '测试消息已发送，请查看手机' : `发送失败：${r.error}`, r.ok ? 'ok' : 'err');
    } catch (err) { toast(err.message, 'err'); }
    b.disabled = false; b.textContent = '测试推送';
    refreshState();
  }));
  el('channelList').querySelectorAll('[data-cedit]').forEach((b) => b.addEventListener('click', () => openChannelModal(b.dataset.cedit)));
  el('channelList').querySelectorAll('[data-cdel]').forEach((b) => b.addEventListener('click', async () => {
    const okDel = await confirmDialog({
      title: '删除推送渠道',
      message: '确定删除该推送渠道？删除后余票通知将不再发送到它。',
      confirmText: '删除',
      danger: true,
    });
    if (!okDel) return;
    try { await api(`/api/channels/${b.dataset.cdel}`, { method: 'DELETE' }); toast('已删除', 'ok'); await loadConfig(); }
    catch (err) { toast(err.message, 'err'); }
  }));
}

function channelSummary(c) {
  const def = config.meta.channelTypes.find((x) => x.type === c.type) || { fields: [] };
  return def.fields.map((f) => `${f.label}：${c[f.key] ? String(c[f.key]).slice(0, 60) : '未填'}`).join('　');
}

const EVENT_LABEL = { hit: '余票', clear: '余票消失', error: '查询失败', pushfail: '推送失败', system: '系统', info: '信息' };

// 余票事件里的「商务座9 一等座有」用圆点标注，扫一眼就能定位关注的席别。
// 席别全集来自 SEAT_DOT_KEY（原 SEAT_FAMILY 已随图标方案移除，若再引用会抛 ReferenceError）。
function highlightSeats(text) {
  const labels = Object.keys(SEAT_DOT_KEY).sort((a, b) => b.length - a.length);
  let html = esc(text);
  for (const label of labels) {
    // 注意：在模板字符串里 \s 会被解析成字面量 s，必须写成 \\s 才对
    const re = new RegExp(`(${label})(\\s*)(有|无|候补|\\d+)`, 'g');
    html = html.replace(re, (m, name, sp, state) => {
      const has = state === '有' || /^\d+$/.test(state);
      const cls = `seat-tag${has ? ' has' : ''}`;
      return `<span class="${cls}">${seatDot(name, has)}${name}${sp}${state}</span>`;
    });
  }
  return html;
}

function renderEvents(data) {
  const events = data.events || [];
  el('eventList').innerHTML = events.length ? events.map((e) => `
    <div class="event ${esc(e.kind)}">
      <span class="t">${esc(fmtDateTime(e.at))}</span>
      <span class="m">[${esc(EVENT_LABEL[e.kind] || e.kind)}] ${esc(e.message)}${e.detail ? `<div class="d">${e.kind === 'hit' ? highlightSeats(e.detail) : esc(e.detail)}</div>` : ''}</span>
    </div>`).join('') : '<div class="empty">暂无事件</div>';
  const logs = data.logs || [];
  el('logList').textContent = logs.length ? logs.map((l) => `[${fmtDateTime(l.time)}] ${l.level.toUpperCase()} ${l.msg}`).join('\n') : '（暂无日志）';
}

/* ---------- 数据加载 ---------- */
async function loadConfig() {
  config = await api('/api/config');
  fillSettings();
  renderWatches();
  renderChannels();
}

async function refreshState() {
  try {
    const data = await api('/api/state');
    state = safeState(data.state);
    if (!state) return;
    renderStats();
    renderOverview();
    renderWatches();
    updateTopbar();
    if (activeTab === 'events') renderEvents(data);
  } catch (err) {
    // 不引导用 ?token=xxx：查询串会落进反代访问日志与浏览器历史
    if (String(err.message).includes('令牌')) toast('访问令牌无效，请在弹出框中重新输入令牌', 'err');
  }
}

async function loadEvents() {
  if (activeTab !== 'events') return;
  try { renderEvents(await api('/api/state')); } catch (err) { /* 忽略 */ }
}

// 倒计时归零、但服务端还没推来新一轮状态时（SSE 断开、或恰好卡在边界），
// 主动补拉一次，避免页面永远停在「0 秒后」。
let lastResyncAt = 0;
function resyncIfOverdue() {
  if (!state || !state.running || !state.nextRunAt) return;
  const overdue = Date.now() - state.nextRunAt;
  // 宽限 5 秒：给服务端留出发送与网络延迟，避免刚归零就抢跑
  if (overdue > 5000 && Date.now() - lastResyncAt > 5000) {
    lastResyncAt = Date.now();
    refreshState().catch(() => {});
  }
}

// 当前本地时间 HH:MM:SS（每秒重渲染时自然走动）
function localClock() {
  const n = new Date();
  const p = (v) => String(v).padStart(2, '0');
  return `${p(n.getHours())}:${p(n.getMinutes())}:${p(n.getSeconds())}`;
}

// 浏览器与服务端时间明显不一致时提示一次：两者都用于判断「预售期/是否过期」，
// 差得太多会让人看不懂为什么某个日期不能选。
let clockSkewWarned = false;
function maybeWarnClockSkew(now) {
  if (clockSkewWarned || !state || !state.localTime) return;
  const m = /(\d{2}):(\d{2}):(\d{2})/.exec(state.localTime);
  if (!m) return;
  const serverSec = Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]);
  const localSec = now.getHours() * 3600 + now.getMinutes() * 60 + now.getSeconds();
  let diff = Math.abs(serverSec - localSec);
  if (diff > 43200) diff = 86400 - diff;   // 跨午夜取最短差
  if (diff > 120) {
    clockSkewWarned = true;
    const hint = el('stationHint');
    if (hint && hint.style.display === 'none') {
      hint.style.display = '';
      hint.textContent = `本机时间与服务端相差约 ${Math.round(diff / 60)} 分钟，日期判断可能不一致，建议校准系统时间。`;
    }
  }
}

function updateTopbar() {
  if (!state) return;
  resyncIfOverdue();
  const dot = el('runDot');
  dot.className = 'dot ' + (state.running ? 'on' : 'off');
  el('runBadge').textContent = state.running ? '运行中' : '已停止';
  el('runBadge').className = 'badge ' + (state.running ? 'ok' : 'err');
  el('toggleMonitor').textContent = state.running ? '停止监控' : '启动监控';
  el('intervalInfo').textContent = `间隔：${state.intervalSeconds}s`;
  el('nextRun').textContent = state.running ? `下次查询：${countdown(state.nextRunAt)}` : '下次查询：--';
  // 时钟用浏览器本地时间每秒自己走，不要复用服务端快照里的 localTime ——
  // 那只是上次推送时的值，会卡住不动，看起来像页面死了。
  // 只校验一次时钟是否明显偏离服务端（时区/系统时间不一致时给出提示）。
  const now = new Date();
  const p2 = (n) => String(n).padStart(2, '0');
  el('clock').textContent = `${p2(now.getHours())}:${p2(now.getMinutes())}:${p2(now.getSeconds())}`;
  maybeWarnClockSkew(now);
  const hint = el('stationHint');
  if (!state.stationsLoaded) {
    hint.style.display = '';
    hint.textContent = '车站表尚未加载成功，无法解析站名。请在「设置」页或重试后刷新页面。';
  } else if (state.stationError) {
    hint.style.display = '';
    hint.textContent = '车站表刷新失败：' + state.stationError;
  } else {
    hint.style.display = 'none';
  }
}

/* ---------- 弹窗通用行为（Esc 关闭、背景滚动锁定、层级管理） ---------- */
const modalStack = [];

function registerModal(wrap) {
  modalStack.push(wrap);
  lockScroll();
}

function unregisterModal(wrap) {
  const i = modalStack.indexOf(wrap);
  if (i >= 0) modalStack.splice(i, 1);
  if (!modalStack.length) unlockScroll();
}

function lockScroll() {
  document.body.style.overflow = 'hidden';
}

function unlockScroll() {
  document.body.style.overflow = '';
}

// 全局只挂一个监听：Esc 只关最上层弹窗，不会一次关掉全部
document.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape' || !modalStack.length) return;
  const top = modalStack[modalStack.length - 1];
  const closer = top.__onEscape;
  if (closer) closer();
});

// 统一的确认弹窗，替代原生 confirm（原生框在移动端易被拦截、样式也割裂）
function confirmDialog({ title, message, confirmText = '确定', danger = false }) {
  return new Promise((resolve) => {
    const wrap = document.createElement('div');
    wrap.className = 'modal-mask';
    wrap.innerHTML = `
      <div class="modal narrow">
        <h3>${esc(title)}</h3>
        <div class="muted" style="line-height:1.7">${esc(message)}</div>
        <div class="modal-actions">
          <button class="btn" data-cancel>取消</button>
          <button class="btn ${danger ? 'danger-solid' : 'primary'}" data-ok>${esc(confirmText)}</button>
        </div>
      </div>`;
    document.body.appendChild(wrap);
    registerModal(wrap);

    const finish = (val) => {
      unregisterModal(wrap);
      wrap.remove();
      resolve(val);
    };
    wrap.__onEscape = () => finish(false);
    wrap.querySelector('[data-cancel]').addEventListener('click', () => finish(false));
    wrap.querySelector('[data-ok]').addEventListener('click', () => finish(true));
    wrap.addEventListener('click', (e) => { if (e.target === wrap) finish(false); });
    wrap.querySelector('[data-ok]').focus();
  });
}

// 令牌输入弹窗：避免引导用户把令牌放进 URL 查询串（会落进反代日志与浏览器历史）
function tokenDialog() {
  return new Promise((resolve) => {
    const wrap = document.createElement('div');
    wrap.className = 'modal-mask';
    wrap.innerHTML = `
      <div class="modal narrow">
        <h3>需要访问令牌</h3>
        <div class="muted" style="line-height:1.7">
          本服务已启用访问令牌。请输入后继续，令牌只保存在本机浏览器，不会出现在地址栏或日志里。
        </div>
        <label class="field" style="margin-top:10px">
          <input type="password" id="__tokenInput" placeholder="访问令牌" autocomplete="current-password">
        </label>
        <div class="modal-actions">
          <button class="btn" data-cancel>取消</button>
          <button class="btn primary" data-ok>确定</button>
        </div>
      </div>`;
    document.body.appendChild(wrap);
    registerModal(wrap);
    const input = wrap.querySelector('#__tokenInput');
    const finish = (val) => { unregisterModal(wrap); wrap.remove(); resolve(val); };
    wrap.__onEscape = () => finish(null);
    wrap.querySelector('[data-cancel]').addEventListener('click', () => finish(null));
    wrap.querySelector('[data-ok]').addEventListener('click', () => finish(input.value.trim() || null));
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter') finish(input.value.trim() || null); });
    wrap.addEventListener('click', (e) => { if (e.target === wrap) finish(null); });
    input.focus();
  });
}

/* ---------- 详情弹窗（概览页点击进入） ---------- */
let detailModal = null;

function openDetailModal(watchId) {
  const w = state && state.watches.find((x) => x.watchId === watchId);
  if (!w) { toast('任务不存在，可能已被删除', 'err'); return; }
  const cfg = (config && config.watches.find((x) => x.id === watchId)) || {};
  const seatLabels = cfg.seats || [];
  const hits = w.hits || [];

  // 有票时默认只看有票车次，可切换到全部结果
  let onlyHits = hits.length > 0;

  const wrap = document.createElement('div');
  wrap.className = 'modal-mask';
  wrap.innerHTML = `
    <div class="modal wide">
      <div class="detail-head">
        <div>
          <h3 style="margin:0">${esc(w.name)}</h3>
          <div class="muted" style="margin-top:4px">
            上次查询 ${esc(fmtTime(w.lastCheckAt))}${w.lastDurationMs ? `（${w.lastDurationMs}ms）` : ''}
            · 共 ${w.resultCount} 个车次
            ${w.filterInfo && (w.filterInfo.byCode || w.filterInfo.byTime || w.filterInfo.byPrice) ? '· 已按筛选条件过滤' : ''}
          </div>
        </div>
        <button class="btn" data-close>关闭</button>
      </div>

      ${w.status === 'error' ? `<div class="errors">查询失败：${esc(w.lastError || '未知错误')}</div>` : ''}
      ${w.filterInfo && w.filterInfo.emptiedByTimePrice ? `<div class="warn-box">当前筛选条件下没有符合条件的车次（${w.filterInfo.afterCode} 个车次被时段或票价排除），可在「编辑」中放宽条件。</div>` : ''}

      <div class="detail-bar">
        <div class="chip-list" id="dtTabs">
          <span class="chip ${hits.length ? 'on' : ''}" data-mode="hits">有票车次 ${hits.length}</span>
          <span class="chip ${hits.length ? '' : 'on'}" data-mode="all">全部结果 ${w.resultCount}</span>
        </div>
        <span class="muted" id="dtNote"></span>
      </div>

      <div id="dtBody"></div>
    </div>`;
  document.body.appendChild(wrap);
  detailModal = wrap;
  registerModal(wrap);
  wrap.__onEscape = closeDetailModal;

  const render = () => {
    const rows = onlyHits ? hits : (w.lastResult || []);
    const note = document.getElementById('dtNote');
    if (note) {
      note.textContent = onlyHits
        ? (hits.length ? '仅显示当前有票的车次与席别' : '当前没有有票的车次')
        : `显示全部 ${w.resultCount} 个车次`;
    }
    const body = document.getElementById('dtBody');
    if (!rows.length) {
      body.innerHTML = '<div class="empty">没有可展示的车次</div>';
      return;
    }

    if (onlyHits) {
      body.innerHTML = `<div class="scroll-x"><table>
        <thead><tr><th>车次</th><th>出发</th><th>到达</th><th>历时</th><th>有票席别</th></tr></thead>
        <tbody>${rows.map((h) => `<tr>
          <td><button class="train-link" data-stops="${esc(h.trainNo || '')}" data-code="${esc(h.trainCode)}" data-watch="${esc(w.watchId)}" data-name="${esc(w.name)}" title="查看经停站">${esc(h.trainCode)}</button></td>
          <td>${esc(h.startTime)}</td>
          <td>${esc(h.arriveTime)}</td>
          <td>${esc(h.duration)}</td>
          <td class="hit-seats">${Object.entries(h.matched).map(([k, v]) => {
            const p = (h.prices || {})[k];
            const price = typeof p === 'number' ? `<span class="hit-price">¥${p}</span>` : '';
            return `<span class="hit-seat">${seatDot(k, true)}<span class="hit-name">${esc(k)}</span><b class="hit-count">${esc(v)}</b>${price}</span>`;
          }).join('')}</td>
        </tr>`).join('')}</tbody></table></div>`;
      bindStopsLinks(body);
      return;
    }

    const headerHtml = ['车次', '出发', '到达', '历时']
      .map((h) => `<th>${esc(h)}</th>`).join('')
      + seatLabels.map((sl) => `<th class="seat-col">${seatDot(sl, true)}${esc(sl)}</th>`).join('')
      + '<th class="num">最低价</th>';
    body.innerHTML = `<div class="scroll-x" style="max-height:52vh"><table>
      <thead><tr>${headerHtml}</tr></thead>
      <tbody>${rows.map((t) => {
        const codeCell = `<td><button class="train-link" data-stops="${esc(t.trainNo || '')}" data-code="${esc(t.trainCode)}" data-watch="${esc(w.watchId)}" data-name="${esc(w.name)}" title="查看经停站">${esc(t.trainCode)}</button></td>`;
        const cells = [t.startTime, t.arriveTime, t.duration].map((v) => `<td>${esc(v)}</td>`).join('');
        const seatCells = seatLabels.map((sl) => {
          const v = (t.tickets || {})[sl] || '';
          const has = v === '有' || (/^\d+$/.test(v) && Number(v) > 0);
          const price = (t.prices || {})[sl];
          const priceHtml = typeof price === 'number' ? `<span class="seat-price">¥${price}</span>` : '';
          return `<td class="seat-cell ${has ? 'has' : ''}"><span class="seat-status">${esc(v || '-')}</span>${priceHtml}</td>`;
        }).join('');
        const low = lowestOf(t, seatLabels);
        return `<tr>${codeCell}${cells}${seatCells}<td class="num">${low === null ? '-' : '¥' + low}</td></tr>`;
      }).join('')}</tbody></table></div>`;
    bindStopsLinks(body);
  };
  render();

  wrap.querySelectorAll('#dtTabs .chip').forEach((chip) => chip.addEventListener('click', () => {
    onlyHits = chip.dataset.mode === 'hits';
    wrap.querySelectorAll('#dtTabs .chip').forEach((c) => c.classList.toggle('on', c === chip));
    render();
  }));
  wrap.querySelectorAll('[data-close]').forEach((b) => b.addEventListener('click', closeDetailModal));
  wrap.addEventListener('click', (e) => { if (e.target === wrap) closeDetailModal(); });
}

function closeDetailModal() {
  if (detailModal) { unregisterModal(detailModal); detailModal.remove(); detailModal = null; }
}

/* ---------- 经停站弹窗（点击车次打开） ---------- */

// 绑定点车次事件；参数全部来自 dataset，避免渲染作用域外的闭包引用
function bindStopsLinks(container) {
  container.querySelectorAll('[data-stops]').forEach((b) => b.addEventListener('click', (e) => {
    e.stopPropagation();
    openStopsModal(b.dataset.stops, b.dataset.code, b.dataset.watch, b.dataset.name);
  }));
}
let stopsModal = null;
const stopsMemo = new Map();

function openStopsModal(trainNo, trainCode, watchId, watchName) {
  if (!trainNo) { toast('该车次缺少内部编号，无法查询经停站', 'err'); return; }
  if (stopsModal) { unregisterModal(stopsModal); stopsModal.remove(); stopsModal = null; }

  const wrap = document.createElement('div');
  wrap.className = 'modal-mask';
  wrap.innerHTML = `
    <div class="modal wide">
      <div class="detail-head">
        <div>
          <h3 style="margin:0">${esc(trainCode)} 经停站</h3>
          <div class="muted" style="margin-top:4px">${esc(watchName || '')}</div>
        </div>
        <button class="btn" data-close>关闭</button>
      </div>
      <div id="stopsBody"><div class="empty">加载中…</div></div>
      <div class="muted" style="margin-top:10px">经停站按需查询（每车次一次请求，结果缓存 6 小时），不参与余票轮询。</div>
    </div>`;
  document.body.appendChild(wrap);
  stopsModal = wrap;
  registerModal(wrap);
  wrap.__onEscape = closeStopsModal;
  wrap.querySelectorAll('[data-close]').forEach((b) => b.addEventListener('click', closeStopsModal));
  wrap.addEventListener('click', (e) => { if (e.target === wrap) closeStopsModal(); });

  const key = `${trainNo}|${watchId}`;
  if (stopsMemo.has(key)) {
    renderStops(wrap, stopsMemo.get(key));
    return;
  }

  (async () => {
    try {
      const cfg = (config && config.watches.find((x) => x.id === watchId)) || {};
      const r = await api('/api/trains/stops', {
        method: 'POST',
        // 只传任务 id 与车次内部编号，日期与站点码由服务端从任务取
        body: JSON.stringify({ watchId, trainNo, trainCode }),
      });
      if (!r.ok) throw new Error(r.error || '查询失败');
      stopsMemo.set(key, r);
      if (stopsModal !== wrap) return; // 用户已关闭
      renderStops(wrap, r);
    } catch (err) {
      const body = wrap.querySelector('#stopsBody');
      if (body) body.innerHTML = `<div class="errors">${esc(err.message)}</div>`;
    }
  })();
}

function renderStops(wrap, data) {
  const body = wrap.querySelector('#stopsBody');
  if (!body) return;
  const stops = data.stops || [];
  if (!stops.length) {
    body.innerHTML = '<div class="empty">该车次暂无经停站数据</div>';
    return;
  }
  body.innerHTML = `<div class="scroll-x" style="max-height:56vh"><table class="stops-table">
    <thead><tr><th>#</th><th>车站</th><th>到达</th><th>发车</th><th>停留</th></tr></thead>
    <tbody>${stops.map((s) => {
      const isEnds = s.isStart || s.isEnd;
      return `<tr class="${isEnds ? 'stop-terminal' : ''}">
        <td class="num">${esc(s.no)}</td>
        <td><strong>${esc(s.name)}</strong>${s.isStart ? '<span class="stop-tag">始发</span>' : ''}${s.isEnd ? '<span class="stop-tag end">终到</span>' : ''}</td>
        <td>${esc(s.arriveTime === '----' ? '-' : s.arriveTime)}</td>
        <td>${esc(s.startTime)}</td>
        <td>${esc(!s.stopover || s.stopover === '----' ? '-' : s.stopover)}</td>
      </tr>`;
    }).join('')}</tbody></table></div>`;
}

function closeStopsModal() {
  if (stopsModal) { unregisterModal(stopsModal); stopsModal.remove(); stopsModal = null; }
}

/* ---------- 任务弹窗 ---------- */
let watchModal = null;

function openWatchModal(id) {
  const cfg = id ? config.watches.find((w) => w.id === id) : null;
  const seats = config.meta.seatOptions;
  // 自研日期选择器实例（原生 input[type=date] 无法定制样式）
  let datePicker = null;
  const selected = new Set(cfg ? cfg.seats : ['二等座', '一等座']);
  const wrap = document.createElement('div');
  wrap.className = 'modal-mask';
  wrap.innerHTML = `
    <div class="modal">
      <h3>${cfg ? '编辑监控任务' : '新增监控任务'}</h3>
      <div id="wmErrors"></div>
      <label class="field"><span>出发站</span>
        <div class="autocomplete"><input id="wmFrom" autocomplete="off" placeholder="如：上海 / 上海虹桥 / shanghai" value="${esc(cfg ? cfg.from : '')}"><ul hidden></ul></div>
      </label>
      <label class="field"><span>到达站</span>
        <div class="autocomplete"><input id="wmTo" autocomplete="off" placeholder="如：北京 / 北京南" value="${esc(cfg ? cfg.to : '')}"><ul hidden></ul></div>
      </label>
      <div class="field"><span class="field-label">乘车日期</span>
        <div id="wmDateMount"></div>
      </div>
      <div class="field">
        <span class="field-label">站名匹配方式</span>
        <div class="radio-row">
          <label class="radio ${!cfg || cfg.exactStation !== false ? 'on' : ''}">
            <input type="radio" name="wmExact" value="exact" ${!cfg || cfg.exactStation !== false ? 'checked' : ''}>
            <span class="radio-body">
              <b>精确匹配</b>
              <em>只查所选车站（默认）</em>
            </span>
          </label>
          <label class="radio ${cfg && cfg.exactStation === false ? 'on' : ''}">
            <input type="radio" name="wmExact" value="fuzzy" ${cfg && cfg.exactStation === false ? 'checked' : ''}>
            <span class="radio-body">
              <b>模糊匹配</b>
              <em>包含同城其它站，如查「盐城」也含「盐城大丰」</em>
            </span>
          </label>
        </div>
        <div class="field-hint" id="wmExactHint"></div>
      </div>
      <label class="field"><span>车次（可选，逗号分隔，如 G2,G4；留空表示该区间所有车次）</span>
        <input id="wmTrains" placeholder="G2,G4" value="${esc(cfg && cfg.trains ? cfg.trains.join(',') : '')}">
      </label>
      <div class="filter-box" id="wmFilters">
        <div class="filter-head">
          <span class="filter-title">筛选条件</span>
          <span class="filter-note">四个条件各自独立：可只开一个、可组合、也可全不开。同时开启时取交集。</span>
        </div>

        <div class="filter-row" id="rowTime">
          <label class="switch" title="开启后按出发时刻过滤">
            <input type="checkbox" id="wmTimeEnabled" ${cfg && cfg.timeEnabled ? 'checked' : ''}>
            <span class="track"></span>
          </label>
          <div class="filter-body">
            <div class="filter-label">出发时段
              <span class="filter-state" id="stateTime"></span>
            </div>
            <div class="filter-fields">
              <input type="time" id="wmTimeFrom" value="${esc(cfg && cfg.timeFrom ? cfg.timeFrom : '')}">
              <span class="range-sep">至</span>
              <input type="time" id="wmTimeTo" value="${esc(cfg && cfg.timeTo ? cfg.timeTo : '')}">
            </div>
            <div class="filter-hint">支持跨午夜，例如 22:00 至 06:00 表示夜间发车。只填一端则只限制那一端。</div>
          </div>
        </div>

        <div class="filter-row" id="rowDuration">
          <label class="switch" title="开启后按历时过滤">
            <input type="checkbox" id="wmDurationEnabled" ${cfg && cfg.durationEnabled ? 'checked' : ''}>
            <span class="track"></span>
          </label>
          <div class="filter-body">
            <div class="filter-label">历时
              <span class="filter-state" id="stateDuration"></span>
            </div>
            <div class="filter-fields">
              <input type="text" id="wmDurationMin" inputmode="numeric" placeholder="最短，如 4:30" value="${esc(cfg && cfg.durationMin != null ? fmtDurationInput(cfg.durationMin) : '')}">
              <span class="range-sep">至</span>
              <input type="text" id="wmDurationMax" inputmode="numeric" placeholder="最长，如 10:00" value="${esc(cfg && cfg.durationMax != null ? fmtDurationInput(cfg.durationMax) : '')}">
            </div>
            <div class="filter-hint">填 <code>4:30</code> 表示 4 小时 30 分；只填 <code>4</code> 表示 4 小时。只填一端则只限制那一端。</div>
          </div>
        </div>

        <div class="filter-row" id="rowPrice">
          <label class="switch" title="开启后按最低票价过滤">
            <input type="checkbox" id="wmPriceEnabled" ${cfg && cfg.priceEnabled ? 'checked' : ''}>
            <span class="track"></span>
          </label>
          <div class="filter-body">
            <div class="filter-label">票价区间
              <span class="filter-state" id="statePrice"></span>
            </div>
            <div class="filter-fields">
              <input type="number" min="0" step="10" id="wmPriceMin" placeholder="最低" value="${cfg && cfg.priceMin !== null && cfg.priceMin !== undefined ? esc(cfg.priceMin) : ''}">
              <span class="range-sep">至</span>
              <input type="number" min="0" step="10" id="wmPriceMax" placeholder="最高" value="${cfg && cfg.priceMax !== null && cfg.priceMax !== undefined ? esc(cfg.priceMax) : ''}">
            </div>
            <div class="filter-hint">按你在下面勾选的席别取最低票价比较，只填一端则只限制那一端。票价来自官方余票响应，不产生额外请求。</div>
          </div>
        </div>

        <div class="filter-row" id="rowSeats">
          <span class="row-mark" title="席别始终参与命中判断">固定</span>
          <div class="filter-body">
            <div class="filter-label">席别偏好 <span class="filter-state always">始终生效</span></div>
            <div class="chip-list" id="wmSeats">
              ${seats.map((s) => `<span class="chip ${selected.has(s) ? 'on' : ''}" data-seat="${esc(s)}">${esc(s)}</span>`).join('')}
            </div>
            <div class="filter-hint">命中其中任一席别有票即推送；同时决定上一条「票价」按哪些席别比价。</div>
          </div>
        </div>
      </div>
      <label class="inline"><input type="checkbox" id="wmEnabled" ${!cfg || cfg.enabled !== false ? 'checked' : ''}> 启用该任务</label>
      <div class="modal-actions">
        <button class="btn" data-close>取消</button>
        <button class="btn primary" id="wmSave">保存</button>
      </div>
    </div>`;
  document.body.appendChild(wrap);
  watchModal = wrap;
  registerModal(wrap);
  wrap.__onEscape = closeWatchModal;

  wrap.querySelectorAll('#wmSeats .chip').forEach((chip) => chip.addEventListener('click', () => {
    chip.classList.toggle('on');
    refreshFilterUI();
  }));

  // 开关与状态提示联动：关闭时把输入框置灰，明确「存着但不生效」
  function refreshFilterUI() {
    const bind = (enabledId, rowId, stateId, ids, summarize) => {
      const on = wrap.querySelector('#' + enabledId).checked;
      const row = wrap.querySelector('#' + rowId);
      row.classList.toggle('off', !on);
      ids.forEach((id) => { wrap.querySelector('#' + id).disabled = !on; });
      const state = wrap.querySelector('#' + stateId);
      state.textContent = on ? '' : '未启用';
      state.className = 'filter-state' + (on ? '' : ' off');
      if (on) {
        const hint = summarize();
        // 开了但没填：必须明确提示，否则用户以为已生效
        state.textContent = hint || '待填写';
        state.className = 'filter-state' + (hint ? ' on' : ' warn');
      }
    };

    bind('wmTimeEnabled', 'rowTime', 'stateTime', ['wmTimeFrom', 'wmTimeTo'], () => {
      const f = wrap.querySelector('#wmTimeFrom').value;
      const t = wrap.querySelector('#wmTimeTo').value;
      if (!f && !t) return '';
      return `${f || '00:00'} 至 ${t || '24:00'}`;
    });
    bind('wmDurationEnabled', 'rowDuration', 'stateDuration', ['wmDurationMin', 'wmDurationMax'], () => {
      const lo = wrap.querySelector('#wmDurationMin').value.trim();
      const hi = wrap.querySelector('#wmDurationMax').value.trim();
      if (!lo && !hi) return '';
      return lo && hi ? `${lo} 至 ${hi}` : (lo ? `不短于 ${lo}` : `不长于 ${hi}`);
    });
    bind('wmPriceEnabled', 'rowPrice', 'statePrice', ['wmPriceMin', 'wmPriceMax'], () => {
      const lo = wrap.querySelector('#wmPriceMin').value;
      const hi = wrap.querySelector('#wmPriceMax').value;
      if (lo === '' && hi === '') return '';
      return lo === '' ? `不高于 ¥${hi}` : (hi === '' ? `不低于 ¥${lo}` : `¥${lo} - ¥${hi}`);
    });
  }

  ['wmTimeEnabled', 'wmPriceEnabled', 'wmDurationEnabled'].forEach((id) => {
    wrap.querySelector('#' + id).addEventListener('change', refreshFilterUI);
  });
  ['wmTimeFrom', 'wmTimeTo', 'wmPriceMin', 'wmPriceMax', 'wmDurationMin', 'wmDurationMax'].forEach((id) => {
    wrap.querySelector('#' + id).addEventListener('input', refreshFilterUI);
  });
  refreshFilterUI();
  wrap.querySelectorAll('[data-close]').forEach((b) => b.addEventListener('click', closeWatchModal));
  wrap.addEventListener('click', (e) => { if (e.target === wrap) closeWatchModal(); });
  // 站名匹配方式：切换时更新选中态与提示
  const syncExact = () => {
    const checked = wrap.querySelector('input[name="wmExact"]:checked');
    wrap.querySelectorAll('.radio-row .radio').forEach((r) => r.classList.toggle('on', r.querySelector('input').checked));
    const hint = wrap.querySelector('#wmExactHint');
    if (hint) {
      hint.textContent = checked && checked.value === 'exact'
        ? '12306 按城市返回车次，精确匹配会过滤掉同城其它站，避免同一车次重复出现。'
        : '会包含同城其它车站（如查「盐城」也会出现「盐城大丰」的车次）。';
    }
  };
  wrap.querySelectorAll('input[name="wmExact"]').forEach((r) => r.addEventListener('change', syncExact));
  syncExact();
  setupAutocomplete(wrap.querySelector('#wmFrom').parentElement);
  setupAutocomplete(wrap.querySelector('#wmTo').parentElement);
  datePicker = createDatePicker(wrap.querySelector('#wmDateMount'), {
    initial: cfg ? cfg.date : todayPlus(1),
    minIso: todayPlus(0),
    maxIso: todayPlus(PRESALE_DAYS_UI),
  });

  el('wmSave').addEventListener('click', async () => {
    const btn = el('wmSave');
    const seatsSel = [...wrap.querySelectorAll('#wmSeats .chip.on')].map((c) => c.dataset.seat);
    const body = {
      from: wrap.querySelector('#wmFrom').value.trim(),
      to: wrap.querySelector('#wmTo').value.trim(),
      date: datePicker ? datePicker.value : '',
      trains: wrap.querySelector('#wmTrains').value.split(/[,，\s]+/).filter(Boolean),
      timeEnabled: wrap.querySelector('#wmTimeEnabled').checked,
      timeFrom: wrap.querySelector('#wmTimeFrom').value,
      timeTo: wrap.querySelector('#wmTimeTo').value,
      priceEnabled: wrap.querySelector('#wmPriceEnabled').checked,
      priceMin: wrap.querySelector('#wmPriceMin').value,
      priceMax: wrap.querySelector('#wmPriceMax').value,
      durationEnabled: wrap.querySelector('#wmDurationEnabled').checked,
      durationMin: wrap.querySelector('#wmDurationMin').value,
      durationMax: wrap.querySelector('#wmDurationMax').value,
      exactStation: wrap.querySelector('input[name="wmExact"]:checked').value === 'exact',
      seats: seatsSel,
      enabled: wrap.querySelector('#wmEnabled').checked,
    };
    btn.disabled = true; btn.textContent = '保存中…';
    try {
      if (cfg) await api(`/api/watches/${cfg.id}`, { method: 'PUT', body: JSON.stringify(body) });
      else await api('/api/watches', { method: 'POST', body: JSON.stringify(body) });
      closeWatchModal();
      toast('已保存', 'ok');
      await loadConfig();
      refreshState();
    } catch (err) {
      wrap.querySelector('#wmErrors').innerHTML = `<div class="errors">${esc(err.message)}</div>`;
      btn.disabled = false; btn.textContent = '保存';
    }
  });
}

function closeWatchModal() {
  if (watchModal) { unregisterModal(watchModal); watchModal.remove(); watchModal = null; }
}

function setupAutocomplete(container) {
  const input = container.querySelector('input');
  const list = container.querySelector('ul');
  let timer = null;
  let items = [];
  input.addEventListener('input', () => {
    clearTimeout(timer);
    const q = input.value.trim();
    if (q.length < 1) { list.hidden = true; return; }
    timer = setTimeout(async () => {
      try {
        const data = await api('/api/stations?q=' + encodeURIComponent(q));
        items = data.items || [];
        if (!items.length) { list.hidden = true; return; }
        list.innerHTML = items.map((s, i) => `<li data-i="${i}"><span>${esc(s.name)}${s.city && s.city !== s.name ? ` <span class="code">${esc(s.city)}</span>` : ''}</span><span class="code">${esc(s.code)}</span></li>`).join('');
        list.hidden = false;
        list.querySelectorAll('li').forEach((li) => li.addEventListener('mousedown', (e) => {
          e.preventDefault();
          input.value = items[Number(li.dataset.i)].name;
          list.hidden = true;
        }));
      } catch (err) { list.hidden = true; }
    }, 180);
  });
  input.addEventListener('blur', () => setTimeout(() => { list.hidden = true; }, 150));
}

el('addWatch').addEventListener('click', () => openWatchModal(null));

/* ---------- 渠道弹窗 ---------- */
function openChannelModal(id) {
  const cfg = id ? config.channels.find((c) => c.id === id) : null;
  const types = config.meta.channelTypes;
  const current = cfg ? cfg.type : types[0].type;
  const wrap = document.createElement('div');
  wrap.className = 'modal-mask';
  wrap.innerHTML = `
    <div class="modal">
      <h3>${cfg ? '编辑推送渠道' : '新增推送渠道'}</h3>
      <div id="cmErrors"></div>
      <label class="field"><span>渠道类型</span>
        <select id="cmType">${types.map((t) => `<option value="${esc(t.type)}" ${t.type === current ? 'selected' : ''}>${esc(t.label)}</option>`).join('')}</select>
      </label>
      <div id="cmFields"></div>
      <label class="field"><span>备注名称（可选）</span><input id="cmName" value="${esc(cfg ? cfg.name || '' : '')}"></label>
      <label class="inline"><input type="checkbox" id="cmEnabled" ${!cfg || cfg.enabled !== false ? 'checked' : ''}> 启用该渠道</label>
      <div class="modal-actions">
        <button class="btn" data-close>取消</button>
        <button class="btn" id="cmTest">测试推送</button>
        <button class="btn primary" id="cmSave">保存</button>
      </div>
    </div>`;
  document.body.appendChild(wrap);
  registerModal(wrap);
  // 关闭必须走同一个函数：直接 wrap.remove() 会让 modalStack 残留，
  // 导致页面滚动被永久锁住（overflow 一直是 hidden）。
  const closeChannelModal = () => { unregisterModal(wrap); wrap.remove(); };
  wrap.__onEscape = closeChannelModal;

  function renderFields() {
    const type = wrap.querySelector('#cmType').value;
    const def = types.find((t) => t.type === type);
    wrap.querySelector('#cmFields').innerHTML = def.fields.map((f) => {
      const existingVal = cfg && cfg.type === type ? (cfg[f.key] || '') : (f.default || '');
      const isMasked = existingVal === '******';
      return `
      <label class="field"><span>${esc(f.label)}${f.required ? ' *' : ''}</span>
        <input data-key="${esc(f.key)}" value="${isMasked ? '' : esc(existingVal)}" placeholder="${isMasked ? '已保存，留空则不修改' : ''}" ${f.key.toLowerCase().includes('key') || f.key.toLowerCase().includes('token') || f.key.toLowerCase().includes('secret') ? 'type="password"' : ''}>
      </label>${f.hint ? `<div class="muted" style="margin:-8px 0 12px">${esc(f.hint)}</div>` : ''}`;
    }).join('');
  }
  renderFields();
  wrap.querySelector('#cmType').addEventListener('change', renderFields);
  wrap.querySelectorAll('[data-close]').forEach((b) => b.addEventListener('click', closeChannelModal));
  wrap.addEventListener('click', (e) => { if (e.target === wrap) closeChannelModal(); });

  function collect() {
    const body = { type: wrap.querySelector('#cmType').value, name: wrap.querySelector('#cmName').value.trim(), enabled: wrap.querySelector('#cmEnabled').checked };
    wrap.querySelectorAll('#cmFields input').forEach((i) => {
      const key = i.dataset.key;
      const val = i.value.trim();
      const existing = cfg && cfg.type === body.type ? (cfg[key] || '') : '';
      // 未改动的已存密钥留空提交，让后端保留原值，避免把 ****** 或空串写进配置
      if (val === '' && existing) return;
      body[key] = val;
    });
    if (cfg) body.id = cfg.id;
    return body;
  }

  wrap.querySelector('#cmTest').addEventListener('click', async (e) => {
    const btn = e.currentTarget;
    btn.disabled = true; btn.textContent = '发送中…';
    try {
      const r = await api('/api/channels/test-draft', { method: 'POST', body: JSON.stringify(collect()) });
      wrap.querySelector('#cmErrors').innerHTML = r.ok ? '' : `<div class="errors">${esc(r.error)}</div>`;
      toast(r.ok ? '测试消息已发送' : `发送失败：${r.error}`, r.ok ? 'ok' : 'err');
    } catch (err) {
      wrap.querySelector('#cmErrors').innerHTML = `<div class="errors">${esc(err.message)}</div>`;
    }
    btn.disabled = false; btn.textContent = '测试推送';
  });

  wrap.querySelector('#cmSave').addEventListener('click', async (e) => {
    const btn = e.currentTarget;
    btn.disabled = true; btn.textContent = '保存中…';
    try {
      if (cfg) await api(`/api/channels/${cfg.id}`, { method: 'PUT', body: JSON.stringify(collect()) });
      else await api('/api/channels', { method: 'POST', body: JSON.stringify(collect()) });
      closeChannelModal();
      toast('已保存', 'ok');
      await loadConfig();
    } catch (err) {
      wrap.querySelector('#cmErrors').innerHTML = `<div class="errors">${esc(err.message)}</div>`;
      btn.disabled = false; btn.textContent = '保存';
    }
  });
}

el('addChannel').addEventListener('click', () => openChannelModal(null));

/* ---------- 设置 ---------- */
function fillSettings() {
  if (!config || activeTab !== 'settings') return;
  const s = config.settings;
  el('s_interval').value = s.intervalSeconds;
  el('s_jitter').value = s.jitterSeconds;
  el('s_minInterval').value = s.minIntervalSeconds;
  el('s_retryOnHit').value = s.retryOnHitSeconds;
  el('s_retryMax').value = s.retryOnHitMaxMinutes;
  el('s_notifyOnHit').checked = Boolean(s.notifyOnHit);
  el('s_notifyRecovery').checked = Boolean(s.notifyRecovery);
  el('s_quietEnabled').checked = Boolean(s.quietHours && s.quietHours.enabled);
  el('s_quietStart').value = (s.quietHours && s.quietHours.start) || '23:30';
  el('s_quietEnd').value = (s.quietHours && s.quietHours.end) || '06:30';
  el('s_token').value = s.token || '';
  const w = s.webdav || {};
  el('d_enabled').checked = Boolean(w.enabled);
  el('d_url').value = w.url || '';
  el('d_user').value = w.username || '';
  // 掩码值不回填到密码框：留空表示不修改，避免误覆盖
  el('d_pass').value = '';
  el('d_pass').placeholder = w.password ? '已保存，留空则不修改' : '留空则不修改已保存的密码';
  el('d_path').value = w.path || 'ticket-monitor';
  el('d_keep').value = w.keep || 20;
  el('d_auto').checked = Boolean(w.autoBackup);
}

function davDraft() {
  return {
    enabled: el('d_enabled').checked,
    url: el('d_url').value.trim(),
    username: el('d_user').value.trim(),
    password: el('d_pass').value.trim(),
    path: el('d_path').value.trim() || 'ticket-monitor',
    keep: Number(el('d_keep').value) || 20,
    autoBackup: el('d_auto').checked,
  };
}

function davMsg(text, kind = '') {
  el('d_msg').textContent = text;
  el('d_msg').className = kind === 'err' ? 'muted' : 'muted';
  if (kind === 'err') toast(text, 'err');
}

async function davSaveSettings({ silent = false } = {}) {
  const w = davDraft();
  const body = { webdav: { ...w } };
  // 密码留空表示不修改，不提交该字段
  if (!w.password) delete body.webdav.password;
  const r = await api('/api/settings', { method: 'POST', body: JSON.stringify(body) });
  await loadConfig();
  if (!silent) toast('WebDAV 设置已保存', 'ok');
  return r;
}

el('d_save').addEventListener('click', async () => {
  try { await davSaveSettings(); } catch (err) { davMsg(err.message, 'err'); }
});

el('d_test').addEventListener('click', async (e) => {
  const btn = e.currentTarget;
  btn.disabled = true; btn.textContent = '测试中…';
  try {
    const w = davDraft();
    const body = { webdav: { ...w } };
    if (!w.password) delete body.webdav.password;
    const r = await api('/api/webdav/test', { method: 'POST', body: JSON.stringify(body) });
    if (r.ok) {
      el('d_result').innerHTML = `<div class="hint-tip">连接成功${r.dav ? `（DAV: ${esc(r.dav)}）` : ''}${r.backups ? `，云端已有 ${r.backups.length} 份备份` : '，备份目录尚未创建（首次备份时自动创建）'}。</div>`;
      davMsg('连接正常', 'ok');
    } else {
      el('d_result').innerHTML = `<div class="errors">连接失败：${esc(r.error)}${r.hint ? `<div style="margin-top:4px">${esc(r.hint)}</div>` : ''}</div>`;
      davMsg('连接失败', 'err');
    }
  } catch (err) { davMsg(err.message, 'err'); }
  btn.disabled = false; btn.textContent = '测试连接';
});

el('d_backup').addEventListener('click', async (e) => {
  const btn = e.currentTarget;
  btn.disabled = true; btn.textContent = '备份中…';
  try {
    const w = davDraft();
    const body = { webdav: { ...w } };
    if (!w.password) delete body.webdav.password;
    const r = await api('/api/webdav/backup', { method: 'POST', body: JSON.stringify(body) });
    if (r.ok) {
      el('d_result').innerHTML = `<div class="hint-tip">备份成功：<code>${esc(r.name)}</code>（${r.size} 字节）${r.pruned && r.pruned.length ? `，已按保留份数清理 ${r.pruned.length} 份旧备份` : ''}</div>`;
      davMsg('备份成功', 'ok');
      await loadConfig();
    } else {
      el('d_result').innerHTML = `<div class="errors">备份失败：${esc(r.error)}${r.hint ? `<div style="margin-top:4px">${esc(r.hint)}</div>` : ''}</div>`;
      davMsg('备份失败', 'err');
    }
  } catch (err) { davMsg(err.message, 'err'); }
  btn.disabled = false; btn.textContent = '立即备份';
});

el('d_list').addEventListener('click', async () => {
  try {
    const r = await api('/api/webdav/backups');
    if (!r.ok) {
      el('d_result').innerHTML = `<div class="errors">读取失败：${esc(r.error)}${r.hint ? `<div style="margin-top:4px">${esc(r.hint)}</div>` : ''}</div>`;
      return;
    }
    if (!r.items.length) {
      el('d_result').innerHTML = '<div class="muted">云端还没有备份。点「立即备份」创建第一份。</div>';
      return;
    }
    el('d_result').innerHTML = `<div class="scroll-x"><table>
      <thead><tr><th>备份文件</th><th>大小</th><th>时间</th><th></th></tr></thead>
      <tbody>${r.items.map((it) => `<tr>
        <td><code>${esc(it.name)}</code></td>
        <td class="num">${it.size !== null ? esc(it.size) + ' B' : '-'}</td>
        <td>${it.modifiedAt ? esc(fmtDateTime(it.modifiedAt)) : '-'}</td>
        <td><button class="btn" data-restore="${esc(it.name)}">恢复此备份</button></td>
      </tr>`).join('')}</tbody></table></div>
      <div class="muted" style="margin-top:8px">恢复会用云端的配置<strong>整体替换</strong>当前配置（推送密钥用本地的补回）。恢复前会自动在本地留一份快照。</div>`;

    el('d_result').querySelectorAll('[data-restore]').forEach((b) => b.addEventListener('click', async () => {
      const name = b.dataset.restore;
      const okRestore = await confirmDialog({
        title: '从云端恢复配置',
        message: `将用 ${name} 整体替换当前的任务、渠道与设置。当前配置会先自动备份到数据目录，但恢复后页面上的未保存改动会丢失。确定继续？`,
        confirmText: '恢复',
        danger: true,
      });
      if (!okRestore) return;
      b.disabled = true; b.textContent = '恢复中…';
      try {
        const res = await api('/api/webdav/restore', { method: 'POST', body: JSON.stringify({ name }) });
        if (res.ok) {
          const warnHtml = (res.warnings && res.warnings.length)
            ? `<div class="warn-box" style="margin-top:8px">以下任务已跳过（不影响其余配置）：<br>${res.warnings.map(esc).join('<br>')}</div>`
            : '';
          el('d_result').innerHTML = `<div class="hint-tip">已恢复：${res.watches} 个任务 / ${res.channels} 个渠道${res.localSnapshot ? `。恢复前的配置已存为 <code>${esc(res.localSnapshot)}</code>` : ''}</div>${warnHtml}`;
          davMsg('恢复成功', 'ok');
          await loadConfig(); refreshState();
        } else {
          el('d_result').innerHTML = `<div class="errors">恢复失败：${esc(res.error)}${res.errors ? '<div style="margin-top:4px">' + res.errors.map(esc).join('<br>') + '</div>' : ''}</div>`;
          davMsg('恢复失败', 'err');
        }
      } catch (err) { davMsg(err.message, 'err'); }
      b.disabled = false; b.textContent = '恢复此备份';
    }));
  } catch (err) { davMsg(err.message, 'err'); }
});

el('saveSettings').addEventListener('click', async (e) => {
  const btn = e.currentTarget;
  btn.disabled = true;
  try {
    await api('/api/settings', {
      method: 'POST',
      body: JSON.stringify({
        intervalSeconds: Number(el('s_interval').value),
        jitterSeconds: Number(el('s_jitter').value),
        minIntervalSeconds: Number(el('s_minInterval').value),
        retryOnHitSeconds: Number(el('s_retryOnHit').value),
        retryOnHitMaxMinutes: Number(el('s_retryMax').value),
        notifyOnHit: el('s_notifyOnHit').checked,
        notifyRecovery: el('s_notifyRecovery').checked,
        quietHours: { enabled: el('s_quietEnabled').checked, start: el('s_quietStart').value, end: el('s_quietEnd').value },
        token: el('s_token').value.trim(),
      }),
    });
    el('settingsMsg').textContent = '已保存';
    toast('设置已保存', 'ok');
    await loadConfig();
    setTimeout(() => { el('settingsMsg').textContent = ''; }, 2500);
  } catch (err) { toast(err.message, 'err'); }
  btn.disabled = false;
});

el('exportConfig').addEventListener('click', async () => {
  try {
    const data = await api('/api/export');
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'ticket-monitor-config.json';
    a.click();
    URL.revokeObjectURL(a.href);
  } catch (err) { toast(err.message, 'err'); }
});

el('importConfig').addEventListener('click', () => el('importFile').click());
el('importFile').addEventListener('change', async (e) => {
  const file = e.target.files[0];
  if (!file) return;
  try {
    const text = await file.text();
    const r = await api('/api/import', { method: 'POST', body: text });
    const skipped = (r.warnings || []).filter((x) => x.includes('跳过'));
    toast(`导入成功：${r.watches} 个任务 / ${r.channels} 个渠道${skipped.length ? `，跳过 ${skipped.length} 个` : ''}`, 'ok');
    if (skipped.length) {
      el('settingsMsg').innerHTML = `已跳过 ${skipped.length} 个不可用任务：${esc(skipped.join('；'))}`;
      setTimeout(() => { el('settingsMsg').textContent = ''; }, 15000);
    }
    await loadConfig();
    refreshState();
  } catch (err) { toast('导入失败：' + err.message, 'err'); }
  e.target.value = '';
});

/* ---------- SSE ---------- */
let streamAlive = false;
// SSE 断开时的兜底轮询：否则页面会完全停住，用户以为服务挂了
let pollFallback = null;
function startPollFallback() {
  if (pollFallback) return;
  pollFallback = setInterval(() => {
    if (streamAlive) { clearInterval(pollFallback); pollFallback = null; return; }
    refreshState().catch(() => {});
  }, 5000);
}

function connectStream() {
  try {
    const es = new EventSource(withToken('/api/stream'));
    es.addEventListener('state', (e) => {
      streamAlive = true;
      try {
        state = JSON.parse(e.data);
        renderStats(); renderOverview(); renderWatches(); updateTopbar();
      } catch (err) { /* 单帧损坏不应打断整个页面 */ }
    });
    es.addEventListener('event', (e) => {
      try {
        const ev = JSON.parse(e.data);
        if (activeTab === 'events') loadEvents();
        if (ev.kind === 'hit' || ev.kind === 'clear') toast(ev.message, ev.kind === 'hit' ? 'ok' : '');
      } catch (err) { /* 忽略损坏帧 */ }
    });
    // 断线时 EventSource 会自动重连，但重连期间页面不能停住 → 启动兜底轮询
    es.onerror = () => { streamAlive = false; startPollFallback(); };
    es.onopen = () => { streamAlive = true; };
  } catch (err) { /* 忽略 */ }
}

/* ---------- 启动 ---------- */
(async function init() {
  try {
    await loadConfig();
    await refreshState();
  } catch (err) {
    toast('初始化失败：' + err.message, 'err');
  }
  connectStream();
  setInterval(() => {
    if (!state) return;
    updateTopbar();
    // 只改文本，不整块重渲染（避免每秒重建 DOM 造成闪烁）
    const c = el('statClock');
    if (c) c.textContent = localClock();
  }, 1000);
  setInterval(loadEvents, 5000);
})();
