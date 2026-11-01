/**
 * Lottie Sniffer —— MAIN world 探针
 *
 * 运行位置：页面主世界（world: "MAIN"），在 document_start 阶段执行，
 * 因此可以先于页面自身的脚本安装劫持钩子。
 *
 * 侦测手段（按可靠性排序）：
 *  1. 劫持 window.fetch，克隆响应体（不干扰页面自身的读取）后分析；
 *  2. 劫持 XMLHttpRequest，在 load 事件里读取 responseText / response；
 *  3. 轮询 window.lottie / window.bodymovin，劫持 loadAnimation，
 *     捕获「直接传入 animationData」的内联动画（这类动画从不发网络请求）；
 *  4. 响应 Popup 的「重新扫描」指令，扫描 lottie 实例、DOM 动画路径与性能时间线
 *     （Worker 内发起的 .json / .lottie 请求不会经过主线程钩子，只能从资源条目补救）。
 *
 * 与 Service Worker 的通信方式：
 *  MAIN world 无法直接调用 chrome.* API，因此通过 window.postMessage 把结果
 *  交给同页面的 ISOLATED world 内容脚本（content.js），再由它转发给 SW。
 *
 * 注意：本文件内联了 shared/detect.js 的识别逻辑（MAIN world 不支持 ES Module），
 *      改动识别规则时两处需同步。
 */
