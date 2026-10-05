'use strict';

// 真实接口冒烟：会访问 12306 官方只读接口，用于确认「无登录、无 Cookie」下可用
// 用法：node scripts/smoke.js [YYYY-MM-DD]
// 判定：HTTP 200 + status=true + 解析出车次。不看「有无余票」（淡季/旺季不同）。

const client = require('../src/client');

const date = process.argv[2] || new Date(Date.now() + 86400000).toISOString().slice(0, 10);

(async function main() {
  console.log(`\n冒烟测试：上海 → 北京，日期 ${date}`);
  let failed = 0;

  const stations = await client.getStations();
  console.log(`  [1] 车站表：${stations.length} 个车站 ✓`);
  const from = client.resolveStation('上海', stations);
  const to = client.resolveStation('北京', stations);
  if (!from || !to) { console.error('  [2] 站名解析失败 ✗'); process.exit(1); }
  console.log(`  [2] 站名解析：${from.name}(${from.code}) → ${to.name}(${to.code}) ✓`);

  const started = Date.now();
  const { trains, stationMap } = await client.queryTickets({ date, fromCode: from.code, toCode: to.code });
  const cost = Date.now() - started;
  if (!trains.length) { console.error('  [3] 未解析到车次 ✗'); process.exit(1); }
  console.log(`  [3] 余票查询：${trains.length} 个车次，耗时 ${cost}ms ✓`);
  console.log(`      站名映射：${Object.entries(stationMap).map(([k, v]) => `${k}=${v}`).join(' ')}`);

  const sample = trains.slice(0, 3);
  console.log('  [4] 抽样解析：');
  for (const t of sample) {
    const seats = Object.entries(t.tickets).filter(([, v]) => v).map(([k, v]) => `${k}:${v}`).join(' ');
    console.log(`      ${t.trainCode} ${t.startTime}-${t.arriveTime} (${t.duration}) ${seats}`);
  }
  const seats = Object.keys(client.emptyTickets());
  const missing = trains.filter((t) => !Object.keys(t.tickets).length === false && seats.some((s) => t.tickets[s] === undefined));
  if (missing.length) { console.error('  [5] 席别字段缺失 ✗'); failed += 1; }
  else console.log('  [5] 12 个席别字段全部就位 ✓');

  const hits = client.pickHits(trains, ['二等座', '一等座']);
  console.log(`  [6] 命中判定：${hits.length} 个车次在「二等座/一等座」有票${hits.length ? '（例：' + hits[0].trainCode + ' ' + JSON.stringify(hits[0].matched) + '）' : ''} ✓`);

  console.log(`\n结果：${failed ? '失败' : '通过'}\n`);
  process.exit(failed ? 1 : 0);
})().catch((err) => {
  console.error(`\n冒烟失败：${err.message}\n`);
  process.exit(1);
});
