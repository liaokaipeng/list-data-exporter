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
| detect.js | util | 手动收集辅助：`findContainingList(el, strict)` 所在列表识别——真列表语义规则优先（cur 为 li 且父级 ul/ol → 条目 = 全部 li 子元素，odd/even 条纹类不拆列表；strict=true 跳过语义规则只按签名，Ctrl+点击收子集）；否则自点击处向上找最近一级「同签名兄弟 ≥2」的祖先（签名 = tagName + 排序 class，见 `elSig()`，覆盖 a 包裹卡片网格 / div 伪列表）；`orderFromRects()` 列优先视觉排序纯函数（x 区间重叠聚列、列间按 x 列内按 y，零尺寸排末尾）与 DOM 包装 `visualOrder()`（双列交错 DOM 序还原阅读顺序）；`pickItem()` 单条回退时点击吸附候选（li 优先 → 行内 display:inline 向上到块级，body/html 除外）；`previewOf()/firstItemText()` 首条预览（Element[] 入参）；`makeListName()` 收集N 命名；elSig/预览/命名/orderFromRects 纯函数离线回归，findContainingList/pickItem/visualOrder 走浏览器回归 |
| format.js | util | 导出格式序列化纯函数：`toCsv()`（RFC4180+BOM+CRLF）/ `toJson()`（单列表行对象、多列表名键嵌套）/ `toMarkdown()`（GFM + 二级标题分区）/ `toHtmlDocument()`（完整文档）；数据模型 `{ name, rows:[{content,link}], withLinks }`；离线回归 |
| main.js   | 其余全部 | 主 UI / 事件 / 收集模式 / 选中管理 / 导出 / 退出清理（详见下）                                                                                                                                                                   |

### main.js 关键机制

- **UI/事件**：单个 Shadow DOM host（`all:initial` 隔离页面样式），含悬浮面板、高亮框池、选中覆盖层、toast 容器。`mouseover` 捕获：收集模式下高亮识别所在列表（整表）/独立候选（`setManualHover()`）；常规模式双向联动——悬浮页面已收集元素，面板对应条目 `scrollIntoView` + 短暂强调（`entryAt()` 自目标向上逐祖先查 items 归属）。`click` 捕获：收集模式拦截所有点击做整表/单条收集与移除；常规模式仅拦截已收集元素点选（选中/取消）与链接 `a[href]` 导航（就地红框 1s + 警示 toast），其余放行（翻页/筛选可用，`pruneDetached()` 剔除被替换的元素）。`keydown`：Esc 结束收集 / 退出会话；Enter 导出（焦点在面板控件或页面元素上时放行）。`scroll`/`resize` rAF 节流重定位

- **收集模式**（v1.2 核心通道，无自动识别）：「添加选择」进入（每次进入新建单条收集列表 `currentManual`，行带「收集中」徽标，按钮变「完成收集」）；进入时挂载**采集盾**（`mountShield()`）——全屏透明层（`position:fixed; inset:0`，z-index 2147483646 仅低于面板宿主）接管所有指针命中：页面元素与任何层级的页面监听（含 window 捕获路由拦截器）看到的 target 均为盾层，无从触发跳转；真实目标经 `probeAt()`（瞬间摘掉盾层 `pointer-events` 后 `elementFromPoint`，同步恢复无闪烁）还原——盾层 `mousemove` 探测悬浮（`setManualHover()`：优先 `findContainingList()` 识别所在列表整表高亮，无列表回退 `pickItem()` 单候选），click 在 document 捕获中探测后 `collectToggle()`；面板在其上不受影响，wheel 放行滚动链到文档；Esc / 「完成收集」时 `unmountShield()` 摘除。`collectToggle(el, strict)` 先 `findContainingList(el, strict)`（strict 来自 Ctrl+点击）：命中 → 该组条目经 `visualOrder()` 列优先重排后整表收集为独立条目（条目记录 `container`；同容器且条目重叠的再次点击 = 整表移除——整表与严格子集共用容器，toggle 键须含条目重叠判断；条目与其他列表重叠 → toast 不动作）；未命中（独立元素）→ `pickItem()` 吸附后单条累积进 `currentManual`（已在活动列表 → 移除序号重排，已在其他列表 → toast，否则追加）。收集即选中；空列表整行移除。数据模型：`{ items: Element[]（有序 = 导出行序，整表收集经 visualOrder 列优先重排）, container（整表条目的列表容器）, withLinks, preview, full, rowEl, flashT, groupId }`

