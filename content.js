/**
 * Lottie Sniffer —— ISOLATED world 内容脚本（桥接层）
 *
 * 职责非常单一：把 MAIN world 探针（inject.js）通过 window.postMessage 发出的
 * 捕获结果转发给 Service Worker，并把 Popup / SW 的「重新扫描」指令回传给探针。
 *
 * 之所以需要这一层，是因为 MAIN world 运行在页面自身的 JS 上下文里，
 * 无法访问 chrome.* 扩展 API。
 */
(() => {
  'use strict';

  const GUARD = '__lottieSnifferContent__';
  if (Object.prototype.hasOwnProperty.call(window, GUARD)) return;
  Object.defineProperty(window, GUARD, { value: true, enumerable: false, configurable: false });

  const UP = '__ls_up__';
  const DOWN = '__ls_down__';

  /** 安全地给后台发消息：扩展被重载 / 上下文失效时不应抛出未捕获异常 */
  function sendToBackground(message) {
    try {
      const result = chrome.runtime.sendMessage(message);
      if (result && typeof result.catch === 'function') result.catch(() => {});
    } catch {
      /* 扩展上下文已失效（例如插件刚被更新），忽略即可 */
    }
  }

  window.addEventListener('message', (event) => {
    // 只接受来自本窗口的消息，防止其他 frame 伪造
    if (event.source !== window) return;
    const data = event.data;
    if (!data || data[UP] !== true || !data.payload) return;

    const payload = data.payload;

    if (payload.kind === 'hint') {
      // DOM 扫描发现的动画地址：交给后台以扩展权限抓取，可绕过 CORS 限制
      sendToBackground({ type: 'URL_HINT', url: payload.url });
      return;
    }

    sendToBackground({ type: 'CAPTURE', payload });
  });

  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (!message || typeof message !== 'object') return false;

    if (message.type === 'PING') {
      sendResponse({ ok: true });
      return false;
    }

    if (message.type === 'SCAN') {
      try {
        window.postMessage({ [DOWN]: true, cmd: 'scan' }, '*');
      } catch {
        /* 忽略 */
      }
      sendResponse({ ok: true });
      return false;
    }

    return false;
  });
})();
