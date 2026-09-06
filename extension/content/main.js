/**
 * List Data Exporter 主 UI：可拖拽悬浮面板、手动收集模式、悬浮高亮联动、
 * 多列表多选导出（xlsx / csv / json / md / html，须最后注入）
 * 依赖 window.__lde 命名空间（entry / util / detect / format 先行注入）；
 * UI 层与算法层只经命名空间单向调用。
 * v1.3 交互增强：
 *   - 真列表语义收集：点击 ul/ol 内任一 li = 全部 li 整表收集（无视 odd/even
 *     条纹类；整表条目经 visualOrder 列优先重排——双列交错 DOM 序还原阅读顺序）；
 *     Ctrl+点击 = 严格签名只收同样式子集（如双列布局单收一列）
 *   - 选择模式 Ctrl+点击 = 并入最近选中条目的 Sheet 组（groupId），同组多个
 *     收集列表导出时拼接为同一个 Sheet；行序号徽标显示 Sheet 序号直观可见
 * v1.2 交互模型（无自动识别）：
 *   - 「添加选择」进入收集模式：点击列表中任一元素 = 收集该列表全部同类条目
 *     （findContainingList 同签名兄弟识别，整表为一条目，再次点击整表移除）；
 *     独立元素（无同类兄弟）回退单条累积收集；Esc / 「完成收集」结束；
 *     收集期间采集盾（全屏透明层）接管指针命中 + 事件闸拦截激活类事件——
 *     页面任何层级的监听（含 window 捕获路由拦截器）均无从触发跳转
 *   - 面板条目悬浮 → 页面该列表全部元素紫色高亮框（池化 + 滚动跟随定位）；
 *     页面悬浮已收集元素 → 面板条目滚入视野并短暂强调（双向联动）
 *   - 选中：面板/页面点选（覆盖层 + 列表内序号徽标，贴边翻内侧）；点击放行页面交互，
 *     仅拦截已收集元素点选与链接导航；失联元素自动剔除
 *   - 图标再点 = 收起面板（会话保留），收起后再点 / Esc /「退出」= 退出清理
 *   - 导出成功保留面板（toast 提供「退出」动作），可换格式连续导出
 */