(() => {
  'use strict';

  const GUARD = '__lottieSnifferMain__';
  if (Object.prototype.hasOwnProperty.call(window, GUARD)) return;
  Object.defineProperty(window, GUARD, { value: true, enumerable: false, configurable: false });

  // ---------------------------------------------------------------- 常量

  /** JSON 文本上限（字符数） */
  const MAX_TEXT = 20 * 1024 * 1024;
  /** 二进制文件上限（字节） */
  const MAX_BINARY = 16 * 1024 * 1024;
  /** 消息通道标记：探针 -> 内容脚本 */
  const UP = '__ls_up__';
  /** 消息通道标记：内容脚本 -> 探针 */
  const DOWN = '__ls_down__';

  /** 已上报内容的签名集合，避免同一动画因多次请求 / 多次扫描被重复发送 */
  const reported = new Set();

  /** 已通过 URL 提示过的地址，避免重复请求 */
  const hintedUrls = new Set();

  // ---------------------------------------------------------------- 识别逻辑
  // 与 shared/detect.js 保持同步（MAIN world 无法 import）

  function quickCheck(text) {
    if (typeof text !== 'string') return false;
    if (text.length < 40 || text.length > MAX_TEXT) return false;
    if (text.indexOf('"layers"') === -1) return false;
    return text.indexOf('"fr"') !== -1 && text.indexOf('"op"') !== -1;
  }

  function isAnimation(obj) {
    return !!obj
      && typeof obj === 'object'
      && !Array.isArray(obj)
      && Array.isArray(obj.layers)
      && obj.layers.length > 0
      && typeof obj.fr === 'number'
      && typeof obj.ip === 'number'
      && typeof obj.op === 'number';
  }

  function findAnimation(root) {
    return walk(root, 0, { n: 4000 });
  }

  function walk(node, depth, budget) {
    if (budget.n-- <= 0 || depth > 4) return null;

    if (typeof node === 'string') {
      if (node.length > 64 && node.length <= MAX_TEXT && node.indexOf('"layers"') !== -1) {
        try {
          return walk(JSON.parse(node), depth + 1, budget);
        } catch {
          return null;
        }
      }
      return null;
    }

    if (!node || typeof node !== 'object') return null;
    if (isAnimation(node)) return node;

    if (Array.isArray(node)) {
      const max = Math.min(node.length, 8);
      for (let i = 0; i < max; i++) {
        const hit = walk(node[i], depth + 1, budget);
        if (hit) return hit;
      }
      return null;
    }

    const keys = Object.keys(node);
    const max = Math.min(keys.length, 60);
    for (let i = 0; i < max; i++) {
      const hit = walk(node[keys[i]], depth + 1, budget);
      if (hit) return hit;
    }
    return null;
  }

  function animationMeta(anim) {
    return {
      nm: typeof anim.nm === 'string' ? anim.nm : '',
      w: Number(anim.w) || 0,
      h: Number(anim.h) || 0,
      fr: Number(anim.fr) || 0,
      ip: Number(anim.ip) || 0,
      op: Number(anim.op) || 0,
      layers: Array.isArray(anim.layers) ? anim.layers.length : 0,
      v: typeof anim.v === 'string' ? anim.v : ''
    };
  }

  // ---------------------------------------------------------------- 工具

  /** 把可能是相对地址的 URL 解析为绝对地址 */
  function absolute(raw) {
    try {
      return new URL(String(raw), document.baseURI).href;
    } catch {
      return '';
    }
  }

  /** 生成用于去重的短签名：首尾各取一段 + 总长度，避免对整段大文本做哈希 */
  function signature(str) {
    let h = 0x811c9dc5;
    const sample = str.slice(0, 192) + '|' + str.length + '|' + str.slice(-192);
    for (let i = 0; i < sample.length; i++) {
      h ^= sample.charCodeAt(i);
      h = Math.imul(h, 0x01000193);
    }
    return (h >>> 0).toString(36);
  }

  /** 二进制转 base64（分块调用避免超出 fromCharCode 参数上限） */
  function bytesToBase64(bytes) {
    let binary = '';
    const chunk = 0x8000;
    for (let i = 0; i < bytes.length; i += chunk) {
      binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
    }
    return btoa(binary);
  }

  /** 把结果发给 ISOLATED world 的内容脚本 */
  function emit(payload) {
    try {
      window.postMessage({ [UP]: true, payload }, '*');
    } catch {
      /* 跨源 / 序列化失败时忽略 */
    }
  }

  /** 去重后上报 JSON 动画 */
  function reportText(text, url, source) {
    if (!quickCheck(text)) return false;
    let json;
    try {
      json = JSON.parse(text);
    } catch {
      return false;
    }
    const anim = findAnimation(json);
    if (!anim) return false;

    // 若动画被包裹在别的结构里，只提取动画本体，保证下载结果可直接使用
    const out = anim === json ? text : JSON.stringify(anim);
    if (out.length > MAX_TEXT) return false;

    const sig = 'j:' + signature(out);
    if (reported.has(sig)) return false;
    reported.add(sig);

    emit({
      kind: 'json',
      url: url || '',
      text: out,
      bytes: out.length,
      source,
      ...animationMeta(anim)
    });
    return true;
  }

  /** 去重后上报已解析对象中的动画（用于 lottie 实例 / XHR responseType=json） */
  function reportObject(obj, url, source) {
    if (!obj || typeof obj !== 'object') return false;
    const anim = findAnimation(obj);
    if (!anim) return false;

    // lottie-web 渲染时会给 shape 对象写入内部标记 "_render"，它不影响播放，
    // 但会让「同一动画」在渲染前后序列化出不同文本，因此统一剔除。
    const text = JSON.stringify(anim).replace(/,"_render":(true|false)/g, '');
    if (text.length > MAX_TEXT) return false;

    const sig = 'j:' + signature(text);
    if (reported.has(sig)) return false;
    reported.add(sig);

    emit({
      kind: 'json',
      url: url || '',
      text,
      bytes: text.length,
      source,
      ...animationMeta(anim)
    });
    return true;
  }

  /** 去重后上报 .lottie（zip 包） */
  function reportBinary(bytes, url, source) {
    if (!bytes || bytes.length === 0 || bytes.length > MAX_BINARY) return false;
    // zip 魔数校验：PK\x03\x04，用于排除误判的二进制响应
    if (!(bytes[0] === 0x50 && bytes[1] === 0x4b && bytes[2] === 0x03 && bytes[3] === 0x04)) return false;

    const base64 = bytesToBase64(bytes);
    const sig = 'b:' + signature(base64);
    if (reported.has(sig)) return false;
    reported.add(sig);

    emit({
      kind: 'lottie',
      url: url || '',
      base64,
      bytes: bytes.length,
      source
    });
    return true;
  }

  /** 把 URL 交给后台去抓取（用于 DOM 扫描发现、但页面自身没请求过的动画地址） */
  function hintUrl(raw) {
    const url = absolute(raw);
    if (!url || url.startsWith('data:')) return;
    if (!/\.(json|lottie)(?:$|[?#])|lottie|bodymovin/i.test(url)) return;
    if (hintedUrls.has(url)) return;
    hintedUrls.add(url);
    emit({ kind: 'hint', url, source: 'dom' });
  }

  // ---------------------------------------------------------------- 响应分析

  /** 明显的埋点 / 统计接口，直接跳过以减少开销 */
  const TRACK_RE = /\/\/(collect|track|beacon|log|metrics|stats|analytics|sentry|bugsnag)\b/i;
  /** URL 本身的 Lottie 特征 */
  const URL_HINT_RE = /\.(json|lottie)(?:$|[?#])|lottie|bodymovin/i;

  /**
   * 判断这个响应值不值得读取。策略：
   *  - URL 命中 Lottie 特征 => 一定读取；
   *  - Content-Type 是 JSON 且不是埋点接口 => 读取后做廉价预检
   *    （很多站点用 /api/animation?id=xx 这类不带扩展名的地址）
   */
  function shouldInspect(url, contentType) {
    const u = (url || '').toLowerCase();
    if (!u || u.startsWith('data:')) return false;
    if (URL_HINT_RE.test(u)) return true;
    const ct = (contentType || '').toLowerCase();
    if (ct.includes('json') && !TRACK_RE.test(u)) return true;
    return false;
  }

  /** 读取克隆响应的文本，超限返回 null */
  async function readText(res) {
    try {
      const text = await res.text();
      if (!text || text.length > MAX_TEXT) return null;
      return text;
    } catch {
      return null;
    }
  }

  /** 读取克隆响应的二进制，超限返回 null */
  async function readBytes(res) {
    try {
      const buf = await res.arrayBuffer();
      if (!buf || buf.byteLength === 0 || buf.byteLength > MAX_BINARY) return null;
      return new Uint8Array(buf);
    } catch {
      return null;
    }
  }

  async function inspectResponse(clone, url) {
    const ct = (clone.headers.get('content-type') || '').toLowerCase();
    const len = Number(clone.headers.get('content-length') || 0);
    if (len > MAX_TEXT) return;

    const isJsonLike = ct.includes('json') || /\.json(?:$|[?#])/i.test(url);
    const isZipLike = ct.includes('zip') || ct.includes('octet-stream') || /\.lottie(?:$|[?#])/i.test(url);

    if (isJsonLike) {
      const text = await readText(clone);
      if (text) reportText(text, url, 'fetch');
      return;
    }

    if (isZipLike) {
      const bytes = await readBytes(clone);
      if (bytes) reportBinary(bytes, url, 'fetch');
      return;
    }

    // 少数服务端以 text/plain 返回 lottie JSON
    const text = await readText(clone);
    if (text && quickCheck(text)) reportText(text, url, 'fetch');
  }

  // ---------------------------------------------------------------- fetch 劫持

  const nativeFetch = window.fetch;
  if (typeof nativeFetch === 'function') {
    window.fetch = function patchedFetch(input) {
      // 兼容 fetch(string | URL | Request)
      let url = '';
      try {
        if (typeof input === 'string') url = input;
        else if (input instanceof URL) url = input.href;
        else if (input && typeof input === 'object' && 'url' in input) url = input.url;
        url = absolute(url);
      } catch {
        url = '';
      }

      const promise = nativeFetch.apply(this, arguments);

      // 在页面自身拿到 Promise 之前先挂载 then，保证 Response 尚未被读取时可以 clone
      promise.then(
        (res) => {
          let clone = null;
          try {
            clone = res.clone();
          } catch {
            return; // 响应体已被读取 / 不可克隆（如 opaque），放弃
          }
          if (!clone) return;
          let ct = '';
          try {
            ct = res.headers.get('content-type') || '';
          } catch {
            /* 忽略 */
          }
          if (!shouldInspect(url, ct)) return;
          inspectResponse(clone, url).catch(() => {});
        },
        () => {}
      );

      return promise;
    };
  }

  // ---------------------------------------------------------------- XHR 劫持

  const XHRProto = window.XMLHttpRequest && window.XMLHttpRequest.prototype;
  if (XHRProto) {
    const nativeOpen = XHRProto.open;
    const nativeSend = XHRProto.send;

    XHRProto.open = function patchedOpen(method, url) {
      try {
        this.__lsUrl = absolute(url);
      } catch {
        this.__lsUrl = '';
      }
      return nativeOpen.apply(this, arguments);
    };

    XHRProto.send = function patchedSend() {
      this.addEventListener('load', function onXhrLoad() {
        inspectXhr(this);
      });
      return nativeSend.apply(this, arguments);
    };
  }

  async function inspectXhr(xhr) {
    const url = xhr.responseURL || xhr.__lsUrl || '';
    let ct = '';
    try {
      ct = xhr.getResponseHeader('content-type') || '';
    } catch {
      /* 忽略 */
    }
    if (!shouldInspect(url, ct)) return;

    const type = xhr.responseType || '';
    const isZipLike = /zip|octet-stream/i.test(ct) || /\.lottie(?:$|[?#])/i.test(url);

    if (isZipLike) {
      if (type === 'arraybuffer' && xhr.response) {
        const bytes = new Uint8Array(xhr.response);
        reportBinary(bytes, url, 'xhr');
      } else if (type === 'blob' && xhr.response) {
        readBlob(xhr.response, url);
      } else if (type === '') {
        const text = xhr.responseText;
        if (text && quickCheck(text)) reportText(text, url, 'xhr');
      }
      return;
    }

    if (type === '' || type === 'text') {
      reportText(xhr.responseText || '', url, 'xhr');
    } else if (type === 'json') {
      reportObject(xhr.response, url, 'xhr');
    } else if (type === 'arraybuffer' && xhr.response) {
      const bytes = new Uint8Array(xhr.response);
      reportBinary(bytes, url, 'xhr');
    } else if (type === 'blob' && xhr.response) {
      readBlob(xhr.response, url);
    }
  }

  function readBlob(blob, url) {
    try {
      const reader = new FileReader();
      reader.onload = () => {
        try {
          const buf = reader.result;
          if (buf && buf.byteLength <= MAX_BINARY) reportBinary(new Uint8Array(buf), url, 'xhr');
        } catch {
          /* 忽略 */
        }
      };
      reader.readAsArrayBuffer(blob);
    } catch {
      /* 忽略 */
    }
  }

  // ---------------------------------------------------------------- lottie 库劫持
  // 有些站点把动画 JSON 内联打包进 JS，再通过 lottie.loadAnimation({animationData}) 播放，
  // 这类动画不会产生任何网络请求，只能在库函数这一层捕获。

  function hookLottieLibrary(lib) {
    if (!lib || typeof lib !== 'object' || lib.__lsHooked) return;
    if (typeof lib.loadAnimation !== 'function') return;

    try {
      const nativeLoad = lib.loadAnimation.bind(lib);
      lib.loadAnimation = function patchedLoadAnimation(params) {
        let captured = false;
        try {
          if (params && typeof params === 'object') {
            if (params.animationData) {
              captured = reportObject(params.animationData, params.path || 'inline', 'lottie');
            } else if (typeof params.path === 'string') {
              hintUrl(params.path);
            }
          }
        } catch {
          /* 绝不影响页面自身逻辑 */
        }

        const item = nativeLoad.apply(lib, arguments);

        // 标记已上报的实例，扫描时就不再重复读取（此时 animationData 已被渲染流程改写）
        try {
          if (captured && item) item.__lsReported = true;
        } catch {
          /* 忽略 */
        }
        return item;
      };
      Object.defineProperty(lib, '__lsHooked', { value: true, enumerable: false });
    } catch {
      /* 库被冻结时忽略 */
    }
  }

  function tryHookLottie() {
    for (const key of ['lottie', 'bodymovin', 'lottie_light', 'Lottie']) {
      try {
        const lib = window[key];
        if (lib && typeof lib.loadAnimation === 'function') hookLottieLibrary(lib);
      } catch {
        /* 忽略 */
      }
    }
  }

  // 页面的 lottie 可能在任意时刻挂到 window 上，因此持续轮询（开销极小）
  tryHookLottie();
  setInterval(tryHookLottie, 500);

  // ---------------------------------------------------------------- 主动扫描

  /** 性能条目里只认扩展名明确的动画文件，避免把 JS/CSS 也拉一遍 */
  const PERF_ANIM_RE = /\.(json|lottie)(?:$|[?#])/i;

  /** 扫描已注册的 lottie 实例 + DOM，找回那些没走网络 / 没走 loadAnimation 钩子的动画 */
  function scanPage() {
    tryHookLottie();

    // 1) 已注册动画实例（lottie-web 会维护一个注册表）
    for (const key of ['lottie', 'bodymovin', 'lottie_light']) {
      try {
        const lib = window[key];
        if (!lib || typeof lib.getRegisteredAnimations !== 'function') continue;
        const list = lib.getRegisteredAnimations() || [];
        for (const item of list) {
          if (!item) continue;
          // 通过 loadAnimation 钩子已经上报过的实例无需重复处理
          if (item.__lsReported) continue;
          if (item.animationData) reportObject(item.animationData, item.path || 'inline', 'lottie');
          else if (typeof item.path === 'string') hintUrl(item.path);
        }
      } catch {
        /* 忽略 */
      }
    }

    // 2) DOM 中的 Lottie 播放器 / 数据属性 / 预加载链接
    const selectors = [
      'lottie-player',
      'dotlottie-player',
      'lottie-animation',
      '[data-animation-path]',
      '[data-lottie-src]',
      '[data-lottie]',
      '[data-animation]',
      '[data-src]',
      'link[rel="preload"]'
    ].join(',');

    let nodes = [];
    try {
      nodes = Array.from(document.querySelectorAll(selectors));
    } catch {
      nodes = [];
    }

    for (const el of nodes) {
      for (const attr of ['src', 'data-src', 'data-animation-path', 'data-lottie-src']) {
        const value = el.getAttribute && el.getAttribute(attr);
        if (value) hintUrl(value);
      }
      // data-lottie / data-animation 可能是内联 JSON，也可能是 URL
      for (const attr of ['data-lottie', 'data-animation']) {
        const value = el.getAttribute && el.getAttribute(attr);
        if (!value) continue;
        const trimmed = value.trim();
        if (trimmed.startsWith('{')) {
          try {
            reportObject(JSON.parse(trimmed), 'inline', 'dom');
          } catch {
            /* 忽略非法内联 JSON */
          }
        } else {
          hintUrl(trimmed);
        }
      }
    }

    // 3) JSON 类型的 script 标签（有些站点把动画塞进 <script type="application/json">）
    try {
      const scripts = document.querySelectorAll(
        'script[type="application/json"],script[type="application/lottie+json"],script[type="application/ld+json"]'
      );
      for (const s of scripts) {
        const text = s.textContent || '';
        if (quickCheck(text)) reportText(text, '', 'dom');
      }
    } catch {
      /* 忽略 */
    }

    // 4) 性能时间线中的动画地址
    //    Worker 里发起的请求不会经过主线程的 fetch / XHR 钩子（例如 lottiefiles 的
    //    dotLottie 播放器就在 Worker 内取 .lottie），但资源条目里仍留有 URL，
    //    这里只取扩展名明确的地址，交给后台按 URL 抓取，避免把 JS/CSS 也拉一遍。
    try {
      const entries = performance.getEntriesByType('resource');
      for (const entry of entries) {
        if (PERF_ANIM_RE.test(entry.name)) hintUrl(entry.name);
      }
    } catch {
      /* 忽略 */
    }
  }

  // 收到内容脚本的扫描指令
  window.addEventListener('message', (event) => {
    if (event.source !== window) return;
    const data = event.data;
    if (!data || data[DOWN] !== true) return;
    if (data.cmd === 'scan') scanPage();
  });
})();
