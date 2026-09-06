/** 通用工具函数（零依赖，纯函数可离线回归） */
(() => {
  'use strict';
  const ns = window.__lde;

  const pad = (n) => String(n).padStart(2, '0');

  /** 时间戳 yyyymmdd-hhmmss（导出文件名默认后缀） */
  function timestamp() {
    const d = new Date();
    return (
      d.getFullYear() + pad(d.getMonth() + 1) + pad(d.getDate()) + '-' +
      pad(d.getHours()) + pad(d.getMinutes()) + pad(d.getSeconds())
    );
  }

  /** 文件名清洗：过滤 Windows 非法字符，去首尾空白 */
  function sanitizeFilename(s) {
    return (s || '').replace(/[\\/:*?"<>|]/g, '_').trim();
  }

  /** HTML 转义（面板 innerHTML 插值防注入） */
  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, ch => (
      { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]
    ));
  }

  /** 条目文本视觉归一化：换行/Tab/nbsp/连续空格合并为单个空格（如「4722 PHP」） */
  function normalizeText(s) {
    return String(s == null ? '' : s)
      .replace(/[\r\n\t]+/g, ' ')
      .replace(/\u00a0/g, ' ')
      .replace(/ {2,}/g, ' ')
      .trim();
  }

  /** 截断预览文案：超过 max 字符以 … 结尾 */
  function truncate(s, max) {
    s = String(s == null ? '' : s);
    return s.length > max ? s.slice(0, max) + '…' : s;
  }

  /** 视觉宽度：CJK/全角按 2、半角按 1（xlsx 列宽估算口径，与 web-table-exporter 一致） */
  function visualWidth(s) {
    let w = 0;
    for (const ch of String(s)) {
      const code = ch.codePointAt(0);
      const wide = (
        (code >= 0x1100 && code <= 0x115f) ||
        (code >= 0x2e80 && code <= 0xa4cf) ||
        (code >= 0xac00 && code <= 0xd7a3) ||
        (code >= 0xf900 && code <= 0xfaff) ||
        (code >= 0xfe30 && code <= 0xfe4f) ||
        (code >= 0xff00 && code <= 0xff60) ||
        (code >= 0xffe0 && code <= 0xffe6) ||
        (code >= 0x3000 && code <= 0x303e)
      );
      w += wide ? 2 : 1;
    }
    return w;
  }

  /** xlsx 列宽自适应：逐列取最大视觉宽度，钳制 [6, 50]（wch 字符数）——
   *  下限防窄列挤成一条线，上限防超长内容撑爆版面 */
  function autoColWidths(aoa) {
    const rows = aoa || [];
    if (!rows.length) return [];
    const cols = [];
    for (const row of rows) {
      if (!row) continue;
      for (let c = 0; c < row.length; c++) {
        const w = visualWidth(row[c] == null ? '' : String(row[c]));
        cols[c] = Math.max(cols[c] || 0, w);
      }
    }
    return cols.map(w => ({ wch: Math.min(50, Math.max(6, w)) }));
  }

  ns.util = {
    timestamp: timestamp,
    sanitizeFilename: sanitizeFilename,
    escapeHtml: escapeHtml,
    normalizeText: normalizeText,
    truncate: truncate,
    visualWidth: visualWidth,
    autoColWidths: autoColWidths
  };
})();
