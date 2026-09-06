/**
 * 导出格式序列化（纯函数，零 DOM 依赖）：CSV / JSON / Markdown / HTML
 * 数据模型（v1.4 多列）：表 = { name, columns: string[], rows: string[][] }
 *   columns 为列名（无字段定义时 = 单列「内容」；定义字段后 = 各字段名）
 *   rows 为二维单元格数组，行 = 一个已收集条目，列 = 一个字段（缺失为空串）
 *   CSV 多列表由调用方拆多文件；单元格一律按字符串处理，null/undefined 视为空
 * 依赖：util.escapeHtml；算法层模块，经 __lde.format 挂载
 */
(() => {
  'use strict';
  const ns = window.__lde;
  const { escapeHtml } = ns.util;

  /** 表头列名：columns（缺省单列「内容」——无字段定义时的旧行为） */
  function headersOf(table) {
    return (table && table.columns && table.columns.length) ? table.columns : ['内容'];
  }

  /** 数据行 → 单元格数组（缺列补空串，保证与表头等长） */
  function rowCells(r, cols) {
    return cols.map((_, i) => (r && r[i] != null ? String(r[i]) : ''));
  }

  /* ---------------- CSV（RFC 4180 + BOM + CRLF，Excel 可直接识别 UTF-8） ---------------- */

  /** 单元格转义：含逗号/引号/换行时双引号包裹，内部引号翻倍 */
  function csvCell(v) {
    const s = v == null ? '' : String(v);
    return /[",\r\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  }

  function toCsv(table) {
    const cols = headersOf(table);
    const lines = [cols.map(csvCell).join(',')];
    for (const r of table.rows) {
      lines.push(rowCells(r, cols).map(csvCell).join(','));
    }
    return '\ufeff' + lines.join('\r\n') + '\r\n';
  }

  /* ---------------- JSON ---------------- */

  /** 行对象数组：键为列名（无字段定义 = 「内容」） */
  function rowObjects(table) {
    const cols = headersOf(table);
    return table.rows.map(r => {
      const obj = {};
      cols.forEach((c, i) => { obj[c] = r && r[i] != null ? String(r[i]) : ''; });
      return obj;
    });
  }

  /** JSON 文档：单列表 = 行对象数组；多列表 = 列表名键嵌套 */
  function toJson(tables) {
    if (tables.length === 1) {
      return JSON.stringify(rowObjects(tables[0]), null, 2);
    }
    const doc = {};
    tables.forEach(t => { doc[t.name] = rowObjects(t); });
    return JSON.stringify(doc, null, 2);
  }

  /* ---------------- Markdown（GFM 表格） ---------------- */

  /** 单元格：竖线转义、换行转 <br>（GFM 单元格内不能有裸换行） */
  function mdCell(v) {
    return String(v == null ? '' : v)
      .replace(/\r/g, '')
      .replace(/\n/g, '<br>')
      .replace(/\|/g, '\\|');
  }

  /** Markdown 文档：多列表以二级标题分区 */
  function toMarkdown(tables) {
    const parts = tables.map(t => {
      const cols = headersOf(t);
      const lines = [
        '## ' + t.name,
        '',
        '| ' + cols.map(mdCell).join(' | ') + ' |',
        '| ' + cols.map(() => '---').join(' | ') + ' |'
      ];
      for (const r of t.rows) {
        lines.push('| ' + rowCells(r, cols).map(mdCell).join(' | ') + ' |');
      }
      return lines.join('\n');
    });
    return parts.join('\n\n') + '\n';
  }

  /* ---------------- HTML ---------------- */

  /** 单列表 HTML 片段：表头行入 thead（th），数据行入 tbody（td） */
  function htmlTable(t) {
    const cols = headersOf(t);
    let html = '<h2>' + escapeHtml(t.name) + '</h2>\n<table>\n<thead>\n<tr>' +
      cols.map(h => '<th>' + escapeHtml(h) + '</th>').join('') + '</tr>\n</thead>\n<tbody>\n';
    for (const r of t.rows) {
      html += '<tr>' + rowCells(r, cols)
        .map(v => '<td>' + escapeHtml(v == null ? '' : String(v)) + '</td>')
        .join('') + '</tr>\n';
    }
    return html + '</tbody>\n</table>';
  }

  /** HTML 完整文档（UTF-8 声明 + 极简样式，多列表串接，浏览器直接打开） */
  function toHtmlDocument(tables, title) {
    return [
      '<!DOCTYPE html>',
      '<html>',
      '<head>',
      '<meta charset="utf-8">',
      '<title>' + escapeHtml(title || '导出列表') + '</title>',
      '<style>body{font:14px/1.6 -apple-system,"Segoe UI","Microsoft YaHei",sans-serif;color:#333;margin:24px;}h2{font-size:18px;margin:24px 0 8px;}table{border-collapse:collapse;}th,td{border:1px solid #ccc;padding:6px 12px;text-align:left;}th{background:#f5f7fa;}</style>',
      '</head>',
      '<body>',
      tables.map(htmlTable).join('\n'),
      '</body>',
      '</html>'
    ].join('\n');
  }

  ns.format = {
    headersOf: headersOf,
    rowCells: rowCells,
    csvCell: csvCell,
    toCsv: toCsv,
    rowObjects: rowObjects,
    toJson: toJson,
    mdCell: mdCell,
    toMarkdown: toMarkdown,
    toHtmlDocument: toHtmlDocument
  };
})();
