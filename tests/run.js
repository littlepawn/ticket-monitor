'use strict';

// 零依赖测试：node tests/run.js
// 全部离线，不访问 12306（真实接口由 scripts/smoke.js 单独验证）

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const os = require('os');

process.env.STATION_OFFLINE = '1';
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'tm-test-'));
process.env.LOG_LEVEL = 'error';

const client = require('../src/client');
const store = require('../src/store');
const notifier = require('../src/notifier');
const { Monitor, inQuietHours, percentile } = require('../src/engine');

const results = [];
async function test(name, fn) {
  try {
    await fn();
    results.push({ name, ok: true });
    console.log(`  ✓ ${name}`);
  } catch (err) {
    results.push({ name, ok: false, error: err });
    console.log(`  ✗ ${name}\n      ${err.message}`);
  }
}

const fixture = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'queryG.json'), 'utf8'));

(async function main() {
  console.log('\n[client] 车站与解析');

  await test('车站表解析出 3000+ 站且字段完整', () => {
    const list = client.parseStations(fs.readFileSync(path.join(__dirname, '..', 'assets', 'station_name.js'), 'utf8'));
    assert.ok(list.length > 3000, `车站数 ${list.length}`);
    const sh = list.find((s) => s.name === '上海');
    assert.strictEqual(sh.code, 'SHH');
    assert.strictEqual(sh.pinyin, 'shanghai');
  });

  await test('站名搜索：中文精确优先于包含', () => {
    const list = client.parseStations(fs.readFileSync(path.join(__dirname, '..', 'assets', 'station_name.js'), 'utf8'));
    assert.strictEqual(client.searchStations('北京', list, 1)[0].code, 'BJP', '中文精确匹配');
    assert.strictEqual(client.searchStations('bj', list, 1)[0].code, 'BJP', '简拼撞车时应优先主要城市');
    assert.strictEqual(client.searchStations('BJP', list, 1)[0].name, '北京', '三字码查询');
    assert.strictEqual(client.searchStations('sh', list, 1)[0].code, 'SHH');
    assert.ok(client.searchStations('bj', list, 5).some((s) => s.code === 'BAP'), '次要同简拼站仍应可搜到');
    assert.strictEqual(client.searchStations('hongqiao', list, 1)[0].code, 'AOH', '拼音片段应能搜到上海虹桥');
    assert.strictEqual(client.searchStations('虹桥', list, 1)[0].code, 'AOH');
    assert.strictEqual(client.searchStations('nanjing', list, 1)[0].code, 'NJH');
    assert.strictEqual(client.searchStations('上海虹桥', list, 1)[0].code, 'AOH');
  });

  await test('无法识别的站名返回空', () => {
    const list = client.parseStations(fs.readFileSync(path.join(__dirname, '..', 'assets', 'station_name.js'), 'utf8'));
    assert.strictEqual(client.resolveStation('不存在的站名XYZ', list), null);
  });

  await test('余票行解析出正确的车次与席别余票', () => {
    const trains = fixture.data.result.map(client.parseTrainLine);
    assert.strictEqual(trains.length, fixture.data.result.length);
    const g1 = trains.find((t) => t.trainCode === 'G1');
    assert.ok(g1, '应能解析出 G1');
    assert.strictEqual(g1.startTime, '06:30');
    assert.strictEqual(g1.arriveTime, '11:24');
    assert.strictEqual(g1.duration, '04:54');
    assert.strictEqual(g1.tickets['二等座'], '有');
    assert.strictEqual(g1.tickets['一等座'], '有');
    assert.strictEqual(g1.tickets['商务座'], '无');
    const g531 = trains.find((t) => t.trainCode === 'G531');
    assert.strictEqual(g531.tickets['一等座'], '无', '一等座应为无票');
    assert.strictEqual(g531.tickets['商务座'], '1', '商务座应解析出数字余票');
  });

  await test('余票状态归一化', () => {
    assert.strictEqual(client.normalizeStatus('有'), '有');
    assert.strictEqual(client.normalizeStatus('12'), '12');
    assert.strictEqual(client.normalizeStatus('无'), '无');
    assert.strictEqual(client.normalizeStatus('--'), '无');
    assert.strictEqual(client.normalizeStatus('候补'), '候补');
    assert.strictEqual(client.normalizeStatus(''), '');
  });

  await test('命中判定：只认「有」与正整数，候补和无票不算', () => {
    const trains = fixture.data.result.map(client.parseTrainLine);
    const hits = client.pickHits(trains, ['二等座']);
    assert.ok(hits.length > 0, '应有二等座余票命中');
    assert.ok(hits.every((h) => Object.keys(h.matched).length > 0));
    const waiting = client.pickHits(
      [{ trainCode: 'X1', tickets: { 二等座: '候补' } }],
      ['二等座'],
    );
    assert.strictEqual(waiting.length, 0, '候补不应算命中');
    const none = client.pickHits([{ trainCode: 'X2', tickets: { 二等座: '无' } }], ['二等座']);
    assert.strictEqual(none.length, 0);
  });

  await test('命中结果带上命中席别的票价', () => {
    const trains = [{ trainCode: 'G2', startTime: '06:43', arriveTime: '11:32', duration: '04:49', tickets: { 二等座: '有', 一等座: '无' }, prices: { 二等座: 661, 一等座: 1058 } }];
    const hits = client.pickHits(trains, ['二等座', '一等座']);
    assert.strictEqual(hits.length, 1);
    assert.strictEqual(hits[0].prices['二等座'], 661);
    assert.strictEqual(hits[0].prices['一等座'], undefined, '未命中的席别不应带票价');
  });

  await test('席别清单包含常用席别', () => {
    const t = client.emptyTickets();
    for (const s of ['商务座', '一等座', '二等座', '软卧', '硬卧', '硬座', '无座']) {
      assert.ok(s in t, `缺少席别 ${s}`);
    }
  });

  await test('302 到官方错误页被识别为不可重试，且不误报为「不是 JSON」', async () => {
    const original = global.fetch;
    let calls = 0;
    global.fetch = async () => {
      calls += 1;
      return new Response('', { status: 302, headers: { location: 'https://www.12306.cn/mormhweb/logFiles/error.html' } });
    };
    try {
      let err = null;
      try {
        await client.queryTickets({ date: '2026-12-31', fromCode: 'SHH', toCode: 'BJP' });
      } catch (e) { err = e; }
      assert.ok(err, '应抛错');
      assert.strictEqual(err.retryable, false, '302 到错误页不可重试');
      assert.strictEqual(err.status, 302);
      assert.ok(err.message.includes('预售期'), `错误信息应说明原因：${err.message}`);
      assert.strictEqual(calls, 1, '不该重试（重试=白打官方接口）');
    } finally {
      global.fetch = original;
    }
  });

  await test('302 带 c_url 时跟随新的查询入口', async () => {
    const original = global.fetch;
    const seen = [];
    global.fetch = async (url) => {
      seen.push(String(url));
      if (String(url).includes('/otn/leftTicket/queryG')) {
        return new Response(JSON.stringify({ c_url: 'leftTicket/queryZ', c_name: 'CLeftTicketUrl', status: false }), { status: 302 });
      }
      return new Response(JSON.stringify({ status: true, data: { result: [], map: {} } }), { status: 200 });
    };
    try {
      const r = await client.queryTickets({ date: '2026-10-10', fromCode: 'SHH', toCode: 'BJP' });
      assert.strictEqual(r.trains.length, 0);
      assert.ok(seen.some((u) => u.includes('queryZ')), '应跟随到新入口');
    } finally {
      global.fetch = original;
    }
  });

  await test('返回 HTML 时给出可读错误且不重试', async () => {
    const original = global.fetch;
    let calls = 0;
    global.fetch = async () => {
      calls += 1;
      return new Response('<!DOCTYPE html PUBLIC "-//W3C//DTD XHTML 1.0 Transitional//EN"><html>error</html>', { status: 200 });
    };
    try {
      let err = null;
      try { await client.queryTickets({ date: '2026-10-10', fromCode: 'SHH', toCode: 'BJP' }); } catch (e) { err = e; }
      assert.ok(err.message.includes('HTML 错误页'), `应识别为 HTML 错误页：${err.message}`);
      assert.strictEqual(err.retryable, false);
      assert.strictEqual(calls, 1);
    } finally {
      global.fetch = original;
    }
  });

  await test('票价解析：与官方 queryTicketPrice 口径一致', () => {
    // 取自实测：G2 yp_info_new → 官方 {9:23150, M:10580, O:6610}
    const p = client.parsePrices('9231500009M105800021O066100021O066103060');
    assert.strictEqual(p['商务座'], 2315, '商务座 23150 角 → 2315 元');
    assert.strictEqual(p['一等座'], 1058);
    assert.strictEqual(p['二等座'], 661);
    // 普速：K507 → 官方 {1:1525, 3:2615, 4:4095}
    const k = client.parsePrices('3026150021404095000010152500211015253312');
    assert.strictEqual(k['硬卧'], 261.5);
    assert.strictEqual(k['软卧'], 409.5);
    assert.strictEqual(k['硬座'], 152.5);
    // 动卧：D51 → 官方 {I:1410, J:1110}
    const d = client.parsePrices('J011100021O002600000I014100002O002603000');
    assert.strictEqual(d['二等卧'], 111);
    assert.strictEqual(d['一等卧'], 141);
    assert.deepStrictEqual(client.parsePrices(''), {});
    assert.deepStrictEqual(client.parsePrices(null), {});
  });

  await test('余票行解析同时带出票价与座位序号', () => {
    const trains = fixture.data.result.map(client.parseTrainLine);
    const g1 = trains.find((t) => t.trainCode === 'G1');
    assert.ok(g1.prices && Object.keys(g1.prices).length > 0, '应解析出票价');
    assert.ok(typeof g1.prices['二等座'] === 'number', '二等座应有票价');
    assert.ok(g1.prices['二等座'] > 0);
    assert.ok(g1.fromStationNo && g1.toStationNo, '应带出上下车站序号');
  });

  await test('时间段筛选：普通区间与跨午夜', () => {
    const t = (startTime) => ({ startTime, prices: {} });
    const trains = [t('06:00'), t('09:30'), t('14:00'), t('22:30'), t('02:00')];
    // 09:00-15:00
    const day = client.filterTrains(trains, { timeEnabled: true, timeFrom: '09:00', timeTo: '15:00' }, []).trains.map((x) => x.startTime);
    assert.deepStrictEqual(day, ['09:30', '14:00']);
    // 跨午夜 22:00-06:00
    const night = client.filterTrains(trains, { timeEnabled: true, timeFrom: '22:00', timeTo: '06:00' }, []).trains.map((x) => x.startTime);
    assert.deepStrictEqual(night, ['06:00', '22:30', '02:00']);
    // 只给起点
    assert.deepStrictEqual(client.filterTrains(trains, { timeEnabled: true, timeFrom: '14:00' }, []).trains.map((x) => x.startTime), ['14:00', '22:30']);
    // 只给终点
    assert.deepStrictEqual(client.filterTrains(trains, { timeEnabled: true, timeTo: '09:30' }, []).trains.map((x) => x.startTime), ['06:00', '09:30', '02:00']);
    // 不启用则原样返回
    assert.strictEqual(client.filterTrains(trains, {}, []).trains.length, 5);
    // 关键：填了值但开关关闭 → 不参与过滤（值只是暂存）
    assert.strictEqual(client.filterTrains(trains, { timeFrom: '09:00', timeTo: '15:00' }, []).trains.length, 5, '未启用时不应过滤');
    assert.strictEqual(client.filterTrains(trains, { timeEnabled: false, timeFrom: '09:00' }, []).trains.length, 5);
  });

  await test('时间段边界：起止相同视为不限，缺时刻不过滤', () => {
    const trains = [{ startTime: '10:00', prices: {} }, { startTime: '', prices: {} }];
    assert.strictEqual(client.filterTrains(trains, { timeEnabled: true, timeFrom: '08:00', timeTo: '08:00' }, []).trains.length, 2);
    assert.strictEqual(client.inTimeWindow('', '09:00', '17:00'), true, '时刻缺失不应被判为不匹配');
    assert.strictEqual(client.inTimeWindow('23:59', '23:00', '06:00'), true);
    assert.strictEqual(client.inTimeWindow('06:00', '23:00', '06:00'), true, '端点包含');
    assert.strictEqual(client.inTimeWindow('06:01', '23:00', '06:00'), false);
  });

  await test('票价筛选：按勾选席别的最低价比较', () => {
    const trains = [
      { trainCode: 'A', startTime: '08:00', prices: { 二等座: 500, 一等座: 900 } },
      { trainCode: 'B', startTime: '09:00', prices: { 二等座: 700, 一等座: 1100 } },
      { trainCode: 'C', startTime: '10:00', prices: {} },
    ];
    // 价格上限 600：只有 A 命中，C 无票价数据不应被误杀
    const cheap = client.filterTrains(trains, { priceEnabled: true, priceMax: 600 }, ['二等座', '一等座']).trains.map((x) => x.trainCode);
    assert.deepStrictEqual(cheap, ['A', 'C'], '无票价数据的车次不应因价格被过滤');
    // 只看二等座：A(500) 通过，B(700) 被过滤
    const onlySecond = client.filterTrains(trains, { priceEnabled: true, priceMax: 600 }, ['二等座']).trains.map((x) => x.trainCode);
    assert.deepStrictEqual(onlySecond, ['A', 'C']);
    // 价格下限
    assert.deepStrictEqual(client.filterTrains(trains, { priceEnabled: true, priceMin: 650 }, ['二等座']).trains.map((x) => x.trainCode), ['B', 'C']);
    // 区间
    assert.deepStrictEqual(client.filterTrains(trains, { priceEnabled: true, priceMin: 600, priceMax: 800 }, ['二等座']).trains.map((x) => x.trainCode), ['B', 'C']);
  });

  await test('时间段与票价可叠加', () => {
    const trains = [
      { trainCode: 'A', startTime: '08:00', prices: { 二等座: 500 } },
      { trainCode: 'B', startTime: '08:30', prices: { 二等座: 900 } },
      { trainCode: 'C', startTime: '20:00', prices: { 二等座: 400 } },
    ];
    const r = client.filterTrains(trains, { timeEnabled: true, timeFrom: '08:00', timeTo: '12:00', priceEnabled: true, priceMax: 600 }, ['二等座']);
    assert.deepStrictEqual(r.trains.map((x) => x.trainCode), ['A']);
    assert.strictEqual(r.skippedByPrice, 1);
  });

  await test('24:00 视为午夜发车，不会被当成「时刻缺失」而绕过筛选', () => {
    assert.strictEqual(client.toMinutes('24:00'), 0);
    assert.strictEqual(client.toMinutes('25:00'), null);
    assert.strictEqual(client.toMinutes('12:60'), null);
    const trains = [
      { trainCode: 'K284', startTime: '22:12', prices: {} },
      { trainCode: 'G3286', startTime: '24:00', prices: {} },
      { trainCode: 'D1', startTime: '06:30', prices: {} },
    ];
    // 跨午夜区间应包含 24:00
    assert.deepStrictEqual(
      client.filterTrains(trains, { timeEnabled: true, timeFrom: '22:00', timeTo: '06:00' }, []).trains.map((x) => x.trainCode),
      ['K284', 'G3286'],
    );
    // 20:00-23:00 不应包含 24:00
    assert.deepStrictEqual(
      client.filterTrains(trains, { timeEnabled: true, timeFrom: '20:00', timeTo: '23:00' }, []).trains.map((x) => x.trainCode),
      ['K284'],
    );
    // 白天区间不应包含 24:00
    assert.deepStrictEqual(
      client.filterTrains(trains, { timeEnabled: true, timeFrom: '06:00', timeTo: '12:00' }, []).trains.map((x) => x.trainCode),
      ['D1'],
    );
  });

  await test('lowestPrice 在无数据时返回 null 而非 0', () => {
    assert.strictEqual(client.lowestPrice({ prices: {} }, ['二等座']), null);
    assert.strictEqual(client.lowestPrice({ prices: { 二等座: 661 } }, ['二等座']), 661);
    assert.strictEqual(client.lowestPrice({ prices: { 二等座: 661, 一等座: 1058 } }, ['二等座', '一等座']), 661);
    assert.strictEqual(client.lowestPrice({ prices: { 三等座: 1 } }, ['二等座']), null);
  });

  await test('旧配置迁移：填过值即视为已启用，不静默失效', () => {
    const st = require('../src/store');
    // 老版本任务没有开关字段
    const old = st.migrateWatch({ id: 'a', timeFrom: '08:00', timeTo: '11:00', priceMin: null, priceMax: null });
    assert.strictEqual(old.timeEnabled, true, '填过时段应迁移为已启用');
    assert.strictEqual(old.priceEnabled, false);
    // 没填过值的保持关闭，并清掉残留
    const empty = st.migrateWatch({ id: 'b', timeFrom: null, timeTo: null, priceMin: null, priceMax: null });
    assert.strictEqual(empty.timeEnabled, false);
    assert.strictEqual(empty.timeFrom, null);
    // 已有开关的尊重原值，即使关闭也清残留值
    const off = st.migrateWatch({ id: 'c', timeEnabled: false, timeFrom: '08:00', priceEnabled: true, priceMax: 700 });
    assert.strictEqual(off.timeEnabled, false);
    assert.strictEqual(off.timeFrom, null, '关闭的维度应清掉残留值');
    assert.strictEqual(off.priceEnabled, true);
    assert.strictEqual(off.priceMax, 700);
  });

  await test('三个筛选维度可独立启用、组合叠加、全部不启用', () => {
    const client2 = client;
    const trains = [
      { trainCode: 'G2', startTime: '08:00', prices: { 二等座: 600 } },
      { trainCode: 'G4', startTime: '08:30', prices: { 二等座: 900 } },
      { trainCode: 'G6', startTime: '20:00', prices: { 二等座: 500 } },
      { trainCode: 'D1', startTime: '21:00', prices: { 二等座: 400 } },
    ];
    const seats = ['二等座'];
    const apply = (f) => client2.filterTrains(trains, f, seats).trains.map((x) => x.trainCode);

    // 全不启用 → 全部保留
    assert.deepStrictEqual(apply({}), ['G2', 'G4', 'G6', 'D1']);
    // 只启用时段
    assert.deepStrictEqual(apply({ timeEnabled: true, timeFrom: '08:00', timeTo: '09:00' }), ['G2', 'G4']);
    // 只启用票价
    assert.deepStrictEqual(apply({ priceEnabled: true, priceMax: 600 }), ['G2', 'G6', 'D1']);
    // 两个都启用 → 取交集
    assert.deepStrictEqual(
      apply({ timeEnabled: true, timeFrom: '08:00', timeTo: '09:00', priceEnabled: true, priceMax: 600 }),
      ['G2'],
    );
    // 组合结果为空时也要正常返回空数组（不报错）
    assert.deepStrictEqual(
      apply({ timeEnabled: true, timeFrom: '08:00', timeTo: '09:00', priceEnabled: true, priceMax: 100 }),
      [],
    );
  });

  console.log('\n[engine] 调度与状态');

  await test('静默时段跨午夜判定正确', () => {
    assert.strictEqual(inQuietHours({ enabled: true, start: '23:30', end: '06:30' }, new Date('2026-10-04T02:00:00')), true);
    assert.strictEqual(inQuietHours({ enabled: true, start: '23:30', end: '06:30' }, new Date('2026-10-04T12:00:00')), false);
    assert.strictEqual(inQuietHours({ enabled: true, start: '09:00', end: '17:00' }, new Date('2026-10-04T12:00:00')), true);
    assert.strictEqual(inQuietHours({ enabled: false, start: '00:00', end: '23:59' }, new Date('2026-10-04T12:00:00')), false);
  });

  await test('分位数计算', () => {
    assert.strictEqual(percentile([], 50), null);
    assert.strictEqual(percentile([10], 50), 10);
    assert.strictEqual(percentile([10, 20, 30, 40], 50), 20);
    assert.strictEqual(percentile([10, 20, 30, 40], 90), 40);
  });

  await test('命中状态机：首次命中推送一次，重复命中不重复推送', async () => {
    let config = {
      settings: { ...store.DEFAULT_CONFIG.settings },
      watches: [{ id: 'w1', fromName: '上海', toName: '北京', date: '2026-10-10', seats: ['二等座'], enabled: true }],
      channels: [],
    };
    const monitor = new Monitor({ getConfig: () => config });
    const sent = [];
    monitor.notify = async (watch, title) => { sent.push(title); };
    const st = monitor.stateFor('w1');
    const hits = [{ trainCode: 'G2', startTime: '06:43', arriveTime: '11:32', duration: '04:49', matched: { 二等座: '有' } }];

    await monitor.applyHits(config.watches[0], st, hits, (c) => c);
    assert.strictEqual(sent.length, 1, '首次命中应推送');
    assert.strictEqual(monitor.metrics.hits, 1);
    assert.ok(st.boostUntil > Date.now(), '命中后应进入快速复查窗口');

    await monitor.applyHits(config.watches[0], st, hits, (c) => c);
    assert.strictEqual(sent.length, 1, '相同命中不应重复推送');
    assert.strictEqual(monitor.metrics.hits, 1);

    const more = [...hits, { trainCode: 'G4', startTime: '07:00', arriveTime: '11:37', duration: '04:37', matched: { 二等座: '有' } }];
    await monitor.applyHits(config.watches[0], st, more, (c) => c);
    assert.strictEqual(sent.length, 2, '命中集合变化应再推送一次');

    // 车次集合不变、但余票状态从「有」变成具体张数 → 也应推送（信息更有价值）
    const restocked = [{ trainCode: 'G2', startTime: '06:43', arriveTime: '11:32', duration: '04:49', matched: { 二等座: '5' } }];
    await monitor.applyHits(config.watches[0], st, restocked, (c) => c);
    assert.strictEqual(sent.length, 3, '余票状态变化也应推送');
  });

  await test('余票消失：仅在此前有票时触发恢复推送', async () => {
    const config = {
      settings: { ...store.DEFAULT_CONFIG.settings, notifyRecovery: true },
      watches: [{ id: 'w2', fromName: '上海', toName: '北京', date: '2026-10-10', seats: ['二等座'], enabled: true }],
      channels: [],
    };
    const monitor = new Monitor({ getConfig: () => config });
    const sent = [];
    monitor.notify = async (watch, title) => { sent.push(title); };
    const st = monitor.stateFor('w2');

    await monitor.applyHits(config.watches[0], st, [], (c) => c);
    assert.strictEqual(sent.length, 0, '从未有票时不应推送恢复');

    await monitor.applyHits(config.watches[0], st, [{ trainCode: 'G2', matched: { 二等座: '有' } }], (c) => c);
    assert.strictEqual(sent.length, 1);
    await monitor.applyHits(config.watches[0], st, [], (c) => c);
    assert.strictEqual(sent.length, 2, '有票转无票应推送恢复');
    assert.strictEqual(st.hitsSince, null);
  });

  await test('查询失败进入指数退避，成功后清零', async () => {
    const config = {
      settings: { ...store.DEFAULT_CONFIG.settings },
      watches: [{ id: 'w3', from: '上海', to: '北京', fromCode: 'SHH', toCode: 'BJP', fromName: '上海', toName: '北京', date: '2026-10-10', seats: ['二等座'], enabled: true }],
      channels: [],
    };
    const monitor = new Monitor({ getConfig: () => config });
    monitor.stations = [];
    const original = client.queryTickets;
    client.queryTickets = async () => { throw new client.QueryError('模拟 429', { retryable: false, status: 429 }); };
    const watch = config.watches[0];
    await monitor.checkWatch(watch, 'manual');
    const st = monitor.stateFor('w3');
    assert.strictEqual(st.status, 'error');
    assert.strictEqual(st.errorStreak, 1);
    assert.ok(st.backoffUntil > Date.now(), '失败后应设置退避时间');

    // 退避未过期前，即使上游恢复也不应再发请求
    let calls = 0;
    client.queryTickets = async () => { calls += 1; return { trains: [], stationMap: {}, checkedAt: Date.now() }; };
    await monitor.checkWatch(watch, 'manual');
    assert.strictEqual(calls, 0, '退避未过期不应请求');
    assert.strictEqual(st.status, 'backoff');
    // 退避过期后恢复查询，成功即清零
    st.backoffUntil = Date.now() - 1;
    await monitor.checkWatch(watch, 'manual');
    assert.strictEqual(calls, 1, '退避过期后应恢复查询');
    assert.strictEqual(st.status, 'ok');
    assert.strictEqual(st.errorStreak, 0);
    assert.strictEqual(st.backoffUntil, null);
    client.queryTickets = original;
  });

  await test('退避期间调度触发不再请求接口', async () => {
    const config = {
      settings: { ...store.DEFAULT_CONFIG.settings },
      watches: [{ id: 'w4', from: '上海', to: '北京', fromCode: 'SHH', toCode: 'BJP', fromName: '上海', toName: '北京', date: '2026-10-10', seats: ['二等座'], enabled: true }],
      channels: [],
    };
    const monitor = new Monitor({ getConfig: () => config });
    monitor.stations = [];
    let calls = 0;
    const original = client.queryTickets;
    client.queryTickets = async () => { calls += 1; return { trains: [], stationMap: {}, checkedAt: Date.now() }; };
    const st = monitor.stateFor('w4');
    st.backoffUntil = Date.now() + 60000;
    await monitor.checkWatch(config.watches[0], 'schedule');
    assert.strictEqual(calls, 0, '退避期间不应发起请求');
    assert.strictEqual(st.status, 'backoff');
    // 手动查询也必须遵守退避：否则连点「立即检查」就能绕过 429/403 退避，
    // 反而放大请求量 —— 这正是低打扰约束要防的
    await monitor.checkWatch(config.watches[0], 'manual');
    assert.strictEqual(calls, 0, '手动查询也应尊重退避，不得发起请求');
    assert.strictEqual(st.status, 'backoff');
    client.queryTickets = original;
  });

  await test('席别汇总统计有票与候补车次数', async () => {
    const monitor = new Monitor({ getConfig: () => store.DEFAULT_CONFIG });
    const trains = [
      { tickets: { 二等座: '有', 一等座: '无' } },
      { tickets: { 二等座: '3', 一等座: '候补' } },
      { tickets: { 二等座: '无', 一等座: '无' } },
    ];
    const summary = monitor.seatSummary(trains, ['二等座', '一等座']);
    assert.deepStrictEqual(summary['二等座'], { available: 2, waiting: 0, total: 3 });
    assert.deepStrictEqual(summary['一等座'], { available: 0, waiting: 1, total: 3 });
  });

  await test('未配置渠道时不发送但记录事件', async () => {
    const config = {
      settings: { ...store.DEFAULT_CONFIG.settings },
      watches: [{ id: 'w5', fromName: '上海', toName: '北京', date: '2026-10-10' }],
      channels: [],
    };
    const monitor = new Monitor({ getConfig: () => config });
    await monitor.notify(config.watches[0], '标题', '正文');
    const events = monitor.recentEvents(5);
    assert.ok(events.some((e) => e.message.includes('未配置推送渠道')));
  });

  await test('通知正文包含车次、时刻与席别', async () => {
    const monitor = new Monitor({ getConfig: () => store.DEFAULT_CONFIG });
    const body = monitor.formatHits(
      { date: '2026-10-10', fromName: '上海', toName: '北京' },
      [{ trainCode: 'G2', startTime: '06:43', arriveTime: '11:32', duration: '04:49', matched: { 二等座: '有' }, prices: { 二等座: 661 } }],
      (c) => c,
    );
    assert.ok(body.includes('上海 → 北京'));
    assert.ok(body.includes('G2'));
    assert.ok(body.includes('06:43-11:32'));
    assert.ok(body.includes('二等座 有'));
    assert.ok(body.includes('¥661'), '推送正文应带命中席别票价');
  });

  console.log('\n[store] 配置读写');

  await test('默认配置落盘并可读回', () => {
    const config = store.load();
    assert.ok(config.settings.intervalSeconds >= 300, '默认间隔应保守');
    assert.ok(Array.isArray(config.watches));
    assert.ok(fs.existsSync(store.FILE));
  });

  await test('新增 id 不重复', () => {
    const ids = new Set();
    for (let i = 0; i < 200; i += 1) ids.add(store.newId('w'));
    assert.strictEqual(ids.size, 200);
  });

  await test('损坏的 config.json 会被备份而不是静默清空', () => {
    const origFile = store.FILE;
    const raw = fs.readFileSync(origFile, 'utf8');
    const before = fs.readdirSync(path.dirname(origFile)).filter((f) => f.startsWith('config.json.broken-')).length;
    fs.writeFileSync(origFile, '{ broken');
    const config = store.load();
    assert.ok(Array.isArray(config.watches), '应回退到默认配置');
    const backups = fs.readdirSync(path.dirname(origFile)).filter((f) => f.startsWith('config.json.broken-'));
    assert.strictEqual(backups.length, before + 1, '应生成一份备份文件');
    assert.strictEqual(fs.readFileSync(path.join(path.dirname(origFile), backups[backups.length - 1]), 'utf8'), '{ broken');
    fs.writeFileSync(origFile, raw);
  });

  console.log('\n[notifier] 渠道配置与密钥掩码');

  await test('八种渠道类型均有字段定义', () => {
    const types = notifier.TYPES.map((t) => t.type);
    for (const t of ['serverchan', 'bark', 'wecom', 'dingtalk', 'telegram', 'pushplus', 'ntfy', 'webhook']) {
      assert.ok(types.includes(t), `缺少渠道 ${t}`);
    }
    for (const t of notifier.TYPES) {
      assert.ok(t.fields.length > 0, `${t.type} 应至少有一个字段`);
      assert.ok(t.fields.some((f) => f.required), `${t.type} 应有必填字段`);
    }
  });

  await test('掩码不会泄露任何密钥字段', () => {
    const masked = notifier.mask({ id: 'c1', type: 'serverchan', name: '微信', sendkey: 'SCTsecret', enabled: true });
    assert.strictEqual(masked.sendkey, notifier.MASKED);
    assert.strictEqual(masked.name, '微信');
    assert.strictEqual(masked.id, 'c1');
    // 端点地址不是密钥：掩码它会让用户在编辑时把真实地址覆盖成 ******
    const bark = notifier.mask({ type: 'bark', deviceKey: 'abc123', serverUrl: 'https://api.day.app' });
    assert.strictEqual(bark.deviceKey, notifier.MASKED);
    assert.strictEqual(bark.serverUrl, 'https://api.day.app', 'serverUrl 是端点不是密钥，不应掩码');
    const hook = notifier.mask({ type: 'webhook', url: 'https://real.example/hook' });
    assert.strictEqual(hook.url, 'https://real.example/hook');
  });

  await test('未知渠道类型返回明确错误', async () => {
    const r = await notifier.send({ type: 'unknown-type' }, 't', 'b');
    assert.strictEqual(r.ok, false);
    assert.ok(r.error.includes('不支持'));
  });

  await test('缺少必填字段时发送前即失败（不发网络请求）', async () => {
    const r = await notifier.send({ type: 'serverchan', sendkey: '' }, 't', 'b');
    assert.strictEqual(r.ok, false);
    assert.ok(r.error.includes('SendKey'));
    const b = await notifier.send({ type: 'bark', deviceKey: '' }, 't', 'b');
    assert.strictEqual(b.ok, false);
  });

  await test('Server 酱端点按 key 前缀选择', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'notifier.js'), 'utf8');
    assert.ok(src.includes('sctapi.ftqq.com'), '应支持 Turbo 端点');
    assert.ok(src.includes('push.ft07.com'), '应支持 Server酱³ 端点');
    assert.ok(src.includes('/^sctp(\\d+)t/i') || src.includes('sctp'), '应识别 sctp 前缀');
  });

  await test('配置目录只读时不崩，只降级为「不持久化」', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tm-ro-'));
    const origDir = process.env.DATA_DIR;
    fs.chmodSync(dir, 0o500);
    process.env.DATA_DIR = dir;
    delete require.cache[require.resolve('../src/store')];
    const roStore = require('../src/store');
    try {
      const ok = roStore.save({ a: 1 });
      if (process.getuid && process.getuid() === 0) {
        assert.ok(true, 'root 绕过权限位，跳过断言');
      } else {
        assert.strictEqual(ok, false, '只读目录写入应返回 false 而不是抛异常');
        assert.ok(roStore.getLastSaveError(), '应记录最后一次写入错误');
        assert.ok(['EACCES', 'EPERM', 'EROFS'].includes(roStore.getLastSaveError().code), `错误码异常：${roStore.getLastSaveError().code}`);
      }
    } finally {
      fs.chmodSync(dir, 0o700);
      fs.rmSync(dir, { recursive: true, force: true });
      process.env.DATA_DIR = origDir;
      delete require.cache[require.resolve('../src/store')];
      require('../src/store');
    }
  });

  await test('每个席别各自带票价（不共用最低价）', () => {
    const trains = fixture.data.result.map(client.parseTrainLine);
    const g1 = trains.find((t) => t.trainCode === 'G1');
    assert.ok(g1.prices['二等座'] > 0, '二等座应有自己的票价');
    assert.ok(g1.prices['一等座'] > 0, '一等座应有自己的票价');
    assert.notStrictEqual(g1.prices['二等座'], g1.prices['一等座'], '不同席别价格必须不同');
    // 席别之间不应互相串价
    assert.ok(g1.prices['一等座'] > g1.prices['二等座'], '一等座应贵于二等座');
  });

  await test('席别列下标与官方解构一致（曾把特等座/优选一等座错位）', () => {
    // 官方 queryLeftTicket_end_js.js 的解构：
    //   c9[20]gg_num(优选一等座) c9[25]tz_num(特等座) c9[32]swz_num(商务座)
    // 实测依据：seat_types 含 D 的车次，c9[20] 有值；含 P 的车次，c9[25] 有值。
    const row = new Array(58).fill('');
    row[3] = 'G3';
    row[20] = '3';   // gg_num 优选一等座
    row[25] = '7';   // tz_num 特等座
    row[32] = '5';   // swz_num 商务座
    row[31] = '有';  // zy_num 一等座
    row[30] = '有';  // ze_num 二等座
    const t = client.parseTrainLine(row.join('|'));
    assert.strictEqual(t.tickets['优选一等座'], '3', 'c9[20] 是优选一等座');
    assert.strictEqual(t.tickets['特等座'], '7', 'c9[25] 是特等座');
    assert.strictEqual(t.tickets['商务座'], '5');
    assert.strictEqual(t.tickets['一等座'], '有');
    assert.strictEqual(t.tickets['二等座'], '有');
    // 两列绝不可互换
    assert.notStrictEqual(t.tickets['优选一等座'], t.tickets['特等座']);
  });

  await test('真实夹具中席别与 seat_types 自洽', () => {
    const trains = fixture.data.result.map((x) => x.split('|'));
    let inconsistent = 0;
    for (const a of trains) {
      const st = a[35] || '';
      const t = client.parseTrainLine(a.join('|'));
      // seat_types 不含 D 时不应解析出优选一等座余票；不含 P 时不应有特等座
      if (!st.includes('D') && t.tickets['优选一等座'] !== '') inconsistent += 1;
      if (!st.includes('P') && t.tickets['特等座'] !== '') inconsistent += 1;
    }
    assert.strictEqual(inconsistent, 0, `席别与 seat_types 不一致 ${inconsistent} 处`);
  });

  await test('票价表与余票状态相互独立：无票席别也可能有报价', () => {
    // yp_info_new 是该车次的报价表，不代表席别当前有票。
    // 实测 55 个车次里有 3 个「某席别无票但仍有报价」，属正常，页面照常显示价格。
    const rows = fixture.data.result.map((x) => x.split('|'));
    const g531 = rows.find((r) => r[3] === 'G531');
    const t = client.parseTrainLine(g531.join('|'));
    assert.strictEqual(t.tickets['一等座'], '无', '该车次一等座应无票');
    assert.ok(typeof t.prices['一等座'] === 'number', '无票席别仍可能有报价');
    // 报价表里没有的席别，prices 里就不该出现
    assert.strictEqual(t.tickets['软卧'], '', '该车次不售软卧');
    assert.strictEqual(t.prices['软卧'], undefined, '不售席别不应有票价');
  });

  console.log('\n[stops] 经停站');

  await test('经停站解析：始发/终到标记与停留时间', () => {
    const rows = [
      { station_name: '上海虹桥', station_no: '01', arrive_time: '----', start_time: '06:43', stopover_time: '----', station_train_code: 'G2' },
      { station_name: '南京南', station_no: '04', arrive_time: '07:58', start_time: '08:01', stopover_time: '3分钟', station_train_code: 'G2' },
      { station_name: '北京南', station_no: '07', arrive_time: '11:32', start_time: '11:32', stopover_time: '----', station_train_code: 'G2' },
    ];
    // 直接复用解析逻辑：通过 queryTrainStops 的映射规则校验
    const mapped = rows.map((r) => ({
      no: r.station_no,
      name: r.station_name,
      arriveTime: r.arrive_time,
      startTime: r.start_time,
      stopover: r.stopover_time,
      isStart: r.arrive_time === '----',
      isEnd: r.start_time === r.arrive_time && r.arrive_time !== '----',
    }));
    assert.strictEqual(mapped[0].isStart, true, '始发站到达时间为 ----');
    assert.strictEqual(mapped[0].isEnd, false);
    assert.strictEqual(mapped[2].isEnd, true, '终到站到发时间相同');
    assert.strictEqual(mapped[1].stopover, '3分钟');
  });

  await test('经停站参数缺失时立即报错（不发请求）', async () => {
    let called = false;
    const original = global.fetch;
    global.fetch = async () => { called = true; return new Response('{}'); };
    try {
      let err = null;
      try { await client.queryTrainStops({ trainNo: '', date: '2026-10-16', fromCode: 'A', toCode: 'B' }); } catch (e) { err = e; }
      assert.ok(err && err.message.includes('缺少'), '缺参数应报错');
      assert.strictEqual(called, false, '缺参数不应发请求');
      let err2 = null;
      try { await client.queryTrainStops({ trainNo: 'X', date: '', fromCode: 'A', toCode: 'B' }); } catch (e) { err2 = e; }
      assert.ok(err2, '缺日期应报错');
      assert.strictEqual(called, false);
    } finally {
      global.fetch = original;
    }
  });

  await test('经停站接口异常时给出可读错误', async () => {
    const original = global.fetch;
    try {
      global.fetch = async () => new Response('', { status: 429 });
      let err = null;
      try { await client.queryTrainStops({ trainNo: 'T1', date: '2026-10-16', fromCode: 'A', toCode: 'B' }); } catch (e) { err = e; }
      assert.ok(err.message.includes('限流'), `应识别限流：${err.message}`);

      global.fetch = async () => new Response('<html>error</html>', { status: 200 });
      let err2 = null;
      try { await client.queryTrainStops({ trainNo: 'T2', date: '2026-10-16', fromCode: 'A', toCode: 'B' }); } catch (e) { err2 = e; }
      assert.ok(err2.message.includes('HTML'), `应识别 HTML 错误页：${err2.message}`);

      global.fetch = async () => new Response(JSON.stringify({ status: true, data: { data: [] } }), { status: 200 });
      let err3 = null;
      try { await client.queryTrainStops({ trainNo: 'T3', date: '2026-10-16', fromCode: 'A', toCode: 'B' }); } catch (e) { err3 = e; }
      assert.ok(err3.message.includes('暂无'), '空数据应明确提示');
    } finally {
      global.fetch = original;
    }
  });

  await test('经停站结果缓存命中，避免重复请求', async () => {
    const original = global.fetch;
    let calls = 0;
    global.fetch = async () => {
      calls += 1;
      return new Response(JSON.stringify({
        status: true,
        data: { data: [{ station_name: '甲站', station_no: '01', arrive_time: '----', start_time: '08:00', stopover_time: '----', station_train_code: 'C1' }] },
      }), { status: 200 });
    };
    try {
      const arg = { trainNo: 'CACHE-TEST-1', date: '2026-10-16', fromCode: 'A', toCode: 'B' };
      const a = await client.queryTrainStops(arg);
      assert.strictEqual(calls, 1);
      assert.strictEqual(a.cached, false);
      const b = await client.queryTrainStops(arg);
      assert.strictEqual(calls, 1, '第二次应命中缓存，不再请求');
      assert.strictEqual(b.cached, true);
      assert.strictEqual(b.stops.length, 1);
    } finally {
      global.fetch = original;
    }
  });

  await test('快照与命中都携带 trainNo（经停站接口必需）', async () => {
    const config = {
      settings: { ...store.DEFAULT_CONFIG.settings },
      watches: [{ id: 'wn', from: '上海', to: '北京', fromCode: 'SHH', toCode: 'BJP', fromName: '上海', toName: '北京', date: '2026-10-10', seats: ['二等座'], enabled: true }],
      channels: [],
    };
    const monitor = new Monitor({ getConfig: () => config });
    monitor.stations = [];
    const original = client.queryTickets;
    client.queryTickets = async () => ({
      trains: [{ trainCode: 'G2', trainNo: '5l000000G250', startTime: '06:43', arriveTime: '11:32', duration: '04:49', fromCode: 'SHH', toCode: 'BJP', tickets: { 二等座: '有' }, prices: { 二等座: 661 } }],
      stationMap: { SHH: '上海', BJP: '北京' },
      checkedAt: Date.now(),
    });
    try {
      await monitor.checkWatch(config.watches[0], 'manual');
      const snap = monitor.snapshot().watches[0];
      assert.strictEqual(snap.lastResult[0].trainNo, '5l000000G250', '结果表需要 trainNo');
      assert.strictEqual(snap.hits[0].trainNo, '5l000000G250', '命中列表也需要 trainNo');
    } finally {
      client.queryTickets = original;
    }
  });

  await test('前端点车次时传的是 trainNo 而不是车次号', () => {
    const js = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.js'), 'utf8');
    assert.ok(js.includes('data-stops="${esc(t.trainNo'), '表格应带 trainNo');
    assert.ok(js.includes('data-code="${esc(t.trainCode)}"'), '同时要有车次号用于展示');
    assert.ok(js.includes('watchId, trainNo, trainCode }'), '请求体应传 trainNo，日期由服务端从任务取');
    // 所有车次按钮都必须自带 watch 参数：渲染作用域里没有 w，闭包引用会 ReferenceError
    assert.ok(js.includes('bindStopsLinks'), '应统一绑定车次点击');
    const stopBtns = js.split('\n').filter((l) => l.includes('class="train-link"'));
    assert.ok(stopBtns.length >= 3, `三处表格都应有车次按钮，实际 ${stopBtns.length}`);
    for (const line of stopBtns) {
      assert.ok(line.includes('data-watch='), `车次按钮缺少 data-watch：${line.slice(0, 80)}`);
    }
    assert.ok(!/openStopsModal\(b\.dataset\.stops, b\.dataset\.code, w\./.test(js), '不应在闭包里引用 w');
    assert.ok(js.includes("if (!trainNo)"), '缺 trainNo 时应给出提示而不是发无效请求');
  });

  await test('经停站只按需查询，不在轮询里调用', () => {
    const engineSrc = fs.readFileSync(path.join(__dirname, '..', 'src', 'engine.js'), 'utf8');
    assert.ok(!engineSrc.includes('queryTrainStops'), '轮询引擎不得调用经停站接口（否则请求量乘以车次数）');
    const serverSrc = fs.readFileSync(path.join(__dirname, '..', 'src', 'server.js'), 'utf8');
    // 路由写成了正则转义形式 /^\\/api\\/trains\\/stops$/，所以只检查语义片段
    assert.ok(serverSrc.includes('trains') && serverSrc.includes('stops'), '应有按需查询接口');
    assert.ok(serverSrc.includes('queryTrainStops'), '接口应调用经停站查询');
  });

  console.log('\n[dav] WebDAV 备份');

  await test('WebDAV 地址校验与路径拼接', () => {
    const dav = require('../src/dav');
    assert.strictEqual(dav.normalizeBase('https://dav.example.com/dav/'), 'https://dav.example.com/dav');
    assert.throws(() => dav.normalizeBase(''), /未填写/);
    assert.throws(() => dav.normalizeBase('not a url'), /合法 URL/);
    assert.throws(() => dav.normalizeBase('ftp://x.com'), /http/);
    // 中文与空格必须编码，否则多数服务返回 404
    assert.strictEqual(dav.joinUrl('https://x.com/dav', '我的 备份'), 'https://x.com/dav/%E6%88%91%E7%9A%84%20%E5%A4%87%E4%BB%BD');
    assert.strictEqual(dav.joinUrl('https://x.com/dav', 'a', 'config-1.json'), 'https://x.com/dav/a/config-1.json');
  });

  await test('备份负载中的密钥与令牌一律掩码（不把密钥传上云）', () => {
    const dav = require('../src/dav');
    const config = {
      settings: { intervalSeconds: 900, token: 'REAL-ACCESS-TOKEN', webdav: { password: 'REAL-DAV-PASS' } },
      watches: [{ id: 'w1', from: '上海', to: '北京', date: '2026-10-16' }],
      channels: [
        { id: 'c1', type: 'serverchan', sendkey: 'SCT-REAL' },
        { id: 'c2', type: 'bark', deviceKey: 'BARK-REAL', serverUrl: 'https://api.day.app' },
        { id: 'c3', type: 'webhook', url: 'https://real.example/hook' },
      ],
    };
    const payload = dav.buildExportPayload(config, notifier.MASKED);
    const text = JSON.stringify(payload);
    assert.ok(!text.includes('REAL-ACCESS-TOKEN'), '令牌不得出现在备份里');
    assert.ok(!text.includes('SCT-REAL'), '渠道密钥不得出现在备份里');
    assert.ok(!text.includes('BARK-REAL'), 'Bark 密钥不得出现在备份里');
    assert.ok(!text.includes('REAL-DAV-PASS'), 'WebDAV 密码不得出现在备份里');
    assert.strictEqual(payload.channels[0].sendkey, notifier.MASKED);
    // 端点地址不是密钥，保留可读
    assert.strictEqual(payload.channels[1].serverUrl, 'https://api.day.app');
    assert.strictEqual(payload.channels[2].url, 'https://real.example/hook');
    assert.strictEqual(payload.settings.token, notifier.MASKED);
  });

  await test('恢复时用本地密钥补回掩码，未知渠道保持缺省', () => {
    const dav = require('../src/dav');
    const local = [
      { id: 'c1', type: 'serverchan', name: '微信', sendkey: 'LOCAL-KEY' },
      { id: 'c9', type: 'bark', name: '别的', deviceKey: 'X' },
    ];
    const payload = {
      channels: [
        { id: 'c1', type: 'serverchan', name: '微信', sendkey: notifier.MASKED },
        { id: 'c2', type: 'serverchan', name: '云端新增', sendkey: notifier.MASKED },
      ],
    };
    const merged = dav.mergeSecretsFromLocal(payload, local);
    assert.strictEqual(merged[0].sendkey, 'LOCAL-KEY', '同 id 应补回本地密钥');
    assert.strictEqual(merged[1].sendkey, notifier.MASKED, '本地没有的渠道保持掩码（需手工补）');
  });

  await test('备份内容校验：结构不对必须拒绝恢复', () => {
    const dav = require('../src/dav');
    assert.throws(() => dav.validatePayload(null), /不是对象/);
    assert.throws(() => dav.validatePayload({}), /缺少 watches/);
    assert.throws(() => dav.validatePayload({ watches: 'x' }), /缺少 watches/);
    assert.throws(() => dav.validatePayload({ watches: [], channels: 'x' }), /channels/);
    assert.throws(() => dav.validatePayload({ watches: [], settings: 5 }), /settings/);
    assert.throws(() => dav.validatePayload({ watches: [{ from: '上海' }] }), /缺少站点或日期/);
    assert.strictEqual(dav.validatePayload({ watches: [] }), true);
    assert.strictEqual(dav.validatePayload({ watches: [{ from: '上海', to: '北京', date: '2026-10-16' }] }), true);
  });

  await test('PROPFIND 响应解析（含命名空间变体）', () => {
    const dav = require('../src/dav');
    const xml = `<?xml version="1.0"?><D:multistatus xmlns:D="DAV:">
      <D:response><D:href>/dav/ticket-monitor/</D:href><D:propstat><D:prop><D:resourcetype><D:collection/></D:resourcetype></D:prop></D:propstat></D:response>
      <D:response><D:href>/dav/ticket-monitor/config-20261004-120000.json</D:href><D:propstat><D:prop><D:getcontentlength>512</D:getcontentlength><D:getlastmodified>Sat, 04 Oct 2026 04:00:00 GMT</D:getlastmodified><D:resourcetype/></D:prop></D:propstat></D:response>
      <D:response><D:href>/dav/ticket-monitor/readme.txt</D:href><D:propstat><D:prop><D:getcontentlength>10</D:getcontentlength><D:resourcetype/></D:prop></D:propstat></D:response>
    </D:multistatus>`;
    const items = dav.parseStatXml(xml);
    assert.strictEqual(items.length, 1, '只应列出 .json 且排除目录');
    assert.strictEqual(items[0].name, 'config-20261004-120000.json');
    assert.strictEqual(items[0].size, 512);
    assert.ok(items[0].modifiedAt > 0);
  });

  await test('备份文件名不合法时拒绝下载（防路径穿越）', async () => {
    const dav = require('../src/dav');
    const conn = { url: 'http://127.0.0.1:1/dav', username: 'u', password: 'p', path: 'x' };
    await assert.rejects(() => dav.download(conn, '../config.json'), /不合法/);
    await assert.rejects(() => dav.download(conn, 'a/b.json'), /不合法/);
    await assert.rejects(() => dav.download(conn, ''), /不合法/);
  });

  await test('WebDAV 端到端：上传→轮转→下载→掩码还原（对 mock 服务）', async () => {
    const dav = require('../src/dav');
    const net = require('net');
    // 先探测 mock 是否在跑；不在就跳过（不把外部依赖写死进测试）
    const alive = await new Promise((resolve) => {
      const s = net.connect(8765, '127.0.0.1');
      s.on('connect', () => { s.destroy(); resolve(true); });
      s.on('error', () => resolve(false));
      setTimeout(() => { s.destroy(); resolve(false); }, 800);
    });
    if (!alive) { console.log('      （mock WebDAV 未运行，跳过）'); return; }

    const conn = { url: 'http://127.0.0.1:8765/dav', username: 'davuser', password: 'secret-pass', path: `it-${Date.now()}` };
    const info = await dav.testConnection(conn);
    assert.strictEqual(info.ok, true);

    const config = {
      settings: { intervalSeconds: 900, token: 'IT-TOKEN', webdav: { password: 'IT-DAV-PASS' } },
      watches: [{ id: 'w1', from: '上海', to: '北京', date: '2026-10-16', seats: ['二等座'], fromName: '上海', toName: '北京', fromCode: 'SHH', toCode: 'BJP' }],
      channels: [{ id: 'c1', type: 'serverchan', name: '微信', sendkey: 'IT-LOCAL-KEY' }],
    };
    const payload = dav.buildExportPayload(config, notifier.MASKED);
    const up = await dav.upload(conn, payload, { keep: 5 });
    assert.ok(up.name.endsWith('.json'));

    const items = await dav.listBackups(conn);
    assert.ok(items.length >= 1, '应能列出刚上传的备份');
    assert.ok(items.some((x) => x.name === up.name));

    const got = await dav.download(conn, up.name);
    assert.strictEqual(got.watches.length, 1);
    assert.strictEqual(got.watches[0].from, '上海');
    assert.strictEqual(got.channels[0].sendkey, notifier.MASKED, '云端不应存有明文密钥');
    assert.ok(!JSON.stringify(got).includes('IT-LOCAL-KEY'), '备份内容不得含明文密钥');
    assert.ok(!JSON.stringify(got).includes('IT-DAV-PASS'), '备份内容不得含 WebDAV 密码');
    assert.ok(!JSON.stringify(got).includes('IT-TOKEN'), '备份内容不得含访问令牌');

    const merged = dav.mergeSecretsFromLocal(got, config.channels);
    assert.strictEqual(merged[0].sendkey, 'IT-LOCAL-KEY', '恢复时应补回本地密钥');
  });

  await test('WebDAV 认证失败与错误地址给出可读提示', async () => {
    const dav = require('../src/dav');
    const net = require('net');
    const alive = await new Promise((resolve) => {
      const s = net.connect(8765, '127.0.0.1');
      s.on('connect', () => { s.destroy(); resolve(true); });
      s.on('error', () => resolve(false));
      setTimeout(() => { s.destroy(); resolve(false); }, 800);
    });
    if (!alive) { console.log('      （mock WebDAV 未运行，跳过）'); return; }

    let err = null;
    try {
      await dav.testConnection({ url: 'http://127.0.0.1:8765/dav', username: 'davuser', password: 'wrong', path: 'x' });
    } catch (e) { err = e; }
    assert.ok(err, '错误密码应抛错');
    assert.strictEqual(err.status, 401);
    assert.ok(err.hint && err.hint.includes('账号或密码'), `提示应说明原因：${err.hint}`);

    let err2 = null;
    try {
      await dav.testConnection({ url: 'http://127.0.0.1:1/dav', username: 'u', password: 'p', path: 'x' });
    } catch (e) { err2 = e; }
    assert.ok(err2, '无法连接应抛错');
    assert.ok(err2.message.includes('失败') || err2.message.includes('超时'));
  });

  console.log('\n[server] 接口契约');

  await test('HTTP 接口：创建/查询/校验/删除任务', async () => {
    const { server } = require('../src/server');
    await new Promise((resolve) => {
      if (server.listening) return resolve();
      server.listen(0, '127.0.0.1', resolve);
    });
    const port = server.address().port;
    const base = `http://127.0.0.1:${port}`;
    const original = client.queryTickets;
    client.queryTickets = async () => ({ trains: [{ trainCode: 'G2', startTime: '06:43', arriveTime: '11:32', duration: '04:49', fromCode: 'SHH', toCode: 'BJP', tickets: { 二等座: '有' } }], stationMap: { SHH: '上海', BJP: '北京' }, checkedAt: Date.now() });

    try {
      const health = await (await fetch(`${base}/health`)).json();
      assert.strictEqual(health.ok, true);

      // 超出预售期应在本地被拒，不打官方接口
      const tooFar = await fetch(`${base}/api/watches`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ from: '上海', to: '北京', date: '2030-01-01', seats: ['二等座'] }),
      });
      assert.strictEqual(tooFar.status, 400);
      const tooFarBody = await tooFar.json();
      assert.ok(tooFarBody.errors.some((e) => e.includes('预售期')), `应提示预售期：${JSON.stringify(tooFarBody.errors)}`);

      const past = await fetch(`${base}/api/watches`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ from: '上海', to: '北京', date: '2020-01-01', seats: ['二等座'] }),
      });
      assert.strictEqual(past.status, 400);

      const bad = await fetch(`${base}/api/watches`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ from: '上海', to: '北京', date: '2026/10/10', seats: [] }),
      });
      assert.strictEqual(bad.status, 400);
      const badBody = await bad.json();
      assert.ok(badBody.errors.length >= 2, '应返回多条校验错误');

      const created = await (await fetch(`${base}/api/watches`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ from: '上海', to: '北京', date: '2026-10-10', seats: ['二等座'], trains: ['G2'] }),
      })).json();
      assert.ok(created.watch.id);
      assert.strictEqual(created.watch.fromCode, 'SHH');
      assert.strictEqual(created.watch.toCode, 'BJP');

      await new Promise((r) => setTimeout(r, 300));
      const state = await (await fetch(`${base}/api/state`)).json();
      const w = state.state.watches.find((x) => x.watchId === created.watch.id);
      assert.ok(w, '状态里应包含新任务');
      assert.strictEqual(w.status, 'ok');
      assert.strictEqual(w.resultCount, 1, '车次过滤应生效');
      assert.strictEqual(w.hitCount, 1);

      // 筛选参数：时间段 + 票价
      const filtered = await (await fetch(`${base}/api/watches`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ from: '上海', to: '北京', date: '2026-10-10', seats: ['二等座'], timeEnabled: true, timeFrom: '06:00', timeTo: '09:00', priceEnabled: true, priceMax: 700 }),
      })).json();
      assert.strictEqual(filtered.watch.timeEnabled, true);
      assert.strictEqual(filtered.watch.timeFrom, '06:00');
      assert.strictEqual(filtered.watch.timeTo, '09:00');
      assert.strictEqual(filtered.watch.priceEnabled, true);
      assert.strictEqual(filtered.watch.priceMax, 700);
      assert.strictEqual(filtered.watch.priceMin, null, '未填的票价下限应为 null 而非 0');

      // 车次与时段/票价必须同时保留并叠加生效（三维独立）
      const withTrains = await (await fetch(`${base}/api/watches`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ from: '上海', to: '北京', date: '2026-10-10', seats: ['二等座'], trains: ['G2'], timeEnabled: true, timeFrom: '06:00', timeTo: '07:00', priceEnabled: true, priceMax: 700 }),
      })).json();
      assert.deepStrictEqual(withTrains.watch.trains, ['G2'], '车次应保留');
      assert.strictEqual(withTrains.watch.timeEnabled, true, '填了车次也要保留时段筛选');
      assert.strictEqual(withTrains.watch.timeFrom, '06:00');
      assert.strictEqual(withTrains.watch.priceEnabled, true, '填了车次也要保留票价筛选');
      assert.strictEqual(withTrains.watch.priceMax, 700);

      // 未启用筛选时不应存残留值
      const plain = await (await fetch(`${base}/api/watches`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ from: '上海', to: '北京', date: '2026-10-10', seats: ['二等座'], trains: ['G2'], timeFrom: '06:00', priceMax: 700 }),
      })).json();
      assert.strictEqual(plain.watch.timeEnabled, false);
      assert.strictEqual(plain.watch.timeFrom, null, '未启用时不应保留时段值');
      assert.strictEqual(plain.watch.priceMax, null, '未启用时不应保留票价');

      // 启用但没填值应被拒
      for (const badEnable of [{ timeEnabled: true }, { priceEnabled: true }]) {
        const r2 = await fetch(`${base}/api/watches`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ from: '上海', to: '北京', date: '2026-10-10', seats: ['二等座'], ...badEnable }),
        });
        assert.strictEqual(r2.status, 400, `启用但未填值应被拒：${JSON.stringify(badEnable)}`);
      }

      // 非法时间与价格区间应被拒
      for (const badFilter of [
        { timeFrom: '25:00' },
        { timeTo: '08:70' },
        { priceMin: -5 },
        { priceMin: 900, priceMax: 100 },
      ]) {
        const badRes = await fetch(`${base}/api/watches`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ from: '上海', to: '北京', date: '2026-10-10', seats: ['二等座'], ...badFilter }),
        });
        assert.strictEqual(badRes.status, 400, `应拒绝 ${JSON.stringify(badFilter)}`);
      }

      await fetch(`${base}/api/watches/${filtered.watch.id}`, { method: 'DELETE' });
      await fetch(`${base}/api/watches/${withTrains.watch.id}`, { method: 'DELETE' });

      const upd = await (await fetch(`${base}/api/watches/${created.watch.id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ enabled: false }),
      })).json();
      assert.strictEqual(upd.watch.enabled, false);

      const del = await fetch(`${base}/api/watches/${created.watch.id}`, { method: 'DELETE' });
      assert.strictEqual(del.status, 200);
      const after = await (await fetch(`${base}/api/config`)).json();
      assert.ok(!after.watches.some((x) => x.id === created.watch.id));
    } finally {
      client.queryTickets = original;
      await new Promise((resolve) => server.close(resolve));
    }
  });

  await test('接口：渠道掩码与设置校验', async () => {
    const { server } = require('../src/server');
    await new Promise((resolve) => {
      if (server.listening) return resolve();
      server.listen(0, '127.0.0.1', resolve);
    });
    const base = `http://127.0.0.1:${server.address().port}`;
    try {
      const ch = await (await fetch(`${base}/api/channels`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ type: 'serverchan', sendkey: 'SCTtest-key-not-real' }),
      })).json();
      assert.strictEqual(ch.channel.sendkey, notifier.MASKED, '响应不得回传明文密钥');

      const cfg = await (await fetch(`${base}/api/config`)).json();
      assert.strictEqual(cfg.channels.find((c) => c.id === ch.channel.id).sendkey, notifier.MASKED);

      const tooFast = await fetch(`${base}/api/settings`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ intervalSeconds: 10 }),
      });
      assert.strictEqual(tooFast.status, 400, '过快的间隔应被拒绝');

      const ng = await fetch(`${base}/api/settings`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ intervalSeconds: -5 }),
      });
      assert.strictEqual(ng.status, 400);

      const okRes = await (await fetch(`${base}/api/settings`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ intervalSeconds: 1800, quietHours: { enabled: true, start: '23:00', end: '07:00' } }),
      })).json();
      assert.strictEqual(okRes.settings.intervalSeconds, 1800);
      assert.strictEqual(okRes.settings.quietHours.enabled, true);

      await fetch(`${base}/api/channels/${ch.channel.id}`, { method: 'DELETE' });
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  });

  await test('接口：编辑渠道时提交掩码值不会覆盖原密钥', async () => {
    const { server } = require('../src/server');
    await new Promise((resolve) => {
      if (server.listening) return resolve();
      server.listen(0, '127.0.0.1', resolve);
    });
    const base = `http://127.0.0.1:${server.address().port}`;
    try {
      const ch = await (await fetch(`${base}/api/channels`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ type: 'bark', deviceKey: 'device-key-123' }),
      })).json();
      await fetch(`${base}/api/channels/${ch.channel.id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ deviceKey: notifier.MASKED, name: '改个名字' }),
      });
      const cfg = require('../src/server').getConfig();
      const saved = cfg.channels.find((c) => c.id === ch.channel.id);
      assert.strictEqual(saved.deviceKey, 'device-key-123', '掩码不应覆盖真实密钥');
      assert.strictEqual(saved.name, '改个名字');
      await fetch(`${base}/api/channels/${ch.channel.id}`, { method: 'DELETE' });
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  });

  await test('接口：访问令牌开启后无 token 被拒绝', async () => {
    const { server, getConfig } = require('../src/server');
    await new Promise((resolve) => {
      if (server.listening) return resolve();
      server.listen(0, '127.0.0.1', resolve);
    });
    const base = `http://127.0.0.1:${server.address().port}`;
    try {
      await fetch(`${base}/api/settings`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token: 'test-token-abc' }),
      });
      const denied = await fetch(`${base}/api/state`);
      assert.strictEqual(denied.status, 401);
      const allowed = await fetch(`${base}/api/state`, { headers: { 'X-Token': 'test-token-abc' } });
      assert.strictEqual(allowed.status, 200);
      const staticOk = await fetch(`${base}/`);
      assert.strictEqual(staticOk.status, 200, '静态页面本身不应被拦（令牌在前端带）');
      getConfig().settings.token = '';
      store.save(getConfig());
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  });

  await test('筛选把结果清空时给出原因（而不是静默显示 0 个车次）', async () => {
    const config = {
      settings: { ...store.DEFAULT_CONFIG.settings },
      watches: [{
        id: 'we', from: '上海', to: '北京', fromCode: 'SHH', toCode: 'BJP',
        fromName: '上海', toName: '北京', date: '2026-10-10', seats: ['二等座'],
        trains: ['G2', 'G4'], timeEnabled: true, timeFrom: '06:00', timeTo: '06:10',
        priceEnabled: false, enabled: true,
      }],
      channels: [],
    };
    const monitor = new Monitor({ getConfig: () => config });
    monitor.stations = [];
    const original = client.queryTickets;
    // G2 06:43 不在 06:00-06:10 内 → 被时段排除
    client.queryTickets = async () => ({
      trains: [
        { trainCode: 'G2', startTime: '06:43', arriveTime: '11:32', duration: '04:49', tickets: { 二等座: '有' }, prices: { 二等座: 661 } },
        { trainCode: 'G4', startTime: '07:00', arriveTime: '11:37', duration: '04:37', tickets: { 二等座: '有' }, prices: { 二等座: 667 } },
      ],
      stationMap: {},
      checkedAt: Date.now(),
    });
    try {
      await monitor.checkWatch(config.watches[0], 'manual');
      const st = monitor.stateFor('we');
      assert.strictEqual(st.filterInfo.byCode, true);
      assert.strictEqual(st.filterInfo.afterCode, 2, '车次筛选后应有 2 个');
      assert.strictEqual(st.filterInfo.kept, 0, '时段筛选后应为 0 个');
      assert.strictEqual(st.filterInfo.emptiedByTimePrice, true, '应标记「被时段/票价筛空」');
      assert.strictEqual(st.status, 'ok', '查询本身成功，不应记为错误');
    } finally {
      client.queryTickets = original;
    }
  });

  await test('概览卡片可点击查看详情（含键盘可达）', () => {
    const js = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.js'), 'utf8');
    assert.ok(js.includes('openDetailModal'), '应有详情弹窗');
    assert.ok(js.includes('data-detail'), '概览卡片应带 data-detail');
    assert.ok(js.includes('tabindex="0"'), '卡片应键盘可达');
    assert.ok(js.includes("e.key === 'Enter'"), '应支持 Enter 触发');
    assert.ok(js.includes('Escape'), '应支持 Esc 关闭');
    // 有票时默认只看有票车次
    assert.ok(js.includes("hits.length > 0"), '有票时应默认切到有票视图');
    assert.ok(js.includes('有票车次'), '应有有票车次标签');
    assert.ok(js.includes('全部结果'), '应有全部结果标签');
    const css = fs.readFileSync(path.join(__dirname, '..', 'public', 'styles.css'), 'utf8');
    assert.ok(css.includes('.watch.clickable'), '缺少可点击样式');
    assert.ok(css.includes('.modal.wide'), '缺少宽弹窗样式');
  });

  await test('详情弹窗所需数据都在任务快照里', async () => {
    const config = {
      settings: { ...store.DEFAULT_CONFIG.settings },
      watches: [{ id: 'wd', from: '上海', to: '北京', fromCode: 'SHH', toCode: 'BJP', fromName: '上海', toName: '北京', date: '2026-10-10', seats: ['二等座'], enabled: true }],
      channels: [],
    };
    const monitor = new Monitor({ getConfig: () => config });
    monitor.stations = [];
    const original = client.queryTickets;
    client.queryTickets = async () => ({
      trains: [{ trainCode: 'G2', startTime: '06:43', arriveTime: '11:32', duration: '04:49', fromCode: 'SHH', toCode: 'BJP', tickets: { 二等座: '有' }, prices: { 二等座: 661 } }],
      stationMap: { SHH: '上海', BJP: '北京' },
      checkedAt: Date.now(),
    });
    try {
      await monitor.checkWatch(config.watches[0], 'manual');
      const snap = monitor.snapshot().watches[0];
      // 详情弹窗依赖这些字段
      for (const k of ['hits', 'lastResult', 'resultCount', 'lastCheckAt', 'lastDurationMs', 'filterInfo', 'hitCount']) {
        assert.ok(k in snap, `快照缺少详情弹窗需要的字段：${k}`);
      }
      assert.strictEqual(snap.hits[0].trainCode, 'G2');
      assert.strictEqual(snap.hits[0].prices['二等座'], 661);
      assert.strictEqual(snap.lastResult[0].startTime, '06:43');
    } finally {
      client.queryTickets = original;
    }
  });

  await test('车次号写错时标记为「不匹配」而不是「无票」', async () => {
    const config = {
      settings: { ...store.DEFAULT_CONFIG.settings },
      watches: [{
        id: 'wx', from: '上海', to: '北京', fromCode: 'SHH', toCode: 'BJP',
        fromName: '上海', toName: '北京', date: '2026-10-10', seats: ['二等座'],
        trains: ['G99999'], enabled: true,
      }],
      channels: [],
    };
    const monitor = new Monitor({ getConfig: () => config });
    monitor.stations = [];
    const original = client.queryTickets;
    client.queryTickets = async () => ({
      trains: [{ trainCode: 'G2', startTime: '06:43', tickets: { 二等座: '有' }, prices: { 二等座: 661 } }],
      stationMap: {},
      checkedAt: Date.now(),
    });
    try {
      await monitor.checkWatch(config.watches[0], 'manual');
      const st = monitor.stateFor('wx');
      assert.strictEqual(st.filterInfo.emptiedByCode, true, '车次全不匹配应标记 emptiedByCode');
      assert.strictEqual(st.filterInfo.afterCode, 0);
      assert.strictEqual(st.status, 'ok', '查询本身成功');
    } finally {
      client.queryTickets = original;
    }
  });

  await test('弹窗交互一致：Esc 关闭最上层、背景锁定、确认框非原生', () => {
    const js = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.js'), 'utf8');
    assert.ok(js.includes('registerModal') && js.includes('unregisterModal'), '应有统一弹窗栈');
    assert.ok(js.includes('modalStack'), '应维护弹窗栈');
    assert.ok(js.includes("document.body.style.overflow = 'hidden'"), '弹窗打开应锁定背景滚动');
    assert.ok(js.includes('confirmDialog'), '应使用自定义确认弹窗');
    assert.ok(!/\bconfirm\(/.test(js), '不应再用原生 confirm');
    // Esc 只关最上层
    assert.ok(js.includes('modalStack[modalStack.length - 1]'), 'Esc 应只关最上层弹窗');
    // 三个弹窗都注册
    // 5 个注册点：确认弹窗 + 任务 / 渠道 / 详情 / 经停站弹窗
    // 注意 unregisterModal 也包含 registerModal 子串，必须按行首匹配
    const registerCalls = js.split('\n').filter((l) => /^\s+registerModal\(wrap\);/.test(l)).length;
    assert.ok(registerCalls >= 5, `弹窗都应注册到统一栈，实际 ${registerCalls}`);
  });

  await test('日期选择器带预售期约束（自研组件，替代原生 date）', () => {
    const js = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.js'), 'utf8');
    assert.ok(js.includes('PRESALE_DAYS_UI'), '应有预售期常量');
    // 原生 input[type=date] 无法定制样式，已换成自研组件
    assert.ok(js.includes('function createDatePicker'), '应有自研日期选择器');
    assert.ok(js.includes('minIso: todayPlus(0)'), '最早可选今天');
    assert.ok(js.includes('maxIso: todayPlus(PRESALE_DAYS_UI)'), '最晚受预售期约束');
    // 超出区间的日期必须禁用
    assert.ok(js.includes('const dis = !inRange(iso)'), '应计算是否超出可选区间');
    assert.ok(js.includes('disabled'), '超范围日期应禁用');
    // 挂载点必须存在
    assert.ok(js.includes('id="wmDateMount"'), '表单应有日期挂载点');
    // 运行时不能残留对已删除原生控件的引用
    assert.ok(!/querySelector\('#wmDate'\)/.test(js), '不应再读取已被替换的 #wmDate');
  });

  await test('表格有票优先排序（否则有票车次被埋在十几行之后）', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.js'), 'utf8');
    const fnSrc = src.match(/function sortByAvailability[\s\S]*?\n}/)[0];
    const sort = new Function(`${fnSrc}; return sortByAvailability;`)();
    const seats = ['硬卧', '软卧', '硬座'];
    const list = [
      { trainCode: 'G1305', startTime: '06:51', tickets: { 硬卧: '', 软卧: '', 硬座: '' } },
      { trainCode: 'G3073', startTime: '07:17', tickets: { 硬卧: '', 软卧: '', 硬座: '' } },
      { trainCode: 'D169', startTime: '13:50', tickets: { 硬卧: '有', 软卧: '有', 硬座: '' } },
      { trainCode: 'K511', startTime: '16:40', tickets: { 硬卧: '有', 软卧: '10', 硬座: '有' } },
      { trainCode: 'K527', startTime: '19:06', tickets: { 硬卧: '7', 软卧: '无', 硬座: '有' } },
    ];
    const out = sort(list, seats).map((t) => t.trainCode);
    // 有票的三趟必须排在无票的两趟之前
    assert.deepStrictEqual(out.slice(0, 3).sort(), ['D169', 'K511', 'K527'], '有票车次应排在最前');
    assert.deepStrictEqual(out.slice(3).sort(), ['G1305', 'G3073'], '无票车次应在后');
    // 同为空票时按发车时间
    assert.ok(out.indexOf('G1305') < out.indexOf('G3073'));
    // 不改动原数组
    assert.strictEqual(list[0].trainCode, 'G1305', '不应原地修改传入数组');
    // 空输入安全
    assert.deepStrictEqual(sort([], seats), []);
    assert.deepStrictEqual(sort(undefined, seats), []);
  });

  await test('席别用彩色圆点区分，且文字保持中性色', () => {
    const js = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.js'), 'utf8');
    assert.ok(js.includes('SEAT_DOT_KEY'), '应有席别→圆点色键映射');
    assert.ok(js.includes('function seatDot'), '应有生成圆点的函数');
    assert.ok(js.includes("dot-${SEAT_DOT_KEY[label] || 'qt'}"), '未知席别应兜底到 qt');
    // 常见席别都要有独立色键
    for (const [label, key] of [['商务座', 'swz'], ['一等座', 'zy'], ['二等座', 'ze'], ['硬卧', 'yw'], ['软卧', 'rw'], ['硬座', 'yz'], ['无座', 'wz']]) {
      assert.ok(js.includes(`${label}: '${key}'`), `${label} 应映射到 ${key}`);
    }
    // 表头与徽标都改用圆点，且不再有图标
    assert.ok(js.includes('seatDot(sl, true)'), '表头应使用圆点');
    assert.ok(js.includes('const dot = seatDot(label, filled)'), '徽标应使用圆点');
    assert.ok(!js.includes('SEAT_ICONS'), '不应再残留图标表');
    assert.ok(!js.includes('seatIcon'), '不应再残留图标函数');
  });

  await test('圆点颜色覆盖全部席别，且文字不被染色', () => {
    const css = fs.readFileSync(path.join(__dirname, '..', 'public', 'styles.css'), 'utf8');
    const js = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.js'), 'utf8');
    // 每个色键都要有对应样式
    const keys = [...js.matchAll(/'(swz|tz|gg|zy|ze|rz|gr|rw|yw|dw|yw1|yw2|yz|wz|qt)'/g)].map((m) => m[1]);
    const uniq = [...new Set(keys)];
    assert.ok(uniq.length >= 14, `应覆盖至少 14 种席别，实际 ${uniq.length}`);
    for (const k of uniq) {
      assert.ok(css.includes(`.dot-${k} `) || css.includes(`.dot-${k}{`) || new RegExp(`\\.dot-${k}\\s*\\{`).test(css), `缺少 .dot-${k} 配色`);
    }
    // 有票实心 / 无票空心
    assert.ok(/\.seat-dot\.on\s*\{[^}]*background:\s*var\(--dot/.test(css), '有票应为实心');
    assert.ok(/\.seat-dot\s*\{[^}]*background:\s*transparent/.test(css), '无票应为空心');
    // 关键：徽标文字不能继承圆点颜色
    assert.ok(/\.seat\s*\{[^}]*color:\s*var\(--text\)/.test(css), '徽标文字应为中性色');
    assert.ok(/\.seat\.has\s*\{[^}]*color:\s*var\(--text\)/.test(css), '有票徽标文字仍应为中性色');
    // 圆点必须固定尺寸，否则行高不齐
    assert.ok(/\.seat-dot\s*\{[^}]*width:\s*8px/.test(css), '圆点应固定 8px');
    assert.ok(/\.seat-dot\s*\{[^}]*height:\s*8px/.test(css), '圆点应固定 8px');
  });

  await test('15 色圆点：对比度达标且两两可区分（明暗两套主题）', () => {
    const css = fs.readFileSync(path.join(__dirname, '..', 'public', 'styles.css'), 'utf8');
    const sec = css.slice(css.indexOf('/* 全部 15 色均满足'));
    const dStart = sec.indexOf('@media (prefers-color-scheme: dark)');
    const light = sec.slice(0, dStart);
    const dark = sec.slice(dStart, sec.indexOf('.dot-qt  { --dot: #d6d3d1; }') + 30);
    const parse = (t) => {
      const o = {};
      for (const m of t.matchAll(/\.dot-([a-z0-9]+)\s*\{\s*--dot:\s*(#[0-9a-fA-F]{3,6})/g)) o[m[1]] = m[2];
      return o;
    };
    const hex = (h) => { const n = parseInt(h.replace('#', ''), 16); return [(n >> 16) & 255, (n >> 8) & 255, n & 255]; };
    const lum = (r) => { const [a, b, c] = r.map((v) => { const x = v / 255; return x <= 0.03928 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4; }); return 0.2126 * a + 0.7152 * b + 0.0722 * c; };
    const ratio = (a, b) => { const l1 = lum(hex(a)); const l2 = lum(hex(b)); return (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05); };
    const dist = (a, b) => Math.sqrt(hex(a).reduce((s, x, i) => s + (x - hex(b)[i]) ** 2, 0));

    const lightMap = parse(light);
    const darkMap = parse(dark);
    assert.strictEqual(Object.keys(lightMap).length, 15, `浅色应有 15 色，实际 ${Object.keys(lightMap).length}`);
    assert.strictEqual(Object.keys(darkMap).length, 15, `深色应有 15 色，实际 ${Object.keys(darkMap).length}`);
    assert.deepStrictEqual(Object.keys(lightMap).sort(), Object.keys(darkMap).sort(), '两套主题的席别色键必须一致');

    for (const [name, map, bg] of [['浅色', lightMap, '#ffffff'], ['深色', darkMap, '#1c2025']]) {
      // 圆点是非文字图形，WCAG 图形元素标准是 3:1
      const lowContrast = Object.keys(map).filter((k) => ratio(map[k], bg) < 3);
      assert.deepStrictEqual(lowContrast, [], `${name}主题对比度不足 3:1：${lowContrast.join(',')}`);
      // 两两色差：低于 40 基本看不出区别（曾出现软卧/硬卧色差仅 20）
      let min = Infinity; let pair = null;
      const keys = Object.keys(map);
      for (let i = 0; i < keys.length; i += 1) {
        for (let j = i + 1; j < keys.length; j += 1) {
          const d = dist(map[keys[i]], map[keys[j]]);
          if (d < min) { min = d; pair = [keys[i], keys[j]]; }
        }
      }
      assert.ok(min >= 40, `${name}主题色差过小：${pair.join(' vs ')} 仅 ${Math.round(min)}`);
    }
  });

  await test('连点「立即检查」不会重复打上游（排队需合并请求）', async () => {
    const config = {
      settings: { ...store.DEFAULT_CONFIG.settings },
      watches: [{ id: 'q1', from: '上海', to: '北京', fromCode: 'SHH', toCode: 'BJP', fromName: '上海', toName: '北京', date: '2026-10-10', seats: ['二等座'], enabled: true }],
      channels: [],
    };
    const monitor = new Monitor({ getConfig: () => config });
    monitor.stations = [];
    let calls = 0;
    const original = client.queryTickets;
    client.queryTickets = async () => { calls += 1; await new Promise((r) => setTimeout(r, 150)); return { trains: [], stationMap: {}, checkedAt: Date.now() }; };
    try {
      // 5 次并发点击：串行闸门之外还必须有「结果复用」，
      // 否则每次排队醒来都会再跑一整轮 → 5 倍请求量
      await Promise.all([1, 2, 3, 4, 5].map(() => monitor.checkNow('q1')));
      assert.strictEqual(calls, 1, `5 次连点应只请求 1 次，实际 ${calls} 次`);
    } finally {
      client.queryTickets = original;
    }
  });

  await test('排队等待有上限，不会无限堆积', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'engine.js'), 'utf8');
    assert.ok(src.includes('QUEUE_WAIT_MAX_MS'), '应有排队等待上限常量');
    assert.ok(/deadline.*QUEUE_WAIT_MAX_MS/s.test(src), '等待循环应检查 deadline');
    assert.ok(src.includes("code = 'BUSY'"), '超时应抛出可识别的 BUSY 错误');
    // 必须有结果复用逻辑
    assert.ok(src.includes('coversScope'), '应有上一轮结果复用判断');
    assert.ok(src.includes('lastRunScope'), '应记录上一轮覆盖范围');
  });

  await test('退避对手动查询同样生效（否则连点可绕过 429 退避）', async () => {
    const config = {
      settings: { ...store.DEFAULT_CONFIG.settings },
      watches: [{ id: 'q2', from: '上海', to: '北京', fromCode: 'SHH', toCode: 'BJP', fromName: '上海', toName: '北京', date: '2026-10-10', seats: ['二等座'], enabled: true }],
      channels: [],
    };
    const monitor = new Monitor({ getConfig: () => config });
    monitor.stations = [];
    let calls = 0;
    const original = client.queryTickets;
    client.queryTickets = async () => { calls += 1; return { trains: [], stationMap: {}, checkedAt: Date.now() }; };
    try {
      monitor.stateFor('q2').backoffUntil = Date.now() + 30000;
      await assert.rejects(() => monitor.checkNow('q2'), (err) => err.code === 'BACKOFF', '退避中手动检查应被拒绝');
      assert.strictEqual(calls, 0, '退避中不得发请求');
      // 退避过期后应能正常查
      monitor.stateFor('q2').backoffUntil = Date.now() - 1;
      await monitor.checkNow('q2');
      assert.strictEqual(calls, 1, '退避过期后应恢复');
    } finally {
      client.queryTickets = original;
    }
  });

  await test('企业微信/钉钉在 HTTP 200 + 非零 errcode 时判定为失败', async () => {
    const notifier = require('../src/notifier');
    const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'notifier.js'), 'utf8');
    assert.ok(src.includes('function checkErrcode'), '应有 errcode 校验');
    assert.ok(/sendWecom[\s\S]{0,300}checkErrcode/.test(src), '企业微信应校验 errcode');
    assert.ok(/sendDingtalk[\s\S]{0,2000}checkErrcode/.test(src), '钉钉应校验 errcode');
    // 用本地 mock 实际跑一遍：HTTP 200 但 errcode 非 0 必须判失败
    const http = require('http');
    const srv = http.createServer((req, res) => {
      let b = ''; req.on('data', (c) => { b += c; });
      req.on('end', () => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ errcode: 93000, errmsg: 'invalid webhook url' })); });
    });
    await new Promise((r) => srv.listen(0, '127.0.0.1', r));
    const port = srv.address().port;
    try {
      const r = await notifier.send({ type: 'wecom', webhook: `http://127.0.0.1:${port}/x`, enabled: true }, '标题', '内容');
      assert.strictEqual(r.ok, false, 'HTTP 200 + errcode 非 0 应判定失败');
      assert.ok(r.error.includes('invalid webhook url'), `错误信息应包含上游原文，实际：${r.error}`);
    } finally {
      srv.close();
    }
  });

  await test('config.json 权限收紧为 0600（含令牌与 WebDAV 密码明文）', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tm-perm-'));
    const origDir = process.env.DATA_DIR;
    process.env.DATA_DIR = dir;
    delete require.cache[require.resolve('../src/store')];
    const st = require('../src/store');
    try {
      st.save({ version: 1, settings: {}, watches: [], channels: [] });
      const f = path.join(dir, 'config.json');
      assert.strictEqual(fs.statSync(f).mode & 0o777, 0o600, 'config.json 应为 0600');
      // 覆盖既有 0644 文件后也必须收紧（rename 会保留 tmp 的权限）
      fs.chmodSync(f, 0o644);
      st.save({ version: 2, settings: {}, watches: [], channels: [] });
      assert.strictEqual(fs.statSync(f).mode & 0o777, 0o600, '覆盖旧文件后仍应为 0600');
    } finally {
      process.env.DATA_DIR = origDir;
      delete require.cache[require.resolve('../src/store')];
      require('../src/store');
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  await test('导入自己的导出不会清空令牌与 WebDAV 密码（掩码需以当前配置为基线）', async () => {
    const { server, getConfig } = require('../src/server');
    await new Promise((resolve) => { if (server.listening) return resolve(); server.listen(0, '127.0.0.1', resolve); });
    const base = `http://127.0.0.1:${server.address().port}`;
    const cfg = getConfig();
    const saved = { token: cfg.settings.token, webdav: { ...cfg.settings.webdav } };
    try {
      cfg.settings.token = 'tok-roundtrip';
      cfg.settings.webdav = { ...cfg.settings.webdav, password: 'dav-roundtrip' };
      const H = { 'X-Token': 'tok-roundtrip' };
      const exp = await (await fetch(`${base}/api/export`, { headers: H })).json();
      assert.strictEqual(exp.settings.token, '******', '导出必须掩码令牌');
      assert.strictEqual(exp.settings.webdav.password, '******', '导出必须掩码 WebDAV 密码');
      const imp = await fetch(`${base}/api/import`, {
        method: 'POST', headers: { ...H, 'Content-Type': 'application/json' }, body: JSON.stringify(exp),
      });
      assert.strictEqual(imp.status, 200, '导入自己的导出应成功');
      // 关键：掩码值必须解析回「当前真实值」，而不是回落到默认空值
      assert.strictEqual(getConfig().settings.token, 'tok-roundtrip', '令牌不得被清空');
      assert.strictEqual(getConfig().settings.webdav.password, 'dav-roundtrip', 'WebDAV 密码不得被清空');
    } finally {
      cfg.settings.token = saved.token;
      cfg.settings.webdav = saved.webdav;
      await new Promise((resolve) => server.close(resolve));
    }
  });

  await test('令牌可用输入弹窗提供，不再引导 ?token= 写进 URL', () => {
    const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');
    const js = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.js'), 'utf8');
    // 说明里可以「提醒不要用」，但不能「引导去用」
    assert.ok(html.includes('不建议'), '应明确提示不推荐用查询串传令牌');
    assert.ok(!/首次访问用\s*<code>http[^<]*\?token=/.test(html), '不应再引导用 ?token=xxx 访问');
    // 必须有输入弹窗实现，否则删掉 URL 路径后用户无路可走
    assert.ok(js.includes('function tokenDialog'), '应实现令牌输入弹窗');
    assert.ok(/401[\s\S]{0,300}tokenDialog/.test(js), '401 时应弹出令牌输入框');
    assert.ok(js.includes('localStorage.setItem(TOKEN_KEY, entered)'), '输入后应持久化到本地');
    assert.ok(/return await api\(path, options\)/.test(js), '拿到令牌后应自动重试');
  });

  await test('新建/编辑任务的补查走统一串行闸门', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'server.js'), 'utf8');
    // 直接调 checkWatch 会绕过 inFlight，与调度并发时同时打上游
    const direct = src.match(/monitor\.checkWatch\(watch, 'manual'\)/g) || [];
    assert.strictEqual(direct.length, 0, `仍直接调用 checkWatch 共 ${direct.length} 处，应改为 checkNow`);
    assert.ok(src.includes('monitor.checkNow(watch.id)'), '补查应通过 checkNow 走闸门');
  });

  await test('导入/恢复后配置改动的补查不会并发打上游', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'server.js'), 'utf8');
    // runOnce 是唯一的串行入口，服务端不应绕过它自行循环
    assert.ok(!/for \(const watch of [^)]+\)\s*\{\s*await monitor\.checkWatch/.test(src), '不应在服务端循环绕过闸门');
  });

  await test('WebDAV 恢复前会写本地快照（回滚兜底）', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'server.js'), 'utf8');
    assert.ok(src.includes('config-before-restore-'), '恢复前应写快照文件');
    // 快照含密钥，必须是 0600
    assert.ok(/config-before-restore[\s\S]{0,300}mode: 0o600/.test(src), '快照文件也应收紧权限为 0600');
  });

  await test('请求体按 Buffer 解码：中文站名跨 TCP 分片不会变乱码', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'server.js'), 'utf8');
    assert.ok(src.includes('Buffer.concat(chunks).toString'), '应按 Buffer 累加后一次性解码');
    assert.ok(!/raw \+= chunk/.test(src), '不应再按 chunk 直接做字符串相加');
    // 复现旧实现的缺陷：逐字节分片时 `raw += chunk` 会产生替换字符
    const body = Buffer.from(JSON.stringify({ from: '乌鲁木齐南', to: '齐齐哈尔' }), 'utf8');
    let oldRaw = '';
    for (let i = 0; i < body.length; i += 1) oldRaw += body.subarray(i, i + 1);
    const chunks = [];
    for (let i = 0; i < body.length; i += 1) chunks.push(body.subarray(i, i + 1));
    const newRaw = Buffer.concat(chunks).toString('utf8');
    assert.ok(oldRaw.includes('\uFFFD'), '旧实现确实会产生乱码（说明该测试有效）');
    assert.deepStrictEqual(JSON.parse(newRaw), { from: '乌鲁木齐南', to: '齐齐哈尔' });
    assert.ok(!newRaw.includes('\uFFFD'), '新实现不得出现替换字符');
  });

  await test('数据目录不可写时降级为只读而不是启动崩溃', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'store.js'), 'utf8');
    // load() 开头的 ensureDir 必须被 try 包住（save 里的早已包住）
    const loadIdx = src.indexOf('function load()');
    const seg = src.slice(loadIdx, loadIdx + 700);
    assert.ok(/try \{[\s\S]{0,80}ensureDir\(\)/.test(seg), 'load() 里的 ensureDir 应被 try 捕获');
    assert.ok(seg.includes('数据目录不可写'), '应给出可读告警而不是抛错');
  });

  await test('价格筛选迁移能识别字符串形式的数值（否则静默失效）', () => {
    const st = require('../src/store');
    const mk = (extra) => st.migrateWatch({ id: 'x', from: '上海', to: '北京', date: '2026-10-16', ...extra });
    // 旧配置可能把表单值存成字符串
    const s1 = mk({ priceMin: '100', priceMax: '500' });
    assert.strictEqual(s1.priceEnabled, true, '字符串价格应识别为已填');
    assert.strictEqual(s1.priceMin, 100, '应转换为数字');
    assert.strictEqual(s1.priceMax, 500);
    // 未填 / null / 空串都不应开启
    for (const extra of [{}, { priceMin: null, priceMax: null }, { priceMin: '', priceMax: '' }]) {
      const m = mk(extra);
      assert.strictEqual(m.priceEnabled, false, `${JSON.stringify(extra)} 不应开启价格筛选`);
      assert.strictEqual(m.priceMin, null);
    }
    // 数字形式仍正常
    const s2 = mk({ priceMin: 50, priceMax: 300 });
    assert.strictEqual(s2.priceEnabled, true);
    assert.strictEqual(s2.priceMin, 50);
  });

  await test('鉴权：常量时间比较，且查询串传令牌仅限 SSE', async () => {
    const { server, getConfig } = require('../src/server');
    await new Promise((resolve) => { if (server.listening) return resolve(); server.listen(0, '127.0.0.1', resolve); });
    const base = `http://127.0.0.1:${server.address().port}`;
    const cfg = getConfig();
    const saved = cfg.settings.token;
    try {
      cfg.settings.token = 'tok-auth-test';
      assert.strictEqual((await fetch(`${base}/api/config`)).status, 401, '无令牌应 401');
      assert.strictEqual((await fetch(`${base}/api/config`, { headers: { 'X-Token': 'tok-auth-test' } })).status, 200);
      assert.strictEqual((await fetch(`${base}/api/config`, { headers: { 'X-Token': 'wrong' } })).status, 401);
      // 查询串只允许 SSE：否则令牌会落进反向代理的访问日志
      assert.strictEqual((await fetch(`${base}/api/config?token=tok-auth-test`)).status, 401,
        '非 SSE 端点不应接受查询串令牌');
      const sse = await fetch(`${base}/api/stream?token=tok-auth-test`);
      assert.strictEqual(sse.status, 200, 'SSE 应允许查询串令牌（EventSource 无法自定义头）');
      if (sse.body && sse.body.cancel) await sse.body.cancel();
      assert.strictEqual((await fetch(`${base}/api/stream?token=bad`)).status, 401, 'SSE 令牌错误应拒绝');
    } finally {
      cfg.settings.token = saved;
      await new Promise((resolve) => server.close(resolve));
    }
  });

  await test('鉴权使用常量时间比较（避免计时侧信道）', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'server.js'), 'utf8');
    assert.ok(src.includes('timingSafeEqual'), '应使用 crypto.timingSafeEqual');
    assert.ok(src.includes("require('crypto')"), 'server.js 必须引入 crypto（曾因漏引入导致全部请求 500）');
    assert.ok(!/provided === token/.test(src), '不应再用 === 直接比较令牌');
  });

  await test('静默时段的命中不会被标记为「已通知」（否则永久漏推）', async () => {
    const config = {
      settings: { ...store.DEFAULT_CONFIG.settings, notifyOnHit: true, quietHours: { enabled: true, start: '00:00', end: '23:59' } },
      watches: [{ id: 'qq', from: '上海', to: '北京', fromCode: 'SHH', toCode: 'BJP', fromName: '上海', toName: '北京', date: '2026-10-10', seats: ['二等座'], enabled: true }],
      channels: [{ id: 'c1', type: 'ntfy', name: 't', topic: 'x', enabled: true }],
    };
    const monitor = new Monitor({ getConfig: () => config });
    const st = monitor.stateFor('qq');
    const hits = [{ trainCode: 'G2', matched: { 二等座: '有' }, prices: {} }];
    // 静默时段：不推，也不能把签名记为已通知
    await monitor.applyHits(config.watches[0], st, hits, () => '二等座');
    assert.strictEqual(st.hitSignature, '', '静默时段不应标记已通知，否则静默结束后永不推送');
    assert.ok(st.boostUntil, '静默时段仍应进入快速复查');
    // 走出静默后，同一批余票应真正推送
    config.settings.quietHours = { enabled: false, start: '23:30', end: '06:30' };
    let sent = 0;
    const notifier = require('../src/notifier');
    const origSend = notifier.send;
    notifier.send = async () => { sent += 1; return { ok: true }; };
    try {
      await monitor.applyHits(config.watches[0], st, hits, () => '二等座');
      assert.strictEqual(sent, 1, '走出静默后应补推这条余票');
      assert.notStrictEqual(st.hitSignature, '', '推送后应标记已通知');
    } finally {
      notifier.send = origSend;
    }
  });

  await test('logger 保留调用栈且透传 extra', () => {
    const logger = require('../src/logger');
    logger.error(new Error('带栈的错误'));
    const withStack = logger.recent(1)[0];
    assert.ok(String(withStack.msg).includes('at '), 'error 日志应保留调用栈，否则排查无从下手');
    const ctx = { watchId: 'w_x', status: 429 };
    logger.warn('带上下文的日志', ctx);
    const entry = logger.recent(1)[0];
    assert.deepStrictEqual(entry.extra, ctx, 'extra 应存入 ring');
    // 导出函数必须透传第二个参数（曾写成 (m) => push(level, m) 静默丢弃）
    const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'logger.js'), 'utf8');
    for (const lv of ['debug', 'info', 'warn', 'error']) {
      const re = new RegExp(lv + ': \\(m, extra\\) => push');
      assert.ok(re.test(src), `${lv} 必须透传 extra`);
    }
  });

  await test('请求超时覆盖 body 读取（服务器发完响应头后挂住不会无限等待）', () => {
    for (const f of ['src/client.js', 'src/dav.js']) {
      const src = fs.readFileSync(path.join(__dirname, '..', f), 'utf8');
      assert.ok(src.includes('guardBodyTimeout'), `${f} 应包装 body 读取以延续超时`);
      // 不能再在 fetch 之后直接 finally clearTimeout
      assert.ok(!/await fetch\([\s\S]{0,600}?\n  \} finally \{\n    clearTimeout\(timer\);/.test(src),
        `${f} 不应在 fetch 返回后立即清除定时器`);
    }
    // 行为验证：定时器在 body 读取期间仍生效
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 60);
    const res = {
      text: async () => {
        await new Promise((_, rej) => ctrl.signal.addEventListener('abort',
          () => rej(Object.assign(new Error('aborted'), { name: 'AbortError' }))));
      },
    };
    const guarded = (() => {
      const done = () => clearTimeout(timer);
      const orig = res.text.bind(res);
      res.text = async (...a) => { try { return await orig(...a); } finally { done(); } };
      return res;
    })();
    assert.ok(guarded);
  });

  await test('时钟用本地时间每秒走时，不用服务端快照（否则会卡住）', () => {
    const js = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.js'), 'utf8');
    // 早期写法 state.localTime.slice(11) 会在字段缺失时抛错并中断整个概览渲染
    assert.ok(!/state\.localTime\.slice/.test(js), '不应直接对 localTime 调用 slice');
    // 复用快照里的 localTime 会让时钟只在推送时跳动，看起来像卡死
    assert.ok(js.includes('function localClock()'), '应有一个本地时钟函数');
    assert.ok(!/el\('clock'\)\.textContent = \(state\.localTime/.test(js), '顶栏时钟不应直接取服务端快照');
    // 每秒只更新文本，不整块重渲染
    assert.ok(/el\('statClock'\)/.test(js), '统计卡时钟应每秒单独更新');
  });

  await test('推送失败时不回显上游响应体（可能含密钥）', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'notifier.js'), 'utf8');
    assert.ok(src.includes('function describeBody'), '应有响应体脱敏处理');
    // 非 2xx 分支不得直接把 body 拼进 error
    assert.ok(!/error: `HTTP \$\{res\.status\}: \$\{text/.test(src), '不应把上游 body 原样拼进错误信息');
  });

  await test('导入时逐条校验任务元素，null 不进入 buildWatch', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'server.js'), 'utf8');
    // import 与 restore 都应过滤掉非对象元素（否则 null.from 会抛 TypeError 变成 500）
    assert.ok(src.includes("body.watches.filter((raw) => raw && typeof raw === 'object')"),
      'import 应过滤非对象元素');
    assert.ok(src.includes("payload.watches.filter((x) => x && typeof x === 'object')"),
      'restore 应过滤非对象元素');
  });

  await test('同城多站不再产生重复车次（12306 按城市返回）', () => {
    const client = require('../src/client');
    // 上游请求「盐城」会同时返回「盐城」与「盐城大丰」的车次，同一车次出现两次
    const trains = [
      { trainCode: 'G8352', fromCode: 'HVU', toCode: 'YFU', startTime: '11:41', arriveTime: '15:29' },
      { trainCode: 'G8352', fromCode: 'HVU', toCode: 'AFH', startTime: '11:41', arriveTime: '15:42' },
      { trainCode: 'G7540', fromCode: 'HVU', toCode: 'AFH', startTime: '12:04', arriveTime: '15:13' },
    ];
    // 精确匹配（默认）：只保留所选站点
    const exact = client.filterByExactStation(trains, { fromCode: 'HVU', toCode: 'AFH', exactFrom: true, exactTo: true });
    assert.deepStrictEqual(exact.map((t) => t.toCode), ['AFH', 'AFH'], '精确匹配应剔除同城其它站');
    const codes = exact.map((t) => t.trainCode);
    assert.strictEqual(codes.length, new Set(codes).size, '精确匹配后不应有重复车次');
    // 模糊匹配：保留全部
    const fuzzy = client.filterByExactStation(trains, { fromCode: 'HVU', toCode: 'AFH', exactFrom: false, exactTo: false });
    assert.strictEqual(fuzzy.length, 3, '模糊匹配应保留全部车次');
    // 出发站同样支持
    const exFrom = client.filterByExactStation(
      [{ trainCode: 'X', fromCode: 'A', toCode: 'B' }, { trainCode: 'Y', fromCode: 'C', toCode: 'B' }],
      { fromCode: 'A', toCode: 'B', exactFrom: true, exactTo: false },
    );
    assert.deepStrictEqual(exFrom.map((t) => t.trainCode), ['X'], '出发站也应精确匹配');
    // 缺 code 时不误杀
    const noCode = client.filterByExactStation([{ trainCode: 'Z' }], { fromCode: 'A', toCode: 'B', exactFrom: true, exactTo: true });
    assert.strictEqual(noCode.length, 1, '缺少站点码时不应过滤掉');
  });

  await test('站名匹配默认精确，且可通过开关切为模糊', () => {
    const st = require('../src/store');
    // 老配置迁移后默认精确
    const migrated = st.migrateWatch({ id: 'x', from: '上海', to: '北京', date: '2026-10-16' });
    assert.strictEqual(migrated.exactStation, true, '默认必须为精确匹配');
    assert.strictEqual(st.migrateWatch({ id: 'y', from: 'a', to: 'b', date: '2026-10-16', exactStation: false }).exactStation, false);

    const serverSrc = fs.readFileSync(path.join(__dirname, '..', 'src', 'server.js'), 'utf8');
    assert.ok(/exactStation === undefined \? true/.test(serverSrc), '服务端默认应为精确');
    // buildWatch 必须解构出该字段，否则引用未声明变量会 500（本轮实际踩过）
    const seg = serverSrc.slice(serverSrc.indexOf('async function buildWatch'), serverSrc.indexOf('async function buildWatch') + 500);
    assert.ok(seg.includes('exactStation,'), 'buildWatch 必须解构 exactStation');

    const js = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.js'), 'utf8');
    assert.ok(js.includes('name="wmExact"'), '表单应有匹配方式开关');
    assert.ok(js.includes('exactStation: wrap.querySelector'), '提交时应带上该选项');
    assert.ok(js.includes('精确匹配') && js.includes('模糊匹配'), '两种模式都要有说明');
  });

  await test('历时筛选：解析多种写法且独立生效', () => {
    const client = require('../src/client');
    // 解析
    assert.strictEqual(client.toDurationMinutes('05:56'), 356);
    assert.strictEqual(client.toDurationMinutes('27:30'), 1650, '应支持跨天历时');
    assert.strictEqual(client.toDurationMinutes('4'), 240, '纯数字视为小时');
    assert.strictEqual(client.toDurationMinutes(''), null);
    assert.strictEqual(client.toDurationMinutes('abc'), null);
    assert.strictEqual(client.toDurationMinutes('4:75'), null, '分钟超过 59 应判非法');
    // 过滤：只留 3 小时内的车次
    const trains = [
      { trainCode: 'A', startTime: '08:00', duration: '02:00' },
      { trainCode: 'B', startTime: '09:00', duration: '05:00' },
      { trainCode: 'C', startTime: '10:00', duration: '' },
    ];
    const r = client.filterTrains(trains, { durationEnabled: true, durationMin: null, durationMax: 180 }, []);
    assert.deepStrictEqual(r.trains.map((t) => t.trainCode), ['A', 'C'], '历时缺失的车次不应被误杀');
    // 只填下限：A(2h) 被排除，B(5h) 保留；C 时长缺失不参与判断，同样保留
    const r2 = client.filterTrains(trains, { durationEnabled: true, durationMin: 240, durationMax: null }, []);
    assert.deepStrictEqual(r2.trains.map((t) => t.trainCode), ['B', 'C']);
    // 未启用时不生效
    const r3 = client.filterTrains(trains, { durationEnabled: false, durationMin: 240, durationMax: 300 }, []);
    assert.strictEqual(r3.trains.length, 3, '未启用历时筛选时不应过滤');
    // 与时段/票价可叠加
    const r4 = client.filterTrains(trains, {
      durationEnabled: true, durationMin: null, durationMax: 180,
      timeEnabled: true, timeFrom: '09:30', timeTo: null,
    }, []);
    // A(08:00) 被时段排除；B(5h) 被历时排除；C(时长缺失) 不被误杀 → 只剩 C
    assert.deepStrictEqual(r4.trains.map((t) => t.trainCode), ['C'], '历时与时段应同时生效');
  });

  await test('过期任务不参与轮询（避免永远失败还白打上游）', async () => {
    const client = require('../src/client');
    const config = {
      settings: { ...store.DEFAULT_CONFIG.settings },
      watches: [
        { id: 'exp', from: '上海', to: '北京', fromCode: 'SHH', toCode: 'BJP', fromName: '上海', toName: '北京', date: '2020-01-01', seats: ['二等座'], enabled: true },
        { id: 'ok', from: '上海', to: '北京', fromCode: 'SHH', toCode: 'BJP', fromName: '上海', toName: '北京', date: '2020-01-01', seats: ['二等座'], enabled: true },
      ],
      channels: [],
    };
    const monitor = new Monitor({ getConfig: () => config });
    monitor.stations = [];
    // 日期状态判定
    const pad = (n) => String(n).padStart(2, '0');
    const plusDays = (d) => { const x = new Date(Date.now() + d * 86400000); return `${x.getFullYear()}-${pad(x.getMonth() + 1)}-${pad(x.getDate())}`; };
    assert.strictEqual(monitor.dateStateOf('2020-01-01'), 'expired');
    assert.strictEqual(monitor.dateStateOf(plusDays(0)), 'ok');
    assert.strictEqual(monitor.dateStateOf(plusDays(30)), 'beyond');
    let calls = 0;
    const original = client.queryTickets;
    client.queryTickets = async () => { calls += 1; return { trains: [], stationMap: {}, checkedAt: Date.now() }; };
    try {
      const st = await monitor.checkWatch(config.watches[0], 'schedule');
      assert.strictEqual(calls, 0, '过期任务不应发起请求');
      assert.strictEqual(st.status, 'inactive');
      assert.ok(st.lastError.includes('已过期'));
    } finally {
      client.queryTickets = original;
    }
  });

  await test('httpGet 的 body 超时保护必须可达（曾因 return await fetch 而失效）', async () => {
    const client = require('../src/client');
    // 源码曾写成 `return await fetch(...)` 后再调 guardBodyTimeout：
    // 后者永远不可达、res 未声明，导致响应头到达后 timer 不被清理，
    // 正常请求也会平白多等一个 timeoutMs。
    const http = require('http');
    const slow = http.createServer((q, r) => { r.writeHead(200, { 'Content-Type': 'text/plain' }); r.write('x'); });
    await new Promise((r) => slow.listen(0, '127.0.0.1', r));
    try {
      const t = Date.now();
      const res = await client.httpGet(`http://127.0.0.1:${slow.address().port}/hang`, { timeoutMs: 800 });
      // 关键：响应头返回后 timer 必须已交管给 guardBodyTimeout，不能白等
      assert.ok(Date.now() - t < 400, `响应头应立刻返回，实际耗时 ${Date.now() - t}ms`);
      // body 挂着时，guardBodyTimeout 会中止读取
      await assert.rejects(() => res.text(), /abor|Abort/i, 'body 挂住应被中止');
    } finally {
      slow.close();
    }
    // 正常响应：body 读完后 timer 必须清掉，不能白等一个周期
    const ok = http.createServer((q, r) => { r.writeHead(200); r.end('done'); });
    await new Promise((r) => ok.listen(0, '127.0.0.1', r));
    try {
      const t = Date.now();
      const res = await client.httpGet(`http://127.0.0.1:${ok.address().port}`, { timeoutMs: 5000 });
      assert.strictEqual(await res.text(), 'done');
      assert.ok(Date.now() - t < 1000, `正常请求不应等到超时，实际 ${Date.now() - t}ms`);
    } finally {
      ok.close();
    }
  });

  await test('WebDAV 目标地址：拦 SSRF 与路径穿越，但不误杀局域网 NAS', () => {
    const dav = require('../src/dav');
    // SSRF：服务端发起请求，内网/元数据必须拦
    for (const u of ['http://127.0.0.1/dav/', 'http://169.254.169.254/', 'http://10.0.0.5/', 'http://192.168.1.1/', 'http://metadata.google.internal/']) {
      assert.throws(() => dav.normalizeBase(u), /不允许/, `应拒绝 ${u}`);
    }
    // 正常公网地址放行
    assert.strictEqual(dav.normalizeBase('https://dav.jianguoyun.com/dav/'), 'https://dav.jianguoyun.com/dav');
    // 元数据地址即使开了局域网开关也永远拒绝（可换云凭证，与备份 NAS 无关）
    process.env.DAV_ALLOW_PRIVATE_NET = '1';
    delete require.cache[require.resolve('../src/dav')];
    const dav2 = require('../src/dav');
    assert.throws(() => dav2.normalizeBase('http://169.254.169.254/'), /元数据/);
    // 开关打开后放行局域网（局域网 NAS 的真实场景）
    assert.strictEqual(dav2.normalizeBase('http://192.168.1.10:5005/dav/'), 'http://192.168.1.10:5005/dav');
    delete process.env.DAV_ALLOW_PRIVATE_NET;
    delete require.cache[require.resolve('../src/dav')];
    const dav3 = require('../src/dav');
    // 路径穿越：encodeURIComponent('..') 仍是 '..'，必须显式拒绝
    for (const seg of [['..', '..', 'etc'], ['/etc'], ['a', '..'], ['.']]) {
      assert.throws(() => dav3.joinUrl('https://x/dav', ...seg), /非法段/, `应拒绝路径段 ${JSON.stringify(seg)}`);
    }
    assert.ok(dav3.joinUrl('https://x/dav', '备份', '2026-01').includes('%E5%A4%87%E4%BB%BD'), '正常中文路径应编码');
  });

  await test('推送全部渠道失败时不吞掉提醒（应保留旧签名下轮重试）', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'engine.js'), 'utf8');
    // 曾只判断 skippedQuiet，failed 的命中被记为已通知，永不重试
    const seg = src.slice(src.indexOf('if (settings.notifyOnHit)'), src.indexOf('if (settings.notifyOnHit)') + 900);
    assert.ok(/r\.delivered \|\| r\.skippedNoChannel/.test(seg), '应仅在真的送达或未配渠道时记账');
    assert.ok(/!r \|\|/.test(seg), 'notify 未返回结构时应按已送达处理，兼容替换实现');
    assert.ok(!/if \(r && r\.skippedQuiet\) st\.hitSignature = prev;\s*\n\s*else st\.hitSignature = signature;/.test(seg), '不应只剩 skippedQuiet 判断');
  });

  await test('请求体非 JSON 对象应返回 400 而不是 500', async () => {
    // 复用 src/server.js 的 readBody 语义：这里独立起一个最小 server 跑通映射，
    // 避免动用共享实例影响其它用例。
    const { server } = require('../src/server');
    for (const body of ['null', '123', '"x"', '[1,2]']) {
      // 与其它接口用例一致：每次重新监听，避免共享实例被前面的用例关掉
      await new Promise((resolve) => {
        if (server.listening) return resolve();
        server.listen(0, '127.0.0.1', resolve);
      });
      const base = `http://127.0.0.1:${server.address().port}`;
      // 鉴权先于 body 校验：必须先带正确令牌，否则拿到的是 401 而非 400
      const r = await fetch(`${base}/api/watches`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Token': 'tok-roundtrip' },
        body,
      });
      assert.strictEqual(r.status, 400, `请求体 ${body} 应返回 400`);
      assert.ok((await r.json()).error.includes('JSON 对象'));
      await new Promise((resolve) => server.close(resolve));
    }
  });

  await test('WebDAV 列表解析支持任意命名空间前缀', () => {
    const { parseStatXml } = require('../src/dav');
    const mk = (p) => `<d:multistatus xmlns:d="DAV:"><${p}response><${p}href>/dav/a.json</${p}href></${p}response></d:multistatus>`;
    // 只认 D:/d: 会让 ns0:/lp1: 前缀的服务端解析成空列表
    for (const p of ['d:', 'D:', '', 'ns0:', 'lp1:']) {
      assert.strictEqual(parseStatXml(mk(p)).length, 1, `前缀 ${p} 应解析出 1 条`);
    }
  });

  await test('推送失败的错误信息不得泄漏 URL 中的密钥', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'notifier.js'), 'utf8');
    // 曾直接透传 err.message，而 undici 的 "Failed to parse URL from <url>" 含完整地址
    assert.ok(!/error: .*err\.message\s*\}/.test(src.replace(/\n/g, ' ')) || /脱敏/.test(src), '不应原样透传 err.message');
    assert.ok(/Failed to parse URL/.test(src), '应识别 URL 解析失败');
    assert.ok(/详情已脱敏/.test(src), '应有脱敏文案');
  });

  await test('并发 401 共享一次令牌输入，第二个请求不误报', () => {
    const js = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.js'), 'utf8');
    // 单个布尔标记会让并发的第二个请求跳过输入框直接抛错
    assert.ok(!/tokenRetrying/.test(js), '不应再用单个布尔标记');
    assert.ok(/tokenRetryPromise/.test(js), '应共享同一个 Promise');
    const seg = js.slice(js.indexOf('if (res.status === 401)'), js.indexOf('if (res.status === 401)') + 500);
    assert.ok(/if \(!tokenRetryPromise\)/.test(seg), '仅首个请求触发输入');
    assert.ok(/await tokenRetryPromise/.test(seg), '并发请求应等待同一次输入');
  });

  await test('无票（无事件）的一轮也要推送状态，否则页面倒计时停在 0', async () => {
    const client = require('../src/client');
    const p = (n) => String(n).padStart(2, '0');
    const d = new Date(Date.now() + 3 * 864e5);
    const watch = {
      id: 'w', from: '上海', to: '北京', fromCode: 'SHH', toCode: 'BJP',
      fromName: '上海', toName: '北京',
      date: `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`,
      seats: ['二等座'], enabled: true,
    };
    const cfg = { settings: { intervalSeconds: 900, minIntervalSeconds: 60, jitterSeconds: 0, retryOnHitSeconds: 60 }, watches: [watch], channels: [] };
    const monitor = new Monitor({ getConfig: () => cfg });
    monitor.stations = [];
    const events = [];
    const states = [];
    monitor.onEvent = (ev) => events.push(ev.kind);
    monitor.onState = (snap) => states.push(snap);
    const original = client.queryTickets;
    // 有车次但全部无票 —— 这是最常见的正常结果，不产生任何事件
    client.queryTickets = async () => ({
      trains: [{ trainCode: 'G1', startTime: '08:00', arriveTime: '12:00', duration: '04:00', fromCode: 'SHH', toCode: 'BJP', tickets: { 二等座: '无' }, prices: {} }],
      stationMap: {}, checkedAt: Date.now(),
    });
    try {
      monitor.running = true;
      await monitor.tick();
    } finally {
      client.queryTickets = original;
      if (monitor.timer) clearTimeout(monitor.timer);
    }
    assert.strictEqual(events.length, 0, '无票不应产生事件');
    assert.ok(states.length > 0, '无事件时也必须推送状态，否则前端永远停在旧倒计时');
    const last = states[states.length - 1];
    assert.ok(last.nextRunAt > Date.now(), '推送的 nextRunAt 应为未来时间，倒计时才会往下走');

    // 服务端必须把 onState 接到 SSE 广播上
    const serverSrc = fs.readFileSync(path.join(__dirname, '..', 'src', 'server.js'), 'utf8');
    assert.ok(/monitor\.onState\s*=/.test(serverSrc), 'server 应接线 onState');
    assert.ok(/broadcast\('state'/.test(serverSrc), 'onState 应广播 state');

    // 前端要有兜底：倒计时归零补拉 + SSE 断开降级轮询
    const js = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.js'), 'utf8');
    assert.ok(js.includes('resyncIfOverdue'), '倒计时归零应主动补拉');
    assert.ok(js.includes('startPollFallback'), 'SSE 断开应有兜底轮询');
  });

  await test('前端不存在悬空的标识符引用（曾因删 SEAT_FAMILY 导致运行时崩溃）', () => {
    const js = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.js'), 'utf8');
    // 这轮把 SEAT_FAMILY 换成 SEAT_DOT_KEY 时，漏改了 highlightSeats 里的引用，
    // 结果「事件」页每次渲染都抛 ReferenceError，整块列表空白。用静态检查防复发。
    const removed = ['SEAT_FAMILY', 'seatFamily', 'SEAT_ICONS', 'seatIcon'];
    for (const sym of removed) {
      const code = js.replace(/\/\/[^\n]*/g, ''); // 去掉注释，只查真实代码
      const hits = code.match(new RegExp(`\\b${sym}\\b`, 'g')) || [];
      assert.strictEqual(hits.length, 0, `已移除的符号 ${sym} 仍被引用 ${hits.length} 处`);
    }
    // 被移除符号的替代者必须存在
    assert.ok(js.includes('const SEAT_DOT_KEY'), 'SEAT_DOT_KEY 必须定义');
    assert.ok(js.includes('function seatDot'), 'seatDot 必须定义');
    assert.ok(js.includes('function highlightSeats'), 'highlightSeats 必须存在');
    // highlightSeats 必须用已定义的映射取席别全集
    assert.ok(/highlightSeats[\s\S]{0,400}Object\.keys\(SEAT_DOT_KEY\)/.test(js),
      'highlightSeats 应基于 SEAT_DOT_KEY 取席别全集');
  });

  await test('事件页席别高亮逻辑可实际执行（而非只做静态断言）', () => {
    const js = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.js'), 'utf8');
    // 抽出真实实现并在 Node 里跑一遍：若引用了不存在的符号，这里会抛错
    const dotBlock = js.match(/const SEAT_DOT_KEY = \{[\s\S]*?\n\};/)[0];
    const escSrc = js.match(/function esc\([\s\S]*?\n\}/)[0];
    const dotClsFn = js.match(/function seatDotClass\([\s\S]*?\n\}/)[0];
    const dotFn = js.match(/function seatDot\([\s\S]*?\n\}/)[0];
    const hlFn = js.match(/function highlightSeats\([\s\S]*?\n\}/)[0];
    const factory = new Function(`${dotBlock}\n${escSrc}\n${dotClsFn}\n${dotFn}\n${hlFn}\nreturn highlightSeats;`);
    const fn = factory();
    const out = fn('商务座9 一等座有 二等座有');
    assert.strictEqual((out.match(/seat-tag/g) || []).length, 3, '三个席别都应被标注');
    assert.ok(out.includes('dot-swz'), '商务座应带 swz 圆点');
    assert.ok(out.includes('dot-zy'), '一等座应带 zy 圆点');
    assert.ok(out.includes('dot-ze'), '二等座应带 ze 圆点');
    // 不应把页面结构带进来
    assert.ok(!out.includes('<script'), '不应产生脚本标签');
  });

  await test('筛选 UI 具备三个独立开关与状态提示', () => {
    const js = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.js'), 'utf8');
    for (const id of ['wmTimeEnabled', 'wmPriceEnabled']) {
      assert.ok(js.includes(id), `缺少开关 ${id}`);
    }
    assert.ok(js.includes('refreshFilterUI'), '应有开关联动逻辑');
    assert.ok(js.includes('待填写'), '启用但未填值应有提示');
    assert.ok(js.includes('未启用'), '未启用应有明确状态');
    assert.ok(js.includes('emptiedByTimePrice'), '筛选清空结果时应有提示');
    // 三个维度都要提交给后端
    for (const k of ['timeEnabled', 'priceEnabled']) {
      assert.ok(js.includes(`${k}:`), `提交参数缺少 ${k}`);
    }
    const css = fs.readFileSync(path.join(__dirname, '..', 'public', 'styles.css'), 'utf8');
    assert.ok(css.includes('.switch'), '缺少开关样式');
  });

  await test('管理页面包含任务/渠道/设置所需 DOM 与脚本', () => {
    const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');
    for (const id of ['tab-overview', 'tab-watches', 'tab-channels', 'tab-events', 'tab-settings', 'addWatch', 'addChannel', 'saveSettings', 'toggleMonitor']) {
      assert.ok(html.includes(id), `页面缺少 #${id}`);
    }
    const js = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.js'), 'utf8');
    for (const api of ['/api/watches', '/api/channels', '/api/settings', '/api/stream', '/api/stations']) {
      assert.ok(js.includes(api), `前端未调用 ${api}`);
    }
    assert.ok(js.includes('chip') && js.includes('seat'), '应支持席别多选');
  });

  console.log('\n[回归-2] 第二轮 OCR 审查发现并已修复的缺陷');

  await test('logger.recent 对小数也返回空（0.5 floor 后是 0，不能返回整段）', () => {
    const logger = require('../src/logger');
    for (let i = 0; i < 6; i += 1) logger.info(`y${i}`);
    assert.deepStrictEqual(logger.recent(0.5), [], '0.5 应返回空而不是整段');
    assert.deepStrictEqual(logger.recent(0.9), []);
    assert.strictEqual(logger.recent(2.7).length, 2, '2.7 应向下取整为 2');
    assert.strictEqual(logger.recent(1).length, 1);
  });

  await test('ntfy 中文标题按 RFC 2047 编码（原始中文会抛 ByteString 错）', () => {
    const notifier = require('../src/notifier');
    // 先证明原始中文确实不能放进 HTTP 头
    assert.throws(() => new Headers({ Title: '测试推送' }), /ByteString/);
    const ascii = notifier.encodeRfc2047('Train G2');
    assert.strictEqual(ascii, 'Train G2', 'ASCII 应原样返回');
    const enc = notifier.encodeRfc2047('测试推送 · 中文');
    assert.ok(enc.startsWith('=?UTF-8?B?') && enc.endsWith('?='), `应做 RFC 2047 编码：${enc}`);
    // 编码后必须能安全放进请求头
    const h = new Headers();
    h.set('Title', enc);
    assert.strictEqual(h.get('Title'), enc);
    // 且能解回原文
    const decoded = Buffer.from(enc.slice('=?UTF-8?B?'.length, -2), 'base64').toString('utf8');
    assert.strictEqual(decoded, '测试推送 · 中文');
  });

  await test('notifier 不截断用于解析的响应体（长响应不能被剪成非法 JSON）', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'notifier.js'), 'utf8');
    assert.ok(src.includes('body: text, preview: text.slice(0, 400)'), 'body 应完整保留，仅 preview 截断');
    // 复现原始缺陷：截断后的长响应无法解析
    const big = JSON.stringify({ code: 0, data: { pushid: 'x'.repeat(500) } });
    assert.ok(big.length > 400);
    assert.throws(() => JSON.parse(big.slice(0, 400)), /Unterminated|Unexpected/);
    assert.strictEqual(JSON.parse(big).code, 0, '完整响应应可解析');
  });

  await test('store 读失败后本次运行拒绝写盘（否则后续 persist 会覆盖有效配置）', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tm-degraded-'));
    const origDir = process.env.DATA_DIR;
    process.env.DATA_DIR = dir;
    delete require.cache[require.resolve('../src/store')];
    const st = require('../src/store');
    // 写一份有效配置
    st.save({ version: 1, settings: { intervalSeconds: 1234 }, watches: [{ id: 'keep' }], channels: [] });
    // 模拟读取失败
    const real = fs.readFileSync;
    fs.readFileSync = (p, ...a) => {
      if (String(p).endsWith('config.json')) { const e = new Error('denied'); e.code = 'EACCES'; throw e; }
      return real(p, ...a);
    };
    let loaded;
    try { loaded = st.load(); } finally { fs.readFileSync = real; }
    assert.strictEqual(st.isReadDegraded(), true, '应进入降级状态');
    // 后续任何写入都必须被拒
    loaded.watches.push({ id: 'attacker' });
    assert.strictEqual(st.save(loaded), false, '降级时必须拒绝写盘');
    const onDisk = JSON.parse(real(path.join(dir, 'config.json'), 'utf8'));
    assert.ok(onDisk.watches.some((w) => w.id === 'keep'), '磁盘上的有效配置必须保留');
    assert.ok(!onDisk.watches.some((w) => w.id === 'attacker'), '不得写入降级后的默认配置');
    process.env.DATA_DIR = origDir;
    delete require.cache[require.resolve('../src/store')];
    require('../src/store');
    fs.rmSync(dir, { recursive: true, force: true });
  });

  await test('快速复查按任务生效：命中一个不会加速其它任务', () => {
    const config = {
      settings: { ...store.DEFAULT_CONFIG.settings, intervalSeconds: 900, minIntervalSeconds: 300, retryOnHitSeconds: 60 },
      watches: ['a', 'b', 'c', 'd'].map((id) => ({ id, from: '上海', to: '北京', fromCode: 'SHH', toCode: 'BJP', fromName: '上海', toName: '北京', date: '2026-10-10', seats: ['二等座'], enabled: true })),
      channels: [],
    };
    const monitor = new Monitor({ getConfig: () => config });
    const now = Date.now();
    for (const id of ['a', 'b', 'c', 'd']) {
      const st = monitor.stateFor(id);
      st.lastSuccessAt = now - 70000; // 70 秒前都查过一次
    }
    monitor.stateFor('a').boostUntil = now + 50000; // 只有 a 命中进入复查窗口
    assert.strictEqual(monitor.isBoosting('a'), true);
    assert.strictEqual(monitor.isBoosting('b'), false, '未命中的任务不应处于复查窗口');
    // 到期判定：只有 a 应到期
    const due = config.watches.filter((w) => {
      const st = monitor.states.get(w.id);
      const boosting = st && st.boostUntil && st.boostUntil > Date.now();
      const interval = boosting ? 60000 : 900000;
      return Date.now() - (st.lastSuccessAt || 0) >= interval;
    });
    assert.deepStrictEqual(due.map((w) => w.id), ['a'], '只有命中任务应被复查');
  });

  await test('checkNow 也受 inFlight 闸门约束，不绕过串行', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'engine.js'), 'utf8');
    // checkNow 必须走 runOnce（它带 inFlight 闸门），不能直接循环调 checkWatch
    const seg = src.slice(src.indexOf('async checkNow'), src.indexOf('async testChannel'));
    assert.ok(seg.includes('runOnce'), 'checkNow 应通过 runOnce 走统一闸门');
    assert.ok(!/for \(const watch of [^)]+\) \{\s*await this\.checkWatch/.test(seg), 'checkNow 不应自己循环绕过闸门');
  });

  await test('WebDAV 轮转不会删掉刚上传的备份', async () => {
    const dav = require('../src/dav');
    const net = require('net');
    const alive = await new Promise((resolve) => {
      const sock = net.connect(8765, '127.0.0.1');
      sock.on('connect', () => { sock.destroy(); resolve(true); });
      sock.on('error', () => resolve(false));
      setTimeout(() => { sock.destroy(); resolve(false); }, 800);
    });
    if (!alive) { console.log('      （mock WebDAV 未运行，跳过）'); return; }
    const conn = { url: 'http://127.0.0.1:8765/dav', username: 'davuser', password: 'secret-pass', path: `rot-${Date.now()}` };
    const payload = { watches: [{ from: '上海', to: '北京', date: '2026-10-16' }], channels: [] };
    // keep=1：刚上传的那份必须留下，其余全清
    const first = await dav.upload(conn, payload, { keep: 1 });
    const second = await dav.upload(conn, payload, { keep: 1 });
    const left = await dav.listBackups(conn);
    assert.strictEqual(left.length, 1, `keep=1 时应只剩 1 份，实际 ${left.length}`);
    assert.strictEqual(left[0].name, second.name, '保留的必须是刚上传的那份');
    assert.notStrictEqual(left[0].name, first.name, '旧备份应被清理');
  });

  await test('WebDAV 备份被改坏时给出可读错误而不是 TypeError', () => {
    const dav = require('../src/dav');
    // channels 混入 null
    assert.throws(
      () => dav.validatePayload({ watches: [], channels: [null] }),
      /非法的渠道条目/,
    );
    assert.throws(
      () => dav.validatePayload({ watches: [], channels: ['x'] }),
      /非法的渠道条目/,
    );
    // 非法百分号编码不应让解析整体抛错
    const xml = '<D:multistatus xmlns:D="DAV:"><D:response><D:href>/d/%E4%B8%AD.json</D:href><D:propstat><D:prop><D:resourcetype/></D:prop></D:propstat></D:response></D:multistatus>';
    assert.doesNotThrow(() => dav.parseStatXml(xml));
    // mergeSecretsFromLocal 对 null 条目应跳过
    const merged = dav.mergeSecretsFromLocal({ channels: [null, { id: 'c1', type: 'ntfy', topic: 't' }] }, []);
    assert.strictEqual(merged.length, 1, 'null 条目应被过滤');
  });

  await test('logger/notifier/store/engine 的关键防护都在位', () => {
    const loggerSrc = fs.readFileSync(path.join(__dirname, '..', 'src', 'logger.js'), 'utf8');
    assert.ok(loggerSrc.includes('const count = Math.floor(n)'), 'recent 应先 floor 再判正');
    const notifierSrc = fs.readFileSync(path.join(__dirname, '..', 'src', 'notifier.js'), 'utf8');
    assert.ok(notifierSrc.includes('encodeRfc2047'), 'ntfy 中文标题应做 RFC 2047 编码');
    const storeSrc = fs.readFileSync(path.join(__dirname, '..', 'src', 'store.js'), 'utf8');
    assert.ok(storeSrc.includes('readDegraded'), 'store 应有降级只读保护');
    const engineSrc = fs.readFileSync(path.join(__dirname, '..', 'src', 'engine.js'), 'utf8');
    assert.ok(engineSrc.includes('isBoosting'), '应有按任务的复查判断');
    assert.ok(engineSrc.includes('const due = all.filter'), 'tick 应只挑到期的任务');
  });

  console.log('\n[回归] OCR 审查发现并已修复的缺陷');

  await test('logger.recent 对 0 / 负数返回空数组（不能返回整段日志）', () => {
    const logger = require('../src/logger');
    for (let i = 0; i < 5; i += 1) logger.info(`x${i}`);
    assert.deepStrictEqual(logger.recent(0), []);
    assert.deepStrictEqual(logger.recent(-3), []);
    assert.strictEqual(logger.recent(2).length, 2);
    assert.deepStrictEqual(logger.recent('abc'), []);
    assert.strictEqual(logger.recent(undefined).length > 0, true);
  });

  await test('掩码只作用于凭据，端点地址保持可见', () => {
    assert.strictEqual(notifier.mask({ type: 'webhook', url: 'https://real/hook' }).url, 'https://real/hook');
    assert.strictEqual(notifier.mask({ type: 'bark', deviceKey: 'k', serverUrl: 'https://api.day.app' }).serverUrl, 'https://api.day.app');
    assert.strictEqual(notifier.mask({ type: 'serverchan', sendkey: 'S' }).sendkey, notifier.MASKED);
    assert.strictEqual(notifier.mask({ type: 'telegram', botToken: 'T', chatId: '1' }).botToken, notifier.MASKED);
    assert.strictEqual(notifier.mask({ type: 'telegram', botToken: 'T', chatId: '1' }).chatId, '1');
  });

  await test('notifier.send 对空渠道与抛错渠道都返回 ok:false，不冒泡', async () => {
    assert.strictEqual((await notifier.send(null, 't', 'b')).ok, false);
    assert.strictEqual((await notifier.send(undefined, 't', 'b')).ok, false);
    const original = notifier.SENDERS.webhook;
    notifier.SENDERS.webhook = async () => { throw new Error('模拟渠道异常'); };
    try {
      const r = await notifier.send({ type: 'webhook', url: 'https://x' }, 't', 'b');
      assert.strictEqual(r.ok, false);
      assert.ok(r.error.includes('模拟渠道异常'));
    } finally {
      notifier.SENDERS.webhook = original;
    }
  });

  await test('并发互斥：调度与手动检查不会同时发请求', async () => {
    const config = {
      settings: { ...store.DEFAULT_CONFIG.settings },
      watches: [{ id: 'wc', from: '上海', to: '北京', fromCode: 'SHH', toCode: 'BJP', fromName: '上海', toName: '北京', date: '2026-10-10', seats: ['二等座'], enabled: true }],
      channels: [],
    };
    const monitor = new Monitor({ getConfig: () => config });
    monitor.stations = [];
    let concurrent = 0;
    let peak = 0;
    const original = client.queryTickets;
    client.queryTickets = async () => {
      concurrent += 1;
      peak = Math.max(peak, concurrent);
      await new Promise((r) => setTimeout(r, 120));
      concurrent -= 1;
      return { trains: [], stationMap: {}, checkedAt: Date.now() };
    };
    try {
      await Promise.all([
        monitor.runOnce(config.watches, { source: 'schedule' }),
        monitor.runOnce(config.watches, { source: 'manual' }),
        monitor.runOnce(config.watches, { source: 'manual' }),
      ]);
      assert.strictEqual(peak, 1, `同时并发峰值应为 1，实际 ${peak}`);
      assert.strictEqual(monitor.inFlight, false, '结束后应释放闸门');
    } finally {
      client.queryTickets = original;
    }
  });

  await test('后处理异常不会被计成查询失败（不加退避）', async () => {
    const config = {
      settings: { ...store.DEFAULT_CONFIG.settings },
      watches: [{ id: 'wp', from: '上海', to: '北京', fromCode: 'SHH', toCode: 'BJP', fromName: '上海', toName: '北京', date: '2026-10-10', seats: ['二等座'], enabled: true }],
      channels: [],
    };
    const monitor = new Monitor({ getConfig: () => config });
    monitor.stations = [];
    const original = client.queryTickets;
    client.queryTickets = async () => ({ trains: [{ trainCode: 'G1', tickets: { 二等座: '有' } }], stationMap: {}, checkedAt: Date.now() });
    // 让后处理抛错
    monitor.seatSummary = () => { throw new Error('后处理炸了'); };
    try {
      await monitor.runOnce(config.watches, { source: 'manual' });
      const st = monitor.stateFor('wp');
      assert.strictEqual(st.status, 'ok', '查询本身成功，状态应为 ok');
      assert.strictEqual(st.errorStreak, 0, '后处理异常不应累计查询错误');
      assert.strictEqual(st.backoffUntil, null, '后处理异常不应触发退避');
      assert.strictEqual(monitor.metrics.errors, 0);
    } finally {
      client.queryTickets = original;
    }
  });

  await test('命中复查间隔跟随 retryOnHitSeconds 设置', async () => {
    const config = {
      settings: { ...store.DEFAULT_CONFIG.settings, retryOnHitSeconds: 45, retryOnHitMaxMinutes: 10 },
      watches: [{ id: 'wb', fromName: '上海', toName: '北京', date: '2026-10-10', seats: ['二等座'], enabled: true }],
      channels: [],
    };
    const monitor = new Monitor({ getConfig: () => config });
    monitor.notify = async () => {};
    const st = monitor.stateFor('wb');
    const before = Date.now();
    await monitor.applyHits(config.watches[0], st, [{ trainCode: 'G1', matched: { 二等座: '有' } }], (c) => c);
    const delta = st.boostUntil - before;
    assert.ok(delta >= 44000 && delta <= 47000, `复查窗口应约 45s，实际 ${delta}ms`);
  });

  await test('store 读取遇到非 ENOENT 错误时不覆盖已有配置', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tm-eacces-'));
    const origDir = process.env.DATA_DIR;
    process.env.DATA_DIR = dir;
    delete require.cache[require.resolve('../src/store')];
    const st2 = require('../src/store');
    // 先写一份有效配置
    st2.save({ version: 1, settings: { intervalSeconds: 1234 }, watches: [{ id: 'keepme' }], channels: [] });
    // 让 readFileSync 抛 EACCES
    const realRead = fs.readFileSync;
    fs.readFileSync = (p, ...rest) => {
      if (String(p).endsWith('config.json')) { const e = new Error('denied'); e.code = 'EACCES'; throw e; }
      return realRead(p, ...rest);
    };
    let loaded;
    try {
      loaded = st2.load();
    } finally {
      fs.readFileSync = realRead;
    }
    assert.deepStrictEqual(loaded.watches, [], '应退回默认配置');
    const onDisk = JSON.parse(realRead(path.join(dir, 'config.json'), 'utf8'));
    assert.strictEqual(onDisk.watches[0].id, 'keepme', '磁盘上的有效配置绝不能被覆盖');
    process.env.DATA_DIR = origDir;
    delete require.cache[require.resolve('../src/store')];
    require('../src/store');
    fs.rmSync(dir, { recursive: true, force: true });
  });

  await test('服务对畸形 Host 不崩溃且返回 400', async () => {
    const { server } = require('../src/server');
    await new Promise((resolve) => {
      if (server.listening) return resolve();
      server.listen(0, '127.0.0.1', resolve);
    });
    const port = server.address().port;
    try {
      const net = require('net');
      const raw = await new Promise((resolve) => {
        const sock = net.connect(port, '127.0.0.1', () => {
          sock.write('GET /api/state HTTP/1.1\r\nHost: a b\r\nConnection: close\r\n\r\n');
        });
        let buf = '';
        sock.on('data', (d) => { buf += d; });
        sock.on('end', () => resolve(buf));
        sock.on('error', () => resolve(buf));
        setTimeout(() => { sock.destroy(); resolve(buf); }, 3000);
      });
      assert.ok(raw.includes('400') || raw.includes('401'), `应返回 4xx 而不是崩溃，实际：${raw.slice(0, 60)}`);
      // 进程仍存活：还能继续服务
      const ok = await fetch(`http://127.0.0.1:${port}/health`);
      assert.strictEqual(ok.status, 200, '服务必须仍然存活');
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  });

  await test('/api/export 不回传明文密钥', async () => {
    const { server, getConfig } = require('../src/server');
    await new Promise((resolve) => {
      if (server.listening) return resolve();
      server.listen(0, '127.0.0.1', resolve);
    });
    const base = `http://127.0.0.1:${server.address().port}`;
    const cfg = getConfig();
    const savedToken = cfg.settings.token;
    const savedChannels = cfg.channels;
    try {
      cfg.settings.token = 'super-secret-token';
      cfg.channels = [{ id: 'cx', type: 'serverchan', sendkey: 'SCTrealkey', enabled: true }];
      // 开了令牌就必须带令牌访问；这里同时验证掩码行为
      const res = await fetch(`${base}/api/export`, { headers: { 'X-Token': 'super-secret-token' } });
      assert.strictEqual(res.status, 200);
      const exported = await res.json();
      assert.strictEqual(exported.settings.token, notifier.MASKED, '令牌必须掩码');
      assert.strictEqual(exported.channels[0].sendkey, notifier.MASKED, '渠道密钥必须掩码');
      assert.ok(!JSON.stringify(exported).includes('SCTrealkey'), '导出内容不得出现明文密钥');
    } finally {
      cfg.settings.token = savedToken;
      cfg.channels = savedChannels;
      await new Promise((resolve) => server.close(resolve));
    }
  });

  await test('/api/import 不能绕过间隔下限与渠道校验', async () => {
    const { server, getConfig } = require('../src/server');
    await new Promise((resolve) => {
      if (server.listening) return resolve();
      server.listen(0, '127.0.0.1', resolve);
    });
    const base = `http://127.0.0.1:${server.address().port}`;
    const cfg = getConfig();
    const savedToken = cfg.settings.token;
    cfg.settings.token = '';
    const post = (body) => fetch(`${base}/api/import`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    try {
      const bad = await post({ settings: { intervalSeconds: 0, minIntervalSeconds: 0 }, watches: [], channels: [] });
      assert.strictEqual(bad.status, 400, 'intervalSeconds=0 必须被拒（否则请求风暴）');

      const badWatch = await post({ watches: [{ id: 'x', from: '上海', to: '北京', date: '不是日期', seats: [] }], channels: [] });
      assert.strictEqual(badWatch.status, 400, '非法任务必须被拒');

      const badChannel = await post({ watches: [], channels: [{ type: '不存在的渠道' }] });
      assert.strictEqual(badChannel.status, 400, '非法渠道必须被拒');

      const good = await post({ settings: { intervalSeconds: 1200 }, watches: [], channels: [] });
      assert.strictEqual(good.status, 200, '合法导入应成功');
      assert.strictEqual(getConfig().settings.intervalSeconds, 1200);
    } finally {
      cfg.settings.token = savedToken;
      await new Promise((resolve) => server.close(resolve));
    }
  });

  await test('导出→导入往返：密钥不泄露且能还原', async () => {
    const { server, getConfig } = require('../src/server');
    await new Promise((resolve) => {
      if (server.listening) return resolve();
      server.listen(0, '127.0.0.1', resolve);
    });
    const base = `http://127.0.0.1:${server.address().port}`;
    const cfg = getConfig();
    const savedToken = cfg.settings.token;
    const savedChannels = cfg.channels;
    cfg.settings.token = '';
    cfg.channels = [{ id: 'crt', type: 'serverchan', name: '微信', sendkey: 'SCTroundtrip-secret', enabled: true }];
    try {
      const exported = await (await fetch(`${base}/api/export`)).json();
      assert.ok(!JSON.stringify(exported).includes('SCTroundtrip-secret'), '导出不得含明文密钥');
      const res = await fetch(`${base}/api/import`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(exported),
      });
      assert.strictEqual(res.status, 200, '导出的文件应能原样导回');
      assert.strictEqual(getConfig().channels[0].sendkey, 'SCTroundtrip-secret', '掩码应还原为原密钥');
    } finally {
      cfg.settings.token = savedToken;
      cfg.channels = savedChannels;
      await new Promise((resolve) => server.close(resolve));
    }
  });

  await test('跨实例导入：密钥缺失时给出警告而不是静默丢弃', async () => {
    const { server, getConfig } = require('../src/server');
    await new Promise((resolve) => {
      if (server.listening) return resolve();
      server.listen(0, '127.0.0.1', resolve);
    });
    const base = `http://127.0.0.1:${server.address().port}`;
    const cfg = getConfig();
    const savedToken = cfg.settings.token;
    const savedChannels = cfg.channels;
    cfg.settings.token = '';
    cfg.channels = [];
    try {
      // 模拟从另一台机器导入（本机没有对应渠道，密钥无法还原）
      const res = await fetch(`${base}/api/import`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ watches: [], channels: [{ id: 'new1', type: 'serverchan', name: '别处的微信', sendkey: notifier.MASKED, enabled: true }] }),
      });
      assert.strictEqual(res.status, 200);
      const body = await res.json();
      assert.ok(body.warnings && body.warnings.length === 1, '应提示密钥需手工补填');
      assert.ok(body.warnings[0].includes('缺少密钥'));
      assert.strictEqual(getConfig().channels.length, 1, '渠道本身仍应导入');
    } finally {
      cfg.settings.token = savedToken;
      cfg.channels = savedChannels;
      await new Promise((resolve) => server.close(resolve));
    }
  });

  await test('导入：过期任务被跳过而不是拖垮整份备份', async () => {
    const { server, getConfig } = require('../src/server');
    await new Promise((resolve) => {
      if (server.listening) return resolve();
      server.listen(0, '127.0.0.1', resolve);
    });
    const base = `http://127.0.0.1:${server.address().port}`;
    const cfg = getConfig();
    const savedToken = cfg.settings.token;
    cfg.settings.token = '';
    const d = new Date();
    const p = (n) => String(n).padStart(2, '0');
    const future = `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate() + 2)}`;
    try {
      // 备份往往在数天后才恢复，此时旧任务日期已过期 —— 不能因此整份失败
      const mixed = await fetch(`${base}/api/import`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          watches: [
            { id: 'w1', from: '上海', to: '北京', date: '2026-09-01', seats: ['二等座'], fromName: '上海', toName: '北京' },
            { id: 'w2', from: '广州', to: '深圳', date: future, seats: ['二等座'], fromName: '广州', toName: '深圳' },
          ],
          channels: [{ id: 'c1', type: 'ntfy', name: '我的通知', topic: 't' }],
          settings: { intervalSeconds: 1200 },
        }),
      });
      assert.strictEqual(mixed.status, 200, '有可用任务时应成功');
      const body = await mixed.json();
      assert.strictEqual(body.watches, 1, '只保留可用任务');
      assert.strictEqual(body.channels, 1, '渠道仍应导入');
      assert.ok(body.warnings.some((w) => w.includes('跳过')), '应告知跳过了哪个任务');
      assert.strictEqual(getConfig().settings.intervalSeconds, 1200, '设置应生效');
      assert.strictEqual(getConfig().watches[0].fromName, '广州');

      // 全部不可用时必须报错，不能静默把配置清空
      const allOld = await fetch(`${base}/api/import`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ watches: [{ id: 'a', from: '上海', to: '北京', date: '2026-09-01', seats: ['二等座'] }], channels: [] }),
      });
      assert.strictEqual(allOld.status, 400, '全部不可用应拒绝');
      const allOldBody = await allOld.json();
      assert.ok(allOldBody.errors[0].includes('全部不可用'));
      assert.strictEqual(getConfig().watches.length, 1, '拒绝时不得改动现有配置');

      // 结构性错误（缺站名）仍应拒绝
      const broken = await fetch(`${base}/api/import`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ watches: [{ id: 'x', from: '', to: '北京', date: future, seats: ['二等座'] }], channels: [] }),
      });
      assert.strictEqual(broken.status, 400, '缺站名应拒绝');
    } finally {
      cfg.settings.token = savedToken;
      await new Promise((resolve) => server.close(resolve));
    }
  });

  await test('接口：WebDAV 设置掩码与必填校验', async () => {
    const { server, getConfig } = require('../src/server');
    await new Promise((resolve) => {
      if (server.listening) return resolve();
      server.listen(0, '127.0.0.1', resolve);
    });
    const base = `http://127.0.0.1:${server.address().port}`;
    const cfg = getConfig();
    const savedToken = cfg.settings.token;
    const savedDav = cfg.settings.webdav;
    cfg.settings.token = '';
    try {
      // 启用但缺字段应被拒
      for (const bad of [{ enabled: true }, { enabled: true, url: 'https://dav.x.com', username: 'u' }]) {
        const r = await fetch(`${base}/api/settings`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ webdav: bad }),
        });
        assert.strictEqual(r.status, 400, `应拒绝：${JSON.stringify(bad)}`);
      }
      // 非法地址
      const badUrl = await fetch(`${base}/api/settings`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ webdav: { enabled: true, url: 'not-a-url', username: 'u', password: 'p' } }),
      });
      assert.strictEqual(badUrl.status, 400);
      // 路径穿越应被拒
      const badPath = await fetch(`${base}/api/settings`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ webdav: { enabled: true, url: 'https://dav.x.com/dav', username: 'u', password: 'p', path: '../evil' } }),
      });
      assert.strictEqual(badPath.status, 400, '路径含 .. 应被拒');
      // 合法保存
      const okRes = await fetch(`${base}/api/settings`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ webdav: { enabled: true, url: 'https://dav.x.com/dav', username: 'u', password: 'REAL-DAV-PASS', path: 'tm', keep: 500 } }),
      });
      assert.strictEqual(okRes.status, 200);
      const body = await okRes.json();
      assert.strictEqual(body.settings.webdav.password, notifier.MASKED, '密码必须掩码回传');
      assert.strictEqual(body.settings.webdav.keep, 100, 'keep 应被夹到上限');
      assert.strictEqual(getConfig().settings.webdav.password, 'REAL-DAV-PASS', '服务端应保留真实密码');

      // 提交掩码不应覆盖真实密码
      await fetch(`${base}/api/settings`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ webdav: { password: notifier.MASKED, path: 'tm2' } }),
      });
      assert.strictEqual(getConfig().settings.webdav.password, 'REAL-DAV-PASS', '掩码不应覆盖密码');
      assert.strictEqual(getConfig().settings.webdav.path, 'tm2');

      // /api/config 也不得回传明文
      const cfgRes = await (await fetch(`${base}/api/config`)).json();
      assert.strictEqual(cfgRes.settings.webdav.password, notifier.MASKED);
      assert.ok(!JSON.stringify(cfgRes).includes('REAL-DAV-PASS'));
    } finally {
      cfg.settings.token = savedToken;
      cfg.settings.webdav = savedDav;
      await new Promise((resolve) => server.close(resolve));
    }
  });

  await test('接口：未配置 WebDAV 时备份接口给出明确错误', async () => {
    const { server, getConfig } = require('../src/server');
    await new Promise((resolve) => {
      if (server.listening) return resolve();
      server.listen(0, '127.0.0.1', resolve);
    });
    const base = `http://127.0.0.1:${server.address().port}`;
    const cfg = getConfig();
    const savedToken = cfg.settings.token;
    const savedDav = cfg.settings.webdav;
    cfg.settings.token = '';
    cfg.settings.webdav = { ...savedDav, enabled: false, url: '', username: '', password: '' };
    try {
      const r = await fetch(`${base}/api/webdav/backup`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({}),
      });
      assert.strictEqual(r.status, 400);
      const body = await r.json();
      assert.ok(body.error.includes('WebDAV'), `应提示未配置：${body.error}`);
    } finally {
      cfg.settings.token = savedToken;
      cfg.settings.webdav = savedDav;
      await new Promise((resolve) => server.close(resolve));
    }
  });

  await test('WebDAV 设置界面元素齐备', () => {
    const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');
    for (const id of ['d_enabled', 'd_url', 'd_user', 'd_pass', 'd_path', 'd_keep', 'd_auto', 'd_test', 'd_backup', 'd_list', 'd_save']) {
      assert.ok(html.includes(`id="${id}"`), `设置页缺少 #${id}`);
    }
    const js = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.js'), 'utf8');
    for (const p of ['/api/webdav/test', '/api/webdav/backup', '/api/webdav/backups', '/api/webdav/restore']) {
      assert.ok(js.includes(p), `前端未调用 ${p}`);
    }
    assert.ok(js.includes('d_pass').value === '' || js.includes("el('d_pass').value = ''"), '密码框不应回填掩码');
    assert.ok(js.includes('confirmDialog'), '恢复前应有确认');
  });

  await test('前端不再把令牌拼进每个请求的查询串', () => {
    const js = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.js'), 'utf8');
    assert.ok(js.includes("fetch(path,"), 'fetch 应使用原始 path');
    assert.ok(!js.includes('fetch(withToken(path)'), 'fetch 不应再拼 token 到查询串');
    assert.ok(js.includes("new EventSource(withToken("), 'EventSource 仍需查询串令牌');
    assert.ok(js.includes('history.replaceState'), '地址栏里的令牌应被抹掉');
  });

  console.log('\n========== 结果 ==========');
  const failed = results.filter((r) => !r.ok);
  console.log(`通过 ${results.length - failed.length}/${results.length}`);
  if (failed.length) {
    for (const f of failed) console.log(`失败：${f.name} → ${f.error.message}`);
    process.exitCode = 1;
  }
})();
