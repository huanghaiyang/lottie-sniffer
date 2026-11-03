/**
 * dotLottie（.lottie）解包工具
 *
 * `.lottie` 文件本质是一个 ZIP 包，规范结构大致为：
 *   manifest.json            动画清单（animations[] 里记录每条动画的 id）
 *   animations/<id>.json     每条动画的 Bodymovin JSON
 *   images/…                 可选的外部图片素材
 *
 * 这里实现一个最小的 ZIP 读取器：
 *   - 只解析中央目录（EOCD / Central Directory）与本地文件头；
 *   - 支持 store(0) 与 deflate(8) 两种压缩方式；
 *   - 解压交给浏览器原生 DecompressionStream('deflate-raw')，不引入第三方库。
 *
 * Popup（预览）与 Service Worker（按 JSON 格式下载）复用同一份实现，
 * 保证解包结果一致，也避免两处代码各自演化。
 */

import { findAnimation, isAnimation } from './detect.js';

/** base64 -> 字节数组（atob 逐字节转换） */
export function base64ToBytes(base64) {
  const binary = atob(base64);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}

/** 解析 ZIP 中央目录，返回每个条目的名称、压缩方式和数据切片 */
function readZipEntries(bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);

  // 从尾部向前查找 EOCD（End of Central Directory）签名
  let eocd = -1;
  const stop = Math.max(0, bytes.length - 22 - 0xffff);
  for (let i = bytes.length - 22; i >= stop; i--) {
    if (view.getUint32(i, true) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error('不是有效的 ZIP / .lottie 文件');

  const count = view.getUint16(eocd + 10, true);
  let pointer = view.getUint32(eocd + 16, true);
  const entries = [];

  for (let i = 0; i < count; i++) {
    if (pointer + 46 > bytes.length || view.getUint32(pointer, true) !== 0x02014b50) break;

    const method = view.getUint16(pointer + 10, true);
    const compressedSize = view.getUint32(pointer + 20, true);
    const uncompressedSize = view.getUint32(pointer + 24, true);
    const nameLength = view.getUint16(pointer + 28, true);
    const extraLength = view.getUint16(pointer + 30, true);
    const commentLength = view.getUint16(pointer + 32, true);
    const localOffset = view.getUint32(pointer + 42, true);

    const name = new TextDecoder().decode(
      bytes.subarray(pointer + 46, pointer + 46 + nameLength)
    );

    // 本地文件头里的名称 / 扩展字段长度可能和中央目录不同，需重新读取
    const localNameLength = view.getUint16(localOffset + 26, true);
    const localExtraLength = view.getUint16(localOffset + 28, true);
    const dataStart = localOffset + 30 + localNameLength + localExtraLength;

    entries.push({
      name,
      method,
      compressedSize,
      uncompressedSize,
      data: bytes.subarray(dataStart, dataStart + compressedSize)
    });

    pointer += 46 + nameLength + extraLength + commentLength;
  }

  return entries;
}

/** 使用浏览器原生 API 解 deflate-raw */
async function inflateRaw(data) {
  if (typeof DecompressionStream === 'undefined') {
    throw new Error('当前浏览器不支持解压 .lottie');
  }
  const stream = new Blob([data]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

async function readZipEntry(entry) {
  if (entry.method === 0) return entry.data;
  if (entry.method === 8) return inflateRaw(entry.data);
  throw new Error(`不支持的压缩方式（${entry.method}）`);
}

/**
 * 解开 .lottie，取出其中的动画 JSON。
 *
 * @param {string} base64 `.lottie` 文件的 base64 正文
 * @returns {Promise<{json: object, text: string, nameHint: string}>}
 */
export async function unzipDotLottie(base64) {
  const bytes = base64ToBytes(base64);
  const entries = readZipEntries(bytes);
  if (!entries.length) throw new Error('.lottie 包内容为空');

  const manifestEntry = entries.find((e) => /^manifest\.json$/i.test(e.name));
  const jsonEntries = entries.filter((e) => /\.json$/i.test(e.name) && !/manifest\.json$/i.test(e.name));
  if (!jsonEntries.length) throw new Error('.lottie 中没有找到动画 JSON');

  // 规范位置是 animations/<id>.json，优先取它
  const preferred = jsonEntries.find((e) => /^animations\/[^/]+\.json$/i.test(e.name));
  const picked = preferred || jsonEntries[0];

  const text = new TextDecoder().decode(await readZipEntry(picked));
  const parsed = JSON.parse(text);
  const anim = findAnimation(parsed) || parsed;

  if (!isAnimation(anim)) throw new Error('.lottie 中的 JSON 不是有效的 Lottie 动画');

  // 读取 manifest 中的动画 id，仅作为名称参考（不强制）
  let nameHint = '';
  if (manifestEntry) {
    try {
      const manifest = JSON.parse(new TextDecoder().decode(await readZipEntry(manifestEntry)));
      const first = Array.isArray(manifest.animations) ? manifest.animations[0] : null;
      if (first && typeof first.id === 'string') nameHint = first.id;
    } catch {
      /* 忽略 */
    }
  }

  return { json: anim, text: JSON.stringify(anim), nameHint };
}