- **悬浮面板**：右侧默认贴边（360px，95vw/70vh 上限），标题栏 mousedown 拖拽（clamp 视口内）；图标再点 = 收起面板（会话保留，覆盖层与监听不动；收起前先结束收集模式），收起后再点 / Esc /「退出」= 全量清理；深色模式经 prefers-color-scheme 覆写 token；prefers-reduced-motion 关动效

- **高亮框池**（`boxPool`）：面板条目悬浮 → 该列表全部已收集元素逐一紫色高亮框（`takeBox()` 复用池避免反复创建）；收集模式悬浮整表候选/单候选同风格；滚动/resize 经 `hoverTarget`（entry / items / el 三型）重算定位

- **选中管理**：`selected` Set<列表对象>（保序 = 导出顺序）+ `overlays` Map<列表, box[]>（每元素一个覆盖层，徽标 = 列表内序号，贴视口边缘翻内侧；增删元素后 `rebuildOverlay()` 整体重建并重排）；面板行序号徽标已选 = Sheet 序号（同 `groupId` 并组条目同号，Ctrl 并组直观可见）、未选 = 行序；条目 `groupId` 在 `addSelected(entry, merge)` 分配——Ctrl+点击（merge=true）并入最近选中条目的组、否则新开一组，`removeSelected()` 置空脱离并组

- **导出**：迭代前快照已选非空列表（yield 间隙的 prune 不影响导出范围），按 `groupId` 聚合为表组——Ctrl 并组的多条目拼接为同一个表（组内行序 = 选择序；链接列口径 = 组内任一条目勾选「附链接」即有该列，未勾选条目的行链接留空）→ 逐表实时取 `items` 的 textContent 归一化（可选 `firstHref()` 附链接列，元素自身或内部第一个 a）→ 按格式生成文件列表（xlsx 多 Sheet + `!cols` 列宽自适应；CSV 多表拆多文件带列表名后缀；json/md/html 汇总单文件）→ 逐文件 base64 经后台 `chrome.downloads` 下载（失败回退 blob）；`fileNamed()` 文件名长度钳制（默认名页面标题超 40 字符截断，导出时主体 ≤60 / 无后缀 ≤100 / 后缀 ≤40，`clampName()` 按码点截断防代理对半截断）；`yieldToMain()`（MessageChannel）逐表让出主线程；导出中按钮「导出中…」防重入；成功保留面板（toast「退出」动作），可换格式连续导出

## 关键设计决策

