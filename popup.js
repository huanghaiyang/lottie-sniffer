/**
 * Lottie Sniffer —— Popup 界面逻辑
 *
 * 界面职责：
 *   - 拉取当前标签页捕获到的动画列表并展示（缩略图 / 元信息）；
 *   - 支持按类型筛选、单个下载、批量打包下载；
 *   - 下载方式可选「JSON」（解包后的动画 JSON）或「压缩包」（保留原始 .lottie / .json 格式）；
 *     .lottie 本身已是 ZIP 包，因此始终直接下载原文件，批量时也是逐个下载而不额外套 ZIP；
 *     仅当结果全为 JSON 且数量大于 1 时才打包成 ZIP。
 *   - 内置预览器：用 lottie-web 渲染，支持播放 / 暂停 / 拖动进度 / 变速 / 切换背景；
 *   - .lottie（dotLottie）是 ZIP 包，解包逻辑位于 shared/dotlottie.js，Popup 与后台共用。
 */
import { unzipDotLottie } from './shared/dotlottie.js';


// ---------------------------------------------------------------- 常量

/** 预览图标 */
const ICON_PLAY = '<path d="M8 5v14l11-7z"/>';
const ICON_PAUSE = '<path d="M6 5h4v14H6zM14 5h4v14h-4z"/>';

/** 迷你按钮图标 */
const SVG_PREVIEW =
  '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">' +
  '<path d="M2 12s3.6-6.5 10-6.5S22 12 22 12s-3.6 6.5-10 6.5S2 12 2 12z"/>' +
  '<circle cx="12" cy="12" r="2.6"/></svg>';

const SVG_DOWNLOAD =
  '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">' +
  '<path d="M12 4v11"/><path d="M7.5 10.5L12 15l4.5-4.5"/>' +
  '<path d="M5 18h14"/></svg>';

const SVG_EMPTY_ART =
  '<svg viewBox="0 0 64 64" width="72" height="72" fill="none">' +
  '<rect x="6" y="6" width="52" height="52" rx="16" stroke="#2c2c40" stroke-width="2" stroke-dasharray="5 6"/>' +
  '<path d="M22 44c0-14 20-10 20-24" stroke="url(#emptyGrad)" stroke-width="3.4" stroke-linecap="round"/>' +
  '<circle cx="22" cy="44" r="3.4" fill="#7c6bff"/>' +
  '<circle cx="42" cy="20" r="3.4" fill="#4ee0c8"/>' +
  '<defs><linearGradient id="emptyGrad" x1="22" y1="44" x2="42" y2="20">' +
  '<stop offset="0" stop-color="#7c6bff"/><stop offset="1" stop-color="#4ee0c8"/>' +
  '</linearGradient></defs></svg>';

// ---------------------------------------------------------------- 状态

const els = {
  site: document.getElementById('site'),
  count: document.getElementById('count'),
  rescan: document.getElementById('btn-rescan'),
  clear: document.getElementById('btn-clear'),
  filters: document.getElementById('filters'),
  list: document.getElementById('list'),
  footer: document.getElementById('footer'),
  summary: document.getElementById('summary'),
  fmtSwitch: document.getElementById('fmt-switch'),
  zip: document.getElementById('btn-zip'),
  preview: document.getElementById('preview'),
  pvName: document.getElementById('pv-name'),
  pvMeta: document.getElementById('pv-meta'),
  pvClose: document.getElementById('pv-close'),
  pvStage: document.getElementById('pv-stage'),
  pvCanvas: document.getElementById('pv-canvas'),
  pvLoading: document.getElementById('pv-loading'),
  pvError: document.getElementById('pv-error'),
  pvPlay: document.getElementById('pv-play'),
  pvPlayIcon: document.getElementById('pv-play-icon'),
  pvRestart: document.getElementById('pv-restart'),
  pvSeek: document.getElementById('pv-seek'),
  pvTime: document.getElementById('pv-time'),
  pvSpeed: document.getElementById('pv-speed'),
  pvCopy: document.getElementById('pv-copy'),
  pvDownload: document.getElementById('pv-download'),
  toast: document.getElementById('toast')
};

