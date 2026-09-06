/**
 * 回归测试：util / detect 纯函数 / format 序列化（Node 直接运行，零依赖）
 * 内容脚本经 window.__lde 命名空间挂载（零构建无模块系统），此处模拟浏览器
 * 全局后按依赖序加载（util → detect → format），仅覆盖可离线回归的纯函数；
 * pickItem / findContainingList（依赖 DOM）与 UI 层走 test/fixture.html 浏览器回归。
 */
'use strict';
const path = require('path');
const fs = require('fs');

// 模拟浏览器全局：模块经 window.__lde 命名空间挂载
global.window = { __lde: {} };

const dir = path.join(__dirname, '..', 'extension', 'content');
for (const f of ['util.js', 'detect.js', 'format.js']) {
  new Function(fs.readFileSync(path.join(dir, f), 'utf8'))();
}
const { util, detect, format } = window.__lde;

let passed = 0;
function ok(cond, msg) {
  if (!cond) {
    console.error('FAIL: ' + msg);
    process.exit(1);
  }
  passed++;
}

/* ---------------- util ---------------- */

ok(/^\d{8}-\d{6}$/.test(util.timestamp()), 'timestamp 格式 yyyymmdd-hhmmss');
ok(util.sanitizeFilename('a/b:c*d?e"f<g>h|i') === 'a_b_c_d_e_f_g_h_i', 'sanitizeFilename 过滤非法字符');
ok(util.sanitizeFilename('  名字  ') === '名字', 'sanitizeFilename 去首尾空白');
ok(util.normalizeText('  4722   PHP\n换行\t制表 ') === '4722 PHP 换行 制表', 'normalizeText 换行/连续空格合并');
ok(util.normalizeText('a\u00a0\u00a0b') === 'a b', 'normalizeText nbsp 归一');
ok(util.truncate('1234567890', 5) === '12345…', 'truncate 截断加省略号');
ok(util.truncate('123', 5) === '123', 'truncate 不超长原样');
ok(util.visualWidth('中文ab') === 6, 'visualWidth CJK 双宽');
ok(util.visualWidth('ｆｕｌｌ') === 8, 'visualWidth 全角双宽');
ok(util.autoColWidths([['ab']])[0].wch === 6, 'autoColWidths 下限 6');
ok(util.autoColWidths([['x'.repeat(80)]])[0].wch === 50, 'autoColWidths 上限 50');
ok(util.escapeHtml('<a href="x">&\'') === '&lt;a href=&quot;x&quot;&gt;&amp;&#39;', 'escapeHtml');

/* ---------------- detect 纯函数（手动收集模型） ---------------- */

ok(detect.makeListName(0) === '收集1', 'makeListName 收集N 命名');
ok(detect.makeListName(2) === '收集3', 'makeListName 序号递增');
ok(detect.elSig({ tagName: 'DIV', classList: ['card', 'is-hover'] }) === 'DIV|card.is-hover', 'elSig class 排序稳定');
ok(detect.elSig({ tagName: 'A', classList: [] }) === 'A', 'elSig 无 class 仅 tagName');
ok(detect.firstItemText([{ textContent: '  hello   world ' }]) === 'hello world', 'firstItemText 归一化');
ok(detect.firstItemText([]) === '', 'firstItemText 空列表');
ok(detect.previewOf([{ textContent: 'x'.repeat(50) }]).length === 41, 'previewOf 截断 40 字符 + 省略号');
ok(detect.previewOf([{ textContent: '  4722   PHP  ' }]) === '4722 PHP', 'previewOf 归一化首条');

/* ---------------- format ---------------- */

const t1 = {
  name: '评论',
  withLinks: true,
  rows: [
    { content: 'hello, "world"', link: 'https://a/b' },
    { content: 'line1\nline2', link: '' }
  ]
};
const t2 = { name: '公告', withLinks: false, rows: [{ content: 'a|b', link: null }] };

// CSV：BOM + RFC4180 转义 + CRLF
const csv = format.toCsv(t1);
ok(csv.startsWith('\ufeff'), 'CSV UTF-8 BOM');
ok(csv.includes('"hello, ""world"""'), 'CSV 逗号/引号转义');
ok(csv.includes('"line1\nline2"'), 'CSV 换行双引号包裹');
ok(csv.includes('\r\n'), 'CSV CRLF 行尾');
ok(csv.split('\r\n')[0] === '\ufeff内容,链接', 'CSV 表头含链接列');
ok(format.toCsv(t2).split('\r\n')[0] === '\ufeff内容', 'CSV 无链接列表头仅内容');

// JSON：单列表行对象数组 / 多列表名键嵌套
const j1 = JSON.parse(format.toJson([t2]));
ok(Array.isArray(j1) && j1[0]['内容'] === 'a|b' && !('链接' in j1[0]), 'JSON 单列表行对象、无链接键');
const j2 = JSON.parse(format.toJson([t1, t2]));
ok(Array.isArray(j2['评论']) && j2['评论'][0]['链接'] === 'https://a/b' && j2['公告'].length === 1, 'JSON 多列表嵌套');

// Markdown：二级标题分区 + 竖线转义 + 换行转 <br>
const md = format.toMarkdown([t1, t2]);
ok(md.includes('## 评论') && md.includes('## 公告'), 'MD 二级标题分区');
ok(md.includes('a\\|b'), 'MD 竖线转义');
ok(md.includes('line1<br>line2'), 'MD 换行转 <br>');
ok(md.includes('| --- | --- |'), 'MD 分隔行与链接列对齐');

// HTML：完整文档 + 转义
const html = format.toHtmlDocument([t1], '测试');
ok(html.startsWith('<!DOCTYPE html>') && html.includes('<meta charset="utf-8">'), 'HTML 文档结构与编码声明');
ok(html.includes('&lt;h2&gt;') === false && html.includes('<h2>评论</h2>'), 'HTML 列表名标题');
ok(html.includes('&quot;world&quot;'), 'HTML 内容转义');
ok(html.includes('<th>链接</th>'), 'HTML 链接列表头');

console.log('PASS: ' + passed + ' 项断言通过（util / detect / format 纯函数回归）');
