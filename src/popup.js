/* B站 AI 内容屏蔽 —— 设置面板 + 屏蔽预览 / 放行 */
'use strict';

const DEFAULTS = {
  enabled: true,
  useApi: true,
  useDom: true,
  guess: false,
  markOnly: false,
  hideLive: true,
  hideHero: false,
  hideSideButtons: false,
  hideBanner: false,
  keywords: ''
};

const FIELDS = ['enabled', 'useApi', 'useDom', 'hideLive', 'hideBanner', 'hideHero', 'hideSideButtons', 'guess', 'markOnly'];
const $ = (id) => document.getElementById(id);

let listOpen = false; // 屏蔽列表默认收起，点「已屏蔽」展开
let items = [];
let hiddenCount = 0;

function setStatus(text) {
  $('status').textContent = text;
}

function renderStats(stats) {
  hiddenCount = stats && typeof stats.hidden === 'number' ? stats.hidden : 0;
  $('hiddenCount').textContent = hiddenCount;
  $('checkedCount').textContent = stats && typeof stats.checked === 'number' ? stats.checked : '0';
  $('totalCount').textContent = stats && typeof stats.total === 'number' ? stats.total : '0';
  applyVisibility();
}

async function getActiveTab() {
  const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
  return tabs && tabs[0] ? tabs[0] : null;
}

async function callTab(message) {
  const tab = await getActiveTab();
  if (!tab || !tab.id) throw new Error('no tab');
  return chrome.tabs.sendMessage(tab.id, message);
}

async function loadStats() {
  const tab = await getActiveTab();
  if (!tab || !tab.id) {
    setStatus('未找到当前标签页');
    return;
  }
  // 注意：没有 tabs 权限时 tab.url 是 undefined，不能靠 URL 判断页面类型，
  // 直接问内容脚本：回复了就说明是 B 站页面且插件已注入。
  try {
    const stats = await chrome.tabs.sendMessage(tab.id, { type: 'ai-stats' });
    if (!stats || typeof stats !== 'object') throw new Error('no response');
    renderStats(stats);
    if (stats.hidden > 0) setStatus(`已在该页面屏蔽 ${stats.hidden} 张卡片`);
    else if (stats.checked > 0) setStatus('本页已检查过，暂无需要屏蔽的卡片');
    else setStatus('已就绪，正在识别本页卡片…');
  } catch (err) {
    renderStats(null);
    setStatus('当前页面不是 B 站，或插件还没注入（刷新页面试试）');
  }
}

/* ------------------------------ 列表展开 / 收起 ----------------------------- */

function applyVisibility() {
  const show = listOpen && items.length > 0;
  $('preview').hidden = !show;
  $('listHint').hidden = !(hiddenCount > 0 && !listOpen);
  $('hiddenStat').classList.toggle('is-open', show);
}

async function toggleList(force) {
  const next = typeof force === 'boolean' ? force : !listOpen;
  if (next === listOpen) return;
  listOpen = next;
  if (listOpen) {
    if ($('settings').open) $('settings').open = false; // 展开列表时收起设置，弹窗不超高
    await loadList();
  }
  applyVisibility();
}

/* ------------------------------- 屏蔽预览列表 ------------------------------ */

function renderList(list) {
  items = Array.isArray(list) ? list : [];
  const ul = $('list');
  ul.textContent = '';

  for (const item of items) {
    const li = document.createElement('li');
    li.className = 'row';

    const img = document.createElement('img');
    img.alt = '';
    img.loading = 'lazy';
    if (item.cover) img.src = item.cover;
    else img.classList.add('noimg');

    const meta = document.createElement('div');
    meta.className = 'meta';

    const title = document.createElement('div');
    title.className = 't';
    title.textContent = item.title || '未命名';
    title.title = item.title || '';

    const sub = document.createElement('div');
    sub.className = 'a';
    sub.textContent = item.author || item.reason || '未知 UP 主';
    sub.title = item.reason || '';

    meta.append(title, sub);

    const acts = document.createElement('div');
    acts.className = 'acts';

    const allow = document.createElement('button');
    allow.type = 'button';
    allow.textContent = '放行';
    allow.title = '放行这张卡片（之后不再屏蔽）';
    allow.addEventListener('click', () => act({ type: 'ai-allow', key: item.key }));
    acts.append(allow);

    if (item.mid) {
      const allowUp = document.createElement('button');
      allowUp.type = 'button';
      allowUp.className = 'ghost';
      allowUp.textContent = 'UP主';
      allowUp.title = '放行该 UP 主的所有 AI 视频';
      allowUp.addEventListener('click', () => act({ type: 'ai-allow-mid', mid: item.mid }));
      acts.append(allowUp);
    }

    li.append(img, meta, acts);
    ul.append(li);
  }

  applyVisibility();
}

async function loadList() {
  try {
    const res = await callTab({ type: 'ai-hidden-list' });
    renderList(res && res.items);
  } catch (err) {
    renderList([]);
  }
}

async function act(message) {
  try {
    await callTab(message);
    await refreshAll();
  } catch (err) {
    setStatus('操作失败，刷新页面后重试');
  }
}

async function refreshAll() {
  await loadStats();
  if (listOpen) await loadList();
}

/* ---------------------------------- 设置 ---------------------------------- */

async function save(patch) {
  await chrome.storage.sync.set(patch);
  // 纯布局开关（大图推荐位 / 悬浮按钮）不影响判定结果，不用重扫
  const layoutOnly = Object.keys(patch).every((k) => k === 'hideHero' || k === 'hideSideButtons' || k === 'hideBanner');
  const tab = await getActiveTab();
  if (tab && tab.id) {
    if (!layoutOnly) {
      await chrome.tabs.sendMessage(tab.id, { type: 'ai-rescan' }).catch(() => {});
    }
    setTimeout(refreshAll, 400);
  }
}

async function init() {
  const stored = await chrome.storage.sync.get(DEFAULTS);
  for (const key of FIELDS) {
    $(key).checked = !!stored[key];
  }
  $('keywords').value = stored.keywords || '';

  for (const key of FIELDS) {
    $(key).addEventListener('change', () => save({ [key]: $(key).checked }));
  }

  let keywordTimer = 0;
  $('keywords').addEventListener('input', () => {
    clearTimeout(keywordTimer);
    keywordTimer = setTimeout(() => save({ keywords: $('keywords').value }), 500);
  });

  const stat = $('hiddenStat');
  stat.addEventListener('click', () => toggleList());
  stat.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      toggleList();
    }
  });

  $('settings').addEventListener('toggle', () => {
    if ($('settings').open && listOpen) {
      listOpen = false;
      applyVisibility();
    }
  });

  $('rescan').addEventListener('click', async () => {
    try {
      await callTab({ type: 'ai-rescan' });
      setTimeout(refreshAll, 500);
    } catch (err) {
      setStatus('当前页面不支持，刷新后再试');
    }
  });

  $('clearAllow').addEventListener('click', async () => {
    if (!window.confirm('清空所有放行记录？清空后这些卡片会重新被屏蔽。')) return;
    try {
      await callTab({ type: 'ai-clear-allow' });
      await refreshAll();
      setStatus('放行记录已清空');
    } catch (err) {
      setStatus('当前页面不是 B 站，或插件还没注入');
    }
  });

  await refreshAll();
}

void init();

