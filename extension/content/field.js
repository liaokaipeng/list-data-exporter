/**
 * 字段提取（v1.4）：把已收集条目内部的子信息拆成导出的多列
 * 字段 = { name, sel, alt, type, attr, name2? }
 *   sel  相对条目根的选择器（:scope 起、后代匹配，跨条目验证后取最优候选）
 *   alt  结构索引回退 { order, sig }——条目内 DFS 序号 + 元素签名，
 *        hash class 站点（CSS-in-JS）选择器不稳定时兜底
 *   type 取值类型：text（默认，归一化文本）/ link（a[href] 绝对地址）/
 *        image（img src）/ attr（指定属性）
 * 两条产出路径：
 *   ① 手动点选：在样本条目内点击元素 → fieldFromSample 生成选择器 →
 *      在其余条目上验证命中率 → 存为字段
 *   ② 自动识别：describeItem 逐条目枚举内容节点 → suggestFields 跨条目结构
 *      对齐（同路径出现 ≥60%）→ 候选字段（用户勾选确认，不静默应用）
 * 纯函数（isStableClass / isStableId / guessFieldName / pickBestSelector /
 * suggestFields / columnsOf）经 __lde.field 挂载，algo-check.cjs 离线回归；
 * DOM 部分（describeItem / fieldFromSample / extractCells）走浏览器回归。
 * 依赖：util.normalizeText、detect.elSig
 */
