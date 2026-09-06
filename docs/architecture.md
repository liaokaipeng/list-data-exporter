# 架构文档

## 总体结构

```
┌─────────────┐  点击图标   ┌──────────────────┐  按需注入   ┌─────────────────┐
│ 扩展图标     │ ─────────→ │ service-worker.js │ ─────────→ │ 页面 isolated    │
│ (action)    │            │ (background)      │            │ world（仅顶层）  │
└─────────────┘            └────────┬─────────┘            │ ├ xlsx.full.min  │
                                    │ sendMessage          └ content/ 5 文件  │
                                    ↓ (base64)             └────────┬────────┘
                           ┌──────────────────┐                     │
                           │ chrome.downloads │ ←───────────────────┘
                           └──────────────────┘   生成导出文件后经后台下载
```

## 模块职责

### extension/manifest.json

- MV3，权限最小化：`activeTab` + `scripting`（点击时注入）+ `downloads`（绕过页面 CSP）；无 `host_permissions`、无静态 `content_scripts`——SheetJS 约 950KB，不常驻所有页面

- 仅注入顶层 frame（v1 不支持 iframe，见 product.md 已知限制）

- 图标 16/32/48/128 四尺寸（纯色极简：品牌紫底 + 白色列表符号）：`test/gen-icon.ps1` GDI+ 矢量绘制 512px 母版降采样生成，勿手改二进制

- `extension/` 为插件本体目录（chrome://extensions 加载）；`test/`、`docs/` 为开发材料，不随插件分发

### extension/background/service-worker.js

- `chrome.action.onClicked`：向当前 tab 注入 `lib/xlsx.full.min.js` 与 `content/` 下 5 个文件（同一 isolated world，main.js 直接用全局 `XLSX`；路径相对 extension/ 根）

- `chrome.runtime.onMessage`（`type: 'lde-download'`）：base64 数据（按 `msg.mime` 定 MIME，缺省 xlsx）经 `chrome.downloads.download` 落盘并回传结果

- 受限页面（chrome:// 等）注入失败静默处理

### extension/content/（5 文件按依赖拓扑序注入，每文件一个 IIFE 挂载到 window.__lde）

注入守卫（entry.js）：`window.__listDataExporter` 已存在 → 标记 `__lde.aborted` 并调上轮 `toggle()`（面板可见则收起、已收起则退出，本轮后续文件放弃初始化）；否则创建命名空间。零构建无 import/export，**注入顺序即依赖顺序**：

| 文件       | 依赖   | 职责                                                                                                                                                                                                                             |
| --------- | ---- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| entry.js  | —    | 注入守卫 + `__lde` 命名空间                                                                                                                                                                                                      |
| util.js   | —    | timestamp / sanitizeFilename / escapeHtml / normalizeText（视觉归一化）/ truncate / visualWidth（CJK 双宽）/ autoColWidths（列宽钳制 6~50）；纯函数，algo-check.cjs 离线回归                                                       |
| detect.js | util | 手动收集辅助：`pickItem()` 点击吸附候选元素（li 优先 → 行内 display:inline 向上到块级，body/html 除外）；`previewOf()/firstItemText()` 首条预览（Element[] 入参）；`makeListName()` 收集N 命名；纯函数离线回归，pickItem 走浏览器回归 |
| format.js | util | 导出格式序列化纯函数：`toCsv()`（RFC4180+BOM+CRLF）/ `toJson()`（单列表行对象、多列表名键嵌套）/ `toMarkdown()`（GFM + 二级标题分区）/ `toHtmlDocument()`（完整文档）；数据模型 `{ name, rows:[{content,link}], withLinks }`；离线回归 |
| main.js   | 其余全部 | 主 UI / 事件 / 收集模式 / 选中管理 / 导出 / 退出清理（详见下）                                                                                                                                                                   |

### main.js 关键机制

