/*
 * B站 AI 内容屏蔽 —— 内容脚本
 *
 * 识别思路（三路，按可靠性排序）：
 *   1. API 判定：把卡片里的 BV 号交给后台，读 B 站官方的「内容声明」字段。
 *      这是最准的一路 —— 视频页上那句「含AI生成内容」就是这条数据渲染出来的。
 *   2. DOM 判定：卡片里如果直接出现 AI 角标 / 声明文字（argue 组件之类），立即隐藏。
 *   3. 关键词猜测（默认关闭）：标题、UP 主名里出现 AI 工具名就隐藏，容易误伤。
 *
 * 识别到之后，隐藏的是整张卡片所在的「格位」（.feed-card 等），
 * 这样首页网格会自动补位，不会留下空洞。
 */
(() => {
  'use strict';
  if (window.__bbaiLoaded) return;
  window.__bbaiLoaded = true;

  /* ------------------------------- 常量与配置 ------------------------------- */

  const CLS_HIDDEN = 'bbai-hidden';
  const CLS_MARKED = 'bbai-marked';
  const CLS_SKELETON = 'bbai-skeleton-hidden';
  const CLS_ANCHOR = 'bbai-anchor-collapsed';
  const ATTR_REASON = 'data-bbai-reason';

  // 需要检查的卡片根节点
  const CARD_SEL = [
    '.bili-video-card', // 首页 / 搜索 / 视频页推荐的主卡片
    '.bili-video-card__wrap.__scale-wrap', // 竖屏 story 卡片
    '.video-page-card-small' // 视频页右侧小卡片
  ].join(',');

  // 首页信息流里的「楼层卡」：直播 / 番剧 / 课程
  const FLOOR_SEL = '.floor-single-card';

  // 卡片外面那层「格位」：隐藏它才能让网格补位
  const WRAPPERS = ['.feed-card', '.video-list-item', '.bili-feed-card', '.rank-item'];

  // 爬到这些容器就停手，避免把整行 / 整个网格藏掉
  const STOP_RE =
    /(^|\s)(container|bili-grid|bili-feed4|feed2|video-list|recommended-container_floor-aside|search-content|main|row|col_3)(\s|$)/;

  // AI 标注文案（B 站自己的声明文案是「含AI生成内容」）
  const AI_TEXT_RE =
    /(?:含|疑似|可能含)?\s*(?:AI|AIGC)\s*(?:生成|制作|合成|创作|辅助|改写|配音|绘画|视频|动画)|人工智能(?:生成|合成)/i;

  // 标题、UP 主、日期、简介里的文字不算角标，避免标题党误判
  const EXCLUDE_SEL =
    '.bili-video-card__info--tit, .bili-video-card__info--author, .bili-video-card__info--date, [class*="desc"], [class*="title"]';

  // 猜测模式的关键词表（默认关闭；开启后宁可错杀）
  // 说明见 README「标题关键词猜测的算法」：英文按词匹配、中文按子串匹配。
  const GUESS_KEYWORDS = [
    'AI生成',
    'AIGC',
    'AI绘画',
    'AI视频',
    'AI动画',
    'AI配音',
    'AI翻唱',
    'AI换脸',
    'AI创作',
    'AI MV',
    '数字人',
    '即梦',
    '可灵',
    '海螺',
    'Vidu',
    'Sora',
    'Veo',
    'Midjourney',
    'Stable Diffusion',
    'ComfyUI'
  ];

  const DEFAULTS = {
    enabled: true,
    useApi: true,
    useDom: true,
    guess: false,
    markOnly: false,
    hideLive: true,
    hideEsports: false,
    hideHero: false,
    hideSideButtons: false,
    hideBanner: false,
    keywords: ''
  };

  const API_BATCH = 12;
  const API_RETRY_MS = 20000;
  const API_COOLDOWN_MS = 60000;

  let cfg = { ...DEFAULTS };
  let extraKeywords = [];

  const state = {
    hidden: new Map(), // 被处理掉的格位 -> { reason, source, meta }
    skeletons: new Set(), // 被临时隐藏的「下一批骨架卡」占位
    anchors: new Set(), // 被压扁的「加载更多」占位
    allowKeys: new Set(), // 放行的卡片（BV 号 / 直播间号）
    allowMids: new Set(), // 放行的 UP 主（空间 mid）
    done: new WeakSet(), // 已经处理过的卡片
    doneFloor: new WeakSet(), // 已经处理过的楼层卡
    bvidOf: new WeakMap(),
    bvidCards: new Map(), // bvid -> Set<card>
    verdict: new Map(), // bvid -> { ai, msg }，本次页面的判定结果
    pending: new Set(),
    queued: new Set(),
    answered: new Set(),
    flushTimer: 0,
    scanTimer: 0,
    blockedUntil: 0,
    deferredTimer: 0,
    deferredRounds: 0,
    observer: null,
    mo: null
  };

  /* --------------------------------- 工具 ---------------------------------- */

  const norm = (s) => String(s || '').replace(/\s+/g, ' ').trim();

  const toText = (el) => norm(el ? el.textContent : '');

  function parseKeywords(raw) {
    if (Array.isArray(raw)) return raw.map(norm).filter(Boolean);
    return String(raw || '')
      .split(/[,，;；\n|]+/)
      .map(norm)
      .filter(Boolean);
  }

  function isAiText(text) {
    if (!text) return false;
    return AI_TEXT_RE.test(text);
  }

  function sameMembers(arr, set) {
    if (arr.length !== set.size) return false;
    for (const v of arr) if (!set.has(v)) return false;
    return true;
  }

  /* ------------------------------- 卡片识别 -------------------------------- */

  function findBvid(card) {
    const links = card.querySelectorAll('a[href*="/video/BV"]');
    for (const a of links) {
      const m = String(a.getAttribute('href') || '').match(/BV[0-9A-Za-z]{10}/);
      if (m) return m[0];
    }
    const attr = card.getAttribute('data-bvid') || '';
    const m2 = attr.match(/BV[0-9A-Za-z]{10}/);
    return m2 ? m2[0] : '';
  }

  function toAbsoluteUrl(url) {
    const u = String(url || '').trim();
    if (!u) return '';
    if (u.startsWith('//')) return 'https:' + u;
    return u;
  }

  /** 采集卡片信息：预览列表、放行白名单都要用 */
  function cardMeta(card) {
    const bvid = findBvid(card);
    const owner = card.querySelector('.bili-video-card__info--owner, a[href*="space.bilibili.com"]');
    let mid = '';
    if (owner) {
      const m = String(owner.getAttribute('href') || '').match(/space\.bilibili\.com\/(\d+)/);
      if (m) mid = m[1];
    }
    const liveLink = card.querySelector('a[href*="live.bilibili.com"]');
    const liveId = liveLink
      ? (String(liveLink.getAttribute('href') || '').match(/live\.bilibili\.com\/(\d+)/) || [])[1] || ''
      : '';
    const titleEl = card.querySelector('.bili-video-card__info--tit, .title, h3');
    const authorEl = card.querySelector('.bili-video-card__info--author, [class*="author"]');
    const img = card.querySelector('img');
    let titleText = toText(titleEl);
    // 直播卡的标题节点里混着「直播中」角标，去掉
    const liveBadge = titleEl ? titleEl.querySelector('.living, [class*="live-tag"], [class*="liveTag"]') : null;
    const badgeText = toText(liveBadge);
    if (badgeText) titleText = norm(titleText.replace(badgeText, ''));
    const key = bvid || (liveId ? 'live:' + liveId : 't:' + titleText.slice(0, 40));
    return {
      key,
      bvid,
      mid,
      liveId,
      title: titleText.slice(0, 90),
      author: toText(authorEl).slice(0, 40) || (liveId ? '直播' : ''),
      cover: img ? toAbsoluteUrl(img.currentSrc || img.getAttribute('src')) : ''
    };
  }

  function isAllowed(meta) {
    if (!meta) return false;
    if (meta.key && state.allowKeys.has(meta.key)) return true;
    if (meta.mid && state.allowMids.has(meta.mid)) return true;
    return false;
  }

  /** 卡片里直接画着 AI 角标 / 声明文字吗 */
  function domVerdict(card) {
    // 1) B 站原生的内容声明组件（视频页是 .argue-text，卡片以后也可能复用）
    const argue = card.querySelector('.argue-text, .argue-wrap, [class*="argue"]');
    if (argue) {
      const text = toText(argue);
      if (text && text.length <= 40 && isAiText(text)) return text;
    }

    // 2) 角标类短文本：只看叶子节点，且必须挂在 tag/badge/notice 一类样式上
    const nodes = card.querySelectorAll('span, em, i, b, p, div');
    for (const el of nodes) {
      if (el.children.length > 0) continue;
      const text = toText(el);
      if (!text || text.length > 20) continue;
      if (el.closest(EXCLUDE_SEL)) continue;
      const cls = typeof el.className === 'string' ? el.className : '';
      // 有些角标只画一个「AI」字样
      const isPlainAiBadge = /^(AI|ＡＩ)$/.test(text) && /ai[-_]?(tag|badge|label|mark)/i.test(cls);
      if (!isPlainAiBadge && !isAiText(text)) continue;
      if (!/argue|tag|badge|label|mark|notice|declare|tip|ai[-_]?/i.test(cls)) continue;
      return text;
    }
    return '';
  }

  /**
   * 猜测模式的文本归一化：全角字母数字转半角 → 转小写 → 空白折叠。
   * 这样「Ｓｏｒａ」「SORA」「sora」都归成 sora。
   */
  function normForGuess(text) {
    return String(text || '')
      .replace(/[\uFF01-\uFF5E]/g, (ch) => String.fromCharCode(ch.charCodeAt(0) - 0xfee0))
      .toLowerCase()
      .replace(/\s+/g, ' ')
      .trim();
  }

  /**
   * 英文/型号类关键词按「词」匹配：前后不能紧贴英文字母，
   * 但允许紧跟数字（veo3、sora2 这类型号写法）和中文（"sora生成"）。
   */
  function hitKeyword(blob, keyword) {
    const kw = normForGuess(keyword);
    if (!kw) return false;
    if (/^[\x20-\x7e]+$/.test(kw)) {
      const escaped = kw.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      return new RegExp(`(^|[^a-z])${escaped}([^a-z]|$)`).test(blob);
    }
    // 中文没有词边界，按子串匹配
    return blob.includes(kw);
  }

  /**
   * 关键词猜测：标题 + UP 主名，命中任一关键词即隐藏。
   * 只做「AI 工具名 / AI 生成字样」的粗筛，默认关闭，开了会误伤 AI 教程类内容。
   */
  function guessVerdict(card) {
    const title = toText(card.querySelector('.bili-video-card__info--tit, h3, [class*="video-name"]'));
    const author = toText(
      card.querySelector('.bili-video-card__info--author, [class*="author"], [class*="up-name"]')
    );
    const blob = normForGuess(title + ' ' + author);
    for (const kw of GUESS_KEYWORDS) {
      if (hitKeyword(blob, kw)) return kw;
    }
    return '';
  }

  /**
   * 用户自定义屏蔽关键词：标题 / UP 主名 / 楼层卡标题里包含即隐藏。
   * 归一化后按子串匹配（中文最常见），英文不区分大小写。
   */
  function keywordVerdict(el) {
    if (!extraKeywords.length) return '';
    const title = toText(el.querySelector('.bili-video-card__info--tit, h3, [class*="video-name"], .title'));
    const author = toText(
      el.querySelector('.bili-video-card__info--author, [class*="author"], [class*="up-name"], .sub-title')
    );
    const blob = normForGuess(title + ' ' + author);
    if (!blob) return '';
    for (const kw of extraKeywords) {
      const k = normForGuess(kw);
      if (k && blob.includes(k)) return kw;
    }
    return '';
  }

  /** 直播卡片：B 站的「直播中」角标 / .living 标记 / 直播房间链接 */
  function isLiveCard(el) {
    if (el.querySelector('.living, [class*="live-tag"], [class*="liveTag"]')) return true;
    if (el.querySelector('a[href*="live.bilibili.com"], a[href*="/live/"]')) return true;
    return /直播中/.test(toText(el));
  }

  /** 赛事卡片：楼层卡左上角的「赛事」角标（电竞赛事 / 体育赛事都算） */
  function isEsportsCard(el) {
    const badge = el.querySelector('.floor-title, .badge');
    return !!badge && /赛事/.test(toText(badge));
  }

  /* ------------------------------- 隐藏与还原 ------------------------------ */

  function pickTarget(card) {
    for (const sel of WRAPPERS) {
      const wrapper = card.closest(sel);
      if (wrapper) return wrapper;
    }
    // 没有已知包裹层时，向上找到「独占一个格子」的那层
    let node = card;
    let parent = node.parentElement;
    for (let i = 0; i < 3 && parent; i++) {
      if (parent.children.length !== 1) break;
      if (STOP_RE.test(String(parent.className || ''))) break;
      if (parent.tagName === 'MAIN' || parent.tagName === 'BODY') break;
      node = parent;
      parent = node.parentElement;
    }
    return node;
  }

  function hide(card, reason, source) {
    const meta = cardMeta(card);
    if (isAllowed(meta)) return false;
    const target = pickTarget(card);
    if (!target || state.hidden.has(target)) return false;
    target.classList.remove(CLS_HIDDEN, CLS_MARKED);
    target.classList.add(cfg.markOnly ? CLS_MARKED : CLS_HIDDEN);
    target.setAttribute(ATTR_REASON, reason);
    state.hidden.set(target, { reason, source, meta });
    pushBadge();
    return true;
  }

  /** 放行单张卡片：解除隐藏并记到白名单，之后不再屏蔽 */
  function releaseTarget(target) {
    target.classList.remove(CLS_HIDDEN, CLS_MARKED);
    target.removeAttribute(ATTR_REASON);
    state.hidden.delete(target);
  }

  async function persistAllow() {
    try {
      await chrome.storage.local.set({
        allowlist: { keys: [...state.allowKeys], mids: [...state.allowMids] }
      });
    } catch (err) {
      // 存储失败不影响本次会话的白名单
    }
  }

  async function loadAllow() {
    try {
      const stored = await chrome.storage.local.get('allowlist');
      const list = stored && stored.allowlist;
      if (!list) return;
      for (const key of list.keys || []) state.allowKeys.add(String(key));
      for (const mid of list.mids || []) state.allowMids.add(String(mid));
    } catch (err) {
      // ignore
    }
  }

  async function allowKey(key) {
    if (!key) return 0;
    state.allowKeys.add(key);
    await persistAllow();
    let released = 0;
    for (const [target, rec] of [...state.hidden]) {
      if (rec.meta && rec.meta.key === key) {
        releaseTarget(target);
        released++;
      }
    }
    if (released) pushBadge();
    return released;
  }

  async function allowMid(mid) {
    if (!mid) return 0;
    state.allowMids.add(mid);
    await persistAllow();
    let released = 0;
    for (const [target, rec] of [...state.hidden]) {
      if (rec.meta && rec.meta.mid === mid) {
        releaseTarget(target);
        released++;
      }
    }
    if (released) pushBadge();
    return released;
  }

  async function clearAllow() {
    state.allowKeys.clear();
    state.allowMids.clear();
    await persistAllow();
  }

  /** 供面板展示的「被屏蔽卡片」列表 */
  function listHidden() {
    const seen = new Set();
    const items = [];
    for (const [target, rec] of state.hidden) {
      if (!target.isConnected) continue;
      const meta = rec.meta || {};
      if (!meta.key || seen.has(meta.key)) continue;
      seen.add(meta.key);
      items.push({
        key: meta.key,
        bvid: meta.bvid || '',
        mid: meta.mid || '',
        title: meta.title || '未命名',
        author: meta.author || '',
        cover: meta.cover || '',
        reason: rec.reason || ''
      });
      if (items.length >= 40) break;
    }
    return items;
  }

  function unhideAll() {
    for (const target of state.hidden.keys()) {
      target.classList.remove(CLS_HIDDEN, CLS_MARKED);
      target.removeAttribute(ATTR_REASON);
    }
    state.hidden.clear();
    for (const el of state.skeletons) el.classList.remove(CLS_SKELETON);
    state.skeletons.clear();
    for (const el of state.anchors) el.classList.remove(CLS_ANCHOR);
    state.anchors.clear();
  }

  function pushBadge() {
    try {
      const ret = chrome.runtime.sendMessage({ type: 'ai-badge', count: state.hidden.size });
      if (ret && typeof ret.catch === 'function') ret.catch(() => {});
    } catch (err) {
      // 扩展被刷新后旧脚本会失联，忽略
    }
  }

  /* -------------------------------- 逐卡处理 ------------------------------- */

  function processCard(card) {
    if (state.done.has(card)) return;

    const bvid = state.bvidOf.get(card) || findBvid(card);
    if (bvid) state.bvidOf.set(card, bvid);

    // 已经放行的卡片（单条或整个 UP 主）不再判定
    if (isAllowed(cardMeta(card))) {
      state.done.add(card);
      return;
    }

    // 用户自定义关键词：优先级最高，命中就藏
    const custom = keywordVerdict(card);
    if (custom) {
      state.done.add(card);
      hide(card, '自定义关键词：' + custom, 'keyword');
      return;
    }

    if (cfg.hideLive && isLiveCard(card)) {
      state.done.add(card);
      hide(card, '直播卡片', 'live');
      return;
    }

    if (cfg.useDom) {
      const label = domVerdict(card);
      if (label) {
        state.done.add(card);
        hide(card, '页面标注：' + label, 'dom');
        return;
      }
    }

    if (cfg.guess) {
      const kw = guessVerdict(card);
      if (kw) {
        state.done.add(card);
        hide(card, '疑似 AI：' + kw, 'guess');
        return;
      }
    }

    if (!cfg.useApi) {
      state.done.add(card);
      return;
    }

    if (!bvid) {
      // 还没有 BV 号：可能是骨架屏（等下一轮扫描），也可能是直播 / 番剧卡
      if (card.querySelector('.bili-video-card__info--tit')) state.done.add(card);
      return;
    }

    // 同一个视频可能在页面里出现多次（推荐位 + 侧栏），直接用已拿到的判定结果
    const known = state.verdict.get(bvid);
    if (known) {
      state.done.add(card);
      if (known.ai) hide(card, 'B站标注：' + (known.msg || '含AI生成内容'), 'api');
      return;
    }

    if (!state.bvidCards.has(bvid)) state.bvidCards.set(bvid, new Set());
    state.bvidCards.get(bvid).add(card);
    state.done.add(card);
    observe(card, bvid);
  }

  /** 只对「快要进入视口」的卡片发请求，首页首屏十几张就够，省流量也不容易触发风控 */
  function observe(card, bvid) {
    if (state.blockedUntil > Date.now()) {
      // 正在风控冷却：等冷却结束重新扫一遍，别把这张卡漏掉
      scheduleDeferredScan();
      return;
    }
    if (typeof IntersectionObserver !== 'function') {
      queueApi(bvid);
      return;
    }
    if (!state.observer) {
      state.observer = new IntersectionObserver(
        (entries) => {
          for (const entry of entries) {
            if (!entry.isIntersecting) continue;
            state.observer.unobserve(entry.target);
            const bv = entry.target.__bbaiBvid;
            if (bv) queueApi(bv);
          }
        },
        { rootMargin: '500px 0px' }
      );
    }
    card.__bbaiBvid = bvid;
    state.observer.observe(card);
  }

  function queueApi(bvid) {
    if (!bvid || state.queued.has(bvid) || state.pending.has(bvid) || state.answered.has(bvid)) return;
    state.queued.add(bvid);
    state.pending.add(bvid);
    scheduleFlush(200);
  }

  function scheduleFlush(delay) {
    if (state.flushTimer) return;
    state.flushTimer = setTimeout(() => {
      state.flushTimer = 0;
      void flush();
    }, delay);
  }

  function hideBvid(bvid, msg) {
    const cards = state.bvidCards.get(bvid);
    if (!cards) return;
    for (const card of cards) {
      if (card.isConnected) hide(card, 'B站标注：' + (msg || '含AI生成内容'), 'api');
    }
  }

  async function flush() {
    if (state.pending.size === 0) return;
    if (state.blockedUntil > Date.now()) {
      // 冷却中：交给冷却结束后的重扫，不在这里空转
      scheduleDeferredScan();
      return;
    }
    const batch = [...state.pending].slice(0, API_BATCH);
    for (const bvid of batch) {
      state.pending.delete(bvid);
    }

    let res = null;
    try {
      res = await chrome.runtime.sendMessage({ type: 'ai-check', bvids: batch });
    } catch (err) {
      res = null; // 扩展上下文失效 / 后台没响应
    }

    if (!res || !res.results) {
      for (const bvid of batch) state.pending.add(bvid);
      scheduleFlush(API_RETRY_MS);
      return;
    }

    for (const [bvid, info] of Object.entries(res.results)) {
      state.queued.delete(bvid);
      state.answered.add(bvid);
      const verdict = { ai: !!(info && info.ai), msg: (info && info.msg) || '' };
      state.verdict.set(bvid, verdict);
      if (verdict.ai) hideBvid(bvid, verdict.msg);
    }

    if (Array.isArray(res.retry) && res.retry.length) {
      const now = Date.now();
      if (res.retry.length >= batch.length) state.blockedUntil = now + API_COOLDOWN_MS;
      for (const bvid of res.retry) {
        state.queued.delete(bvid);
        state.pending.add(bvid);
      }
      scheduleFlush(API_RETRY_MS);
      return;
    }

    if (state.pending.size) scheduleFlush(200);
  }

  /* --------------------------------- 扫描 ---------------------------------- */

  /** 「换一换」/ 路由切换后，旧节点已被移除，把它们的记账清掉 */
  function purgeDetached() {
    let changed = false;
    for (const target of [...state.hidden.keys()]) {
      if (!target.isConnected) {
        state.hidden.delete(target);
        changed = true;
      }
    }
    if (changed) pushBadge();
  }

  /** 楼层卡（直播 / 赛事 / 番剧 / 课程） */
  function scanFloors() {
    if (!cfg.hideLive && !cfg.hideEsports && !extraKeywords.length) return;
    for (const floor of document.querySelectorAll(FLOOR_SEL)) {
      if (state.doneFloor.has(floor)) continue;
      state.doneFloor.add(floor);
      const custom = keywordVerdict(floor);
      if (custom) {
        hide(floor, '自定义关键词：' + custom, 'keyword');
        continue;
      }
      if (cfg.hideEsports && isEsportsCard(floor)) {
        hide(floor, '赛事卡片', 'esports');
        continue;
      }
      if (cfg.hideLive && isLiveCard(floor)) hide(floor, '直播卡片', 'live');
    }
  }

  /**
   * B 站会在信息流末尾预置一批「骨架卡」占位，滚动到底时才换成真实卡片。
   * 我们隐藏 AI 卡片后整页变短，这些灰色占位会被顶进视口，看起来像布局坏了。
   * 这里把「没有数据、只有骨架」的占位卡一并藏起来；滚动时 B 站照常加载下一批。
   */
  function hideSkeletonCells() {
    const container = document.querySelector('.container.is-version8');
    if (!container) return;
    for (const el of container.children) {
      if (el.classList.contains(CLS_SKELETON)) continue;
      if (!el.matches('.bili-video-card, .floor-single-card')) continue;
      if (el.classList.contains('load-more-anchor')) continue;
      if (el.classList.contains(CLS_HIDDEN) || el.classList.contains(CLS_MARKED)) continue;
      if (!el.querySelector('.bili-video-card__skeleton, .floor-skeleton, .skeleton-item')) continue;
      if (el.querySelector('.bili-video-card__info--tit, .title, a[href*="/video/"], a[href*="/live/"]')) continue;
      el.classList.add(CLS_SKELETON);
      state.skeletons.add(el);
    }
  }

  /**
   * 末尾的 .load-more-anchor 里也放着一张骨架楼层卡，会显示成灰块。
   * 直接 display:none 可能影响滚动加载，这里压成 1px 高、视觉隐藏，保留触发能力。
   */
  function collapseLoadAnchor() {
    const anchor = document.querySelector('.load-more-anchor');
    if (!anchor) return;
    anchor.classList.add(CLS_ANCHOR);
    state.anchors.add(anchor);
  }

  /** 占位卡如果被 B 站原地填充成真实卡片，要把隐藏解除，让它正常参与判定 */
  function releaseHydratedSkeletons() {
    for (const el of [...state.skeletons]) {
      if (!el.isConnected) {
        state.skeletons.delete(el);
        continue;
      }
      if (el.querySelector('.bili-video-card__info--tit, .title, a[href*="/video/"], a[href*="/live/"]')) {
        el.classList.remove(CLS_SKELETON);
        state.skeletons.delete(el);
      }
    }
  }

  function scan() {
    if (!cfg.enabled) return;
    purgeDetached();
    releaseHydratedSkeletons();
    const cards = document.querySelectorAll(CARD_SEL);
    for (const card of cards) processCard(card);
    scanFloors();
    hideSkeletonCells();
    collapseLoadAnchor();
  }

  /** 风控冷却结束后重扫一遍：保留已隐藏的卡片，只把没判定完的卡片重新排队 */
  function softRescan() {
    state.done = new WeakSet();
    state.doneFloor = new WeakSet();
    state.bvidOf = new WeakMap();
    state.bvidCards.clear();
    state.pending.clear();
    state.queued.clear();
    state.blockedUntil = 0;
    if (state.observer) {
      state.observer.disconnect();
      state.observer = null;
    }
    scan();
  }

  function scheduleDeferredScan() {
    if (state.deferredTimer || state.deferredRounds >= 5) return;
    state.deferredTimer = setTimeout(() => {
      state.deferredTimer = 0;
      state.deferredRounds++;
      softRescan();
    }, API_COOLDOWN_MS);
  }

  function refresh() {
    unhideAll();
    applyLayoutFlags();
    state.done = new WeakSet();
    state.doneFloor = new WeakSet();
    state.bvidOf = new WeakMap();
    state.bvidCards.clear();
    state.pending.clear();
    state.queued.clear();
    state.answered.clear();
    state.blockedUntil = 0;
    state.deferredRounds = 0;
    if (state.deferredTimer) {
      clearTimeout(state.deferredTimer);
      state.deferredTimer = 0;
    }
    if (state.flushTimer) {
      clearTimeout(state.flushTimer);
      state.flushTimer = 0;
    }
    if (state.observer) {
      state.observer.disconnect();
      state.observer = null;
    }
    if (cfg.enabled) scan();
    pushBadge();
  }

  /* -------------------------------- 布局开关 -------------------------------- */

  /**
   * 两个纯展示开关，只改 <html> 上的 class，由 content.css 接管：
   *  - hideHero：隐藏首页左侧 2×2 的大图推荐位
   *  - hideSideButtons：隐藏右侧「换一换 / 刷新」悬浮按钮
   * 默认都关闭；关闭时把 class 摘掉即可恢复，不会碰 B 站原有样式。
   */
  function applyLayoutFlags() {
    const root = document.documentElement;
    if (!root) return;
    root.classList.toggle('bbai-hide-hero', !!cfg.enabled && !!cfg.hideHero);
    root.classList.toggle('bbai-hide-side', !!cfg.enabled && !!cfg.hideSideButtons);
    root.classList.toggle('bbai-hide-banner', !!cfg.enabled && !!cfg.hideBanner);
  }

  /* -------------------------------- 初始化 --------------------------------- */

  function startObserver() {
    if (state.mo) return;
    state.mo = new MutationObserver(() => {
      if (state.scanTimer) return;
      state.scanTimer = setTimeout(() => {
        state.scanTimer = 0;
        scan();
      }, 300);
    });
    state.mo.observe(document.documentElement, { childList: true, subtree: true });
  }

  async function init() {
    try {
      const stored = await chrome.storage.sync.get(DEFAULTS);
      cfg = { ...DEFAULTS, ...(stored || {}) };
    } catch (err) {
      cfg = { ...DEFAULTS };
    }
    await loadAllow();
    extraKeywords = parseKeywords(cfg.keywords);
    applyLayoutFlags();
    startObserver();
    if (cfg.enabled) scan();

    chrome.storage.onChanged.addListener((changes, area) => {
      if (area === 'local' && changes.allowlist) {
        const list = changes.allowlist.newValue || {};
        const keys = (list.keys || []).map(String);
        const mids = (list.mids || []).map(String);
        if (sameMembers(keys, state.allowKeys) && sameMembers(mids, state.allowMids)) return;
        state.allowKeys = new Set(keys);
        state.allowMids = new Set(mids);
        refresh();
        return;
      }
      if (area !== 'sync') return;
      let layoutDirty = false;
      let needRefresh = false;
      for (const key of Object.keys(DEFAULTS)) {
        if (!(key in changes)) continue;
        cfg[key] = changes[key].newValue;
        if (key === 'hideHero' || key === 'hideSideButtons' || key === 'hideBanner') layoutDirty = true;
        else needRefresh = true;
      }
      if (layoutDirty) applyLayoutFlags();
      if (!needRefresh && !layoutDirty) return;
      if (needRefresh) {
        extraKeywords = parseKeywords(cfg.keywords);
        refresh();
      }
    });

    chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
      if (!msg || typeof msg !== 'object') return undefined;
      if (msg.type === 'ai-stats') {
        sendResponse({
          hidden: state.hidden.size,
          checked: state.answered.size,
          total: document.querySelectorAll(CARD_SEL).length
        });
        return undefined;
      }
      if (msg.type === 'ai-hidden-list') {
        sendResponse({ items: listHidden() });
        return undefined;
      }
      if (msg.type === 'ai-allow') {
        allowKey(String(msg.key || '')).then((released) => sendResponse({ ok: true, released }));
        return true;
      }
      if (msg.type === 'ai-allow-mid') {
        allowMid(String(msg.mid || '')).then((released) => sendResponse({ ok: true, released }));
        return true;
      }
      if (msg.type === 'ai-clear-allow') {
        clearAllow().then(() => {
          refresh();
          sendResponse({ ok: true, hidden: state.hidden.size });
        });
        return true;
      }
      if (msg.type === 'ai-rescan') {
        refresh();
        sendResponse({ ok: true, hidden: state.hidden.size });
        return undefined;
      }
      return undefined;
    });
  }

  void init();
})();


