/**
 * 手动收集辅助：点击吸附候选元素 + 预览/命名
 * 交互模型（v1.1）：无自动识别——用户进入收集模式后逐个点击页面元素，
 * 每次点击 = 列表中的一条数据（一行），多次点击累积为一个收集列表
 * 纯函数（previewOf / firstItemText / makeListName）经 __lde.detect 挂载，
 * algo-check.cjs 离线回归；pickItem 依赖 DOM 走浏览器回归。
 * 依赖：util.normalizeText / truncate
 */
(() => {
  'use strict';
  const ns = window.__lde;
  const { normalizeText, truncate } = ns.util;

  const PREVIEW_MAX = 40;  // 面板首条预览截断长度（字符）

  /** 吸附候选元素：点击处向上找「视觉上独立的一条」——
   *  li 优先（点击列表条目内任意位置吸附到 li）；行内元素（display:inline）
   *  向上到最近的块级容器；body / documentElement 不作为候选 */
  function pickItem(target) {
    if (!target || target.nodeType !== 1 || !target.isConnected) return null;
    if (target === document.body || target === document.documentElement) return null;
    let el = target.closest('li') || target;
    while (el && el !== document.body && el !== document.documentElement) {
      if (getComputedStyle(el).display !== 'inline') return el;
      el = el.parentElement;
    }
    return null;
  }

  /** 首条完整文本（归一化；面板 title 悬浮显全文用） */
  function firstItemText(items) {
    if (!items || !items.length) return '';
    return normalizeText(items[0].textContent);
  }

  /** 首条预览：第一项文本归一化后截断约 40 字符 */
  function previewOf(items) {
    return truncate(firstItemText(items), PREVIEW_MAX);
  }

  /** 收集列表名（Sheet 名 / csv 后缀 / json 键）：收集N（N 按导出序唯一） */
  function makeListName(idx) {
    return '收集' + (idx + 1);
  }

  ns.detect = {
    pickItem: pickItem,
    firstItemText: firstItemText,
    previewOf: previewOf,
    makeListName: makeListName
  };
})();
