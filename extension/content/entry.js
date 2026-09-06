/**
 * List Data Exporter 内容脚本入口（由 background 按需注入，须为 content/ 首个注入文件）
 * 职责：注入守卫 + 共享命名空间 window.__lde。后续文件（util / detect / format /
 * main）按依赖拓扑序注入并挂载模块——零构建项目无 import/export，
 * 注入顺序即依赖顺序。版本历史见 docs/product.md。
 */
(() => {
  'use strict';
  // 重复注入守卫：再次点击扩展图标 → 收起面板/退出（调用上一轮注册的 toggle）
  if (window.__listDataExporter) {
    if (window.__lde) window.__lde.aborted = true; // 标记本轮注入放弃初始化（main 检查）
    window.__listDataExporter.toggle();
    return;
  }
  window.__lde = {}; // 本轮注入的模块命名空间
})();
