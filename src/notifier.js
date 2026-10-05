'use strict';

const logger = require('./logger');

const TYPES = [
  {
    type: 'serverchan',
    label: 'Server 酱（微信）',
    fields: [{ key: 'sendkey', label: 'SendKey', required: true }],
    hint: 'SCT 开头走 sctapi.ftqq.com，sctp 开头走 <num>.push.ft07.com',
  },
  {
    type: 'bark',
    label: 'Bark（iOS）',
    fields: [
      { key: 'deviceKey', label: 'Device Key', required: true },
      { key: 'serverUrl', label: '服务器地址', required: false, default: 'https://api.day.app' },
    ],
  },
  {
    type: 'wecom',
    label: '企业微信群机器人',
    fields: [{ key: 'webhook', label: 'Webhook URL', required: true }],
  },
  {
    type: 'dingtalk',
    label: '钉钉群机器人',
    fields: [
      { key: 'webhook', label: 'Webhook URL', required: true },
      { key: 'secret', label: '加签密钥（可选）', required: false },
    ],
  },
  {
    type: 'telegram',
    label: 'Telegram',
    fields: [
      { key: 'botToken', label: 'Bot Token', required: true },
      { key: 'chatId', label: 'Chat ID', required: true },
    ],
  },
  {
    type: 'pushplus',
    label: 'PushPlus（微信）',
    fields: [{ key: 'token', label: 'Token', required: true }],
  },
  {
    type: 'ntfy',
    label: 'ntfy',
    fields: [
      { key: 'topic', label: 'Topic', required: true },
      { key: 'serverUrl', label: '服务器地址', required: false, default: 'https://ntfy.sh' },
    ],
  },
  {
    type: 'webhook',
    label: '自定义 Webhook（JSON POST）',
    fields: [{ key: 'url', label: 'URL', required: true }],
  },
];

const MASKED = '******';
// 只掩码真正的凭据。url / serverUrl 是端点地址而非密钥，掩码它们会让用户在
// 编辑渠道时看到 ****** 并可能把真实地址覆盖掉。
const SECRET_KEYS = ['sendkey', 'deviceKey', 'webhook', 'secret', 'botToken', 'token'];

function mask(channel) {
  const out = { ...channel };
  for (const k of SECRET_KEYS) {
    if (out[k]) out[k] = MASKED;
  }
  return out;
}

