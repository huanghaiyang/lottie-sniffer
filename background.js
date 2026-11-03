/**
 * Lottie Sniffer —— Service Worker
 *
 * 负责：
 *  1. 接收内容脚本上报的 Lottie 资产，去重后按标签页登记；
 *  2. 元数据持久化到 chrome.storage.session（SW 休眠后仍可恢复列表）；
 *  3. 动画正文持久化到 chrome.storage.local（大文件多，需 unlimitedStorage）；
 *  4. 处理「按 URL 抓取」提示（DOM 扫描发现但页面自身没请求过的地址，可绕过 CORS）；
 *  5. 下载单个 / 批量下载（自行打包为 ZIP，不需要额外依赖）；
 *     下载方式可选「JSON」（.lottie 会先解包成动画 JSON）或「压缩包」（保留原始格式）；
 *  6. 维护标签页角标数量，页面切换 / 关闭时清理数据。
 */
import {
  extractAnimation,
  animationMeta,
  MAX_TEXT_BYTES,
  MAX_BINARY_BYTES
} from './shared/detect.js';
import { unzipDotLottie } from './shared/dotlottie.js';

/** 单个标签页最多保留的动画数量 */
const MAX_ASSETS_PER_TAB = 40;
/** 单个标签页保留的正文总字节上限 */
const MAX_BYTES_PER_TAB = 60 * 1024 * 1024;
/** 标签页销毁时使用的固定前缀 */
const TAB_KEY_PREFIX = 'tab:';
const BODY_KEY_PREFIX = 'b:';

/** tabId -> Asset[]（内存索引，与 storage.session 同步） */
const tabIndex = new Map();
/** id -> {text} | {base64}，正文的内存缓存 */
const bodies = new Map();
/** tabId -> Set<url>，避免同一个地址被重复抓取 */
const hinted = new Map();
/** tabId -> 页面标题缓存 */
const titleCache = new Map();

// ---------------------------------------------------------------- 存储工具

/** 首次使用时把 session 中的元数据恢复到内存 */
let loadPromise = null;
function ensureLoaded() {
  if (!loadPromise) {
    loadPromise = (async () => {
      try {
        const all = await chrome.storage.session.get(null);
        for (const [key, value] of Object.entries(all)) {
          if (key.startsWith(TAB_KEY_PREFIX) && Array.isArray(value)) {
            tabIndex.set(Number(key.slice(TAB_KEY_PREFIX.length)), value);
          }
        }
      } catch {
        /* 读取失败时从空索引开始 */
      }
    })();
  }
  return loadPromise;
}

/** 串行化元数据写入，避免并发读改写导致列表丢项 */
let writeChain = Promise.resolve();
function persistTab(tabId) {
  const key = TAB_KEY_PREFIX + tabId;
  const snapshot = tabIndex.get(tabId) || [];
  writeChain = writeChain
    .then(() => chrome.storage.session.set({ [key]: snapshot }))
    .catch(() => {});
  return writeChain;
}

async function putBody(id, body) {
  bodies.set(id, body);
  try {
    await chrome.storage.local.set({ [BODY_KEY_PREFIX + id]: body });
  } catch {
    /* 存储失败不应影响捕获流程，正文仍保留在内存中 */
  }
}

async function readBody(id) {
  if (bodies.has(id)) return bodies.get(id);
  try {
    const stored = await chrome.storage.local.get(BODY_KEY_PREFIX + id);
    const body = stored && stored[BODY_KEY_PREFIX + id];
    if (body) {
      bodies.set(id, body);
      return body;
    }
  } catch {
    /* 忽略 */
  }
  return null;
}

async function deleteBody(id) {
  bodies.delete(id);
  try {
    await chrome.storage.local.remove(BODY_KEY_PREFIX + id);
  } catch {
    /* 忽略 */
  }
}

// ---------------------------------------------------------------- 通用工具

/** 32 位 FNV-1a，用于生成稳定的短 ID */
function hash32(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(36);
}

/** 内容签名：首尾采样 + 长度，避免对大文件整体哈希 */
function contentSig(kind, body) {
  const text = body.text !== undefined ? body.text : body.base64;
  return kind + '_' + hash32(text.slice(0, 192) + '|' + text.length + '|' + text.slice(-192));
}

