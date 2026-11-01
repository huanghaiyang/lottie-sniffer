# Lottie Sniffer

一个 Chrome / Edge 扩展，用来**自动侦测任意网页里的 Lottie 动画**（Bodymovin JSON 与 dotLottie `.lottie`），并支持预览、单个下载与批量打包下载。

典型用途：在 [lottiefiles.com](https://lottiefiles.com/)、产品官网、运营页面上抓取正在播放的 Lottie 动画资源。

---

## 功能一览

- **自动捕获**：页面加载、切换、滚动时产生的 Lottie 请求都会被侦测，无需手动操作。
- **多路侦测**：同时覆盖 `fetch`、`XMLHttpRequest`、`lottie-web` 内联动画、DOM 属性、预加载链接等来源。
- **格式识别**：原生 Lottie JSON；能自动解开 `{ data: { animation: ... } }` 之类的包裹结构，以及「JSON 字符串再套一层 JSON」的接口返回。
- **dotLottie 支持**：识别 `.lottie`（本质是 ZIP 包），预览时用浏览器原生 `DecompressionStream` 解压，不依赖第三方解压库。
- **列表管理**：按标签页隔离、按类型筛选、内容级去重、角标实时显示数量。
- **内置预览器**：播放 / 暂停、重播、拖动进度、0.25×–2× 变速、透明（棋盘格）/ 浅色 / 深色背景切换、复制 JSON。
- **下载**：单个下载，或把当前列表打包成一个 ZIP（`lottie-animations-YYYY-MM-DD.zip`）。
- **自动命名**：优先用动画内的 `nm`（合成名），其次用 URL 文件名，最后回退到页面标题。

---

## 安装

1. 打开 `chrome://extensions/`（Edge 为 `edge://extensions/`）。
2. 右上角开启 **开发者模式**。
3. 点击 **加载已解压的扩展程序**，选择本项目根目录（包含 `manifest.json` 的那一层）。
4. 建议把扩展固定在工具栏，方便查看数量角标。

> 需要 **Chrome / Edge 111+**。因为探针脚本使用了 Manifest V3 的 `world: "MAIN"` 能力，低于该版本无法加载。

安装完成后，**打开或刷新**目标网页即可。已经打开的旧标签页可以直接在弹窗里点「重新扫描」，扩展会自动补注入脚本。

---

## 使用

1. 在目标网站正常浏览，让动画出现在页面上（列表页通常需要向下滚动触发懒加载）。
2. 点击工具栏中的扩展图标：
   - 顶部左侧显示当前站点与捕获数量；
   - 中间为动画卡片列表，缩略图会实时渲染；
   - 顶部可切换 **全部 / JSON / .lottie** 筛选，右侧是「重新扫描」和「清空」。
3. 点击卡片或眼睛图标 → 打开预览浮层：
   - 底部控件依次为：播放 / 暂停、重播、进度条、时间、速度、背景、复制 JSON、下载。
4. 点击卡片右侧的下载箭头 → 下载单个动画。
5. 底部按钮 → 把当前筛选结果打包下载为 ZIP。

### 关于数据保留

- 列表与正文按**标签页**隔离，切换/关闭标签页会清理对应数据。
- 每个标签页最多保留 **40 个动画**、正文合计 **60 MB**，超出后按时间顺序淘汰最早的条目。
- 元数据放在 `chrome.storage.session`，正文放在 `chrome.storage.local`；Service Worker 休眠后列表仍能恢复。
- 正文如果被浏览器回收，下载时会自动按原始 URL 重新抓取（仅对可访问的地址有效）。

---

## 侦测原理

扩展由三层组成，避免污染页面且尽量不错过资源：

```
页面主世界 (MAIN world)          隔离世界 (ISOLATED)            后台
inject.js  ──postMessage──▶  content.js  ──sendMessage──▶  background.js
   │                                                          │
   ├─ 劫持 fetch / XHR                                         ├─ 去重、登记、持久化
   ├─ 钩住 lottie.loadAnimation                                ├─ 角标
   └─ 扫描 lottie 实例与 DOM                                    └─ 下载 / ZIP 打包
```

1. **`fetch` 钩子**：先 `clone()` 响应再交还给页面，页面自身的读取完全不受影响；只对文本/二进制做轻量嗅探。
2. **`XMLHttpRequest` 钩子**：在 `load` 事件里读取 `responseText` 或 `response`。
3. **`lottie.loadAnimation` 钩子**：轮询 `window.lottie / bodymovin` 并替换 `loadAnimation`，捕获「直接传 `animationData`」的内联动画——这类动画从不发网络请求，只能从运行时拿。
4. **主动扫描**：遍历 `lottie.getRegisteredAnimations()`、`lottie-player` / `dotlottie-player`、`data-animation-path`、`script[type="application/json"]` 等。
5. **性能时间线兜底**：Worker 内发起的请求不经过主线程钩子（例如 lottiefiles 的 dotLottie 播放器在 Worker 内取 `.lottie`），扫描时会从 `performance` 资源条目里取出 `.json` / `.lottie` 地址。
6. **URL 提示**：DOM / 性能时间线里发现但页面自己没请求过的动画地址，交给后台用扩展权限抓取，从而绕过 CORS。

识别规则（`shared/detect.js` 与 `inject.js` 内联副本保持一致）：

- 快速预检：文本必须包含 `"layers"`、`"fr"`、`"op"` 等关键字段；
- 结构校验：`layers` 非空数组，且 `fr` / `ip` / `op` 均为数字；
- 包裹解包：最多向下递归 4 层、节点预算 4000，能识别 `{data:{animation:{...}}}`、`{animationData: "..."}` 等常见形态；
- 内容签名去重：取文本首尾各 192 字符 + 总长度做 FNV-1a 32 位哈希，避免同一动画因多次请求/扫描重复出现；
- 序列化时剔除 `lottie-web` 渲染期写入的 `"_render"` 内部字段，保证同一动画在渲染前后得到相同签名。

---

## 文件结构

```
.
├── manifest.json          # MV3 清单：权限、双世界内容脚本、弹窗
├── background.js          # Service Worker：捕获登记、去重、存储、下载、ZIP
├── inject.js              # MAIN world 探针：fetch/XHR/lottie 钩子、主动扫描
├── content.js             # ISOLATED world 桥接：postMessage ↔ chrome.runtime
├── shared/
│   └── detect.js          # 识别/解包/元信息提取（Popup 与 SW 共用）
├── popup.html             # 弹窗界面
├── popup.css              # 深色主题样式（固定 420px 宽）
├── popup.js               # 列表、缩略图、预览器、下载交互
├── lib/
│   └── lottie.min.js      # lottie-web 5.12.2（本地内置，满足 MV3 无远程代码要求）
└── icons/                 # 16/32/48/128 图标
```

---

## 权限说明

| 权限 | 用途 |
| --- | --- |
| `downloads` | 保存动画文件与 ZIP |
| `storage` / `unlimitedStorage` | 保存捕获列表与动画正文 |
| `tabs` | 按标签页隔离数据、维护角标、获取页面标题 |
| `scripting` | 安装扩展后为已打开的旧标签页补注入内容脚本 |
| `<all_urls>` | 在任意网站侦测 Lottie 资源 |

扩展不上传任何数据，所有捕获内容只保存在本机浏览器存储中。

---

## 已知限制

- **加密 / DRM 保护的资源**：服务端返回密文或需要密钥解密的动画无法解析。
- **纯 WASM 播放器**：若站点用自研播放器且从不暴露原始 JSON/二进制，可能只能拿到 URL 提示。
- **素材依赖**：Lottie JSON 引用的外部图片/音频不会自动打包下载，需要自行获取。
- **跨域受限**：URL 回退抓取依赖目标服务器允许访问；返回 403/404 或需要鉴权的地址会失败。
- **站点反爬**：如 lottiefiles.com 会启用 Cloudflare 人机验证，自动化/无头浏览器可能被拦截；正常人工浏览不受影响。
- **页面内联但未调用的 JSON**：只有在主动扫描能找到（script/DOM 属性）时才会被捕获。

---

## 故障排查

| 现象 | 处理方式 |
| --- | --- |
| 数量角标一直是 0 | 确认页面确实在播放 Lottie；向下滚动触发懒加载；点「重新扫描」；仍为 0 时刷新页面 |
| 弹窗提示「无法在这个页面运行」 | `chrome://`、扩展商店等页面禁止注入，请切换到普通 http/https 页面 |
| 缩略图显示「无法预览」 | 正文读取失败或格式异常，可尝试重新扫描或直接下载后用其他工具检查 |
| 下载失败 | 检查目标地址是否仍可访问（可能已过期或需要鉴权） |
| 刚加载扩展后旧页面无反应 | 浏览器不会回溯注入已打开页面，点「重新扫描」即可自动补注入 |
| 修改代码后不生效 | 到 `chrome://extensions/` 点击该扩展的刷新按钮，再刷新目标页面 |

---

## 开发说明

- 无构建步骤，纯原生 JS，直接修改文件后在扩展管理页点「刷新」即可。
- `inject.js` 运行在 MAIN world，不支持 ES Module，因此内置了一份与 `shared/detect.js` 相同的识别逻辑；**修改识别规则时两处要同步**。
- 本地预览用的 `lib/lottie.min.js` 为 lottie-web 5.12.2（MIT License），仅用于弹窗渲染，不注入页面。
- 主要上限常量：
  - `inject.js`：文本 20 MB、二进制 16 MB；
  - `background.js`：每标签页 40 个资产、正文合计 60 MB。