// 上游错误体只保留「是否结构化」这一层信息，避免把密钥/完整 URL 带进日志
function describeBody(text) {
  const t = String(text || '').trim();
  if (!t) return '';
  if (/^[\s\S]{0,2}[<{]/.test(t)) return '（响应体非空，已省略以免泄漏凭证）';
  return `：${t.slice(0, 80)}`;
}

// HTTP 头只能是 ByteString；非 ASCII 需按 RFC 2047 编码成 =?UTF-8?B?...?=
// 直接发原始中文会抛 TypeError，导致 ntfy 渠道 100% 失败。
function encodeRfc2047(text) {
  const str = String(text || '');
  // eslint-disable-next-line no-control-regex
  if (/^[\x20-\x7E]*$/.test(str)) return str;
  return `=?UTF-8?B?${Buffer.from(str, 'utf8').toString('base64')}?=`;
}

async function post(url, { json, form, headers = {}, timeoutMs = 15000 } = {}) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const init = { method: 'POST', signal: ctrl.signal, headers: { ...headers } };
    if (json) {
      init.headers['Content-Type'] = 'application/json';
      init.body = JSON.stringify(json);
    } else if (form) {
      init.headers['Content-Type'] = 'application/x-www-form-urlencoded';
      init.body = new URLSearchParams(form).toString();
    }
    const res = await fetch(url, init);
    const text = await res.text();
    if (!res.ok) {
      // 不回显上游 body：自定义 webhook 的响应可能回显密钥或内嵌完整 URL，
      // 而 error 会被写进日志、经 SSE 推到前端。只给状态码 + 短摘录。
      return { ok: false, error: `HTTP ${res.status}${describeBody(text)}` };
    }
    // 200 但内容是 HTML（常见于自建网关或错误页）通常意味着并没有真正投递
    if (/^\s*<(!DOCTYPE|html)/i.test(text)) {
      return { ok: false, error: `HTTP ${res.status} 但返回 HTML 而非接口响应，推送可能未送达` };
    }
    // body 要留给调用方做 JSON.parse（Server 酱判断 code），不能截断；
    // 只对展示用的预览做截断，否则长响应会被剪成非法 JSON 并误报失败。
    return { ok: true, body: text, preview: text.slice(0, 400) };
  } catch (err) {
    // 不能直接透传 err.message：Node 的 fetch 在 URL 解析失败时抛出
    // "Failed to parse URL from <完整 URL>"，而 Server 酱 / 钉钉 / 企业微信 / 自定义
    // webhook 的 URL 里就带着密钥，会把凭据写进日志并经 SSE 推到前端。
    // 超时是唯一既安全又有用的信息，其余一律用固定文案 + 脱敏预览。
    if (err && err.name === 'AbortError') return { ok: false, error: '请求超时' };
    const msg = String((err && err.message) || '');
    const leaked = /https?:\/\//i.test(msg) || msg.includes('Failed to parse URL');
    return { ok: false, error: leaked ? '请求失败（地址或网络不可用，详情已脱敏）' : `请求失败：${msg.slice(0, 120)}` };
  } finally {
    clearTimeout(timer);
  }
}

async function sendServerChan(channel, title, body) {
  const key = String(channel.sendkey || '').trim();
  if (!key) return { ok: false, error: '缺少 SendKey' };
  let url;
  const m = key.match(/^sctp(\d+)t/i);
  if (m) url = `https://${m[1]}.push.ft07.com/send/${key}.send`;
  else url = `https://sctapi.ftqq.com/${key}.send`;
  const r = await post(url, { form: { title, desp: body } });
  if (!r.ok) return r;
  try {
    const json = JSON.parse(r.body);
    const code = json.code !== undefined ? json.code : json.data && json.data.code;
    if (code === undefined) return { ok: false, error: '响应缺少 code 字段，无法确认是否送达' };
    if (Number(code) !== 0) return { ok: false, error: `返回 code=${code}` };
  } catch (err) {
    return { ok: false, error: '响应不是 JSON，无法确认是否送达' };
  }
  return { ok: true };
}

async function sendBark(channel, title, body) {
  const server = String(channel.serverUrl || 'https://api.day.app').replace(/\/+$/, '');
  const key = encodeURIComponent(String(channel.deviceKey || '').trim());
  if (!key) return { ok: false, error: '缺少 Device Key' };
  const url = `${server}/${key}/${encodeURIComponent(title)}/${encodeURIComponent(body)}?group=${encodeURIComponent('火车票监控')}&level=timeSensitive`;
  return post(url, {});
}

// 企业微信 / 钉钉失败时返回的是 HTTP 200 + 非零 errcode，
// 只判 res.ok 会把投递失败当成成功，用户以为收到通知其实没有。
function checkErrcode(r) {
  if (!r.ok) return r;
  let json;
  try {
    json = JSON.parse(r.body);
  } catch (err) {
    return { ok: false, error: '响应不是 JSON，无法确认是否送达' };
  }
  const code = json.errcode === undefined ? json.code : json.errcode;
  if (code !== undefined && Number(code) !== 0) {
    const msg = json.errmsg || json.message || `errcode ${code}`;
    return { ok: false, error: `接口返回错误：${msg}` };
  }
  return { ok: true, body: r.body };
}

async function sendWecom(channel, title, body) {
  if (!channel.webhook) return { ok: false, error: '缺少 Webhook' };
  const r = await post(channel.webhook, { json: { msgtype: 'markdown', markdown: { content: `**${title}**\n${body}` } } });
  return checkErrcode(r);
}