- **UI/事件**：单个 Shadow DOM host（`all:initial` 隔离页面样式），含悬浮面板、高亮框池、选中覆盖层、toast 容器。`mouseover` 捕获：收集模式下高亮吸附候选（pickItem）；常规模式双向联动——悬浮页面已收集元素，面板对应条目 `scrollIntoView` + 短暂强调（`entryAt()` 自目标向上逐祖先查 items 归属）。`click` 捕获：收集模式拦截所有点击逐条收集/移除；常规模式仅拦截已收集元素点选（选中/取消）与链接 `a[href]` 导航（就地红框 1s + 警示 toast），其余放行（翻页/筛选可用，`pruneDetached()` 剔除被替换的元素）。`keydown`：Esc 结束收集 / 退出会话；Enter 导出（焦点在面板控件或页面元素上时放行）。`scroll`/`resize` rAF 节流重定位

- **收集模式**（v1.1 核心通道，无自动识别）：「添加选择」进入（每次进入新建列表 `currentManual`，行带「收集中」徽标，按钮变「完成收集」）；点击元素 `pickItem()` 吸附后 `collectToggle()`——已在活动列表 → 移除（序号重排），已在其他列表 → toast 不动作，否则追加；第一条收集时列表自动进入选中态；Esc / 「完成收集」结束，空列表整行移除。数据模型：`{ items: Element[]（有序 = 导出行序）, withLinks, preview, full, rowEl, flashT }`

- **悬浮面板**：右侧默认贴边（360px，95vw/70vh 上限），标题栏 mousedown 拖拽（clamp 视口内）；图标再点 = 收起面板（会话保留，覆盖层与监听不动；收起前先结束收集模式），收起后再点 / Esc /「退出」= 全量清理；深色模式经 prefers-color-scheme 覆写 token；prefers-reduced-motion 关动效

- **高亮框池**（`boxPool`）：面板条目悬浮 → 该列表全部已收集元素逐一紫色高亮框（`takeBox()` 复用池避免反复创建）；收集模式悬浮候选同风格；滚动/resize 经 `hoverTarget` 重算定位

- **选中管理**：`selected` Set<列表对象>（保序 = 导出顺序）+ `overlays` Map<列表, box[]>（每元素一个覆盖层，徽标 = 列表内序号，贴视口边缘翻内侧；增删元素后 `rebuildOverlay()` 整体重建并重排）；面板行序号徽标已选 = 选中序号、未选 = 行序

- **导出**：迭代前快照已选非空列表（yield 间隙的 prune 不影响导出范围）；逐列表实时取 `items` 的 textContent 归一化（可选 `firstHref()` 附链接列，元素自身或内部第一个 a）→ 按格式生成文件列表（xlsx 多 Sheet + `!cols` 列宽自适应；CSV 多列表拆多文件带列表名后缀；json/md/html 汇总单文件）→ 逐文件 base64 经后台 `chrome.downloads` 下载（失败回退 blob）；`yieldToMain()`（MessageChannel）逐列表让出主线程；导出中按钮「导出中…」防重入；成功保留面板（toast「退出」动作），可换格式连续导出

## 关键设计决策