(() => {
  'use strict';
  const ns = window.__lde;
  const { normalizeText } = ns.util;
  const { elSig } = ns.detect;

  // 不参与字段枚举的标签（非内容 / 不可见结构）
  const SKIP_TAGS = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE', 'SVG', 'CANVAS', 'IFRAME', 'BR', 'HR', 'BUTTON']);

  // 正文语义的 data-hook / 属性值（用于识别"多段正文容器"，非站点特定）
  const BODY_HOOK_RE = /(content|body|text|desc|message|comment|richtext|reviewtext)/i;

  /** 节点是否隐藏（textContent 不该被枚举）：hidden 属性 / aria-hidden=true /
   *  inline style display:none / 计算样式 display:none（覆盖 .a-hidden、.hidden 等
   *  任何 CSS class 控制的隐藏，不绑定具体站点）。隐藏子树整段不枚举，
   *  避免折叠提示文案（如"点击展开全文"）污染候选 */
  function isHidden(el) {
    if (!el || el.nodeType !== 1) return false;
    if (el.hasAttribute && el.hasAttribute('hidden')) return true;
    if (el.getAttribute && el.getAttribute('aria-hidden') === 'true') return true;
    const s = el.getAttribute && el.getAttribute('style');
    if (s && /display\s*:\s*none/i.test(s)) return true;
    try {
      const w = el.ownerDocument && el.ownerDocument.defaultView;
      if (w && w.getComputedStyle && w.getComputedStyle(el).display === 'none') return true;
    } catch (e) { /* 忽略计算样式异常 */ }
    return false;
  }

  /** 节点 + 祖先链是否被跳过（含任一隐藏标记 / 非内容标签） */
  function isSkipped(el, root) {
    if (SKIP_TAGS.has(el.tagName)) return true;
    for (let n = el; n && n !== root; n = n.parentElement) {
      if (isHidden(n)) return true;
    }
    return false;
  }

  // class/id 语义词 → 字段名（先命中先赢；覆盖中英文站点常见命名）
  const WORD_NAMES = {
    title: '标题', tit: '标题', subject: '标题', heading: '标题', headline: '标题',
    caption: '标题', captiontext: '标题',
    name: '名称', username: '作者', user: '作者', author: '作者', nick: '作者',
    nickname: '作者', owner: '作者', member: '作者', by: '作者', poster: '作者',
    date: '日期', datetime: '日期', pubdate: '日期', created: '日期', createdat: '日期',
    published: '日期', updated: '日期', time: '时间', timestamp: '时间',
    content: '内容', body: '内容', text: '内容', desc: '内容', description: '内容',
    detail: '内容', summary: '内容', excerpt: '内容', comment: '内容', comments: '内容',
    msg: '内容', message: '内容', intro: '简介', abstract: '摘要', remark: '备注',
    price: '价格', cost: '价格', amount: '金额', money: '金额', fee: '费用',
    salary: '薪资', discount: '折扣',
    link: '链接', url: '链接', href: '链接', site: '站点', domain: '域名',
    img: '图片', image: '图片', photo: '图片', avatar: '头像', pic: '图片',
    picture: '图片', thumb: '缩略图', cover: '封面', icon: '图标',
    tag: '标签', tags: '标签', category: '分类', cat: '分类', type: '类型', kind: '类型',
    count: '数量', num: '数量', number: '数量', views: '浏览量', view: '浏览量',
    read: '阅读数', like: '点赞', likes: '点赞', star: '收藏', fav: '收藏',
    helpful: '有用数', vote: '有用数', votes: '有用数',
    score: '评分', rating: '评分', rank: '排名', hot: '热度', total: '总数',
    id: '编号', no: '编号', code: '编号', sku: '编号', index: '序号', sn: '编号',
    status: '状态', state: '状态', level: '等级', vip: '等级',
    phone: '电话', tel: '电话', mobile: '手机',
    email: '邮箱', mail: '邮箱',
    address: '地址', addr: '地址', location: '位置', city: '城市', area: '地区',
    region: '地区', province: '省份', country: '国家'
  };

  /* ---------------- 纯函数（离线回归） ---------------- */

  // 状态词：随条目/交互变化的类（is-active、odd/even 条纹），不能作为标识
  const STATE_WORDS = new Set(['is', 'has', 'not', 'no', 'odd', 'even', 'first', 'last',
    'active', 'current', 'selected', 'checked', 'hover', 'focus', 'open', 'disabled',
    'hidden', 'visible', 'show', 'on', 'collapsed', 'expanded']);

  /** 稳定 class 判定：排除 hash/随机串（sc-1a2b3c、css-x1y2、_3fJk9、纯数字）
   *  与状态类（is-active / odd / even 随条目变化，不能作为标识） */
  function isStableClass(c) {
    if (!c || c.length < 2 || c.length > 30) return false;
    if (/^[0-9_-]+$/.test(c)) return false;         // 纯数字/符号
    if (/\d/.test(c)) return false;                 // 含数字：hash 尾或序号类
    if (String(c).split(/[-_]/).some(p => STATE_WORDS.has(p.toLowerCase()))) return false;
    return true;
  }

  /** 稳定 id 判定：排除随机 id（uuid 片段、纯数字、超长） */
  function isStableId(id) {
    if (!id || id.length > 40) return false;
    if (/^[0-9]+$/.test(id)) return false;
    if (/[0-9a-f]{8,}/i.test(id)) return false;   // 含 8 位以上连续十六进制 = 随机串
    return true;
  }

  /** 词切分：连字符/下划线/空白/点 分隔 + camelCase 边界 + 剥离尾部数字 */
  function splitWords(s) {
    return String(s || '')
      .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
      .split(/[^A-Za-z0-9\u4e00-\u9fa5]+/)
      .map(w => w.toLowerCase())
      .filter(Boolean);
  }

  /** 由若干节点样本猜字段名（纯函数）：
   *  samples = [{ tag, id, cls, text, hook }]
   *  ① class/id/data-hook 语义词命中词表 → ② 标签语义（h1-h6/time/a/img…）
   *  → ③ 文本形态（日期/纯数字/@/http）→ ④ 回退「字段」 */
  function guessFieldName(samples) {
    const list = (samples || []).filter(Boolean);
    for (const s of list) {
      const words = splitWords(s.cls).concat(splitWords(s.id)).concat(splitWords(s.hook));
      for (const w of words) {
        if (WORD_NAMES[w]) return WORD_NAMES[w];
      }
    }
    const first = list[0];
    if (first) {
      const tag = (first.tag || '').toLowerCase();
      if (/^h[1-6]$/.test(tag) || tag === 'caption' || tag === 'legend') return '标题';
      if (tag === 'time') return '日期';
      if (tag === 'a') return '链接';
      if (tag === 'img' || tag === 'picture' || tag === 'figure') return '图片';
      if (tag === 'address') return '地址';
      if (tag === 'blockquote') return '引用';
      if (tag === 'strong' || tag === 'b') return '强调';
      const t = (first.text || '').trim();
      if (t) {
        if (/^\d{4}[-/年.]\d{1,2}([-/月.]\d{1,2})?/.test(t)) return '日期';
        if (/^\d{1,2}[-/月.]\d{1,2}[日号]?$/.test(t)) return '日期';
        if (/^(刚刚|\d+\s*(秒|分钟|小时|天|周|个月|年)前|昨天|前天|今天)$/.test(t)) return '日期';
        if (/^[\d,.\s]+$/.test(t)) return '数量';
        if (/^@/.test(t)) return '作者';
        if (/^https?:\/\//i.test(t)) return '链接';
      }
    }
    return '字段';
  }

  /** 字段名去重：已存在则追加 2、3… */
  function uniqueName(base, used) {
    let name = base || '字段';
    let n = 1;
    while (used.includes(name)) name = (base || '字段') + (++n);
    used.push(name);
    return name;
  }

  /** 候选选择器择优（纯函数）：命中条目数优先（跨条目覆盖），
   *  命中数相同取分数高者（更具体的选择器优先，避免退化成纯标签） */
  function pickBestSelector(cands) {
    let best = null;
    for (const c of cands || []) {
      if (!c || !c.sel) continue;
      if (!best || c.hits > best.hits || (c.hits === best.hits && c.score > best.score)) best = c;
    }
    return best;
  }

  /** 跨条目结构对齐 → 候选字段（纯函数）：
   *  itemsDesc = 每条目一个节点描述数组 [{ path, sig, text, order, tag, id, cls }]
   *  同路径出现次数 ≥ max(2, 60% 条目数)（单条目时全部保留）→ 候选；
   *  祖先节点若无自身直接文本且存在后代候选 → 丢弃（后代更精确，避免重复列）；
   *  按条目内首次出现顺序（order）排列，保证列序 = 阅读顺序；上限 8 列 */
  function suggestFields(itemsDesc, opts) {
    const items = itemsDesc || [];
    const total = items.length;
    if (!total) return [];
    const stat = new Map();
    for (const desc of items) {
      const seen = new Set();
      for (const d of desc) {
        if (seen.has(d.path)) continue;
        seen.add(d.path);
        let s = stat.get(d.path);
        if (!s) {
          s = { path: d.path, count: 0, samples: [], firstOrder: d.order, depth: d.depth, hasText: false, hook: '', hookStable: true };
          stat.set(d.path, s);
        }
        s.count++;
        if (s.samples.length < 5) s.samples.push({ tag: d.tag, id: d.id, cls: d.cls, text: d.text, hook: d.hook });
        if (d.text) s.hasText = true;
        // data-hook 跨条目值一致才算稳定（动态值如 reviewid 各条不同会被剔除）
        if (d.hook) {
          if (!s.hook) s.hook = d.hook;
          else if (s.hook !== d.hook) s.hookStable = false;
        } else {
          s.hookStable = false;
        }
      }
    }
    const need = total === 1 ? 1 : Math.max(2, Math.ceil(total * 0.6));
    let cands = Array.from(stat.values()).filter(s => s.count >= need);
    cands = cands.filter(a => a.hasText ||
      !cands.some(b => b !== a && b.path.indexOf(a.path + '/') === 0 && b.hasText));
    cands.sort((a, b) => a.firstOrder - b.firstOrder);
    const limit = (opts && opts.limit) || 12;
    const used = (opts && opts.used) || [];
    return cands.slice(0, limit).map(s => ({
      path: s.path,
      coverage: total ? s.count / total : 0,
      depth: s.depth,
      hook: s.hookStable && s.hook ? s.hook : '',
      name: uniqueName(guessFieldName(s.samples), used)
    }));
  }

  /** 表格列名：无字段定义时 = 单列「内容」（旧行为） */
  function columnsOf(fields) {
    if (!fields || !fields.length) return ['内容'];
    return fields.map(f => f.name);
  }

  /** 结构路径（DIV[1]/H3[2]）→ CSS 选择器（:scope div:nth-of-type(1) h3:nth-of-type(2)）：
   *  nth-of-type 序号即同 tag 兄弟序号，与结构路径口径一致，可直接转换 */
  function pathToSelector(path) {
    const segs = String(path || '').split('/').map((seg) => {
      const m = /^([A-Za-z0-9]+)\[(\d+)\]$/.exec(seg);
      return m ? m[1].toLowerCase() + ':nth-of-type(' + m[2] + ')' : '';
    }).filter(Boolean);
    return segs.length ? ':scope ' + segs.join(' ') : '';
  }

  /* ---------------- DOM：节点枚举与结构索引 ---------------- */

  /** 节点在同级同 tag 中的序号（1 起）：结构路径定位用 */
  function nthOfType(el) {
    if (!el.parentElement) return 1;
    let n = 1;
    for (const sib of el.parentElement.children) {
      if (sib === el) break;
      if (sib.tagName === el.tagName) n++;
    }
    return n;
  }

  /** 直接文本（仅自身文本子节点，不含后代元素文本），归一化 */
  function directText(el) {
    let s = '';
    for (const n of el.childNodes) if (n.nodeType === 3) s += n.nodeValue;
    return normalizeText(s);
  }

  /** 稳定 data-hook 值（Amazon 等站点的模板固定标识，跨条目稳定）；
   *  过滤明显不稳定的（含 reviewid / asin / uuid 片段的动态值） */
  function stableHook(el) {
    if (!el || !el.getAttribute) return '';
    const v = el.getAttribute('data-hook') || '';
    if (!v || v.length > 60) return '';
    if (/reviewid|asin|uuid|^\d+$|[-_]\d{5,}/i.test(v)) return '';
    return v;
  }

  /** 条目内内容节点描述（DFS 前序，path = '/' 分隔的 TAG[n] 链，order = 遍历序号）。
   *  仅保留「有直接文本」或「叶子级图片/链接」的节点——纯容器不产生候选列；
   *  隐藏子树整段跳过，避免 CSS 隐藏文本（Amazon teaser 等）误入候选 */
  function describeItem(item) {
    const out = [];
    let order = 0;
    (function walk(el, path, depth) {
      for (const child of Array.from(el.children)) {
        if (isSkipped(child, item)) continue;
        const p = (path ? path + '/' : '') + child.tagName + '[' + nthOfType(child) + ']';
        const text = directText(child);
        // 仅 IMG 自身与 A 自身算媒体候选；包裹容器（有元素子节点的 div/span）不算
        const media = !text && (child.tagName === 'IMG' || child.tagName === 'A');
        if (text || media) {
          out.push({
            path: p,
            sig: elSig(child),
            parentSig: elSig(child.parentElement || child),
            text: text,
            depth: depth + 1,
            order: order,
            tag: child.tagName.toLowerCase(),
            id: child.id || '',
            cls: Array.from(child.classList || []).join(' '),
            hook: stableHook(child)
          });
        }
        order++;
        walk(child, p, depth + 1);
      }
    })(item, '', 0);
    return out;
  }

  /** 自动识别（DOM 包装）：逐条目枚举描述 → suggestFields 候选（只出建议，
   *  由用户勾选确认；路径再经 buildSelector 转成可用选择器）。
   *  附加「全文容器」探测：取条目内 reviewRichContentContainer / reviewText 等
   *  典型长正文容器，跨条目结构一致时作为多段正文合并候选（避免 p[1]/p[2]
   *  只取首段的局限） */
  function suggestFromItems(items, opts) {
    const list = (items || []).filter(el => el && el.isConnected);
    if (!list.length) return [];
    const descs = list.map(describeItem);
    const cands = suggestFields(descs, opts);
    // 正文容器探测：找到 reviewRichContentContainer 等多段正文容器后，
    // 把落在容器内部的「段落级」候选（首段/次段）合并为单一「正文」字段，
    // 避免「首段」+「全文」重复列、且正文多段不会漏
    const extra = suggestContainerField(list, cands);
    if (extra) {
      for (let i = cands.length - 1; i >= 0; i--) {
        if (extra.path && cands[i].path.indexOf(extra.path + '/') === 0) cands.splice(i, 1);
      }
      cands.push(extra);
    }
    // 补结构索引（alt 兜底用）：候选路径在首条目中的 DFS 序号 + 元素签名
    for (const c of cands) {
      const d = (descs[0] || []).find(x => x.path === c.path);
      if (d) {
        c.order = d.order;
        c.sig = d.sig;
        c.parentSig = d.parentSig;
      }
    }
    return cands;
  }

  /** 节点到 root 的结构路径（TAG[n]/... 格式，与 describeItem 口径一致，用于判断包含关系） */
  function structPathOf(node, root) {
    if (!node || node === root) return '';
    const segs = [];
    for (let cur = node; cur && cur !== root; cur = cur.parentElement) {
      segs.unshift(cur.tagName + '[' + nthOfType(cur) + ']');
    }
    return segs.join('/');
  }

  /** 探测"正文容器"作为合并候选：在样本条目内找 data-hook 值含正文语义
   *  （content/body/text/desc/message/comment…）且含多段文本（≥2 个有文本的
   *  块级后代）的容器，跨条目 ≥60% 出现时作为多段正文合并字段（避免 p[1]/p[2]
   *  只取首段的局限）。不绑定具体站点命名——靠「正文语义词 + 多段文本」两个
   *  通用信号识别；多个候选取文本最短者（最精确、不含元数据的那个）。
   *  容器带 data-hook 稳定锚点 → 选择器 = [data-hook=...]，取值 = 容器全文 */
  function suggestContainerField(items, existing) {
    if (!items.length) return null;
    const usedNames = (existing || []).map(c => c.name);
    let best = null, bestHook = '', bestLen = Infinity;
    for (const el of Array.from(items[0].querySelectorAll('[data-hook]'))) {
      const hook = el.getAttribute('data-hook') || '';
      if (!BODY_HOOK_RE.test(hook)) continue;
      let blocks = 0;
      for (const b of el.querySelectorAll('p, div, li, blockquote, h1, h2, h3, h4, h5, h6')) {
        if ((b.textContent || '').trim()) blocks++;
        if (blocks >= 2) break;
      }
      if (blocks < 2) continue;
      const len = (el.textContent || '').length;
      if (len < bestLen) { best = el; bestHook = hook; bestLen = len; }
    }
    if (!best) return null;
    // 跨条目 ≥60% 出现同 hook
    let n = 0;
    for (const it of items) {
      if (it.querySelector('[data-hook="' + bestHook + '"]')) n++;
    }
    const need = Math.max(2, Math.ceil(items.length * 0.6));
    if (n < need) return null;
    return {
      path: structPathOf(best, items[0]),
      coverage: n / items.length,
      depth: 0,
      hook: bestHook,
      name: uniqueName('正文', usedNames)
    };
  }

  /** 结构索引回退定位：条目内第 order 个（DFS 前序）元素。
   *  序号节点签名相符最可信；不符时按「同深度+同签名+同父签名」强校验兜底——
   *  牺牲一定的结构差异容忍换取错位填错值的代价（错位填错比留空更伤信任） */
  function nodeByIndex(item, alt) {
    if (!alt) return null;
    let order = 0;
    let byOrder = null;
    let byStrong = null;
    const wantSig = alt.sig;
    const wantDepth = alt.depth || 0;
    const wantParent = alt.parentSig || '';
    (function walk(el, depth) {
      if (byOrder) return;
      for (const child of Array.from(el.children)) {
        if (SKIP_TAGS.has(child.tagName)) continue;
        if (order === alt.order) byOrder = child;
        if (!byStrong) {
          const sig = elSig(child);
          const pSig = elSig(child.parentElement || child);
          if (sig === wantSig && depth === wantDepth && pSig === wantParent) byStrong = child;
        }
        order++;
        walk(child, depth + 1);
        if (byOrder) return;
      }
    })(item, 0);
    if (byOrder && elSig(byOrder) === alt.sig) return byOrder;
    return byStrong || null;
  }

  /* ---------------- DOM：选择器生成与验证 ---------------- */

  function cssEsc(s) {
    return (typeof CSS !== 'undefined' && CSS && CSS.escape) ? CSS.escape(s) : s;
  }

  function stableClasses(el) {
    return Array.from(el.classList || []).filter(isStableClass);
  }

  /** 单步选择器：data-hook / 稳定 id 优先短路，其次 tag + 稳定 class（可选）
   *  + nth-of-type（同级同 tag 不唯一时）。data-hook 是模板级稳定标识，
   *  跨条目结构微变仍命中，比纯 nth-of-type 链鲁棒得多 */
  function stepSel(st, useCls, useNth) {
    if (st.hook) return '[data-hook="' + cssEsc(st.hook) + '"]';
    if (st.id && isStableId(st.id)) return '#' + cssEsc(st.id);
    let s = st.tag;
    if (useCls && st.cls.length) s += '.' + st.cls.map(cssEsc).join('.');
    if (useNth && st.siblings > 1) s += ':nth-of-type(' + st.nth + ')';
    return s;
  }

  /** 路径拼接：':scope ' + 各步以后代组合（比 '>' 更鲁棒——页面可能在中间插入 wrapper） */
  function buildPath(steps, useCls, useNth) {
    return ':scope ' + steps.map(st => stepSel(st, useCls, useNth)).join(' ');
  }

  /** 选择器在全部条目上的命中数（每条目取第一个匹配即算命中；非法选择器 = 0） */
  function countHits(items, sel) {
    let hits = 0;
    for (const it of items) {
      if (!it || !it.isConnected) continue;
      try { if (it.querySelector(sel)) hits++; } catch (e) { /* 非法选择器忽略 */ }
    }
    return hits;
  }

  /** 由样本节点生成字段（DOM）：
   *  ① 自节点向上到条目根收集每步描述 → ② 生成 6 档候选（全量精确 → 仅末层纯 tag）
   *  → ③ 在全部条目上验证命中数 → ④ 择优（命中优先，平局取更具体）
   *  → ⑤ 附上结构索引 alt 兜底（选择器失效时按 DFS 序号 + 签名定位） */
  function fieldFromSample(items, sample, node, usedNames) {
    if (!node || node.nodeType !== 1 || !sample || node === sample) return null;
    const steps = [];
    for (let cur = node; cur && cur !== sample; cur = cur.parentElement) {
      if (cur.nodeType !== 1) return null;
      const parent = cur.parentElement;
      steps.unshift({
        tag: cur.tagName.toLowerCase(),
        id: cur.id || '',
        hook: stableHook(cur),
        cls: stableClasses(cur),
        nth: nthOfType(cur),
        siblings: parent
          ? Array.from(parent.children).filter(c => c.tagName === cur.tagName).length
          : 1
      });
    }
    if (!steps.length) return null;
    const last = steps[steps.length - 1];
    const cands = [];
    if (last.hook) {
      cands.push({ sel: ':scope [data-hook="' + cssEsc(last.hook) + '"]', score: 90, hits: 0 });
    }
    if (last.id && isStableId(last.id)) {
      cands.push({ sel: ':scope #' + cssEsc(last.id), score: 100, hits: 0 });
    }
    // 正文容器候选标记 wrap：自检用「容器包含点选节点」而非「等于」。
    // 点选「文本叶子」（正文某段的 span）且自身无 hook 时，向上找最近的
    // 正文语义 data-hook 容器（含 ≥2 个有直接文本的块级后代 = 多段正文），
    // 取全文而非单段。选「最近」的容器避免外扩到含元数据的更大包裹层
    if (!last.hook) {
      for (let a = node.parentElement; a && a !== sample; a = a.parentElement) {
        const ah = stableHook(a);
        if (!ah || !BODY_HOOK_RE.test(ah)) continue;
        let blocks = 0;
        for (const b of a.querySelectorAll('p, div, li, blockquote, h1, h2, h3, h4, h5, h6')) {
          if ((b.textContent || '').trim()) blocks++;
          if (blocks >= 2) break;
        }
        if (blocks >= 2) {
          cands.push({ sel: ':scope [data-hook="' + cssEsc(ah) + '"]', score: 70, hits: 0, wrap: true, hook: ah });
          break;
        }
      }
    }
    cands.push({ sel: buildPath(steps, true, true), score: 60, hits: 0 });
    cands.push({ sel: buildPath(steps, true, false), score: 50, hits: 0 });
    cands.push({ sel: buildPath([last], true, true), score: 40, hits: 0 });
    cands.push({ sel: buildPath([last], true, false), score: 30, hits: 0 });
    cands.push({ sel: buildPath(steps, false, true), score: 20, hits: 0 });
    cands.push({ sel: buildPath([last], false, false), score: 10, hits: 0 });
    for (const c of cands) {
      // 样本自检：选择器在样本条目上必须命中点选节点——普通候选要求
      // querySelector 返回点选节点本身；wrap（正文容器）候选要求容器「包含」
      // 点选节点。宽泛候选（退化后的 :scope span 命中祖先/前置同名节点）淘汰，
      // 防「点正文取到整条」；自检通过才算跨条目命中数
      let selfOk = false;
      try {
        const hit = sample.querySelector(c.sel);
        selfOk = c.wrap ? !!(hit && hit.contains(node)) : (hit === node);
      } catch (e) { selfOk = false; }
      c.hits = selfOk ? countHits(items, c.sel) : 0;
    }
    const best = pickBestSelector(cands);
    // 全部候选未过样本自检：不给选择器（取值走结构索引兜底），字段仍可用
    const sel = best && best.hits ? best.sel : '';
    // 选中正文容器候选时字段名统一为「正文」（多段合并语义）；否则按样本猜名
    const name = (best && best.wrap)
      ? uniqueName('正文', usedNames || [])
      : uniqueName(
          guessFieldName([{ tag: last.tag, id: last.id, cls: last.cls.join(' '), text: directText(node), hook: last.hook }]),
          usedNames || []
        );
    return {
      name: name,
      sel: sel,
      alt: { order: orderIn(sample, node), sig: elSig(node), depth: steps.length, parentSig: elSig(node.parentElement || node) },
      type: node.tagName === 'IMG' ? 'image' : (node.matches('a[href]') ? 'link' : 'text')
    };
  }

  /** 节点在条目内的 DFS 序号（与 describeItem / nodeByIndex 同一遍历口径） */
  function orderIn(item, node) {
    let order = -1;
    let found = false;
    (function walk(el) {
      if (found) return;
      for (const child of Array.from(el.children)) {
        if (SKIP_TAGS.has(child.tagName)) continue;
        order++;
        if (child === node) { found = true; return; }
        walk(child);
        if (found) return;
      }
    })(item);
    return found ? order : -1;
  }

  /* ---------------- DOM：取值 ---------------- */

  /** 元素自身或内部第一个 a[href] 的绝对地址（无则空串） */
  function firstHref(el) {
    const a = el.matches('a[href]') ? el : el.querySelector('a[href]');
    return a ? a.href : '';
  }

  /** 节点 → 字段值（按取值类型） */
  function valueOf(node, type, attr) {
    if (!node) return '';
    if (type === 'link') return firstHref(node);
    if (type === 'image') {
      const img = node.tagName === 'IMG' ? node : node.querySelector('img[src]');
      return img ? img.src : '';
    }
    if (type === 'attr') return node.getAttribute(attr || '') || '';
    return normalizeText(node.textContent);
  }

  /** 字段在条目上的定位：选择器优先，失败回退结构索引 */
  function locateNode(item, field) {
    if (field.sel) {
      try { const n = item.querySelector(field.sel); if (n) return n; } catch (e) { /* 非法选择器 */ }
    }
    return nodeByIndex(item, field.alt);
  }

  /** 字段在条目上的取值 */
  function fieldValue(item, field) {
    const node = locateNode(item, field);
    return node ? valueOf(node, field.type, field.attr) : '';
  }

  /** 条目 → 单元格数组（按 fields 顺序；无字段定义 = 单列整元素文本） */
  function extractCells(item, fields) {
    if (!fields || !fields.length) return [normalizeText(item.textContent)];
    return fields.map(f => fieldValue(item, f));
  }

  /** 各字段在所有条目上的命中数（预览/字段行的覆盖率提示；
   *  定位成功即算命中——选择器失效但结构索引兜底成功的也计入） */
  function hitCounts(items, fields) {
    return (fields || []).map(f => {
      let n = 0;
      for (const it of items || []) {
        if (it && it.isConnected && locateNode(it, f)) n++;
      }
      return n;
    });
  }

  /** 列表 → 导出表格 { columns, rows, hits }（rows 为二维字符串数组） */
  function buildTable(items, fields) {
    const rows = (items || []).map(it => extractCells(it, fields));
    return { columns: columnsOf(fields), rows: rows, hits: hitCounts(items, fields) };
  }

  ns.field = {
    isStableClass: isStableClass,
    isStableId: isStableId,
    splitWords: splitWords,
    guessFieldName: guessFieldName,
    uniqueName: uniqueName,
    pickBestSelector: pickBestSelector,
    suggestFields: suggestFields,
    columnsOf: columnsOf,
    pathToSelector: pathToSelector,
    nthOfType: nthOfType,
    directText: directText,
    describeItem: describeItem,
    suggestFromItems: suggestFromItems,
    nodeByIndex: nodeByIndex,
    locateNode: locateNode,
    buildPath: buildPath,
    countHits: countHits,
    fieldFromSample: fieldFromSample,
    orderIn: orderIn,
    firstHref: firstHref,
    valueOf: valueOf,
    fieldValue: fieldValue,
    extractCells: extractCells,
    hitCounts: hitCounts,
    buildTable: buildTable
  };
})();