async function sendDingtalk(channel, title, body) {
  if (!channel.webhook) return { ok: false, error: '缺少 Webhook' };
  let url = channel.webhook;
  if (channel.secret) {
    const crypto = require('crypto');
    const timestamp = Date.now();
    const stringToSign = `${timestamp}\n${channel.secret}`;
    const sign = encodeURIComponent(crypto.createHmac('sha256', channel.secret).update(stringToSign).digest('base64'));
    url += `${url.includes('?') ? '&' : '?'}timestamp=${timestamp}&sign=${sign}`;
  }
  const r = await post(url, { json: { msgtype: 'markdown', markdown: { title, text: `### ${title}\n${body}` } } });
  return checkErrcode(r);
}

async function sendTelegram(channel, title, body) {
  if (!channel.botToken || !channel.chatId) return { ok: false, error: '缺少 Bot Token 或 Chat ID' };
  return post(`https://api.telegram.org/bot${channel.botToken}/sendMessage`, {
    json: { chat_id: channel.chatId, text: `${title}\n${body}`, disable_web_page_preview: true },
  });
}

async function sendPushplus(channel, title, body) {
  if (!channel.token) return { ok: false, error: '缺少 Token' };
  return post('https://www.pushplus.plus/send', {
    json: { token: channel.token, title, content: body.replace(/\n/g, '<br>'), template: 'html' },
  });
}

async function sendNtfy(channel, title, body) {
  const server = String(channel.serverUrl || 'https://ntfy.sh').replace(/\/+$/, '');
  if (!channel.topic) return { ok: false, error: '缺少 Topic' };
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 15000);
  try {
    const res = await fetch(`${server}/${encodeURIComponent(channel.topic)}`, {
      method: 'POST',
      signal: ctrl.signal,
      // HTTP 头值必须是 ByteString（每个字符 <=255）。中文标题直接放进去会抛
      // TypeError: Cannot convert argument to a ByteString —— 推送必然失败。
      // ntfy 支持 RFC 2047 编码字，用它可以正确传中文标题。
      headers: { Title: encodeRfc2047(title), Priority: 'high', Tags: 'train' },
      body,
    });
    if (!res.ok) return { ok: false, error: `HTTP ${res.status}` };
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err.name === 'AbortError' ? '请求超时' : err.message };
  } finally {
    clearTimeout(timer);
  }
}

async function sendWebhook(channel, title, body, meta) {
  if (!channel.url) return { ok: false, error: '缺少 URL' };
  return post(channel.url, { json: { title, body, ...meta } });
}

const SENDERS = {
  serverchan: sendServerChan,
  bark: sendBark,
  wecom: sendWecom,
  dingtalk: sendDingtalk,
  telegram: sendTelegram,
  pushplus: sendPushplus,
  ntfy: sendNtfy,
  webhook: sendWebhook,
};

async function send(channel, title, body, meta = {}) {
  if (!channel || typeof channel !== 'object') return { ok: false, error: '渠道配置缺失' };
  const fn = SENDERS[channel.type];
  if (!fn) return { ok: false, error: `不支持的渠道类型：${channel && channel.type}` };
  const started = Date.now();
  let r;
  try {
    r = await fn(channel, title, body, meta);
  } catch (err) {
    // 任何渠道抛错都不能冒泡成未处理 rejection，也不能中断后续渠道推送
    r = { ok: false, error: err.message };
  }
  const cost = Date.now() - started;
  if (r.ok) logger.info(`推送成功 [${channel.type}] ${title}（${cost}ms）`);
  else logger.warn(`推送失败 [${channel.type}] ${r.error}`);
  return { ...r, cost };
}

module.exports = { TYPES, SENDERS, send, mask, MASKED, encodeRfc2047 };