const state = {
  tabId: null,
  tabUrl: '',
  supported: true,
  assets: [],
  filter: 'all',
  /** 下载方式：json = 解包后的 JSON；zip = 原始文件（多个时打包 ZIP） */
  downloadFormat: 'zip',
  thumbAnims: [],
  previewAsset: null,
  previewAnim: null,
  previewText: '',
  previewToken: 0
};

/** 下载方式的本地持久化键（localStorage 在弹窗之间共享） */
const FORMAT_KEY = 'lottie-sniffer.format';

/** id -> { json, text }，避免反复向后台请求正文 */
const jsonCache = new Map();

let refreshTimer = null;
let toastTimer = null;

// ---------------------------------------------------------------- 工具函数

function escapeHtml(value) {
  return String(value == null ? '' : value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function formatBytes(bytes) {
  const n = Number(bytes) || 0;
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

function formatDuration(asset) {
  if (!asset.fr || !(asset.op > asset.ip)) return '';
  return `${((asset.op - asset.ip) / asset.fr).toFixed(1)}s`;
}

/** 卡片第二行的紧凑元信息 */
function compactMeta(asset) {
  const parts = [formatBytes(asset.bytes)];
  if (asset.w && asset.h) parts.push(`${asset.w}×${asset.h}`);
  if (asset.fr) parts.push(`${asset.fr}fps`);
  const duration = formatDuration(asset);
  if (duration) parts.push(duration);
  return parts.join(' · ');
}

/** 预览面板里的完整元信息 */
function fullMeta(asset) {
  const parts = [asset.kind === 'lottie' ? 'dotLottie 包' : 'Lottie JSON', formatBytes(asset.bytes)];
  if (asset.w && asset.h) parts.push(`${asset.w}×${asset.h}`);
  if (asset.fr) parts.push(`${asset.fr} fps`);
  const duration = formatDuration(asset);
  if (duration) parts.push(`时长 ${duration}`);
  if (asset.layers) parts.push(`${asset.layers} 层`);
  if (asset.v) parts.push(`v${asset.v}`);
  return parts.join(' · ');
}

function toast(message, tone) {
  els.toast.hidden = false;
  els.toast.textContent = message;
  els.toast.style.borderColor = tone === 'error' ? 'rgba(255,107,129,0.5)' : '';
  els.toast.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    els.toast.classList.remove('show');
    setTimeout(() => {
      els.toast.hidden = true;
    }, 200);
  }, 1800);
}

/** 读取上次选择的下载方式，非法值回退到「压缩包」 */
function readFormat() {
  try {
    return localStorage.getItem(FORMAT_KEY) === 'json' ? 'json' : 'zip';
  } catch {
    return 'zip';
  }
}

function saveFormat(format) {
  try {
    localStorage.setItem(FORMAT_KEY, format);
  } catch {
    /* 隐私模式下写入可能失败，忽略即可 */
  }
}

/** 下载按钮文案随下载方式变化 */
function formatLabel(format) {
  return format === 'json' ? '下载 JSON' : '下载原文件';
}

async function sendBackground(message) {
  try {
    return await chrome.runtime.sendMessage(message);
  } catch (error) {
    return { ok: false, error: String((error && error.message) || error) };
  }
}

/** 判断当前页面是否可能运行内容脚本 */
function isSupportedPage(url) {
  if (!url) return true;
  if (/^(chrome|chrome-extension|edge|brave|about|devtools|view-source|moz-extension):/i.test(url)) return false;
  if (/^https?:\/\/(chromewebstore\.google\.com|chrome\.google\.com\/webstore)/i.test(url)) return false;
  return true;
}

// ---------------------------------------------------------------- 初始化

async function init() {
  state.downloadFormat = readFormat();
  try {
    const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
    const tab = tabs && tabs[0];
    state.tabId = tab && tab.id !== undefined ? tab.id : null;
    state.tabUrl = (tab && tab.url) || '';
  } catch {
    state.tabId = null;
  }

  renderSite();
  state.supported = isSupportedPage(state.tabUrl);

  if (!state.supported || state.tabId === null) {
    renderUnsupported();
    bindEvents();
    return;
  }

  bindEvents();
  await refreshAssets();

  chrome.runtime.onMessage.addListener((message) => {
    if (!message || typeof message !== 'object') return;
    if (message.type === 'ASSETS_UPDATED' && message.tabId === state.tabId) scheduleRefresh();
  });

  // 打开弹窗时静默扫描一次，补回「内联在 JS 里」「已经渲染出来」的动画
  requestScan(false);
}

function renderSite() {
  if (!state.tabUrl) {
    els.site.textContent = '当前标签页';
    return;
  }
  try {
    const u = new URL(state.tabUrl);
    const path = u.pathname === '/' ? '' : u.pathname;
    els.site.textContent = `${u.host}${path}`;
    els.site.title = state.tabUrl;
  } catch {
    els.site.textContent = state.tabUrl;
  }
}

// ---------------------------------------------------------------- 列表渲染

function scheduleRefresh() {
  clearTimeout(refreshTimer);
  refreshTimer = setTimeout(() => {
    refreshAssets().catch(() => {});
  }, 260);
}

async function refreshAssets() {
  if (state.tabId === null) return;
  const res = await sendBackground({ type: 'GET_TAB_ASSETS', tabId: state.tabId });
  state.assets = res && res.ok && Array.isArray(res.assets) ? res.assets : [];
  render();
}

function visibleAssets() {
  if (state.filter === 'json') return state.assets.filter((a) => a.kind === 'json');
  if (state.filter === 'lottie') return state.assets.filter((a) => a.kind === 'lottie');
  return state.assets;
}

function disposeThumbs() {
  for (const anim of state.thumbAnims) {
    try {
      anim.destroy();
    } catch {
      /* 忽略 */
    }
  }
  state.thumbAnims = [];
}

function render() {
  disposeThumbs();

  const scrollTop = els.list.scrollTop;
  els.list.innerHTML = '';

  const count = state.assets.length;
  els.count.hidden = count === 0;
  els.count.textContent = count > 99 ? '99+' : String(count);

  // 两种格式都存在时才显示筛选条
  const hasJson = state.assets.some((a) => a.kind === 'json');
  const hasDot = state.assets.some((a) => a.kind === 'lottie');
  els.filters.hidden = !(hasJson && hasDot);

  const visible = visibleAssets();
  if (visible.length === 0) {
    renderEmpty(count > 0);
  } else {
    for (const asset of visible) els.list.appendChild(createCard(asset));
  }

  renderFooter();
  els.list.scrollTop = scrollTop;
}

function renderEmpty(filteredEmpty) {
  const box = document.createElement('div');
  box.className = 'empty';

  if (filteredEmpty) {
    box.innerHTML =
      '<h3>当前筛选下没有动画</h3>' +
      '<p>切换到「全部」可以查看已捕获的其它格式。</p>' +
      '<button class="ghost-btn" id="empty-all">显示全部</button>';
    els.list.appendChild(box);
    const btn = box.querySelector('#empty-all');
    if (btn) {
      btn.addEventListener('click', () => {
        state.filter = 'all';
        syncFilterChips();
        render();
      });
    }
    return;
  }

  box.innerHTML = `
    <div class="empty-art">${SVG_EMPTY_ART}</div>
    <h3>还没有捕获到 Lottie 动画</h3>
    <p>在页面上播放动效，或点击「重新扫描」看看页面里已经存在的动画。</p>
    <p class="hint">刚刚安装插件？请先刷新当前页面再试。</p>
    <button class="primary-btn" id="empty-rescan">重新扫描</button>
  `;
  els.list.appendChild(box);

  const btn = box.querySelector('#empty-rescan');
  if (btn) btn.addEventListener('click', () => requestScan(true));
}

function renderUnsupported() {
  els.site.textContent = '当前页面不受支持';
  els.count.hidden = true;
  els.filters.hidden = true;
  els.footer.hidden = true;
  els.list.innerHTML = `
    <div class="empty">
      <div class="empty-art">${SVG_EMPTY_ART}</div>
      <h3>无法在这个页面运行</h3>
      <p>Chrome 不允许扩展在浏览器内部页面、扩展商店等位置注入脚本。</p>
      <p class="hint">请切换到普通的网页（http / https）后再打开插件。</p>
    </div>
  `;
}

/** 是否需要打包 ZIP：JSON 方式下多个动画打成 JSON 包；
 *  「压缩包」方式下只要含有 .lottie 就逐个直接下载原文件，不再套一层 ZIP。 */
function shouldZipBatch(visible) {
  if (visible.length <= 1) return false;
  if (state.downloadFormat === 'json') return true;
  return !visible.some((a) => a.kind === 'lottie');
}

function renderFooter() {
  const visible = visibleAssets();
  if (visible.length === 0) {
    els.footer.hidden = true;
    return;
  }
  els.footer.hidden = false;
  const totalBytes = visible.reduce((sum, a) => sum + (a.bytes || 0), 0);
  els.summary.textContent = `${visible.length} 个 · ${formatBytes(totalBytes)}`;

  syncFormatChips();

  if (state.downloadFormat === 'json') {
    els.zip.textContent = visible.length === 1 ? '下载 JSON' : '打包 JSON';
  } else if (shouldZipBatch(visible)) {
    els.zip.textContent = '打包 ZIP';
  } else {
    els.zip.textContent = '下载原文件';
  }
}

/** 同步底部「JSON / 压缩包」分段控件的选中态 */
function syncFormatChips() {
  for (const btn of els.fmtSwitch.querySelectorAll('.fmt-btn')) {
    btn.classList.toggle('active', btn.dataset.format === state.downloadFormat);
  }
}

/** 下载方式变化后，刷新列表卡片与预览面板里的下载提示 */
function updateDownloadLabels() {
  const label = formatLabel(state.downloadFormat);
  for (const btn of els.list.querySelectorAll('[data-act="download"]')) {
    btn.title = label;
  }
  els.pvDownload.textContent = label;
}

function syncFilterChips() {
  for (const chip of els.filters.querySelectorAll('.chip')) {
    chip.classList.toggle('active', chip.dataset.filter === state.filter);
  }
}

// ---------------------------------------------------------------- 卡片

function createCard(asset) {
  const card = document.createElement('article');
  card.className = 'card';
  card.dataset.id = asset.id;

  const kindLabel = asset.kind === 'lottie' ? '.lottie' : 'JSON';
  const host = asset.host || '页面内联';

  card.innerHTML = `
    <div class="thumb" data-act="preview">
      <span class="thumb-empty">载入中…</span>
    </div>
    <div class="card-main" data-act="preview">
      <div class="card-title">
        <span class="card-name" title="${escapeHtml(asset.name)}.${asset.kind === 'lottie' ? 'lottie' : 'json'}">${escapeHtml(asset.name)}</span>
        <span class="kind-tag ${asset.kind === 'lottie' ? 'kind-lottie' : 'kind-json'}">${kindLabel}</span>
      </div>
      <div class="card-sub">${escapeHtml(compactMeta(asset))}</div>
      <div class="card-sub dim" title="${escapeHtml(asset.url)}">${escapeHtml(host)}</div>
    </div>
    <div class="card-actions">
      <button class="mini-btn" data-act="preview" title="预览">${SVG_PREVIEW}</button>
      <button class="mini-btn primary" data-act="download" title="${formatLabel(state.downloadFormat)}">${SVG_DOWNLOAD}</button>
    </div>
  `;

  const thumb = card.querySelector('.thumb');
  card.addEventListener('click', (event) => {
    const act = event.target.closest('[data-act]');
    if (!act) return;
    if (act.dataset.act === 'download') {
      downloadAssets([asset.id], state.downloadFormat);
    } else {
      openPreview(asset);
    }
  });

  scheduleThumb(thumb, asset);
  return card;
}

/**
 * 缩略图懒加载：只渲染进入可视区域的卡片，避免一次性创建几十个 lottie 实例。
 */
function scheduleThumb(thumb, asset) {
  const loader = () => {
    renderThumb(thumb, asset);
  };

  if (typeof IntersectionObserver !== 'function') {
    loader();
    return;
  }

  const observer = new IntersectionObserver(
    (entries) => {
      if (entries.some((entry) => entry.isIntersecting)) {
        observer.disconnect();
        loader();
      }
    },
    { root: els.list, rootMargin: '120px' }
  );
  observer.observe(thumb);
}

async function renderThumb(thumb, asset) {
  if (!thumb.isConnected) return;
  try {
    const data = await getJson(asset);
    if (!thumb.isConnected || typeof lottie === 'undefined') return;

    thumb.innerHTML = '';
    const anim = lottie.loadAnimation({
      container: thumb,
      renderer: 'svg',
      loop: false,
      autoplay: false,
      animationData: data.json,
      rendererSettings: {
        preserveAspectRatio: 'xMidYMid meet',
        progressiveLoad: false
      }
    });
    anim.addEventListener('DOMLoaded', () => {
      try {
        anim.goToAndStop(0, true);
      } catch {
        /* 忽略 */
      }
    });
    state.thumbAnims.push(anim);
    thumb.classList.add('loaded');
  } catch {
    thumb.classList.add('failed');
    thumb.innerHTML = `<span class="thumb-empty">${asset.kind === 'lottie' ? '.lottie' : 'JSON'}<br>无法预览</span>`;
  }
}

// ---------------------------------------------------------------- 获取动画数据

async function getJson(asset) {
  const cached = jsonCache.get(asset.id);
  if (cached) return cached;

  const res = await sendBackground({ type: 'GET_ASSET_BODY', id: asset.id });
  if (!res || !res.ok || !res.body) throw new Error('无法读取动画数据');

  let json;
  let text;

  if (typeof res.body.text === 'string') {
    text = res.body.text;
    json = JSON.parse(text);
  } else if (typeof res.body.base64 === 'string') {
    const unzipped = await unzipDotLottie(res.body.base64);
    json = unzipped.json;
    text = unzipped.text;
  } else {
    throw new Error('动画数据为空');
  }

  const entry = { json, text };
  jsonCache.set(asset.id, entry);
  return entry;
}

// ---------------------------------------------------------------- .lottie 解包
// dotLottie 文件本质是 ZIP（内含 manifest.json + animations/<id>.json）。
// 解包实现统一放在 shared/dotlottie.js，后台按 JSON 格式下载时也会复用。

// ---------------------------------------------------------------- 预览

async function openPreview(asset) {
  state.previewToken += 1;
  const token = state.previewToken;

  state.previewAsset = asset;
  state.previewText = '';
  els.preview.hidden = false;
  els.pvName.textContent = `${asset.name}.${asset.kind === 'lottie' ? 'lottie' : 'json'}`;
  els.pvMeta.textContent = fullMeta(asset);
  els.pvDownload.textContent = formatLabel(state.downloadFormat);
  els.pvError.hidden = true;
  els.pvLoading.hidden = false;
  els.pvStage.className = 'pv-stage bg-checker';
  els.pvCanvas.innerHTML = '';
  els.pvSeek.value = '0';
  els.pvTime.textContent = '0.0s';
  els.pvSpeed.value = '1';
  syncBgButtons();
  destroyPreviewAnim();

  try {
    const data = await getJson(asset);
    if (token !== state.previewToken) return;
    state.previewText = data.text;
    els.pvLoading.hidden = true;
    mountPreview(data.json);
  } catch (error) {
    if (token !== state.previewToken) return;
    els.pvLoading.hidden = true;
    els.pvError.hidden = false;
    els.pvError.textContent = `无法预览：${(error && error.message) || '未知错误'}。仍可直接下载该文件。`;
  }
}

function mountPreview(json) {
  if (typeof lottie === 'undefined') {
    els.pvLoading.hidden = true;
    els.pvError.hidden = false;
    els.pvError.textContent = '预览组件未加载，请重新打开插件。';
    return;
  }

  const anim = lottie.loadAnimation({
    container: els.pvCanvas,
    renderer: 'svg',
    loop: true,
    autoplay: true,
    animationData: json,
    rendererSettings: {
      preserveAspectRatio: 'xMidYMid meet',
      progressiveLoad: false
    }
  });

  state.previewAnim = anim;
  anim.addEventListener('DOMLoaded', () => {
    if (state.previewAnim !== anim) return;
    const total = Math.max(1, Math.ceil(anim.totalFrames));
    els.pvSeek.max = String(total);
    updateTime(anim);
    updatePlayIcon();
  });
  anim.addEventListener('enterFrame', () => {
    if (state.previewAnim !== anim) return;
    updateTime(anim);
  });
}

function destroyPreviewAnim() {
  if (state.previewAnim) {
    try {
      state.previewAnim.destroy();
    } catch {
      /* 忽略 */
    }
    state.previewAnim = null;
  }
  els.pvCanvas.innerHTML = '';
}

function closePreview() {
  state.previewToken += 1;
  destroyPreviewAnim();
  state.previewAsset = null;
  els.preview.hidden = true;
}

function updateTime(anim) {
  const frameRate = anim.frameRate || 1;
  const total = Math.max(1, anim.totalFrames || 1);
  const current = Math.min(total, Math.max(0, anim.currentFrame || 0));
  els.pvSeek.value = String(Math.round(current));
  els.pvTime.textContent = `${(current / frameRate).toFixed(1)}s / ${(total / frameRate).toFixed(1)}s`;
}

function updatePlayIcon() {
  const playing = state.previewAnim && !state.previewAnim.isPaused;
  els.pvPlayIcon.innerHTML = playing ? ICON_PAUSE : ICON_PLAY;
}

function togglePlay() {
  const anim = state.previewAnim;
  if (!anim) return;
  if (anim.isPaused) anim.play();
  else anim.pause();
  updatePlayIcon();
}

function syncBgButtons() {
  const current = els.pvStage.className.replace(/^pv-stage\s*/, '') || 'bg-checker';
  for (const btn of document.querySelectorAll('.bg-btn')) {
    btn.classList.toggle('active', btn.dataset.bg === current);
  }
}

// ---------------------------------------------------------------- 交互绑定

function bindEvents() {
  els.rescan.addEventListener('click', () => requestScan(true));
  els.clear.addEventListener('click', async () => {
    if (state.tabId === null) return;
    await sendBackground({ type: 'CLEAR', tabId: state.tabId });
    jsonCache.clear();
    await refreshAssets();
    toast('已清空当前页面的捕获结果');
  });

  els.filters.addEventListener('click', (event) => {
    const chip = event.target.closest('.chip');
    if (!chip) return;
    state.filter = chip.dataset.filter || 'all';
    syncFilterChips();
    render();
  });

  els.fmtSwitch.addEventListener('click', (event) => {
    const btn = event.target.closest('.fmt-btn');
    if (!btn) return;
    const format = btn.dataset.format === 'json' ? 'json' : 'zip';
    if (format === state.downloadFormat) return;
    state.downloadFormat = format;
    saveFormat(format);
    renderFooter();
    updateDownloadLabels();
  });

  els.zip.addEventListener('click', () => {
    const visible = visibleAssets();
    const ids = visible.map((a) => a.id);
    if (ids.length === 0) return;
    if (shouldZipBatch(visible)) downloadZip(ids, state.downloadFormat);
    else downloadAssets(ids, state.downloadFormat);
  });

  els.pvClose.addEventListener('click', closePreview);
  els.pvPlay.addEventListener('click', togglePlay);
  els.pvRestart.addEventListener('click', () => {
    const anim = state.previewAnim;
    if (!anim) return;
    anim.goToAndPlay(0, true);
    updatePlayIcon();
  });

  els.pvSeek.addEventListener('input', () => {
    const anim = state.previewAnim;
    if (!anim) return;
    anim.pause();
    anim.goToAndStop(Number(els.pvSeek.value), true);
    updateTime(anim);
    updatePlayIcon();
  });

  els.pvSpeed.addEventListener('change', () => {
    const anim = state.previewAnim;
    if (!anim) return;
    anim.setSpeed(parseFloat(els.pvSpeed.value) || 1);
  });

  document.getElementById('bg-switch').addEventListener('click', (event) => {
    const btn = event.target.closest('.bg-btn');
    if (!btn) return;
    els.pvStage.className = `pv-stage ${btn.dataset.bg}`;
    syncBgButtons();
  });

  els.pvDownload.addEventListener('click', () => {
    if (!state.previewAsset) return;
    downloadAssets([state.previewAsset.id], state.downloadFormat);
  });

  els.pvCopy.addEventListener('click', async () => {
    if (!state.previewText) {
      toast('动画数据还没准备好');
      return;
    }
    const ok = await copyText(state.previewText);
    toast(ok ? 'JSON 已复制到剪贴板' : '复制失败，请重试', ok ? '' : 'error');
  });

  document.addEventListener('keydown', (event) => {
    if (els.preview.hidden) return;
    if (event.key === 'Escape') {
      closePreview();
    } else if (event.code === 'Space') {
      const tag = event.target && event.target.tagName;
      if (tag === 'SELECT' || tag === 'INPUT' || tag === 'BUTTON') return;
      event.preventDefault();
      togglePlay();
    }
  });
}

async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    // 剪贴板 API 在极少数情况下不可用，退回 textarea 方案
    try {
      const area = document.createElement('textarea');
      area.value = text;
      area.style.position = 'fixed';
      area.style.opacity = '0';
      document.body.appendChild(area);
      area.select();
      const ok = document.execCommand('copy');
      document.body.removeChild(area);
      return ok;
    } catch {
      return false;
    }
  }
}