| 决策 | 理由 |
| --- | --- |
| 零构建多文件：注入顺序即依赖 + `__lde` 命名空间 | 不引打包器（硬约束）；每文件一个 IIFE 挂载模块，service-worker 的 files 数组即依赖拓扑序；util/detect/format 纯函数使 algo-check.cjs 可离线加载回归 |
| 按需注入而非静态 content_scripts | SheetJS 体积大，避免所有页面常驻开销；activeTab 权限利于商店审核 |
| 手动收集为唯一通道（v1.1 取消自动识别） | 识别率不可控（门槛/伪列表/噪声列表），误识别比无识别更伤信任；用户逐条点击所见即所得，收集范围完全由用户定义 |
| 点击吸附规则：li 优先 → 行内向上到块级 | 一刀切到 e.target 太碎（点 span 得 span）、切到固定祖先太粗；li 是页面语义上现成的「一条」；行内→块级符合「视觉上独立的一条」直觉；body/html 排除防全页选中 |
| 每次进入收集模式新建列表 | 一次进出 = 一个语义完整的收集（如「这页商品」）；多次进出天然支持多列表多 Sheet 导出，无需额外 UI |
| 收集即选中（第一条自动进入选中态） | 用户点击收集的意图就是导出它；省去收集后再去找面板行勾选的一步；空列表自动退出选中避免导出空表 |
| 收集模式事件闸（click 外的激活类事件全拦） | 站点可能在 mousedown/pointerup 等时机脚本导航、中键 auxclick 新开标签，仅拦 click 不够；拦掉 focus/文本选择/原生拖拽的副作用在短暂的收集模式中可接受，且抑制原生拖拽让点击收集更稳定 |
| 收集模式中点击已收集元素 = 移除 | toggle 语义统一且即时可逆，误点当场撤销，无需撤销栈 |
| 跨列表元素不重复收集（toast 提示） | 元素属多列表会让导出行重复、页面序号徽标混乱；提示后重新收集成本低 |
| 覆盖层徽标 = 列表内序号而非全局序号 | 页面上每个框标「它在自己的列表里是第几条」，与导出行序一致、与用户收集顺序一致 |
| 高亮框池化复用 | 悬浮联动逐元素加框，大收集（几十条）反复进出创建/销毁开销大；池复用 + hidden 切换 |
| 点击放行（仅拦已收集元素点选与链接导航） | 翻页/筛选等页面交互在会话中照常可用；被拦截链接就地红框 + toast，防误跳转丢会话又不静默吞掉 |
| 收集列表以对象为键（Set 保序） | DOM 元素数组无法序列化且无需持久化（v1 无跨会话配置）；Set 迭代序即导出顺序，徽标编号、Sheet 顺序、csv 后缀序天然一致 |
| 导出迭代前快照选中列表 | 逐列表 yieldToMain 让出主线程期间，点击放行触发的 pruneDetached 会改写选中集合，快照后导出范围在开始一刻锁定 |
| 下载走后台 chrome.downloads | 页面 CSP（如 ERP 后台）拦截 blob: 下载且静默失败；扩展 downloads API 不受页面策略限制，失败时仍回退 blob |
| CSV 多列表拆多文件、json/md/html 汇总单文件 | CSV 单文件无法承载多列表（拼接破坏列结构）；JSON 列表名键嵌套、MD 二级标题分区、HTML 多表天然支持；单列表时文件名不带后缀保持简洁 |
| xlsx 单元格一律文本写入 | SheetJS aoa_to_sheet 对字符串写 t:'s'，长数字/前导零不变形；列表数据无求和诉求，「数字」格式留待后续版本 |
| 图标再点 = 收起 → 再点 = 退出 | 导出后保留会话（可换格式连续导出）与快速退出兼得；Esc /「退出」/「取消」恒为全量退出兜底 |
| 反馈双通道：hint 留引导/进行时，结果性通知走 toast | hint 是面板内一行小字；成功/错误混排会顶掉引导文案；toast 右上角独立堆叠（成功/信息 2.5s、警示 4s、错误常驻可关、同屏 3 条上限） |

## 已知限制

用户向限制（吸附粒度固定、元素单列表归属、无持久化、不含图片等）见 [product.md](product.md)「已知限制」，不在此重复。开发侧补充：

- 文件名输入框默认值每次进入选择模式重填（v1 无持久化，未申请 storage 权限）

- pickItem 的吸附规则是启发式（li / 行内→块级两级），复杂布局（绝对定位浮层、表格内 td）可能吸附到意料外的层级，用户可通过收集/移除即时纠正

- 事件闸对早于本扩展注册的同节点同阶段（document 捕获）页面监听无效（先注册先执行），此类极端场景需全屏覆盖层方案，暂不处理
