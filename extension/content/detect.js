/**
 * 手动收集辅助：所在列表识别 + 点击吸附候选元素 + 预览/命名
 * 交互模型（v1.2）：收集模式下点击列表中任一元素 = 收集该列表全部同类条目
 *  （findContainingList 自点击处向上找最近一级「同签名兄弟 ≥2」的祖先，
 *   签名 = tagName + 排序 class——覆盖 div 伪列表、a 包裹卡片网格等
 *   ul/ol 之外的结构）；无列表上下文的独立元素回退为单条收集（v1.1 行为，
 *  调用方累积进活动列表）
 * 纯函数（previewOf / firstItemText / makeListName / elSig）经 __lde.detect
 * 挂载，algo-check.cjs 离线回归；pickItem / findContainingList 依赖 DOM
 * 走浏览器回归。
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

  /** 元素签名：tagName + 排序后 class 集合——同一模板渲染的兄弟条目签名一致，
   *  与 id / 内联 style / data-* 无关 */
  function elSig(el) {
    const cls = el.classList ? Array.from(el.classList).sort() : [];
    return cls.length ? el.tagName + '|' + cls.join('.') : el.tagName;
  }

  /** 识别 el 所在的「列表」：自 el 逐级向上，最近一级祖先 P 满足——
   *  P 的直接子元素中与「P 内包含 el 的那个子元素」同签名的兄弟 ≥ 2 →
   *  P 为列表容器、同签名兄弟为条目（返回 { container, items }）。
   *  就近取最内层（嵌套列表点内层得内层）；至多向上 12 级，
   *  body / documentElement 不作为容器（防整页区块被当作列表）；
   *  找不到返回 null（调用方回退单元素收集） */
  function findContainingList(el) {
    if (!el || el.nodeType !== 1 || !el.isConnected) return null;
    for (let cur = el, d = 0; cur && cur.parentElement && d < 12; cur = cur.parentElement, d++) {
      const parent = cur.parentElement;
      if (parent === document.body || parent === document.documentElement) break;
      const sig = elSig(cur);
      const items = [];
      for (const c of parent.children) {
        if (elSig(c) === sig) items.push(c);
      }
      if (items.length >= 2) return { container: parent, items: items };
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
    elSig: elSig,
    findContainingList: findContainingList,
    firstItemText: firstItemText,
    previewOf: previewOf,
    makeListName: makeListName
  };
})();