| 决策 | 理由 |
| --- | --- |
| 零构建多文件：注入顺序即依赖 + `__lde` 命名空间 | 不引打包器（硬约束）；每文件一个 IIFE 挂载模块，service-worker 的 files 数组即依赖拓扑序；util/detect/format 纯函数使 algo-check.cjs 可离线加载回归 |
| 按需注入而非静态 content_scripts | SheetJS 体积大，避免所有页面常驻开销；activeTab 权限利于商店审核 |
| 手动收集为唯一通道（v1.1 取消自动识别） | 识别率不可控（门槛/伪列表/噪声列表），误识别比无识别更伤信任；用户点击所见即所得（整表/单条），收集范围完全由用户定义 |
| 收集模式整表收集（同签名兄弟识别） | 点击列表中一个元素的意图几乎总是导出整个列表（如 Element Plus 总览卡片网格：`<a>` 包裹、无 ul/ol，自动识别覆盖不到）；同签名兄弟组（tagName + 排序 class）是最小可靠的「列表」信号，就近取最内层；悬浮整表高亮让范围先于点击可见，误判可整表移除当场撤销 |
| 真列表语义规则（li 且父级 ul/ol → 全部 li 子元素为条目） | 严格同签名会把带 odd/even 条纹类的双列列表拆成两半（如百度热搜：一个 ul 10 个 li，DOM 交错序 + 条纹类，一次点击只收 5 条）；HTML 语义上 ul/ol 的 li 本就是一个列表的条目，样式类差异（条纹/首尾/选中态）不代表不同条目；该规则优先于签名匹配，Ctrl+点击（strict）可回退严格签名收子集（如单收一列） |
| 整表收集列优先视觉排序（orderFromRects 聚列） | 双列交错布局的 DOM 序是视觉行序（0,5,1,6…），直接导出行序错乱；按矩形 x 区间重叠聚列、列间按 x 列内按 y，还原「左列自上而下再右列」的阅读顺序（排行榜类列表的正确序）；单列结果与 DOM 序一致无副作用；聚列逻辑抽为纯函数 orderFromRects 供离线回归 |
| Ctrl 双语义（收集模式 = 严格子集，选择模式 = 并入同 Sheet） | 两个模式各有一个「合并/拆分」诉求：收集模式需要从整表识别回退严格签名（单收一列），选择模式需要把多个独立列表拼进一个 Sheet；Ctrl 是通用的「修饰主操作」键，按模式区分语义不冲突，且避免新增 UI 控件 |
| Sheet 组（groupId）并组导出 | Ctrl 并组的多列表拼接为同一 Sheet 是「一个表一个 Sheet」需求的通解（任意 N 个列表按选择序拼接）；组键挂在条目上随选中生命周期分配/置空，导出时按组聚合，默认（每组一条目）行为与旧版完全一致 |
| 点击吸附规则（单条回退路径）：li 优先 → 行内向上到块级 | 一刀切到 e.target 太碎（点 span 得 span）、切到固定祖先太粗；li 是页面语义上现成的「一条」；行内→块级符合「视觉上独立的一条」直觉；body/html 排除防全页选中 |
| 整表条目以 container 元素为 toggle 键 | 同一列表的任一元素点击语义一致（整表收集/整表移除），无需比对条目集；DOM 结构性相等比对不可靠，容器引用同一即同列表 |
| 每次进入收集模式新建列表 | 一次进出 = 一个语义完整的收集（如「这页商品」）；多次进出天然支持多列表多 Sheet 导出，无需额外 UI |
| 收集即选中（第一条自动进入选中态） | 用户点击收集的意图就是导出它；省去收集后再去找面板行勾选的一步；空列表自动退出选中避免导出空表 |
| 收集模式事件闸（click 外的激活类事件全拦） | 站点可能在 mousedown/pointerup 等时机脚本导航、中键 auxclick 新开标签，仅拦 click 不够；拦掉 focus/文本选择/原生拖拽的副作用在短暂的收集模式中可接受，且抑制原生拖拽让点击收集更稳定 |
| 采集盾（收集模式全屏透明层接管命中） | VitePress 等站点在 window 捕获阶段注册 click 路由拦截器，先于扩展的 document 捕获监听执行，点击 `<a>` 包裹的元素（如 Element Plus 总览卡片）时直接 `router.go()` 编程式跳转——`preventDefault`/`stopPropagation` 到达时跳转已发起，事件闸无解；盾层改变命中目标（target = 盾层而非页面 `<a>` 内元素），任何层级的页面监听都找不到可导航目标，与注册顺序无关；`elementFromPoint` 同步探测还原真实目标，交互体验不变（悬浮吸附/收集/滚动照常）。事件闸降级为第二道防线（盾层被更高 z-index 页面元素盖住时兜底） |
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

- findContainingList 就近取最内层同签名组：嵌套列表点击总是命中最内层；同标签同 class 兄弟 ≥2 即视为列表，粒度不可自定义（误判经再次点击整表移除撤销）；表格内点击会把同行同签名单元格识别为「列表」（表格场景建议用 web-table-exporter）

- 真列表语义规则把 ul/ol 的全部 li 子元素视为一个列表：同 ul 内确实异质的 li（如导航里 li.home + li.item）也会整表收集，Ctrl+点击可回退严格签名收子集；div 伪列表的条纹类（odd/even）不做类合并——类相似度合并有误合并风险（如同容器内共享基类的不同部件），保持严格签名，误拆可经两次收集 + Ctrl 并组弥补

- 列优先排序假设多列列表按列阅读（排行榜类）；横向平铺的卡片网格（阅读序为行优先）导出行序会变为列优先，如需原始顺序可逐列收集后并组

- 事件闸（第二道防线）对早于本扩展注册的同节点同阶段（document 捕获）页面监听无效（先注册先执行）；采集盾为主防线不受此限，但被个别页面元素（z-index 高于 2147483646 的全屏浮层）盖住时命中回到页面元素，由事件闸兜底，window 级捕获监听仍可能漏拦（极端场景）

- 常规模式（非收集）不设盾（需放行翻页/筛选），window 捕获路由站点上点击链接仍可能被页面先行 SPA 跳转——链接拦截对默认行为导航有效，对已发起的编程式导航无法事后取消（已知边界）

- 采集盾 wheel 放行（滚动链到文档级），收集模式中页面内嵌滚动容器（overflow:auto 的非文档级区域）无法滚轮滚动，需先滚动文档或短暂结束收集