(() => {
  'use strict';
  const ns = window.__lde;
  if (!ns || ns.aborted) return; // 守卫已退出（再次点击图标 = 收起/退出），不初始化
  const { timestamp, sanitizeFilename, normalizeText, autoColWidths } = ns.util;
  const { pickItem, previewOf, firstItemText, makeListName, findContainingList, visualOrder } = ns.detect;
  const { toCsv, toJson, toMarkdown, toHtmlDocument } = ns.format;

  // 导出格式注册表：label 为按钮文案、ext 为文件扩展名、mime 为下载 MIME
  const FORMATS = {
    xlsx: { label: 'Excel', ext: 'xlsx', mime: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' },
    csv: { label: 'CSV', ext: 'csv', mime: 'text/csv' },
    json: { label: 'JSON', ext: 'json', mime: 'application/json' },
    md: { label: 'Markdown', ext: 'md', mime: 'text/markdown' },
    html: { label: 'HTML', ext: 'html', mime: 'text/html' }
  };

  // 收集模式需拦截的激活类事件（click 之外）：防站点在 mousedown/pointer 等时机
  // 跳转、中键 auxclick 新开标签；click 由 onPageClick 统一处理收集逻辑
  const GUARD_EVENTS = ['mousedown', 'mouseup', 'pointerdown', 'pointerup', 'auxclick'];

  let active = true;
  let host = null;
  let panelEl = null, titleEl = null, countEl = null, hintEl = null, listEl = null;
  let nameInput = null, fmtSel = null, exportBtn = null, cancelBtn = null, addBtn = null;
  let toastRoot = null;
  let collapsed = false;   // 图标再点：面板收起但选择会话保留
  let manualMode = false;  // 收集模式（点击页面元素逐条收集）
  let exporting = false;   // 导出文件生成/编码进行中（防重入）
  let rafId = 0;
  let dragInfo = null;     // 标题栏拖拽状态
  let shield = null;       // 采集盾：收集模式的全屏透明拦截层（见 mountShield）

  // 收集列表数据模型：{ items: Element[]（有序 = 导出行序，整表收集经 visualOrder
  // 列优先重排）, container（整表收集的列表容器，同容器条目重叠点击 = 同一列表
  // toggle；单条收集无）, withLinks, preview, full, rowEl, flashT, groupId }
  let entries = [];
  let currentManual = null;      // 收集模式中的活动列表（独立元素单条累积）
  const selected = new Set();    // 已选收集列表（Set 保序 = 导出顺序）
  let groupSeq = 0;              // Sheet 组序号发生器（Ctrl 并组见 addSelected）
  const overlays = new Map();    // 列表 → 覆盖层盒子数组（每元素一个，含序号徽标）
  let hoverTarget = null;        // { type:'entry', entry } | { type:'items', items } | { type:'el', el }
  let lastHoverEntry = null;     // 页面悬浮联动：上次强调的条目（防重复闪烁）

  // 高亮框池：面板条目悬浮时逐元素标记（复用避免反复创建/销毁）
  let boxPool = [];
  let poolUsed = 0;

  /* ---------------- UI 构建（Shadow DOM 隔离页面样式） ---------------- */

  function buildUI() {
    host = document.createElement('div');
    host.style.cssText =
      'all:initial;display:block;position:absolute;top:0;left:0;width:0;height:0;' +
      'z-index:2147483647;pointer-events:none;';
    document.documentElement.appendChild(host);

    const root = host.attachShadow({ mode: 'open' });
    // 品牌 token：颜色/圆角集中定义于 :host，深色模式经 prefers-color-scheme 覆写
    root.innerHTML = [
      '<style>',
      '  :host{--c-primary:#7c3aed;--c-primary-weak:rgba(124,58,237,.12);',
      '    --c-info:#1976d2;--c-danger:#c62828;--c-warn:#8d6e00;',
      '    --c-text:#333;--c-text-2:#666;--c-text-3:#999;--c-border:#ccc;--c-border-2:#e0e0e0;',
      '    --c-bg:#fff;--c-bg-2:#f5f7fa;--c-bg-3:#fafbfc;--c-input:#fff;',
      '    --c-disable-bg:#9a9a9a;--c-disable-fg:#767676;--r:10px;--r-s:6px;}',
      '  @media (prefers-color-scheme: dark){:host{--c-primary:#a78bfa;--c-primary-weak:rgba(167,139,250,.18);',
      '    --c-info:#64b5f6;--c-danger:#ef5350;--c-warn:#ffd54f;',
      '    --c-text:#e0e0e0;--c-text-2:#aaa;--c-text-3:#777;--c-border:#555;--c-border-2:#3a3a3a;',
      '    --c-bg:#1e1e1e;--c-bg-2:#2a2a2a;--c-bg-3:#252525;--c-input:#333;',
      '    --c-disable-bg:#555;--c-disable-fg:#888;}}',
      /* 候选高亮框（收集模式悬浮）与选中覆盖层 */
      '  .lde-itemhl{position:absolute;pointer-events:none;box-sizing:border-box;border:2px solid var(--c-primary);background:var(--c-primary-weak);border-radius:3px;transition:left .08s,top .08s,width .08s,height .08s;}',
      '  .lde-sel{position:absolute;pointer-events:none;box-sizing:border-box;border:2px solid var(--c-primary);background:var(--c-primary-weak);border-radius:3px;}',
      '  .lde-badge{position:absolute;top:-12px;left:-12px;min-width:22px;height:22px;padding:0 6px;box-sizing:border-box;border-radius:11px;background:var(--c-primary);color:#fff;font:700 12px/22px -apple-system,"Segoe UI",sans-serif;text-align:center;box-shadow:0 1px 3px rgba(0,0,0,.35);}',
      '  .lde-sel.lde-flip-x .lde-badge{left:auto;right:-12px;}',   /* 元素贴左边缘：徽标翻内侧 */
      '  .lde-sel.lde-flip-y .lde-badge{top:auto;bottom:-12px;}',   /* 元素贴上边缘：徽标翻内侧 */
      /* 悬浮面板（右侧默认贴边，可拖拽移动） */
      '  .lde-panel{position:fixed;top:96px;right:16px;width:360px;max-width:95vw;max-height:70vh;display:flex;flex-direction:column;pointer-events:auto;background:var(--c-bg);border-radius:var(--r);box-shadow:0 8px 32px rgba(0,0,0,.25);font:13px/1.5 -apple-system,"Segoe UI","Microsoft YaHei",sans-serif;color:var(--c-text);z-index:1;}',
      '  .lde-title{display:flex;align-items:center;gap:8px;padding:10px 12px;border-bottom:1px solid var(--c-border-2);cursor:move;user-select:none;}',
      '  .lde-tname{font-weight:700;white-space:nowrap;}',
      '  .lde-count{color:var(--c-text-2);white-space:nowrap;}',
      '  .lde-count b{color:var(--c-primary);}',
      '  .lde-spacer{flex:1;}',
      '  .lde-mini{padding:3px 10px;border:1px solid var(--c-border);border-radius:var(--r-s);background:var(--c-bg);color:var(--c-text-2);cursor:pointer;font:12px/1.4 -apple-system,"Segoe UI",sans-serif;white-space:nowrap;}',
      '  .lde-mini:hover{border-color:var(--c-primary);color:var(--c-primary);}',
      '  .lde-hint{padding:8px 12px;color:var(--c-text-2);border-bottom:1px solid var(--c-border-2);font-size:12px;}',
      '  .lde-list{flex:1;min-height:0;overflow-y:auto;padding:6px;}',
      '  .lde-empty{padding:14px 8px;color:var(--c-text-3);text-align:center;font-size:12px;}',
      '  .lde-row{display:flex;align-items:center;gap:8px;padding:7px 8px;border-radius:var(--r-s);cursor:pointer;}',
      '  .lde-row:hover{background:var(--c-bg-2);}',
      '  .lde-row.lde-on{background:var(--c-primary-weak);}',
      '  .lde-row.lde-flash{outline:2px solid var(--c-primary);outline-offset:-2px;}',  /* 页面悬浮 → 短暂强调 */
      '  .lde-idx{flex:none;min-width:20px;height:20px;padding:0 4px;box-sizing:border-box;border-radius:10px;border:1px solid var(--c-border);color:var(--c-text-3);font:700 11px/18px -apple-system,"Segoe UI",sans-serif;text-align:center;}',
      '  .lde-row.lde-on .lde-idx{background:var(--c-primary);border-color:var(--c-primary);color:#fff;}',
      '  .lde-prev{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}',
      '  .lde-n{flex:none;color:var(--c-text-3);font-size:12px;white-space:nowrap;}',
      '  .lde-tag{flex:none;padding:1px 6px;border-radius:4px;font-size:11px;line-height:1.5;background:var(--c-bg-2);color:var(--c-text-2);border:1px solid var(--c-border-2);white-space:nowrap;}',
      '  .lde-tag-live{color:var(--c-info);border-color:var(--c-info);background:transparent;}',  /* 收集中徽标 */
      '  .lde-link{flex:none;display:inline-flex;align-items:center;gap:3px;color:var(--c-text-2);font-size:12px;cursor:pointer;white-space:nowrap;}',
      '  .lde-link input{margin:0;accent-color:var(--c-primary);}',
      '  .lde-foot{padding:10px 12px;border-top:1px solid var(--c-border-2);display:flex;flex-direction:column;gap:8px;}',
      '  .lde-frow{display:flex;gap:8px;align-items:center;}',
      '  .lde-name{flex:1;min-width:0;padding:6px 10px;border:1px solid var(--c-border);border-radius:var(--r-s);font:13px/1.2 -apple-system,"Segoe UI",sans-serif;color:var(--c-text);outline:none;background:var(--c-input);box-sizing:border-box;}',
      '  .lde-name:focus{border-color:var(--c-primary);}',
      '  .lde-fmt{flex:none;padding:6px 8px;border:1px solid var(--c-border);border-radius:var(--r-s);font:13px/1.2 -apple-system,"Segoe UI",sans-serif;color:var(--c-text);background:var(--c-input);outline:none;cursor:pointer;}',
      '  .lde-fmt:focus{border-color:var(--c-primary);}',
      '  .lde-btn{padding:6px 16px;border:none;border-radius:var(--r-s);cursor:pointer;font:13px/1.2 -apple-system,"Segoe UI",sans-serif;}',
      '  .lde-btn:hover:not(:disabled){filter:brightness(1.06);}',
      '  .lde-btn:active:not(:disabled){filter:brightness(.94);}',
      '  .lde-primary{background:var(--c-primary);color:#fff;}',
      '  .lde-primary:disabled{background:var(--c-disable-bg);color:#fff;cursor:not-allowed;filter:none;}',
      '  .lde-ghost{background:var(--c-bg-3);color:var(--c-text-2);border:1px solid var(--c-border);}',
      '  .lde-ghost:disabled{color:var(--c-disable-fg);cursor:not-allowed;}',
      '  .lde-add{background:var(--c-bg);color:var(--c-info);border:1px solid var(--c-info);padding:5px 12px;font-size:12px;}',
      '  .lde-add:hover:not(:disabled){filter:brightness(1.06);}',
      '  .lde-add.lde-on{background:var(--c-info);color:#fff;}',  /* 收集模式激活态 */
      /* Toast（结果性通知，右上角独立堆叠） */
      '  .lde-toasts{position:fixed;top:16px;right:16px;display:flex;flex-direction:column;gap:8px;z-index:2;pointer-events:none;font:13px/1.4 -apple-system,"Segoe UI",sans-serif;}',
      '  .lde-toast{pointer-events:auto;display:flex;align-items:center;gap:11px;max-width:min(460px,86vw);padding:11px 14px 11px 12px;border-radius:var(--r);background:var(--c-bg);color:var(--c-text);box-shadow:0 6px 24px rgba(0,0,0,.32);animation:lde-in .18s ease-out;border-left:4px solid var(--c-info);font-weight:600;}',
      '  .lde-toast-ico{flex:none;width:22px;height:22px;border-radius:50%;display:flex;align-items:center;justify-content:center;color:#fff;background:var(--c-info);font:700 13px/22px -apple-system,"Segoe UI",sans-serif;text-align:center;}',
      '  .lde-toast-info{background:linear-gradient(0deg,rgba(25,118,210,.10),rgba(25,118,210,.10)),var(--c-bg);}',
      '  .lde-toast-success{border-left-color:var(--c-primary);background:linear-gradient(0deg,rgba(124,58,237,.10),rgba(124,58,237,.10)),var(--c-bg);}',
      '  .lde-toast-success .lde-toast-ico{background:var(--c-primary);}',
      '  .lde-toast-warn{border-left-color:var(--c-warn);background:linear-gradient(0deg,rgba(141,110,0,.12),rgba(141,110,0,.12)),var(--c-bg);}',
      '  .lde-toast-warn .lde-toast-ico{background:var(--c-warn);}',
      '  .lde-toast-error{border-left-color:var(--c-danger);background:linear-gradient(0deg,rgba(198,40,40,.10),rgba(198,40,40,.10)),var(--c-bg);}',
      '  .lde-toast-error .lde-toast-ico{background:var(--c-danger);}',
      '  .lde-toast-msg{flex:1;min-width:0;color:var(--c-text);}',
      '  .lde-toast-btn{padding:3px 10px;border:1px solid var(--c-border);border-radius:var(--r-s);background:var(--c-bg);color:var(--c-text-2);cursor:pointer;font:12px/1.4 -apple-system,"Segoe UI",sans-serif;}',
      '  .lde-toast-btn:hover{border-color:var(--c-primary);color:var(--c-primary);}',
      '  .lde-toast-x{border:none;background:none;color:var(--c-text-3);cursor:pointer;font:16px/1 -apple-system,"Segoe UI",sans-serif;padding:0 2px;}',
      '  .lde-toast-x:hover{color:var(--c-text);}',
      '  button:focus-visible,select:focus-visible,input:focus-visible{outline:2px solid var(--c-info);outline-offset:1px;}',
      '  @keyframes lde-in{from{opacity:0;transform:translateY(-8px);}}',
      '  @media (prefers-reduced-motion: reduce){:host *{animation:none!important;transition:none!important;}}',
      '</style>',
      '<div class="lde-panel" role="dialog" aria-label="列表导出面板">',
      '  <div class="lde-title">',
      '    <span class="lde-tname">导出列表</span>',
      '    <span class="lde-count">已选 <b>0</b></span>',
      '    <span class="lde-spacer"></span>',
      '    <button type="button" class="lde-mini lde-exit">退出</button>',
      '  </div>',
      '  <div class="lde-hint"></div>',
      '  <div class="lde-list"></div>',
      '  <div class="lde-foot">',
      '    <div class="lde-frow">',
      '      <input class="lde-name" type="text" spellcheck="false" aria-label="导出文件名" />',
      '      <select class="lde-fmt" title="导出格式" aria-label="导出格式">' +
      Object.keys(FORMATS).map(k => '<option value="' + k + '">' + FORMATS[k].label + ' (.' + FORMATS[k].ext + ')</option>').join('') +
      '      </select>',
      '    </div>',
      '    <div class="lde-frow">',
      '      <button type="button" class="lde-btn lde-add" title="进入收集模式：逐个点击页面元素，每次点击收集为一条数据（Esc 结束）">＋ 添加选择</button>',
      '      <span class="lde-spacer"></span>',
      '      <button type="button" class="lde-btn lde-primary" disabled></button>',
      '      <button type="button" class="lde-btn lde-ghost">取消 (Esc)</button>',
      '    </div>',
      '  </div>',
      '</div>',
      '<div class="lde-toasts"></div>'
    ].join('');

    panelEl = root.querySelector('.lde-panel');
    titleEl = root.querySelector('.lde-title');
    countEl = root.querySelector('.lde-count b');
    hintEl = root.querySelector('.lde-hint');
    listEl = root.querySelector('.lde-list');
    nameInput = root.querySelector('.lde-name');
    fmtSel = root.querySelector('.lde-fmt');
    exportBtn = root.querySelector('.lde-primary');
    cancelBtn = root.querySelector('.lde-ghost');
    addBtn = root.querySelector('.lde-add');
    toastRoot = root.querySelector('.lde-toasts');

    exportBtn.addEventListener('click', doExport);
    cancelBtn.addEventListener('click', exit);
    root.querySelector('.lde-exit').addEventListener('click', exit);
    addBtn.addEventListener('click', () => { manualMode ? exitManual() : enterManual(); });
    fmtSel.addEventListener('change', syncExportBtn);
    titleEl.addEventListener('mousedown', onDragStart);  // 标题栏拖拽（按钮除外）

    nameInput.value = clampName(sanitizeFilename(document.title), 40) + '_' + timestamp();
  }

  // 导出按钮文案与格式下拉同步（含「导出中…」结束后的恢复）
  function syncExportBtn() {
    if (exporting) return; // 导出中保持「导出中…」，结束时统一恢复
    exportBtn.textContent = '导出 ' + (FORMATS[fmtSel.value] || FORMATS.xlsx).label;
  }

  /* ---------------- Toast 反馈系统 ---------------- */

  /** 结果性通知：成功/信息 2.5s 自动消失（可经 duration 覆盖，如链接拦截 4s），
   *  警示（warn）琥珀色，错误常驻 + 关闭钮；同屏最多 3 条。
   *  hint 行只保留引导与进行时文案，结果全部走 toast */
  const TOAST_ICONS = { success: '✓', error: '✕', warn: '!', info: 'i' };
  function toast(msg, opts) {
    opts = opts || {};
    const type = opts.type || 'info';
    const box = document.createElement('div');
    box.className = 'lde-toast lde-toast-' + type;
    box.setAttribute('role', type === 'error' ? 'alert' : 'status');
    const ico = document.createElement('span');
    ico.className = 'lde-toast-ico';
    ico.setAttribute('aria-hidden', 'true');
    ico.textContent = TOAST_ICONS[type] || TOAST_ICONS.info;
    box.appendChild(ico);
    const msgEl = document.createElement('span');
    msgEl.className = 'lde-toast-msg';
    msgEl.textContent = msg;
    box.appendChild(msgEl);
    let timer = 0;
    let closed = false;
    const close = () => {
      if (closed) return;
      closed = true;
      if (timer) clearTimeout(timer);
      box.remove();
    };
    (opts.actions || []).forEach((a) => {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'lde-toast-btn';
      btn.textContent = a.label;
      btn.addEventListener('click', () => { close(); if (a.onClick) a.onClick(); });
      box.appendChild(btn);
    });
    if (type === 'error') {
      const x = document.createElement('button');
      x.type = 'button';
      x.className = 'lde-toast-x';
      x.setAttribute('aria-label', '关闭');
      x.textContent = '×';
      x.addEventListener('click', close);
      box.appendChild(x);
    }
    toastRoot.appendChild(box);
    while (toastRoot.children.length > 3) toastRoot.firstElementChild.remove();
    if (type !== 'error' && !opts.sticky) {
      timer = setTimeout(close, opts.duration || 2500);
    }
    return {
      update: (m) => { if (!closed) msgEl.textContent = m; },
      close: close
    };
  }

  // hint 行统一入口：引导/进行时文案（CSS 变量色在 shadow 内生效）
  function setHint(msg, color) {
    hintEl.textContent = msg;
    hintEl.style.color = color || 'var(--c-text-2)';
  }

  function resetHint() {
    setHint(entries.length
      ? '悬浮条目查看已收集元素，点击选择（可多选）'
      : '点击「添加选择」，点击页面列表收集数据');
  }

  /* ---------------- 面板条目渲染 ---------------- */

  function makeTag(text, cls) {
    const t = document.createElement('span');
    t.className = 'lde-tag' + (cls ? ' ' + cls : '');
    t.textContent = text;
    return t;
  }

  function buildRow(entry) {
    const row = document.createElement('div');
    row.className = 'lde-row';
    const idx = document.createElement('span');
    idx.className = 'lde-idx';
    const prev = document.createElement('span');
    prev.className = 'lde-prev';
    prev.textContent = entry.preview || '（空）';
    prev.title = entry.full || entry.preview || '';  // 悬浮显全文
    const n = document.createElement('span');
    n.className = 'lde-n';
    n.textContent = entry.items.length + ' 条';
    row.appendChild(idx);
    row.appendChild(prev);
    row.appendChild(n);
    const live = makeTag('收集中', 'lde-tag-live');
    live.hidden = true; // 收集模式中的活动列表经 setLiveBadge 显隐
    row.appendChild(live);
    const lab = document.createElement('label');
    lab.className = 'lde-link';
    lab.title = '导出时每行追加元素内第一个链接的地址';
    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.checked = !!entry.withLinks;
    cb.addEventListener('click', e => e.stopPropagation());  // 勾选不触发行选中
    cb.addEventListener('change', () => { entry.withLinks = cb.checked; });
    lab.appendChild(cb);
    lab.appendChild(document.createTextNode('附链接'));
    lab.addEventListener('click', e => e.stopPropagation());
    row.appendChild(lab);
    row.addEventListener('mouseenter', () => onRowHover(entry));
    row.addEventListener('mouseleave', clearHover);
    row.addEventListener('click', e => toggleSelect(entry, e.ctrlKey || e.metaKey));
    entry.rowEl = row;
    entry.flashT = 0;
    return row;
  }

  /** 收集中条目数变化后刷新行显示（预览/全文/条数） */
  function updateEntryRow(entry) {
    if (!entry.rowEl) return;
    entry.preview = previewOf(entry.items);
    entry.full = firstItemText(entry.items);
    const prev = entry.rowEl.querySelector('.lde-prev');
    prev.textContent = entry.preview || '（空）';
    prev.title = entry.full || entry.preview || '';
    entry.rowEl.querySelector('.lde-n').textContent = entry.items.length + ' 条';
  }

  /** 空态占位统一管理（无收集列表时显示引导） */
  function syncEmpty() {
    const empty = listEl.querySelector('.lde-empty');
    if (!entries.length) {
      if (!empty) {
        const el = document.createElement('div');
        el.className = 'lde-empty';
        el.textContent = '尚未收集任何列表';
        listEl.appendChild(el);
      }
    } else if (empty) {
      empty.remove();
    }
  }

  /** 由页面元素反查所属收集列表：自目标向上找（点已收集元素的内部也能命中） */
  function entryAt(el) {
    for (let n = el; n; n = n.parentElement) {
      for (const en of entries) {
        if (en.items.includes(n)) return en;
      }
    }
    return null;
  }

  /* ---------------- 高亮框池（面板悬浮 → 页面元素逐一标记） ---------------- */

  function takeBox() {
    let b = boxPool[poolUsed];
    if (!b) {
      b = document.createElement('div');
      b.className = 'lde-itemhl';
      host.shadowRoot.appendChild(b);
      boxPool.push(b);
    }
    poolUsed++;
    return b;
  }

  function clearHoverBoxes() {
    poolUsed = 0;
    for (const b of boxPool) b.hidden = true;
  }

  function clearHover() {
    hoverTarget = null;
    clearHoverBoxes();
  }

  /** 面板条目悬浮：该列表全部已收集元素逐一加紫色高亮框 */
  function highlightEntry(entry) {
    clearHoverBoxes();
    for (const el of entry.items) {
      if (el.isConnected) positionBox(takeBox(), el);
    }
  }

  function onRowHover(entry) {
    if (!active || collapsed || manualMode) return;
    hoverTarget = { type: 'entry', entry: entry };
    highlightEntry(entry);
  }

  /* ---------------- 选中状态管理 ---------------- */

  function toggleSelect(entry, merge) {
    if (selected.has(entry)) {
      removeSelected(entry);
    } else {
      addSelected(entry, merge);
    }
  }

  /** 选中收集列表：merge=true（Ctrl+点击）并入最近选中条目的 Sheet 组
   *  （同组多条目导出拼接为同一个 Sheet，组内行序 = 选择序）；
   *  否则新开一组（一列表一 Sheet 的默认行为） */
  function addSelected(entry, merge) {
    if (selected.has(entry)) return;
    const last = [...selected].slice(-1)[0];
    entry.groupId = (merge && last) ? last.groupId : ++groupSeq;
    selected.add(entry); // Set 保序 = 导出顺序
    rebuildOverlay(entry);
    if (entry.rowEl) entry.rowEl.classList.add('lde-on');
    updateBar();
  }

  function removeSelected(entry) {
    if (!selected.has(entry)) return;
    selected.delete(entry);
    entry.groupId = null; // 退出选中即脱离并组（剩余成员分组不受影响）
    const boxes = overlays.get(entry);
    if (boxes) boxes.forEach(b => b.remove());
    overlays.delete(entry);
    if (entry.rowEl) entry.rowEl.classList.remove('lde-on');
    updateBar();
  }

  /** 重建列表的选中覆盖层：每个已收集元素一个框，
   *  徽标 = 元素在列表内的序号（1..N，增删后重排） */
  function rebuildOverlay(entry) {
    const old = overlays.get(entry);
    if (old) old.forEach(b => b.remove());
    overlays.delete(entry);
    if (!selected.has(entry)) return;
    const boxes = [];
    entry.items.forEach((el, i) => {
      if (!el.isConnected) return;
      const box = document.createElement('div');
      box.className = 'lde-sel';
      const badge = document.createElement('span');
      badge.className = 'lde-badge';
      badge.textContent = String(i + 1);
      box.appendChild(badge);
      host.shadowRoot.appendChild(box);
      positionBox(box, el);
      boxes.push(box);
    });
    overlays.set(entry, boxes);
  }

  /** 剔除已断开 DOM 的已收集元素（页面交互翻页/刷新后节点被替换）；
   *  元素全失联的非活动列表整行移除。导出中跳过（快照后范围已锁定） */
  function pruneDetached() {
    if (exporting) return;
    let removedItems = 0;
    let removedLists = 0;
    for (const entry of [...entries]) {
      const before = entry.items.length;
      entry.items = entry.items.filter(el => el.isConnected);
      if (entry.items.length === before) continue;
      removedItems += before - entry.items.length;
      if (!entry.items.length && entry !== currentManual) {
        // 非活动空列表：连同行一起移除
        if (selected.has(entry)) removeSelected(entry);
        if (entry.rowEl) entry.rowEl.remove();
        const i = entries.indexOf(entry);
        if (i >= 0) entries.splice(i, 1);
        removedLists++;
        continue;
      }
      if (selected.has(entry)) rebuildOverlay(entry);
      updateEntryRow(entry);
    }
    if (removedItems) {
      syncEmpty();
      toast('已收集元素被页面刷新移除' + (removedItems > 1 ? '（' + removedItems + ' 条' + (removedLists ? '，含空列表' : '') + '）' : ''), { type: 'warn' });
    }
  }

  /** 工具栏与徽标状态统一刷新：已选计数（并组时附 Sheet 数）、导出按钮禁用态、
   *  页面徽标（列表内元素序号）、面板行序号徽标（已选 = Sheet 序号——同组
   *  并组条目同号直观可见；未选 = 行序） */
  function updateBar() {
    const sheetNo = new Map(); // groupId → Sheet 序号（按选择序分配）
    let sheets = 0;
    for (const en of selected) {
      if (!sheetNo.has(en.groupId)) sheetNo.set(en.groupId, ++sheets);
    }
    countEl.textContent = sheets < selected.size
      ? selected.size + ' · ' + sheets + ' Sheet'
      : String(selected.size);
    for (const boxes of overlays.values()) {
      boxes.forEach((b, i) => { b.firstChild.textContent = String(i + 1); });
    }
    entries.forEach((en, idx) => {
      if (!en.rowEl) return;
      const badge = en.rowEl.querySelector('.lde-idx');
      const sn = selected.has(en) ? sheetNo.get(en.groupId) : null;
      badge.textContent = String(sn != null ? sn : idx + 1);
      badge.title = sn != null ? '导出 Sheet 序号（Ctrl+点击可并入同一 Sheet）' : '';
    });
    exportBtn.disabled = exporting || ![...selected].some(en => en.items.length);
  }

  function positionBox(box, el) {
    const r = el.getBoundingClientRect();
    box.style.left = (r.left + window.scrollX) + 'px';
    box.style.top = (r.top + window.scrollY) + 'px';
    box.style.width = r.width + 'px';
    box.style.height = r.height + 'px';
    // 选中覆盖层徽标贴视口左/上边缘时翻到内侧，避免出屏
    if (box.classList.contains('lde-sel')) {
      box.classList.toggle('lde-flip-x', r.left < 12);
      box.classList.toggle('lde-flip-y', r.top < 12);
    }
    box.hidden = false;
  }

  /* ---------------- 事件处理 ---------------- */

  /** 页面悬浮：收集模式下高亮识别所在列表（整表）/独立候选；
   *  常规模式下双向联动——悬浮已收集元素，面板对应条目滚入视野并短暂强调 */
  function onPageOver(e) {
    if (!active || !(e.target instanceof Element)) return;
    if (e.composedPath().includes(host)) { if (manualMode) clearHover(); return; }
    if (manualMode) {
      // 盾层为命中目标（进盾瞬间触发一次）→ 坐标探测还原真实元素；
      // 之后在盾层内移动由 onShieldMove 持续探测；Ctrl 按下 = 严格签名预览
      setManualHover(e.target === shield ? probeAt(e.clientX, e.clientY) : e.target,
        e.ctrlKey || e.metaKey);
      return;
    }
    if (collapsed) return;
    const entry = entryAt(e.target);
    if (lastHoverEntry && lastHoverEntry !== entry && lastHoverEntry.rowEl) {
      lastHoverEntry.rowEl.classList.remove('lde-flash');
    }
    if (entry && entry.rowEl) {
      if (entry !== lastHoverEntry) {
        lastHoverEntry = entry;
        entry.rowEl.classList.add('lde-flash');
        clearTimeout(entry.flashT);
        entry.flashT = setTimeout(() => {
          if (entry.rowEl) entry.rowEl.classList.remove('lde-flash');
        }, 700);
      }
      entry.rowEl.scrollIntoView({ block: 'nearest' });
    } else {
      lastHoverEntry = null;
    }
  }

  /** 点击放行选择模式：收集模式拦截所有点击逐条收集/移除；
   *  常规模式仅拦截已收集元素点选（选中/取消）与链接导航（防误跳转丢会话），
   *  其余放行（翻页/筛选等页面交互可用） */
  function onPageClick(e) {
    if (!active) return;
    if (e.composedPath().includes(host)) return; // 面板自身不拦截
    // 盾层为命中目标时经坐标探测还原真实页面元素，收集行为与直点一致
    const el = (e.target === shield) ? probeAt(e.clientX, e.clientY)
      : (e.target instanceof Element ? e.target : null);
    if (manualMode) {
      e.preventDefault();
      e.stopPropagation();
      // 传原始元素：列表识别需自点击处向上找；Ctrl = 严格签名收同样式子集
      if (el) collectToggle(el, e.ctrlKey || e.metaKey);
      return;
    }
    const entry = el && entryAt(el);
    if (entry) {
      e.preventDefault();
      e.stopPropagation();
      toggleSelect(entry, e.ctrlKey || e.metaKey); // Ctrl = 并入同一 Sheet 组
      return;
    }
    const link = el && el.closest('a[href]');
    if (link) {
      e.preventDefault();
      e.stopPropagation();
      flashLink(link);
      toast('选择模式下链接已停用，Esc 退出后可跳转', { type: 'warn', duration: 4000 });
      return;
    }
    pruneDetached(); // 放行的点击可能触发翻页/筛选替换 DOM，同步剔除断开的元素
  }

  /** 被拦截的链接就地红框闪烁 ~1s（用户视线在点击处，单靠 toast 易被忽略）。
   *  内联样式经 !important 覆盖页面样式，完后还原，不污染页面元素 */
  function flashLink(link) {
    const prevOutline = link.style.getPropertyValue('outline');
    const prevOffset = link.style.getPropertyValue('outline-offset');
    link.style.setProperty('outline', '3px solid #c62828', 'important');
    link.style.setProperty('outline-offset', '2px', 'important');
    setTimeout(() => {
      link.style.removeProperty('outline');
      link.style.removeProperty('outline-offset');
      if (prevOutline) link.style.setProperty('outline', prevOutline);
      if (prevOffset) link.style.setProperty('outline-offset', prevOffset);
    }, 1000);
  }

  /** 收集模式事件闸（第二道防线，主防线为采集盾）：拦截至页面的激活类事件
   *  （mousedown / mouseup / pointerdown / pointerup / auxclick），防站点在
   *  click 之外的时机跳转（mousedown 导航、中键新开标签页等）——盾层被更高
   *  z-index 页面元素盖住时命中回到页面元素，由此兜底；
   *  preventDefault 顺带抑制文本选择/原生拖拽，点击收集更稳。
   *  面板自身事件放行（拖拽收尾含松开在页面上的场景，先于拦截处理） */
  function onPageGuard(e) {
    if (!active || !manualMode) return;
    if (dragInfo) onDragEnd(); // 拖拽中松开（含松开在页面上）：先结束拖拽再拦事件
    if (e.composedPath().includes(host)) return; // 面板自身不拦
    e.preventDefault();
    e.stopPropagation();
  }

  function onKeyDown(e) {
    if (!active) return;
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      if (manualMode) exitManual(); // 收集模式：Esc 结束收集，不退出会话
      else exit();
      return;
    }
    if (e.key === 'Enter' && !e.isComposing) {
      if (manualMode) {
        // 收集模式：拦页面侧 Enter（防表单提交/链接键盘激活跳转），面板内控件放行
        if (host.contains(document.activeElement)) return;
        e.preventDefault();
        e.stopPropagation();
        return;
      }
      if (exporting) return;
      // 焦点在面板输入框/按钮/下拉上时走默认行为；页面元素持焦时放行给页面
      const focused = host.shadowRoot && host.shadowRoot.activeElement;
      if (focused && (focused.tagName === 'BUTTON' || focused.tagName === 'INPUT' || focused.tagName === 'SELECT')) return;
      const ae = document.activeElement;
      if (ae && ae !== document.body && ae !== document.documentElement && ae !== host) return;
      e.preventDefault();
      e.stopPropagation();
      doExport();
    }
  }

  /** 滚动/resize 时重定位全部覆盖层与高亮框（rAF 节流） */
  function onReposition() {
    if (rafId || !active) return;
    rafId = requestAnimationFrame(() => {
      rafId = 0;
      if (hoverTarget) {
        if (hoverTarget.type === 'entry') highlightEntry(hoverTarget.entry);
        else if (hoverTarget.type === 'items') {
          clearHoverBoxes();
          for (const el of hoverTarget.items) if (el.isConnected) positionBox(takeBox(), el);
        } else if (hoverTarget.el.isConnected) {
          clearHoverBoxes();
          positionBox(takeBox(), hoverTarget.el);
        } else clearHover();
      }
      let detached = false;
      for (const [entry, boxes] of overlays) {
        boxes.forEach((b, i) => {
          const el = entry.items[i];
          if (el && el.isConnected) positionBox(b, el);
          else detached = true; // 失联元素：统一交 pruneDetached 处理
        });
      }
      if (detached) pruneDetached();
    });
  }

  /* ---------------- 采集盾（收集模式全屏拦截层） ---------------- */

  /** 采集盾：收集模式期间挂载的全屏透明层（z-index 仅低于面板宿主，面板不受影响）。
   *  动机：VitePress 等站点在 window 捕获阶段注册 click 路由拦截器——先于本扩展
   *  的 document 捕获监听执行，点击 <a> 包裹的元素（如 Element Plus 总览卡片）时
   *  直接 router.go() 编程式跳转，事件闸的 preventDefault/stopPropagation 到达时
   *  跳转已发起。盾层接管命中测试后，页面元素与任何层级的页面监听看到的 target
   *  都是盾层本身（不在 <a> 内），无从触发跳转，注册顺序不再相关；
   *  真实目标经 elementFromPoint 探测还原。wheel 不拦，滚动链到文档照常翻页 */
  function mountShield() {
    if (shield) return;
    shield = document.createElement('div');
    shield.style.cssText =
      'position:fixed;inset:0;z-index:2147483646;cursor:crosshair;background:transparent;';
    shield.addEventListener('mousemove', onShieldMove);
    document.documentElement.appendChild(shield);
  }

  function unmountShield() {
    if (!shield) return;
    shield.remove();
    shield = null;
  }

  /** 盾层命中探测：瞬间摘掉盾层 pointer-events 后按坐标取下方页面元素
   *  （同步恢复无闪烁）。探测点不会落在面板上——面板在盾层之上，
   *  其事件不会以盾层为目标 */
  function probeAt(x, y) {
    shield.style.pointerEvents = 'none';
    const el = document.elementFromPoint(x, y);
    shield.style.pointerEvents = '';
    return el;
  }

  /** 盾层 mousemove：探测真实元素并吸附高亮（拖拽面板期间跳过防闪烁；
   *  Ctrl 按下时预览严格签名范围，与点击收集口径一致） */
  function onShieldMove(e) {
    if (!manualMode || dragInfo) return;
    setManualHover(probeAt(e.clientX, e.clientY), e.ctrlKey || e.metaKey);
  }

  /** 收集模式悬浮吸附（页面直悬与盾层探测共用入口）：优先识别所在列表 →
   *  整表紫色高亮——悬浮即昭示点击将收集的范围（strict=true 时按严格签名，
   *  与 Ctrl+点击口径一致）；无列表上下文回退单候选高亮 */
  function setManualHover(el, strict) {
    clearHoverBoxes();
    if (!(el instanceof Element)) { hoverTarget = null; return; }
    const list = findContainingList(el, strict);
    if (list) {
      hoverTarget = { type: 'items', items: list.items };
      for (const it of list.items) if (it.isConnected) positionBox(takeBox(), it);
      return;
    }
    const item = pickItem(el);
    hoverTarget = item ? { type: 'el', el: item } : null;
    if (item) positionBox(takeBox(), item);
  }

  /* ---------------- 收集模式 ---------------- */

  function enterManual() {
    if (manualMode) return;
    manualMode = true;
    mountShield(); // 先挂盾再清悬浮：此后悬浮高亮一律走盾层探测
    clearHover();
    // 每次进入收集模式新建一个列表（可多次进出建立多个收集列表）
    const entry = { items: [], withLinks: false, preview: '', full: '', rowEl: null, flashT: 0 };
    entries.push(entry);
    currentManual = entry;
    syncEmpty();
    listEl.appendChild(buildRow(entry));
    setLiveBadge(entry, true);
    addBtn.classList.add('lde-on');
    addBtn.textContent = '完成收集';
    setHint('点击列表中任一元素收集整个列表，再次点击移除；Ctrl+点击只收同样式条目（Esc 结束）', 'var(--c-info)');
  }

  function exitManual() {
    if (!manualMode) return;
    manualMode = false;
    unmountShield(); // 摘盾后页面命中与交互恢复
    clearHover();
    addBtn.classList.remove('lde-on');
    addBtn.textContent = '＋ 添加选择';
    const entry = currentManual;
    currentManual = null;
    if (entry) {
      setLiveBadge(entry, false);
      if (!entry.items.length) {
        // 一条未收集：整行移除
        if (entry.rowEl) entry.rowEl.remove();
        const i = entries.indexOf(entry);
        if (i >= 0) entries.splice(i, 1);
        syncEmpty();
      }
    }
    resetHint();
  }

  function setLiveBadge(entry, on) {
    if (!entry.rowEl) return;
    const t = entry.rowEl.querySelector('.lde-tag-live');
    if (t) t.hidden = !on;
  }

  /** 收集模式核心：点击元素 → findContainingList 识别所在列表（真列表语义
   *  整表 / 同签名兄弟 ≥2；strict=true 时跳过语义规则只按严格签名——
   *  Ctrl+点击收同样式子集，如双列布局单收一列）整表收集为独立条目，
   *  条目经 visualOrder 列优先重排（双列交错 DOM 序还原阅读顺序）；
   *  同容器且条目与已有收集重叠的再次点击 → 整表移除（整表与严格子集
   *  共用容器，toggle 键须含条目重叠判断，单比容器会误删另一子集）；
   *  与其他列表条目重叠 → 提示不动作；无列表上下文的独立元素 → 回退
   *  pickItem 吸附后单条累积（v1.1 行为，进活动列表） */
  function collectToggle(el, strict) {
    const entry = currentManual;
    if (!entry) return;
    const list = findContainingList(el, strict);
    if (list) {
      const same = entries.find(en => en.container === list.container &&
        list.items.some(it => en.items.includes(it)));
      if (same) { // 再次点击同列表任一元素：整表移除
        if (selected.has(same)) removeSelected(same);
        if (same.rowEl) same.rowEl.remove();
        const i = entries.indexOf(same);
        if (i >= 0) entries.splice(i, 1);
        syncEmpty();
        setHint('已移除该列表（' + same.items.length + ' 条），继续点击或 Esc 结束', 'var(--c-info)');
        return;
      }
      if (list.items.some(it => entries.some(en => en.items.includes(it)))) {
        toast('所选列表的元素已在其他收集中', { type: 'info' });
        return;
      }
      const items = visualOrder(list.items); // 列优先：预览/徽标/导出行序一致
      const en = {
        container: list.container,
        items: items,
        withLinks: false,
        preview: previewOf(items),
        full: firstItemText(items),
        rowEl: null,
        flashT: 0
      };
      entries.push(en);
      syncEmpty();
      listEl.appendChild(buildRow(en));
      addSelected(en); // 收集即选中
      setHint('已收集列表 ' + en.items.length + ' 条，再次点击任一元素移除', 'var(--c-info)');
      return;
    }
    const item = pickItem(el);
    if (!item) return;
    const i = entry.items.indexOf(item);
    if (i >= 0) {
      entry.items.splice(i, 1);
      if (!entry.items.length && selected.has(entry)) removeSelected(entry);
      else if (selected.has(entry)) rebuildOverlay(entry);
      updateEntryRow(entry);
    } else if (entries.some(en => en !== entry && en.items.includes(item))) {
      toast('该元素已在其他收集中', { type: 'info' });
      return;
    } else {
      entry.items.push(item);
      if (selected.has(entry)) rebuildOverlay(entry);
      else addSelected(entry); // 收集第一条：列表进入选中态
      updateEntryRow(entry);
    }
    setHint('已收集 ' + entry.items.length + ' 条，继续点击或 Esc 结束', 'var(--c-info)');
  }

  /* ---------------- 面板拖拽 ---------------- */

  function onDragStart(e) {
    if (e.button !== 0 || e.target.closest('button')) return;
    const r = panelEl.getBoundingClientRect();
    dragInfo = { sx: e.clientX, sy: e.clientY, ox: r.left, oy: r.top };
    e.preventDefault();
  }

  function onDragMove(e) {
    if (!dragInfo) return;
    const w = panelEl.offsetWidth, h = panelEl.offsetHeight;
    const left = Math.min(Math.max(dragInfo.ox + e.clientX - dragInfo.sx, 0), Math.max(0, window.innerWidth - w));
    const top = Math.min(Math.max(dragInfo.oy + e.clientY - dragInfo.sy, 0), Math.max(0, window.innerHeight - 40));
    panelEl.style.left = left + 'px';
    panelEl.style.top = top + 'px';
    panelEl.style.right = 'auto'; // 脱离右侧默认贴边定位
  }

  function onDragEnd() {
    dragInfo = null;
  }

  /* ---------------- 导出 ---------------- */

  /** ArrayBuffer → base64：FileReader 原生编码（data URL 截到首个逗号） */
  function arrayBufferToBase64(buf) {
    return new Promise((resolve, reject) => {
      const fr = new FileReader();
      fr.onload = () => {
        const s = String(fr.result);
        resolve(s.slice(s.indexOf(',') + 1));
      };
      fr.onerror = () => reject(fr.error || new Error('base64 编码失败'));
      fr.readAsDataURL(new Blob([buf]));
    });
  }

  /** 让出主线程一拍：多列表导出的逐表间隙调用，生成期间页面可交互不冻结。
   *  MessageChannel 而非 setTimeout：后台标签页的定时器被节流会拖慢导出 */
  const yieldToMain = () => new Promise((resolve) => {
    const ch = new MessageChannel();
    ch.port1.onmessage = () => resolve();
    ch.port2.postMessage(0);
  });

  function downloadViaBlob(buf, name, mime) {
    const blob = new Blob([buf], { type: mime });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = name;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 5000);
  }

  function showError(msg) {
    toast(msg, { type: 'error' });
  }

  /** 导出成功保留面板不自动退出（可换格式连续导出），toast 提供「退出」动作 */
  function finish(n) {
    toast(n > 1 ? '已下载 ' + n + ' 个文件' : '已开始下载…', {
      type: 'success',
      actions: [{ label: '退出', onClick: exit }]
    });
  }

  /** 元素自身或内部第一个 <a> 的绝对地址（无则空串） */
  function firstHref(el) {
    const a = el.matches('a[href]') ? el : el.querySelector('a[href]');
    return a ? a.href : '';
  }

  /** 文件名长度钳制：按 Unicode 码点截断（防代理对被切成乱码） */
  function clampName(s, max) {
    const cps = Array.from(s);
    return cps.length > max ? cps.slice(0, max).join('') : s;
  }

  /** 导出文件名：base + 可选列表名后缀 + 按格式补扩展名；
   *  长度钳制（base ≤60 / 无后缀 ≤100 / 后缀 ≤40）防超长文件名 */
  function fileNamed(base, fmt, suffix) {
    let name = suffix ? clampName(base, 60) + '_' + clampName(sanitizeFilename(suffix), 40) : clampName(base, 100);
    if (!new RegExp('\\.' + fmt.ext + '$', 'i').test(name)) name += '.' + fmt.ext;
    return name.replace(/^\.+/, '');
  }

  /** 列表单元 → xlsx 单文件：多列表多 Sheet，单元格按文本写入（长数字/前导零不丢） */
  function buildXlsxFile(tables, base) {
    if (typeof XLSX === 'undefined') throw new Error('XLSX 库未加载');
    const fmt = FORMATS.xlsx;
    const wb = XLSX.utils.book_new();
    for (const t of tables) {
      const aoa = [t.withLinks ? ['内容', '链接'] : ['内容']];
      for (const r of t.rows) {
        aoa.push(t.withLinks ? [r.content, r.link || ''] : [r.content]);
      }
      const ws = XLSX.utils.aoa_to_sheet(aoa);
      ws['!cols'] = autoColWidths(aoa); // 列宽随内容自适应（中文双宽估算，钳制 6~50）
      XLSX.utils.book_append_sheet(wb, ws, t.name);
    }
    return {
      name: fileNamed(base, fmt, ''),
      mime: fmt.mime,
      buf: XLSX.write(wb, { bookType: 'xlsx', type: 'array' })
    };
  }

  /** 列表单元 → 文本格式文件列表：CSV 多列表拆多文件（单文件无法承载多列表）；
   *  json/md/html 汇总为单文件（多列表经列表名分区/嵌套） */
  function buildTextFiles(fmtKey, base, tables) {
    const fmt = FORMATS[fmtKey];
    const enc = new TextEncoder();
    if (fmtKey === 'csv') {
      return tables.map(t => ({
        name: fileNamed(base, fmt, tables.length > 1 ? t.name : ''),
        mime: fmt.mime,
        buf: enc.encode(toCsv(t))
      }));
    }
    let text;
    if (fmtKey === 'json') text = toJson(tables);
    else if (fmtKey === 'md') text = toMarkdown(tables);
    else text = toHtmlDocument(tables, base);
    return [{ name: fileNamed(base, fmt, ''), mime: fmt.mime, buf: enc.encode(text) }];
  }

  /** 单文件下载：base64 经后台 chrome.downloads（不受页面 CSP 限制），失败回退 blob */
  function downloadFile(b64, file) {
    return new Promise((resolve) => {
      const fallback = (e) => {
        console.error('[LDE] 后台下载失败，回退 blob 下载：', e);
        downloadViaBlob(file.buf, file.name, file.mime);
        resolve();
      };
      try {
        chrome.runtime.sendMessage(
          { type: 'lde-download', data: b64, filename: file.name, mime: file.mime },
          (resp) => {
            const err = chrome.runtime.lastError;
            if (!err && resp && resp.ok) { resolve(); return; }
            fallback(err || resp);
          }
        );
      } catch (err) {
        // 扩展上下文失效（如开发中重新加载了扩展）时 sendMessage 会同步抛错
        fallback(err);
      }
    });
  }

  async function doExport() {
    if (exporting || !active) return;
    // 快照导出范围：已选且非空的收集列表（yield 间隙的 prune 不影响本次范围）
    const list = [...selected].filter(en => en.items.length);
    if (!list.length) return;
    exporting = true; // await 让出主线程期间防重入
    exportBtn.disabled = true;
    exportBtn.textContent = '导出中…';
    setHint('正在生成导出文件…', 'var(--c-info)');
    try {
      // 1. 逐表取数（导出时实时取元素文本，prune 期间不剔除）：
      //    按 Sheet 组聚合——Ctrl 并组（groupId 相同）的多条目拼接为同一个表，
      //    组内行序 = 选择序；链接列口径 = 组内任一条目勾选「附链接」即有该列，
      //    未勾选条目的行链接留空
      const groups = [];
      const byGid = new Map();
      for (const en of list) {
        let g = byGid.get(en.groupId);
        if (!g) { g = []; byGid.set(en.groupId, g); groups.push(g); }
        g.push(en);
      }
      const tables = [];
      let i = 0;
      for (const g of groups) {
        if (!active) return; // yield 间隙用户可能已退出，放弃导出
        const withLinks = g.some(en => en.withLinks);
        const rows = [];
        for (const en of g) {
          for (const el of en.items) {
            rows.push({
              content: normalizeText(el.textContent),
              link: en.withLinks ? firstHref(el) : ''
            });
          }
        }
        tables.push({ name: makeListName(i++), rows: rows, withLinks: withLinks });
        await yieldToMain(); // 每表之间让出主线程：多表导出期间页面不冻结
      }

      // 2. 按所选格式生成下载文件列表（CSV 多列表为多文件，其余单文件）
      const fmtKey = FORMATS[fmtSel.value] ? fmtSel.value : 'xlsx';
      const base = sanitizeFilename(nameInput.value) || ('export_' + timestamp());
      let files;
      try {
        files = fmtKey === 'xlsx' ? [buildXlsxFile(tables, base)] : buildTextFiles(fmtKey, base, tables);
      } catch (err) {
        console.error('[LDE] 生成导出文件失败：', err);
        showError('导出失败：' + (err && err.message ? err.message : err));
        return;
      }

      // 3. 逐文件编码下载（后台 downloads 优先，失败回退 blob）；多文件时进度复用同一条 toast
      let pt = null;
      if (files.length > 1) pt = toast('正在下载 1/' + files.length + '…', { type: 'info', sticky: true });
      for (let fi = 0; fi < files.length; fi++) {
        if (!active) return; // 编码间隙用户已退出，放弃下载
        if (pt) pt.update('正在下载 ' + (fi + 1) + '/' + files.length + '…');
        await downloadFile(await arrayBufferToBase64(files[fi].buf), files[fi]);
        await yieldToMain();
      }
      if (pt) pt.close();
      finish(files.length);
    } finally {
      exporting = false;
      syncExportBtn();
      updateBar();
      if (active) resetHint();
    }
  }

  /* ---------------- 退出与清理 ---------------- */

  /** 图标再点语义：面板可见 → 收起（选择会话保留）；已收起 → 退出 */
  function collapse() {
    if (collapsed) return;
    if (manualMode) exitManual(); // 面板收起后无法继续收集，先结束活动列表
    collapsed = true;
    panelEl.style.display = 'none';
    clearHover();
  }

  function exit() {
    if (!active) return;
    active = false;
    manualMode = false;
    collapsed = false;
    unmountShield(); // 兜底：异常路径退出时确保摘除
    document.removeEventListener('mouseover', onPageOver, true);
    document.removeEventListener('click', onPageClick, true);
    document.removeEventListener('keydown', onKeyDown, true);
    GUARD_EVENTS.forEach(t => document.removeEventListener(t, onPageGuard, true));
    document.removeEventListener('scroll', onReposition, true);
    window.removeEventListener('resize', onReposition);
    document.removeEventListener('mousemove', onDragMove);
    document.removeEventListener('mouseup', onDragEnd);
    if (rafId) cancelAnimationFrame(rafId);
    if (host) host.remove();
    selected.clear();
    overlays.clear();
    entries = [];
    currentManual = null;
    boxPool = [];
    window.__listDataExporter = null;
  }

  window.__listDataExporter = { toggle: () => { collapsed ? exit() : collapse(); } };

  /* ---------------- 启动 ---------------- */

  buildUI();
  syncEmpty();
  syncExportBtn();
  updateBar();
  resetHint();
  document.addEventListener('mouseover', onPageOver, true);
  document.addEventListener('click', onPageClick, true);
  document.addEventListener('keydown', onKeyDown, true);
  GUARD_EVENTS.forEach(t => document.addEventListener(t, onPageGuard, true));
  document.addEventListener('scroll', onReposition, true);
  window.addEventListener('resize', onReposition);
  document.addEventListener('mousemove', onDragMove);
  document.addEventListener('mouseup', onDragEnd);
})();