function bytesToBase64(bytes) {
  let binary = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

function base64ToBytes(base64) {
  const binary = atob(base64);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}

/** 文件名安全化 */
function sanitizeName(name) {
  return (name || '')
    .replace(/[\\/:*?"<>|\u0000-\u001f]+/g, '_')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^\.+/, '')
    .slice(0, 120);
}

const GENERIC_NAME_RE = /^(comp|composition|animation|anim|unnamed|untitled|main|scene|layer)\s*\d*$/i;
const HASH_NAME_RE = /^[0-9a-f]{10,}(-[0-9a-f]{2,})*$/i;

/** 判断名称是否「无信息量」（如 Comp 1、纯 UUID） */
function isGenericName(name) {
  const t = (name || '').trim();
  if (!t) return true;
  if (t.length > 80) return true;
  if (GENERIC_NAME_RE.test(t)) return true;
  if (HASH_NAME_RE.test(t)) return true;
  if (/^(assets?|static|media|cdn|files?)[-_]?\d*$/i.test(t)) return true;
  return false;
}

/** 从页面标题里去掉站点后缀 */
function cleanTitle(title) {
  return (title || '')
    .split(/\s+[|·]\s+/)[0]
    .replace(/\s*[-–]\s*LottieFiles.*$/i, '')
    .trim();
}

/** 综合 URL 文件名 / Lottie 的 nm 字段 / 页面标题，得出可读的动画名 */
function deriveName(payload, pageTitle) {
  const nm = (payload.nm || '').trim();
  if (nm && !isGenericName(nm)) return nm;

  let base = '';
  if (payload.url) {
    try {
      const u = new URL(payload.url);
      const seg = u.pathname.split('/').filter(Boolean).pop() || '';
      base = decodeURIComponent(seg).replace(/\.(json|lottie)$/i, '');
    } catch {
      base = '';
    }
  }
  if (base && !isGenericName(base)) return base;

  const title = cleanTitle(pageTitle);
  if (title && !isGenericName(title)) return title;

  return nm || 'animation';
}

/**
 * 上报类型 -> 扩展名 / MIME。
 *
 * 注意：`.lottie` 虽然本质是 ZIP，但下载时不能给 `application/zip`。
 * Chrome 会按 MIME 做文件类型判定，遇到不认识的 `.lottie` 扩展名时会把文件名改成 `.zip`；
 * 用 `application/octet-stream`（通用二进制）可以保留建议文件名里的 `.lottie` 后缀。
 */
function kindInfo(kind) {
  return kind === 'lottie'
    ? { ext: 'lottie', mime: 'application/octet-stream' }
    : { ext: 'json', mime: 'application/json' };
}

// ---------------------------------------------------------------- 资产登记

async function getPageTitle(tabId, senderTab) {
  if (senderTab && senderTab.title) return senderTab.title;
  if (titleCache.has(tabId)) return titleCache.get(tabId);
  try {
    const tab = await chrome.tabs.get(tabId);
    const title = (tab && tab.title) || '';
    titleCache.set(tabId, title);
    return title;
  } catch {
    return '';
  }
}

function notifyTab(tabId) {
  try {
    chrome.runtime.sendMessage({ type: 'ASSETS_UPDATED', tabId }).catch(() => {});
  } catch {
    /* 弹窗未打开时不会有接收者，忽略 */
  }
}

async function updateBadge(tabId) {
  const count = (tabIndex.get(tabId) || []).length;
  try {
    await chrome.action.setBadgeText({
      tabId,
      text: count === 0 ? '' : count > 99 ? '99+' : String(count)
    });
  } catch {
    /* 标签页可能已关闭 */
  }
}

/**
 * 把一条捕获结果登记为资产。
 *
 * @param {number} tabId
 * @param {number} frameId
 * @param {object} payload 探针上报的数据
 * @param {string} pageTitle
 */
async function addAsset(tabId, frameId, payload, pageTitle) {
  await ensureLoaded();

  const kind = payload.kind === 'lottie' ? 'lottie' : 'json';
  let body;
  let byteSize;

  if (kind === 'lottie') {
    if (typeof payload.base64 !== 'string' || !payload.base64) return false;
    if (payload.base64.length * 0.75 > MAX_BINARY_BYTES) return false;
    body = { base64: payload.base64 };
    byteSize = Number(payload.bytes) || Math.round(payload.base64.length * 0.75);
  } else {
    if (typeof payload.text !== 'string' || !payload.text) return false;
    if (payload.text.length > MAX_TEXT_BYTES) return false;
    body = { text: payload.text };
    byteSize = payload.text.length;
  }

  const id = contentSig(kind, body);
  const list = tabIndex.get(tabId) || [];

  // 同一动画可能被多个手段重复捕获，命中后只更新统计信息
  const existing = list.find((a) => a.id === id);
  if (existing) {
    existing.hits = (existing.hits || 1) + 1;
    existing.lastSeenAt = Date.now();
    if (!existing.url && payload.url) {
      existing.url = payload.url;
      try {
        existing.host = new URL(payload.url).host;
      } catch {
        /* 忽略 */
      }
    }
    persistTab(tabId);
    return true;
  }

  let host = '';
  try {
    if (payload.url) host = new URL(payload.url).host;
  } catch {
    /* 忽略 */
  }

  // 探针上报的已经是提取后的动画元数据，这里做一次类型收敛即可
  const meta = {
    nm: typeof payload.nm === 'string' ? payload.nm : '',
    w: Number(payload.w) || 0,
    h: Number(payload.h) || 0,
    fr: Number(payload.fr) || 0,
    ip: Number(payload.ip) || 0,
    op: Number(payload.op) || 0,
    layers: Number(payload.layers) || 0,
    v: typeof payload.v === 'string' ? payload.v : ''
  };

  const asset = {
    id,
    tabId,
    frameId,
    kind,
    name: deriveName(payload, pageTitle),
    url: payload.url || '',
    host,
    bytes: byteSize,
    source: payload.source || 'unknown',
    v: meta.v,
    w: meta.w,
    h: meta.h,
    fr: meta.fr,
    ip: meta.ip,
    op: meta.op,
    layers: meta.layers,
    createdAt: Date.now(),
    hits: 1
  };

  list.unshift(asset);
  tabIndex.set(tabId, list);

  await putBody(id, body);
  await persistTab(tabId);
  await enforceLimits(tabId);
  await updateBadge(tabId);

  notifyTab(tabId);
  return true;
}

/** 超出数量 / 体积上限时丢弃最早的资产（同时删除正文，避免占用空间） */
async function enforceLimits(tabId) {
  const list = tabIndex.get(tabId);
  if (!list) return;

  let total = list.reduce((sum, a) => sum + (a.bytes || 0), 0);
  const removed = [];

  while (
    (list.length > MAX_ASSETS_PER_TAB || total > MAX_BYTES_PER_TAB) &&
    list.length > 1
  ) {
    const old = list.pop();
    if (!old) break;
    total -= old.bytes || 0;
    removed.push(old.id);
  }

  if (removed.length) {
    tabIndex.set(tabId, list);
    for (const id of removed) await deleteBody(id);
    await persistTab(tabId);
    notifyTab(tabId);
  }
}

/** 清空某个标签页的所有数据 */
async function clearTab(tabId) {
  await ensureLoaded();
  const list = tabIndex.get(tabId) || [];
  for (const asset of list) await deleteBody(asset.id);
  tabIndex.delete(tabId);
  hinted.delete(tabId);
  titleCache.delete(tabId);

  try {
    await chrome.storage.session.remove(TAB_KEY_PREFIX + tabId);
  } catch {
    /* 忽略 */
  }
  await updateBadge(tabId);
  notifyTab(tabId);
}

async function findAsset(id) {
  await ensureLoaded();
  for (const list of tabIndex.values()) {
    const hit = list.find((a) => a.id === id);
    if (hit) return hit;
  }
  return null;
}

// ---------------------------------------------------------------- 网络兜底抓取

/** 打包下载 / 预览需要的正文；内存与本地存储都没有时按 URL 重新抓取 */
async function loadAssetBody(asset) {
  let body = await readBody(asset.id);
  if (body) return body;

  if (!asset.url || !/^https?:/i.test(asset.url)) return null;

  try {
    const res = await fetch(asset.url, { credentials: 'include' });
    if (!res.ok) return null;
    if (asset.kind === 'lottie') {
      const buf = await res.arrayBuffer();
      if (buf.byteLength > MAX_BINARY_BYTES) return null;
      body = { base64: bytesToBase64(new Uint8Array(buf)) };
    } else {
      const text = await res.text();
      const extracted = extractAnimation(text);
      body = { text: extracted ? extracted.text : text };
    }
    await putBody(asset.id, body);
    return body;
  } catch {
    return null;
  }
}

/** DOM 扫描给出的地址：用扩展权限直接抓取，天然绕过页面的 CORS 限制 */
async function handleUrlHint(sender, rawUrl) {
  const tabId = sender.tab && sender.tab.id;
  if (tabId === undefined || tabId === null || !rawUrl) return { ok: false };

  await ensureLoaded();
  let set = hinted.get(tabId);
  if (!set) {
    set = new Set();
    hinted.set(tabId, set);
  }
  if (set.has(rawUrl)) return { ok: true, skipped: true };
  set.add(rawUrl);

  let url;
  try {
    url = new URL(rawUrl).href;
  } catch {
    return { ok: false };
  }
  if (!/^https?:/i.test(url)) return { ok: false };

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15000);

  try {
    const res = await fetch(url, { credentials: 'include', signal: controller.signal });
    if (!res.ok) return { ok: false };

    const ct = (res.headers.get('content-type') || '').toLowerCase();
    const isZip = /zip|octet-stream/.test(ct) || /\.lottie(?:$|[?#])/i.test(url);

    let payload = null;

    if (isZip) {
      const buf = await res.arrayBuffer();
      if (buf.byteLength === 0 || buf.byteLength > MAX_BINARY_BYTES) return { ok: false };
      const bytes = new Uint8Array(buf);
      if (!(bytes[0] === 0x50 && bytes[1] === 0x4b)) return { ok: false };
      payload = {
        kind: 'lottie',
        url,
        base64: bytesToBase64(bytes),
        bytes: bytes.length,
        source: 'dom'
      };
    } else {
      const text = await res.text();
      if (text.length > MAX_TEXT_BYTES) return { ok: false };
      const extracted = extractAnimation(text);
      if (!extracted) return { ok: false };
      payload = {
        kind: 'json',
        url,
        text: extracted.text,
        bytes: extracted.text.length,
        source: 'dom',
        ...animationMeta(extracted.anim)
      };
    }

    const title = await getPageTitle(tabId, sender.tab);
    await addAsset(tabId, sender.frameId || 0, payload, title);
    return { ok: true };
  } catch {
    return { ok: false };
  } finally {
    clearTimeout(timer);
  }
}

// ---------------------------------------------------------------- 下载

function downloadUrl(options) {
  return new Promise((resolve, reject) => {
    chrome.downloads.download(options, (downloadId) => {
      const err = chrome.runtime.lastError;
      if (err) reject(new Error(err.message));
      else resolve(downloadId);
    });
  });
}

/** 把资产正文编码成字节 */
function encodeBody(asset, body) {
  if (!body) return null;
  if (typeof body.text === 'string') return new TextEncoder().encode(body.text);
  if (typeof body.base64 === 'string') return base64ToBytes(body.base64);
  return null;
}

/** 下载方式：json = 解包后的动画 JSON；zip = 保留原始格式（.lottie / .json） */
function normalizeFormat(format) {
  return format === 'json' ? 'json' : 'zip';
}

/** 生成唯一的文件名（同名时追加序号） */
function uniqueFilename(asset, ext, used) {
  const base = sanitizeName(asset.name) || 'animation';
  let name = `${base}.${ext}`;
  let i = 2;
  while (used.has(name)) {
    name = `${base} (${i}).${ext}`;
    i += 1;
  }
  used.add(name);
  return name;
}

/**
 * 按指定下载方式把一个资产转换成待写盘的文件。
 *
 * - json：优先直接使用已捕获的 JSON 文本；`.lottie` 包则解压取出里面的动画 JSON，
 *   统一以 `.json` 命名，方便直接拖进设计/开发工具。
 * - zip：保留原始格式，`.lottie` 下发给 `.lottie`，JSON 下发给 `.json`。
 *
 * @returns {Promise<{name: string, bytes: Uint8Array, mime: string}|null>}
 */
async function assetToFile(asset, body, format, used) {
  if (format === 'json') {
    let text = null;
    if (typeof body.text === 'string') {
      text = body.text;
    } else if (typeof body.base64 === 'string') {
      try {
        text = (await unzipDotLottie(body.base64)).text;
      } catch {
        // 损坏的 .lottie 包：跳过该文件，不影响其余动画下载
        return null;
      }
    }
    if (!text) return null;
    return {
      name: uniqueFilename(asset, 'json', used),
      bytes: new TextEncoder().encode(text),
      mime: 'application/json'
    };
  }

  const bytes = encodeBody(asset, body);
  if (!bytes) return null;
  const info = kindInfo(asset.kind);
  return {
    name: uniqueFilename(asset, info.ext, used),
    bytes,
    mime: info.mime
  };
}

/** 读取一批资产并按下载方式生成文件列表（正文缺失 / 解包失败的条目会被跳过） */
async function collectFiles(ids, format) {
  const used = new Set();
  const files = [];

  for (const id of ids) {
    const asset = await findAsset(id);
    if (!asset) continue;
    const body = await loadAssetBody(asset);
    if (!body) continue;
    const file = await assetToFile(asset, body, format, used);
    if (file) files.push(file);
  }

  return files;
}

async function downloadAssets(ids, format) {
  const files = await collectFiles(ids, format);
  let count = 0;

  for (const file of files) {
    try {
      await downloadUrl({
        url: `data:${file.mime};base64,${bytesToBase64(file.bytes)}`,
        filename: file.name,
        saveAs: false,
        conflictAction: 'uniquify'
      });
      count += 1;
    } catch {
      /* 单个失败不影响其余文件 */
    }
  }

  return { ok: count > 0, count };
}

/**
 * 极简 ZIP 打包器（仅存储模式，不压缩）。
 *
 * .lottie 本身已是 ZIP，二次压缩收益极低；Lottie JSON 体积也不大，
 * 因此不做 deflate，直接用 store 方式拼装，避免引入第三方库。
 */
function buildZip(files) {
  const encoder = new TextEncoder();
  const localParts = [];
  const centralParts = [];
  let offset = 0;

  const now = new Date();
  const dosTime = ((now.getHours() << 11) | (now.getMinutes() << 5) | Math.floor(now.getSeconds() / 2)) & 0xffff;
  const dosDate = (((now.getFullYear() - 1980) << 9) | ((now.getMonth() + 1) << 5) | now.getDate()) & 0xffff;

  for (const file of files) {
    const nameBytes = encoder.encode(file.name);
    const data = file.bytes;
    const crc = crc32(data);

    // 本地文件头
    const local = new Uint8Array(30 + nameBytes.length);
    const lv = new DataView(local.buffer);
    lv.setUint32(0, 0x04034b50, true);
    lv.setUint16(4, 20, true); // 解压所需版本
    lv.setUint16(6, 0x0800, true); // 通用标志位：UTF-8 文件名
    lv.setUint16(8, 0, true); // 压缩方式：store
    lv.setUint16(10, dosTime, true);
    lv.setUint16(12, dosDate, true);
    lv.setUint32(14, crc, true);
    lv.setUint32(18, data.length, true);
    lv.setUint32(22, data.length, true);
    lv.setUint16(26, nameBytes.length, true);
    lv.setUint16(28, 0, true);
    local.set(nameBytes, 30);

    // 中央目录项
    const central = new Uint8Array(46 + nameBytes.length);
    const cv = new DataView(central.buffer);
    cv.setUint32(0, 0x02014b50, true);
    cv.setUint16(4, 20, true);
    cv.setUint16(6, 20, true);
    cv.setUint16(8, 0x0800, true);
    cv.setUint16(10, 0, true);
    cv.setUint16(12, dosTime, true);
    cv.setUint16(14, dosDate, true);
    cv.setUint32(16, crc, true);
    cv.setUint32(20, data.length, true);
    cv.setUint32(24, data.length, true);
    cv.setUint16(28, nameBytes.length, true);
    cv.setUint16(30, 0, true);
    cv.setUint16(32, 0, true);
    cv.setUint16(34, 0, true);
    cv.setUint16(36, 0, true);
    cv.setUint32(38, 0, true);
    cv.setUint32(42, offset, true); // 对应本地文件头偏移
    central.set(nameBytes, 46);

    localParts.push(local, data);
    centralParts.push(central);
    offset += local.length + data.length;
  }

  const centralSize = centralParts.reduce((sum, part) => sum + part.length, 0);

  const eocd = new Uint8Array(22);
  const ev = new DataView(eocd.buffer);
  ev.setUint32(0, 0x06054b50, true);
  ev.setUint16(8, files.length, true);
  ev.setUint16(10, files.length, true);
  ev.setUint32(12, centralSize, true);
  ev.setUint32(16, offset, true);

  const total = offset + centralSize + eocd.length;
  const out = new Uint8Array(total);
  let cursor = 0;
  for (const part of localParts) {
    out.set(part, cursor);
    cursor += part.length;
  }
  for (const part of centralParts) {
    out.set(part, cursor);
    cursor += part.length;
  }
  out.set(eocd, cursor);
  return out;
}

/** 标准 CRC32 查表实现 */
let crcTable = null;
function crc32(bytes) {
  if (!crcTable) {
    crcTable = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) {
        c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      }
      crcTable[n] = c >>> 0;
    }
  }
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) {
    c = crcTable[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  }
  return (c ^ 0xffffffff) >>> 0;
}

async function downloadZip(ids, format) {
  const files = await collectFiles(ids, format);
  if (!files.length) return { ok: false, count: 0 };

  const zip = buildZip(files);
  const dataUrl = `data:application/zip;base64,${bytesToBase64(zip)}`;
  const stamp = new Date().toISOString().slice(0, 10);

  try {
    await downloadUrl({
      url: dataUrl,
      filename: `lottie-animations-${stamp}.zip`,
      saveAs: false,
      conflictAction: 'uniquify'
    });
    return { ok: true, count: files.length };
  } catch (error) {
    return { ok: false, count: 0, error: String(error && error.message) };
  }
}

// ---------------------------------------------------------------- 重新扫描

/**
 * 扩展安装 / 更新后，已打开的页面没有内容脚本。
 * 此时先 ping，失败则用 chrome.scripting 手动注入两个世界的脚本。
 */
async function ensureContentScript(tabId) {
  try {
    await chrome.tabs.sendMessage(tabId, { type: 'PING' });
    return true;
  } catch {
    /* 没有接收者，继续注入 */
  }

  try {
    await chrome.scripting.executeScript({ target: { tabId }, files: ['content.js'] });
    await chrome.scripting.executeScript({
      target: { tabId },
      files: ['inject.js'],
      world: 'MAIN'
    });
    await new Promise((resolve) => setTimeout(resolve, 60));
    return true;
  } catch {
    return false;
  }
}

async function rescan(tabId) {
  if (tabId === undefined || tabId === null) return { ok: false };
  const ready = await ensureContentScript(tabId);
  if (!ready) return { ok: false, error: 'unsupported' };

  try {
    await chrome.tabs.sendMessage(tabId, { type: 'SCAN' });
  } catch {
    return { ok: false, error: 'unsupported' };
  }
  return { ok: true };
}

// ---------------------------------------------------------------- 消息路由

async function handleMessage(message, sender) {
  switch (message.type) {
    case 'CAPTURE': {
      const tabId = sender.tab && sender.tab.id;
      if (tabId === undefined || tabId === null) return { ok: false };
      const title = await getPageTitle(tabId, sender.tab);
      await addAsset(tabId, sender.frameId || 0, message.payload || {}, title);
      return { ok: true };
    }

    case 'URL_HINT':
      return handleUrlHint(sender, message.url);

    case 'GET_TAB_ASSETS': {
      await ensureLoaded();
      return { ok: true, assets: tabIndex.get(message.tabId) || [] };
    }

    case 'GET_ASSET_BODY': {
      const asset = await findAsset(message.id);
      if (!asset) return { ok: false, error: 'not-found' };
      const body = await loadAssetBody(asset);
      if (!body) return { ok: false, error: 'body-missing' };
      return { ok: true, asset, body };
    }

    case 'DOWNLOAD':
      return downloadAssets(
        Array.isArray(message.ids) ? message.ids : [],
        normalizeFormat(message.format)
      );

    case 'DOWNLOAD_ZIP':
      return downloadZip(
        Array.isArray(message.ids) ? message.ids : [],
        normalizeFormat(message.format)
      );

    case 'CLEAR':
      await clearTab(message.tabId);
      return { ok: true };

    case 'RESCAN':
      return rescan(message.tabId);

    default:
      return { ok: false, error: 'unknown-message' };
  }
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message || typeof message !== 'object') return false;

  const task = handleMessage(message, sender);
  if (!task) return false;

  task
    .then((result) => sendResponse(result))
    .catch((error) => sendResponse({ ok: false, error: String((error && error.message) || error) }));

  // 返回 true 表示异步响应
  return true;
});

// ---------------------------------------------------------------- 生命周期

chrome.runtime.onInstalled.addListener(() => {
  try {
    chrome.action.setBadgeBackgroundColor({ color: '#6C63FF' });
  } catch {
    /* 忽略 */
  }
});

try {
  chrome.action.setBadgeBackgroundColor({ color: '#6C63FF' });
} catch {
  /* 忽略 */
}

// 页面开始加载（刷新 / 跳转 / 新导航）时清理该标签页的数据
chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (changeInfo.status !== 'loading') return;
  titleCache.delete(tabId);
  clearTab(tabId).catch(() => {});
});

chrome.tabs.onRemoved.addListener((tabId) => {
  clearTab(tabId).catch(() => {});
});

// 切换标签页时刷新角标
chrome.tabs.onActivated.addListener(({ tabId }) => {
  ensureLoaded()
    .then(() => updateBadge(tabId))
    .catch(() => {});
});
