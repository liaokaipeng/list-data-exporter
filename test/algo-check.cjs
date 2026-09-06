/**
 * 回归测试：util / detect 纯函数 / field 纯函数 / format 序列化（Node 直接运行，零依赖）
 * 内容脚本经 window.__lde 命名空间挂载（零构建无模块系统），此处模拟浏览器
 * 全局后按依赖序加载（util → detect → field → format），仅覆盖可离线回归的纯函数；
 * pickItem / findContainingList / describeItem / fieldFromSample（依赖 DOM）与 UI 层
 * 走 test/fixture.html 浏览器回归。
 */
'use strict';
const path = require('path');
const fs = require('fs');

// 模拟浏览器全局：模块经 window.__lde 命名空间挂载
global.window = { __lde: {} };

const dir = path.join(__dirname, '..', 'extension', 'content');
for (const f of ['util.js', 'detect.js', 'field.js', 'format.js']) {
  new Function(fs.readFileSync(path.join(dir, f), 'utf8'))();
}
const { util, detect, field, format } = window.__lde;

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

// orderFromRects：列优先视觉排序（双列交错 DOM 序还原阅读顺序）
const rectL = t => ({ left: 0, right: 100, top: t, width: 100, height: 20 });   // 左列条目
const rectR = t => ({ left: 120, right: 220, top: t, width: 100, height: 20 }); // 右列条目
ok(JSON.stringify(detect.orderFromRects([])) === '[]', 'orderFromRects 空序列');
ok(JSON.stringify(detect.orderFromRects([rectL(0)])) === '[0]', 'orderFromRects 单元素');
ok(JSON.stringify(detect.orderFromRects([rectL(0), rectL(30)])) === '[0,1]', 'orderFromRects 单列保持原序');
// 双列交错 DOM 序（0,5,1,6,2,7,3,8,4,9 → 左列 0-4 自上而下，再右列 5-9）
const striped = [rectL(0), rectR(0), rectL(30), rectR(30), rectL(60), rectR(60), rectL(90), rectR(90), rectL(120), rectR(120)];
ok(JSON.stringify(detect.orderFromRects(striped)) === JSON.stringify([0, 2, 4, 6, 8, 1, 3, 5, 7, 9]),
  'orderFromRects 双列交错还原列优先序');
// 零尺寸（display:none）不参与聚列，按原相对序排末尾
ok(JSON.stringify(detect.orderFromRects([{ left: 0, right: 0, top: 0, width: 0, height: 0 }, rectL(0)])) === '[1,0]',
  'orderFromRects 零尺寸排末尾');
// 三列网格同样按列分组
const grid = [rectL(0), { left: 240, right: 340, top: 0, width: 100, height: 20 }, rectR(0)];
ok(JSON.stringify(detect.orderFromRects(grid)) === '[0,2,1]', 'orderFromRects 三列网格按 x 分列');

/* ---------------- field 纯函数（字段提取） ---------------- */

// 稳定 class/id 判定：hash、状态类、纯数字均不可作为选择器标识
ok(field.isStableClass('card') === true, 'isStableClass 普通类名稳定');
ok(field.isStableClass('cmt-title') === true, 'isStableClass 带前缀类名稳定');
ok(field.isStableClass('sc-1a2b3c') === false, 'isStableClass hash 类不稳定');
ok(field.isStableClass('css-x1y2z3') === false, 'isStableClass CSS-in-JS 类不稳定');
ok(field.isStableClass('_3fJk9Q') === false, 'isStableClass 随机下划线类不稳定');
ok(field.isStableClass('odd') === false, 'isStableClass 条纹类不稳定');
ok(field.isStableClass('is-active') === false, 'isStableClass 状态类不稳定');
ok(field.isStableClass('a') === false, 'isStableClass 单字符类不稳定');
ok(field.isStableId('comment-1') === true, 'isStableId 语义 id 稳定');
ok(field.isStableId('12') === false, 'isStableId 纯数字不稳定');
ok(field.isStableId('a1b2c3d4') === false, 'isStableId 十六进制串不稳定');

ok(JSON.stringify(field.splitWords('cmt-title')) === '["cmt","title"]', 'splitWords 连字符切分');
ok(JSON.stringify(field.splitWords('userName')) === '["user","name"]', 'splitWords camelCase 切分');

