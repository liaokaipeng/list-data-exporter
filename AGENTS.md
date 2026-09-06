# AGENTS.md — AI 协作须知

Chrome MV3 扩展（原生 JS，零构建）。架构与产品信息见 [docs/architecture.md](docs/architecture.md)、[docs/product.md](docs/product.md)，不在此重复。

目录约定：`extension/` 是插件本体（chrome://extensions 加载该目录）；`test/`、`docs/` 为开发材料，不随插件分发。

## 硬性约定

- 不引入构建步骤、框架、npm 依赖；SheetJS 已本地内置（`extension/lib/xlsx.full.min.js`），直接引用
- 权限最小化：改动 `extension/manifest.json` 权限需有明确理由（当前 activeTab / scripting / downloads，无 host_permissions）
- v1 不支持 iframe：内容脚本仅注入顶层 frame，勿加 all-frames / host_permissions 相关改动
- 注释与文档用中文；提交信息格式：一行标题 + 要点列表
- 每次 git 提交须同步更新相关文档（架构/产品/测试等 docs 与 test/README），保持文档与代码一致

## 验证命令（本机为 PowerShell）

```powershell
# 内容脚本语法检查（5 个文件，依赖序注入，见 docs/architecture.md）
Get-ChildItem extension/content/*.js | ForEach-Object { node --check $_.FullName }
node --check extension/background/service-worker.js
node test/algo-check.cjs
```

注意：PowerShell 不支持 `&&` 和 heredoc；多行提交信息用 `git commit -F <文件>`。`.ps1` 脚本须保存为 UTF-8 with BOM（PS5 按 ANSI 解析无 BOM 文件，中文注释会乱码导致解析错误）。

改代码后的浏览器回归：`chrome://extensions` 刷新扩展 → 刷新目标页 → 按 [test/README.md](test/README.md) 用 fixture 页对照预期值验证。

## 坑（已踩过，勿再踩）

- PowerShell 5.1 脚本无 BOM 时中文注释乱码致解析错误（gen-icon.ps1 已修复为 BOM 保存）
- GDI+ 枚举 `[System.Drawing.Imaging.WrapMode]` 在 PS5 偶发类型解析失败，`SetWrapMode(3)` 数值传入等效
- 条目文本取 textContent 而非 innerText：innerText 排除不可见文本且触发回流，归一化交给 normalizeText 统一处理
