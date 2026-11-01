/**
 * Lottie Sniffer —— 共享的 Lottie 识别模块
 *
 * 该模块同时被 Service Worker（background.js）与 Popup（popup.js）以 ES Module 形式引入，
 * 负责回答一个问题：「这段 JSON 是不是一个 Lottie / Bodymovin 动画？」
 *
 * 注意：MAIN world 的探针脚本（inject.js）无法使用 ES Module（它是通过 content_scripts
 * 注入到页面主世界的普通脚本），因此 inject.js 内联了本文件的核心逻辑，
 * 两处逻辑必须保持一致。
 */

/** 单个 JSON 文本允许的最大长度（字符数近似等于字节数，Lottie JSON 基本为 ASCII） */
export const MAX_TEXT_BYTES = 20 * 1024 * 1024;
/** 单个二进制文件（.lottie）允许的最大字节数 */
export const MAX_BINARY_BYTES = 16 * 1024 * 1024;

/**
 * 廉价预检：在读到的文本里快速判断「有没有可能是 Lottie」。
 *
 * 真正的 Lottie JSON 顶层一定包含 "layers" 数组，并且带有帧率 "fr" 与
 * 出点 "op"。先做字符串 indexOf 可以避免对大量无关 JSON 执行代价高昂的 JSON.parse。
 *
 * @param {string} text 响应正文
 * @returns {boolean}
 */
export function quickCheck(text) {
  if (typeof text !== 'string') return false;
  if (text.length < 40 || text.length > MAX_TEXT_BYTES) return false;
  if (text.indexOf('"layers"') === -1) return false;
  return text.indexOf('"fr"') !== -1 && text.indexOf('"op"') !== -1;
}

/**
 * 判断某个对象本身是否为一个 Lottie 动画（Bodymovin 格式）。
 *
 * 必需字段：
 *  - layers: 图层数组且非空
 *  - fr:     帧率（number）
 *  - ip:     入点帧（number）
 *  - op:     出点帧（number）
 *
 * @param {unknown} obj
 * @returns {boolean}
 */
export function isAnimation(obj) {
  return !!obj
    && typeof obj === 'object'
    && !Array.isArray(obj)
    && Array.isArray(obj.layers)
    && obj.layers.length > 0
    && typeof obj.fr === 'number'
    && typeof obj.ip === 'number'
    && typeof obj.op === 'number';
}

/**
 * 从任意 JSON 结构中递归寻找 Lottie 动画对象。
 *
 * 现实世界的页面常常把动画包在别的结构里，例如：
 *  - { animationData: {...} }（lottie-web 的调用参数）
 *  - { data: { animation: {...} } }（GraphQL / REST 响应）
 *  - { lottie: "{\"v\":...}" }（JSON 被二次序列化成字符串字段，LottieFiles 常见）
 * 因此需要在有限深度内遍历，并支持「字符串里再套一层 JSON」的情况。
 *
 * 为防止恶意 / 超大 JSON 造成卡顿，遍历有深度上限（4）与节点预算（4000）。
 *
 * @param {unknown} root 已解析的 JSON
 * @returns {object|null} 找到的动画对象
 */
export function findAnimation(root) {
  return walk(root, 0, { n: 4000 });
}

function walk(node, depth, budget) {
  if (budget.n-- <= 0 || depth > 4) return null;

  // 字符串字段里可能藏着被二次序列化的动画 JSON
  if (typeof node === 'string') {
    if (node.length > 64 && node.length <= MAX_TEXT_BYTES && node.indexOf('"layers"') !== -1) {
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

/**
 * 提取用于展示的关键元数据（尺寸、帧率、时长、图层数等）。
 *
 * @param {object} anim
 * @returns {{nm:string,w:number,h:number,fr:number,ip:number,op:number,layers:number,v:string}}
 */
export function animationMeta(anim) {
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

/**
 * 把一段响应文本解析成「干净的」Lottie JSON 文本。
 *
 * 如果响应本身就是动画对象，则原样返回（保留原始格式）；
 * 如果动画被包裹在别的结构里，则只提取动画对象并重新序列化，
 * 这样下载得到的文件就能被任意 Lottie 播放器直接使用。
 *
 * @param {string} text
 * @returns {{anim: object, text: string}|null}
 */
export function extractAnimation(text) {
  if (!quickCheck(text)) return null;
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    return null;
  }
  const anim = findAnimation(json);
  if (!anim) return null;
  const out = anim === json ? text : JSON.stringify(anim);
  if (out.length > MAX_TEXT_BYTES) return null;
  return { anim, text: out };
}