// 字段名猜测：class 语义词 → 标签语义 → 文本形态 → 回退
ok(field.guessFieldName([{ tag: 'span', cls: 'cmt-author', id: '', text: '张三' }]) === '作者', 'guessFieldName author → 作者');
ok(field.guessFieldName([{ tag: 'time', cls: 'cmt-date', id: '', text: '2026-03-12' }]) === '日期', 'guessFieldName date → 日期');
ok(field.guessFieldName([{ tag: 'h3', cls: 'cmt-title', id: '', text: '标题' }]) === '标题', 'guessFieldName title → 标题');
ok(field.guessFieldName([{ tag: 'p', cls: 'cmt-body', id: '', text: '正文' }]) === '内容', 'guessFieldName body → 内容');
ok(field.guessFieldName([{ tag: 'a', cls: 'cmt-link', id: '', text: '原文' }]) === '链接', 'guessFieldName link → 链接');
ok(field.guessFieldName([{ tag: 'span', cls: 'cmt-like', id: '', text: '128 赞' }]) === '点赞', 'guessFieldName like → 点赞');
ok(field.guessFieldName([{ tag: 'h2', cls: '', id: '', text: '无语义类名' }]) === '标题', 'guessFieldName h2 标签 → 标题');
ok(field.guessFieldName([{ tag: 'time', cls: '', id: '', text: '2026-03-12' }]) === '日期', 'guessFieldName time 标签 → 日期');
ok(field.guessFieldName([{ tag: 'span', cls: 'x1y2', id: '', text: '刚刚' }]) === '日期', 'guessFieldName 相对时间文本 → 日期');
ok(field.guessFieldName([{ tag: 'span', cls: 'x1y2', id: '', text: '1,024' }]) === '数量', 'guessFieldName 纯数字文本 → 数量');
ok(field.guessFieldName([{ tag: 'span', cls: 'x1y2', id: '', text: '@张三' }]) === '作者', 'guessFieldName @ 文本 → 作者');
ok(field.guessFieldName([{ tag: 'span', cls: 'x1y2', id: '', text: '随便' }]) === '字段', 'guessFieldName 无信号 → 字段');
ok(field.guessFieldName([]) === '字段', 'guessFieldName 空样本 → 字段');

const usedN = ['标题'];
ok(field.uniqueName('标题', usedN) === '标题2', 'uniqueName 重名加序号');
ok(field.uniqueName('作者', usedN) === '作者', 'uniqueName 不重名原样');

ok(field.pathToSelector('DIV[1]/H3[2]') === ':scope div:nth-of-type(1) h3:nth-of-type(2)',
  'pathToSelector 结构路径 → CSS');
ok(field.pathToSelector('') === '', 'pathToSelector 空路径');

// 候选择优选优：命中条目数优先，平局取分数高者（更具体）
ok(field.pickBestSelector([
  { sel: 'a', hits: 3, score: 90 },
  { sel: 'b', hits: 5, score: 60 },
  { sel: 'c', hits: 5, score: 40 }
]).sel === 'b', 'pickBestSelector 命中优先、平局取高分');
ok(field.pickBestSelector([]) === null, 'pickBestSelector 空候选');

// 跨条目结构对齐（条目描述 → 候选字段）
const descA = [
  { path: 'SPAN[1]', sig: 'SPAN|cmt-author', text: '张三', order: 0, tag: 'span', id: '', cls: 'cmt-author' },
  { path: 'TIME[1]', sig: 'TIME|cmt-date', text: '2026-03-12', order: 1, tag: 'time', id: '', cls: 'cmt-date' },
  { path: 'H3[1]', sig: 'H3|cmt-title', text: '标题A', order: 2, tag: 'h3', id: '', cls: 'cmt-title' },
  { path: 'P[1]', sig: 'P|only-a', text: '仅首条有', order: 3, tag: 'p', id: '', cls: 'only-a' }
];
const descB = [
  { path: 'SPAN[1]', sig: 'SPAN|cmt-author', text: '李四', order: 0, tag: 'span', id: '', cls: 'cmt-author' },
  { path: 'TIME[1]', sig: 'TIME|cmt-date', text: '2026-03-13', order: 1, tag: 'time', id: '', cls: 'cmt-date' },
  { path: 'H3[1]', sig: 'H3|cmt-title', text: '标题B', order: 2, tag: 'h3', id: '', cls: 'cmt-title' }
];
const sug = field.suggestFields([descA, descB]);
ok(sug.length === 3, 'suggestFields 低频路径被过滤（仅 1 条出现的 P[1] 不入选）');
ok(sug.map(s => s.name).join(',') === '作者,日期,标题', 'suggestFields 按条目内阅读顺序出列');
ok(sug[0].path === 'SPAN[1]' && sug[0].coverage === 1, 'suggestFields 覆盖率统计');
// 祖先无自身文本且存在有文本的后代候选 → 丢弃祖先（避免重复列）
const descC = [
  { path: 'DIV[1]', sig: 'DIV|wrap', text: '', order: 0, tag: 'div', id: '', cls: 'wrap' },
  { path: 'DIV[1]/SPAN[1]', sig: 'SPAN|t', text: '标题', order: 1, tag: 'span', id: '', cls: 't' }
];
const sug2 = field.suggestFields([descC, descC.map(d => Object.assign({}, d))]);
ok(sug2.length === 1 && sug2[0].path === 'DIV[1]/SPAN[1]', 'suggestFields 无文本祖先让位后代');
ok(field.suggestFields([]).length === 0, 'suggestFields 空条目');