// ---------------------------------------------------------------- 扫描 / 下载

async function requestScan(showFeedback) {
  if (state.tabId === null || !state.supported) return;

  els.rescan.classList.add('spin');
  const res = await sendBackground({ type: 'RESCAN', tabId: state.tabId });

  // 探针扫描后会异步上报，稍等再刷新列表
  setTimeout(async () => {
    els.rescan.classList.remove('spin');
    if (!res || !res.ok) {
      if (showFeedback) toast('该页面不支持扫描', 'error');
      return;
    }
    await refreshAssets();
    if (showFeedback && state.assets.length === 0) toast('扫描完成，暂未发现 Lottie');
  }, 520);
}

async function downloadAssets(ids, format) {
  const res = await sendBackground({ type: 'DOWNLOAD', ids, format });
  if (res && res.ok) {
    const what = format === 'json' ? 'JSON' : '文件';
    toast(`已开始下载 ${res.count} 个${what}`);
  } else {
    toast('下载失败，请重试', 'error');
  }
}

async function downloadZip(ids, format) {
  const res = await sendBackground({ type: 'DOWNLOAD_ZIP', ids, format });
  if (res && res.ok) {
    const what = format === 'json' ? ' JSON 文件' : '动画';
    toast(`已打包 ${res.count} 个${what}`);
  } else {
    toast('打包下载失败，请重试', 'error');
  }
}

// ---------------------------------------------------------------- 启动

init().catch(() => {
  renderUnsupported();
});
