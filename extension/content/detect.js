/**
 * 手动收集辅助：所在列表识别 + 点击吸附候选元素 + 预览/命名 + 视觉排序
 * 交互模型（v1.3）：收集模式下点击列表中任一元素 = 收集该列表全部同类条目
 *  （findContainingList 自点击处向上找最近一级「同签名兄弟 ≥2」的祖先，
 *   签名 = tagName + 排序 class——覆盖 div 伪列表、a 包裹卡片网格等
 *   ul/ol 之外的结构；真列表（li 且父级 ul/ol）按 HTML 语义无视条纹类
 *   整表识别，strict=true 时跳过语义规则只按严格签名——Ctrl+点击收子集）；
 *   无列表上下文的独立元素回退为单条收集（v1.1 行为，调用方累积进活动列表）；
 *   整表收集经 visualOrder 列优先重排（双列交错 DOM 序还原为阅读顺序）
 * 纯函数（previewOf / firstItemText / makeListName / elSig / orderFromRects）
 * 经 __lde.detect 挂载，algo-check.cjs 离线回归；pickItem / findContainingList /
 * visualOrder 依赖 DOM 走浏览器回归。
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
   *  真列表语义规则（strict 省略/false 时优先于签名匹配）：cur 为 li 且
   *  父级为 ul/ol → 条目 = 全部 li 子元素——odd/even 条纹类、首尾类等
   *  样式差异不拆列表（双列交错布局如百度热搜一次点击整表收集；
   *  li 数不足 2 时继续向上由签名规则接手）。
   *  就近取最内层（嵌套列表点内层得内层）；至多向上 12 级，
   *  body / documentElement 不作为容器（防整页区块被当作列表）；
   *  找不到返回 null（调用方回退单元素收集） */
  function findContainingList(el, strict) {
    if (!el || el.nodeType !== 1 || !el.isConnected) return null;
    for (let cur = el, d = 0; cur && cur.parentElement && d < 12; cur = cur.parentElement, d++) {
      const parent = cur.parentElement;
      if (parent === document.body || parent === document.documentElement) break;
      if (!strict && cur.tagName === 'LI' && (parent.tagName === 'UL' || parent.tagName === 'OL')) {
        const lis = Array.from(parent.children).filter(c => c.tagName === 'LI');
        if (lis.length >= 2) return { container: parent, items: lis };
      }
      const sig = elSig(cur);
      const items = [];
      for (const c of parent.children) {
        if (elSig(c) === sig) items.push(c);
      }
      if (items.length >= 2) return { container: parent, items: items };
    }
    return null;
  }

  /** 矩形序列 → 列优先序（索引数组，纯函数离线回归）：
   *  x 区间重叠归同列（按 left 扫描维护当前列右界），列间按 x 升序、
   *  列内按 y 升序；零尺寸矩形（display:none 等）不参与聚列，按原序排末尾 */
  function orderFromRects(rects) {
    const n = rects.length;
    if (n < 2) return rects.map((_, i) => i);
    const vis = [], hid = [];
    rects.forEach((r, i) => {
      if (r.width === 0 && r.height === 0) hid.push(i);
      else vis.push({ i: i, left: r.left, right: r.right, top: r.top, col: 0 });
    });
    vis.sort((a, b) => a.left - b.left);
    let colRight = -Infinity, col = -1;
    for (const it of vis) {
      if (it.left >= colRight) { col++; colRight = it.right; }
      else if (it.right > colRight) colRight = it.right;
      it.col = col;
    }
    vis.sort((a, b) => (a.col - b.col) || (a.top - b.top));
    return vis.map(it => it.i).concat(hid);
  }

  /** 条目视觉排序（列优先）：orderFromRects 的 DOM 包装。
   *  双列交错 DOM 序（0,5,1,6…）还原为左列自上而下再右列（0,1,2…）；
   *  单列结果与 DOM 序一致 */
  function visualOrder(items) {
    if (!items || items.length < 2) return items || [];
    const order = orderFromRects(items.map(el => {
      const r = el.getBoundingClientRect();
      return { left: r.left, right: r.right, top: r.top, width: r.width, height: r.height };
    }));
    return order.map(i => items[i]);
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
    orderFromRects: orderFromRects,
    visualOrder: visualOrder,
    firstItemText: firstItemText,
    previewOf: previewOf,
    makeListName: makeListName
  };
})();
