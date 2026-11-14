/*
 * B站 AI 内容屏蔽 —— 后台服务
 *
 * 职责：
 *  1. 接收内容脚本发来的 BV 号，调用 B 站视频详情接口，读取「内容声明」（argue_info.argue_msg）。
 *  2. B 站给 AI 内容打的标注就是这条数据（视频页上的「含AI生成内容」标签由它渲染），
 *     所以这里判定的是 B 站自己的官方标注，而不是靠猜标题。
 *  3. 结果本地缓存 7 天；带节流和并发控制，避免触发风控。
 */
'use strict';

const VIEW_API = 'https://api.bilibili.com/x/web-interface/view?bvid=';
const CACHE_KEY = 'aiCache';
const CACHE_TTL = 7 * 24 * 3600 * 1000; // 7 天
const CACHE_MAX = 5000;
const REQUEST_GAP_MS = 150; // 两次请求之间的最小间隔
const REQUEST_TIMEOUT_MS = 8000;
const RISK_COOLDOWN_MS = 60 * 1000; // 风控后冷却

/** AI 标注文案匹配（「含虚构演绎内容」之类不算） */
const AI_MSG_RE = /AI|人工智能|AIGC|生成合成/i;

let cache = null; // Map<bvid, { ai: boolean, msg: string, ts: number }>
let bannedUntil = 0;
let lastRequestAt = 0;
let saveTimer = 0;
let gate = Promise.resolve();

/* ---------------------------------- 缓存 ---------------------------------- */

async function loadCache() {
  if (cache) return cache;
  cache = new Map();
  try {
    const stored = await chrome.storage.local.get(CACHE_KEY);
    const raw = stored && stored[CACHE_KEY];
    if (raw && typeof raw === 'object') {
      const now = Date.now();
      for (const [bvid, item] of Object.entries(raw)) {
        if (item && typeof item.ts === 'number' && now - item.ts < CACHE_TTL) {
          cache.set(bvid, { ai: !!item.ai, msg: String(item.msg || ''), ts: item.ts });
        }
      }
    }
  } catch (err) {
    // 缓存读取失败不影响主流程
  }
  return cache;
}

function persistCacheSoon() {
  if (saveTimer) return;
  saveTimer = setTimeout(async () => {
    saveTimer = 0;
    try {
      const obj = {};
      const entries = [...cache.entries()].sort((a, b) => b[1].ts - a[1].ts).slice(0, CACHE_MAX);
      for (const [bvid, item] of entries) obj[bvid] = item;
      await chrome.storage.local.set({ [CACHE_KEY]: obj });
    } catch (err) {
      // ignore
    }
  }, 800);
}

/* --------------------------------- 请求节流 -------------------------------- */

/** 串行排队 + 最小间隔，保证不把接口打爆 */
function schedule(task) {
  const run = gate.then(async () => {
    const wait = Math.max(0, lastRequestAt + REQUEST_GAP_MS - Date.now());
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    lastRequestAt = Date.now();
    return task();
  });
  gate = run.then(
    () => undefined,
    () => undefined
  );
  return run;
}

async function fetchDeclaration(bvid) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), REQUEST_TIMEOUT_MS);
  try {
    const res = await fetch(VIEW_API + encodeURIComponent(bvid), {
      credentials: 'omit',
      cache: 'no-store',
      signal: ctrl.signal,
      headers: { Accept: 'application/json' }
    });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const text = await res.text();
    let json = null;
    try {
      json = JSON.parse(text);
    } catch (err) {
      throw new Error('响应不是 JSON');
    }
    const code = Number(json && json.code);
    if (code === -412 || code === -352 || code === -509) {
      bannedUntil = Date.now() + RISK_COOLDOWN_MS;
      throw new Error('风控 code=' + code);
    }
    if (code !== 0) throw new Error('code=' + code + ' ' + (json.message || ''));
    const data = (json && json.data) || {};
    const argue = data.argue_info || {};
    const msg = String(argue.argue_msg || '').trim();
    return { ai: AI_MSG_RE.test(msg), msg };
  } finally {
    clearTimeout(timer);
  }
}

/* --------------------------------- 批量查询 -------------------------------- */

async function checkBvids(bvids) {
  await loadCache();
  const results = {};
  const retry = [];
  const now = Date.now();
  const queue = [];

  for (const bvid of bvids || []) {
    if (typeof bvid !== 'string' || !/^BV[0-9A-Za-z]{10}$/.test(bvid)) continue;
    const hit = cache.get(bvid);
    if (hit && now - hit.ts < CACHE_TTL) {
      results[bvid] = { ai: hit.ai, msg: hit.msg, cached: true };
    } else if (!queue.includes(bvid)) {
      queue.push(bvid);
    }
  }

  if (bannedUntil > Date.now()) return { results, retry: queue };

  for (const bvid of queue) {
    try {
      const info = await schedule(() => fetchDeclaration(bvid));
      cache.set(bvid, { ai: info.ai, msg: info.msg, ts: Date.now() });
      results[bvid] = info;
      persistCacheSoon();
    } catch (err) {
      retry.push(bvid);
      if (bannedUntil > Date.now()) {
        for (const rest of queue.slice(queue.indexOf(bvid) + 1)) retry.push(rest);
        break;
      }
    }
  }

  return { results, retry };
}

/* --------------------------------- 图标角标 -------------------------------- */

function updateBadge(tabId, count) {
  if (typeof tabId !== 'number') return;
  try {
    chrome.action.setBadgeText({ tabId, text: count > 0 ? String(count) : '' });
    chrome.action.setBadgeBackgroundColor({ tabId, color: '#fb7299' });
  } catch (err) {
    // ignore
  }
}

/* --------------------------------- 消息路由 -------------------------------- */

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || typeof msg !== 'object') return undefined;

  if (msg.type === 'ai-check') {
    checkBvids(msg.bvids)
      .then((payload) => sendResponse(payload))
      .catch((err) => sendResponse({ error: String(err) }));
    return true;
  }

  if (msg.type === 'ai-badge') {
    updateBadge(sender && sender.tab ? sender.tab.id : undefined, Number(msg.count) || 0);
    return undefined;
  }

  return undefined;
});

// 页面刷新时清掉旧角标
chrome.tabs.onUpdated.addListener((tabId, info) => {
  if (info && info.status === 'loading') updateBadge(tabId, 0);
});