// data-hook 跨条目值一致 → 输出 hook（供生成 [data-hook=xxx] 稳定选择器）
const descHook = [
  { path: 'SPAN[1]', sig: 'SPAN|a', text: '张三', order: 0, tag: 'span', id: '', cls: 'a', hook: 'reviewTitle' },
  { path: 'TIME[1]', sig: 'TIME|b', text: '2026', order: 1, tag: 'time', id: '', cls: 'b', hook: 'review-date' }
];
const descHook2 = descHook.map(d => Object.assign({}, d, { text: d.text + '2' }));
const sugHook = field.suggestFields([descHook, descHook2]);
ok(sugHook[0].hook === 'reviewTitle' && sugHook[1].hook === 'review-date', 'suggestFields 稳定 data-hook 输出 hook');
// hook 各条不一致（动态值）→ 不输出 hook（两条目同路径不同 hook）
const descHookBad = [[
  { path: 'SPAN[1]', sig: 'SPAN|a', text: 'x', order: 0, tag: 'span', id: '', cls: 'a', hook: 'r-123' }
], [
  { path: 'SPAN[1]', sig: 'SPAN|a', text: 'y', order: 0, tag: 'span', id: '', cls: 'a', hook: 'r-456' }
]];
ok(field.suggestFields(descHookBad).length === 1 && field.suggestFields(descHookBad)[0].hook === '',
  'suggestFields 动态 hook 值不输出');

ok(JSON.stringify(field.columnsOf(null)) === '["内容"]', 'columnsOf 无字段 = 单列内容');
ok(JSON.stringify(field.columnsOf([{ name: '标题' }, { name: '日期' }])) === '["标题","日期"]', 'columnsOf 字段名即列名');

/* ---------------- format（多列模型：columns + rows 二维数组） ---------------- */

const t1 = {
  name: '评论',
  columns: ['内容', '链接'],
  rows: [
    ['hello, "world"', 'https://a/b'],
    ['line1\nline2', '']
  ]
};
const t2 = { name: '公告', columns: ['内容'], rows: [['a|b']] };
const t3 = { name: '字段表', columns: ['标题', '日期'], rows: [['A', '2026-03-12'], ['B']] };

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

// 多列（字段定义）：表头 = 字段名，缺列补空串
ok(format.toCsv(t3).split('\r\n')[0] === '\ufeff标题,日期', 'CSV 表头 = 字段名');
ok(format.toCsv(t3).split('\r\n')[2] === 'B,', 'CSV 缺列补空');
const j3 = JSON.parse(format.toJson([t3]));
ok(j3[0]['标题'] === 'A' && j3[0]['日期'] === '2026-03-12' && j3[1]['日期'] === '', 'JSON 键 = 字段名、缺失为空串');
ok(format.toMarkdown([t3]).includes('| 标题 | 日期 |'), 'MD 表头 = 字段名');
ok(format.toHtmlDocument([t3], 'x').includes('<th>标题</th>'), 'HTML 表头 = 字段名');
ok(format.rowCells(['A'], ['标题', '日期']).join('|') === 'A|', 'rowCells 缺列补空');

console.log('PASS: ' + passed + ' 项断言通过（util / detect / field / format 纯函数回归）');
