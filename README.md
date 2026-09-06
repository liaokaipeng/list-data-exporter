# List Data Exporter

网页内容一键收集导出为 xlsx / csv / json / md / html 的 Chrome/Edge 扩展（Manifest V3，原生 JS，零构建）。逐个点击页面元素收集数据，悬浮面板多选导出，无需复制粘贴。与 [web-table-exporter](../web-table-exporter) 互补：前者管 `<table>` 整表抓取，本扩展管散落页面元素的手动逐条收集。

## 核心亮点

- **手动收集**：点「添加选择」后逐个点击想要的元素（商品卡片、评论、公告……），每次点击 = 一条数据，页面即时显示序号标记，所见即所得
- **智能吸附**：点击列表条目内任意位置吸附整个 `li`；点行内文字吸附到所在块级容器，不用精确对准
- **字段提取**：条目内部的子信息（如评论的作者/日期/标题/正文）可拆为多列导出——点选条目内内容即生成字段列，或一键自动识别出候选列，实时预览确认
- **即时可逆**：收集模式中再次点击已收集元素即移除，序号自动重排
- **多收集列表**：多次进出收集模式建立多个列表，多选一次性导出：xlsx 多 Sheet、csv 拆多文件、json 键嵌套、md 二级标题分区
- **悬浮联动**：悬浮面板条目 → 页面该列表全部元素紫色高亮；悬浮页面已收集元素 → 面板条目定位强调（双向）
- **隐私友好**：不收集任何数据，权限最小化（activeTab / scripting / downloads）

## 使用

1. 点击扩展图标打开收集面板（面板打开时再点图标收起，已收起时再点 / `Esc` / 「退出」退出）
2. 点「＋ 添加选择」进入收集模式，逐个点击页面元素收集为一条条数据（再次点击已收集元素移除；`Esc` / 「完成收集」结束）
3. 需要多个列表时，再次「添加选择」新建收集列表；悬浮面板条目可查看对应元素
4. （可选）面板行点「字段」，点选条目内的内容或「自动识别」把子信息拆成多列；修改文件名、切换格式（默认 Excel）
5. 点「导出」或按 `Enter`；导出后保留面板，可换格式连续导出

**适用场景**：竞品商品信息整理、评论/反馈汇总、公告要点归档、任意散落页面内容的批量收集。

## 安装

1. 打开 `chrome://extensions` → 开启「开发者模式」
2. 「加载已解压的扩展程序」→ 选择本项目的 `extension/` 目录
3. （可选）如需在本地 HTML 文件上使用：扩展详情 → 打开「允许访问文件网址」

## 目录结构

```
├── extension/                  # 插件本体（chrome://extensions 加载该目录）
│   ├── manifest.json           # MV3 配置（activeTab / scripting / downloads）
│   ├── background/service-worker.js  # 图标点击注入 + 后台下载
│   ├── content/                # 内容脚本（按依赖序注入，零构建无模块系统）
│   │   ├── entry.js            #   注入守卫 + window.__lde 命名空间
│   │   ├── util.js             #   工具函数 + 文本归一化 + 列宽估算
│   │   ├── detect.js           #   点击吸附候选元素（li 优先 / 行内→块级）
│   │   ├── field.js            #   字段提取（条目内部子信息拆多列：点选/自动识别）
│   │   ├── format.js           #   csv/json/md/html 导出格式序列化纯函数
│   │   └── main.js             #   主 UI / 收集模式 / 导出
│   ├── lib/xlsx.full.min.js    # SheetJS 0.20.3（Apache-2.0）
│   └── icons/                  # 图标 16/32/48/128（test/gen-icon.ps1 生成）
├── test/                       # 测试材料（不随插件分发）
│   ├── algo-check.cjs          # 纯函数回归（Node 直接运行）
│   ├── fixture.html            # 浏览器回归测试页（含预期值注释）
│   ├── gen-icon.ps1            # 图标生成脚本
│   └── README.md               # 测试覆盖矩阵与回归步骤
└── docs/                       # 文档（架构 / 产品）
```

## 开发与测试

```powershell
# 语法检查（内容脚本 6 个文件 + 后台脚本）
Get-ChildItem extension/content/*.js | ForEach-Object { node --check $_.FullName }
node --check extension/background/service-worker.js

# 纯函数回归（util / detect / field / format）
node test/algo-check.cjs
```

修改代码后：`chrome://extensions` 刷新扩展 → 刷新目标页面。

## 文档

- [架构文档](docs/architecture.md)：模块划分、数据流、关键设计决策
- [产品文档](docs/product.md)：功能清单、交互规范、已知限制
- [测试与回归](test/README.md)：测试页覆盖矩阵、命令、浏览器回归步骤
