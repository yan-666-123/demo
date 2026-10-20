/* SheetPilot — AI 分析层（直连用户配置的大模型 + 本地分析引擎兜底） */
(function () {
  'use strict';
  const A = window.App;
  const $ = s => document.querySelector(s);
  const $$ = s => Array.from(document.querySelectorAll(s));
  const esc = A.esc;

  /* ============================ 配置 ============================ */
  const LS_KEY = 'sheetpilot.ai.v1';
  const PRESETS = {
    deepseek: { name: 'DeepSeek', baseUrl: 'https://api.deepseek.com/v1', model: 'deepseek-chat', models: ['deepseek-chat', 'deepseek-reasoner'] },
    openai: { name: 'OpenAI', baseUrl: 'https://api.openai.com/v1', model: 'gpt-4o-mini', models: ['gpt-4o-mini', 'gpt-4o', 'gpt-4.1-mini'] },
    moonshot: { name: '月之暗面 Kimi', baseUrl: 'https://api.moonshot.cn/v1', model: ' moonshot-v1-8k'.trim(), models: ['moonshot-v1-8k', 'moonshot-v1-32k', 'kimi-latest'] },
    dashscope: { name: '阿里通义千问', baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1', model: 'qwen-plus', models: ['qwen-plus', 'qwen-turbo', 'qwen-max'] },
    zhipu: { name: '智谱 GLM', baseUrl: 'https://open.bigmodel.cn/api/paas/v4', model: 'glm-4-flash', models: ['glm-4-flash', 'glm-4-plus'] },
    custom: { name: '自定义 / 代理地址', baseUrl: '', model: '', models: [] },
  };

  const cfg = Object.assign({
    preset: 'deepseek',
    baseUrl: PRESETS.deepseek.baseUrl,
    model: PRESETS.deepseek.model,
    apiKey: '',
    temperature: 0.3,
    includeData: true,
  }, readCfg());

  function readCfg() {
    try { return JSON.parse(localStorage.getItem(LS_KEY) || '{}'); } catch (e) { return {}; }
  }
  function saveCfg() {
    try { localStorage.setItem(LS_KEY, JSON.stringify(cfg)); } catch (e) { }
  }
  const hasKey = () => !!cfg.apiKey && !!cfg.baseUrl && !!cfg.model;

  function updateModelTag() {
    const tag = $('#aiModelTag');
    if (!tag) return;
    if (hasKey()) {
      tag.textContent = cfg.model;
      tag.style.color = '';
      tag.title = cfg.model;
    } else {
      tag.textContent = '本地分析模式';
      tag.style.color = 'var(--amber)';
      tag.title = '未配置模型，使用内置分析引擎';
    }
  }

  /* ============================ Markdown ============================ */
  function inlineMd(s) {
    let out = esc(s);
    out = out.replace(/`([^`]+)`/g, '<code>$1</code>');
    out = out.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
    out = out.replace(/(^|[^*])\*([^*\n]+)\*/g, '$1<em>$2</em>');
    out = out.replace(/\[([^\]]+)\]\((https?:[^)]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>');
    return out;
  }

  function mdToHtml(md) {
    const codeBlocks = [];
    let text = String(md == null ? '' : md).replace(/```(\w*)\r?\n?([\s\S]*?)```/g, (m, lang, code) => {
      codeBlocks.push({ lang, code });
      return '\u0000C' + (codeBlocks.length - 1) + '\u0000';
    });
    const lines = text.split(/\r?\n/);
    let html = '';
    let listType = null;
    let tableBuf = [];
    const closeList = () => { if (listType) { html += '</' + listType + '>'; listType = null; } };
    const flushTable = () => {
      if (!tableBuf.length) return;
      const rows = tableBuf.map(r => r.replace(/^\||\|$/g, '').split('|').map(c => c.trim()));
      const bodyRows = rows.filter(r => !r.every(c => /^:?-{2,}:?$/.test(c) || c === ''));
      html += '<table>';
      bodyRows.forEach((r, i) => {
        const tag = i === 0 ? 'th' : 'td';
        html += '<tr>' + r.map(c => `<${tag}>${inlineMd(c)}</${tag}>`).join('') + '</tr>';
      });
      html += '</table>';
      tableBuf = [];
    };
    for (const raw of lines) {
      const line = raw.trim();
      if (/^\|.*\|$/.test(line)) { closeList(); tableBuf.push(line); continue; }
      flushTable();
      const cm = line.match(/^\u0000C(\d+)\u0000$/);
      if (cm) { closeList(); html += '<pre><code>' + esc(codeBlocks[+cm[1]].code.replace(/\s+$/, '')) + '</code></pre>'; continue; }
      if (!line) { closeList(); continue; }
      let m;
      if ((m = line.match(/^(#{1,4})\s+(.*)$/))) { closeList(); const lv = Math.min(4, m[1].length + 2); html += `<h${lv}>${inlineMd(m[2])}</h${lv}>`; continue; }
      if ((m = line.match(/^[-*+]\s+(.*)$/))) {
        if (listType !== 'ul') { closeList(); html += '<ul>'; listType = 'ul'; }
        html += `<li>${inlineMd(m[1])}</li>`; continue;
      }
      if ((m = line.match(/^\d+[.)]\s+(.*)$/))) {
        if (listType !== 'ol') { closeList(); html += '<ol>'; listType = 'ol'; }
        html += `<li>${inlineMd(m[1])}</li>`; continue;
      }
      if ((m = line.match(/^>\s+(.*)$/))) { closeList(); html += `<p style="border-left:3px solid #ddd6fe;padding-left:9px;color:var(--muted)">${inlineMd(m[1])}</p>`; continue; }
      closeList();
      html += `<p>${inlineMd(line)}</p>`;
    }
    flushTable();
    closeList();
    return html;
  }

  /* ============================ 消息 UI ============================ */
  function scrollBottom() {
    const b = $('#aiBody');
    if (b) b.scrollTop = b.scrollHeight + 200;
  }

  function pushMsg(role, html) {
    const el = document.createElement('div');
    el.className = 'ai-msg ' + role;
    const who = role === 'user' ? '你'
      : `<svg width="11" height="11" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="color:var(--ai)"><use href="#i-sparkles"/></svg>AI 助手`;
    el.innerHTML = `<div class="who">${who}</div><div class="ai-bubble">${html}</div>`;
    $('#aiBody').appendChild(el);
    scrollBottom();
    return el.querySelector('.ai-bubble');
  }

  function pushTyping() {
    const bubble = pushMsg('ai', '<div class="typing"><i></i><i></i><i></i></div>');
    bubble.dataset.typing = '1';
    return bubble;
  }

  /* ============================ 图表卡片 ============================ */
  function chartHtml(spec, svg) {
    const typeName = { bar: '柱状图', line: '折线图', pie: '饼图', scatter: '散点图' }[spec.type] || '图表';
    return `<div class="ai-chart-card">
      <div class="cap">${typeName}${spec.title ? ' · ' + esc(spec.title) : ''}</div>
      ${svg || ''}
    </div>`;
  }

  function resolveCol(name) {
    if (name == null) return -1;
    const head = A.header();
    let i = head.findIndex(h => String(h).trim() === String(name).trim());
    if (i >= 0) return i;
    // 兼容列字母
    const s = String(name).trim().toUpperCase();
    if (/^[A-Z]{1,2}$/.test(s)) {
      let n = 0;
      for (const ch of s) n = n * 26 + (ch.charCodeAt(0) - 64);
      if (n - 1 < head.length) return n - 1;
    }
    i = head.findIndex(h => String(h).includes(String(name)));
    return i;
  }

  function buildChart(spec) {
    const xi = resolveCol(spec.x);
    const yi = resolveCol(spec.y);
    if (yi < 0) return '';
    const c = {
      type: ['bar', 'line', 'pie', 'scatter'].includes(spec.type) ? spec.type : 'bar',
      x: xi >= 0 ? xi : '',
      y: yi,
      agg: ['sum', 'avg', 'count'].includes(spec.agg) ? spec.agg : 'sum',
      title: spec.title || '',
      sortByValue: spec.type === 'pie',
    };
    const data = A.prepareChartData(c);
    if (!data.values.length) return '';
    return chartHtml(c, A.renderChartSVG(Object.assign({}, c, data), 352, 210));
  }

  function addChartMessage(spec) {
    openPanel();
    pushMsg('ai', chartHtml(spec, spec.svg || A.renderChartSVG(spec, 352, 210)));
  }

  /* ============================ 可执行动作 ============================ */
  const ACTION_LABEL = {
    deleteDuplicates: () => '删除重复行',
    deleteEmptyRows: () => '删除完全空白行',
    trimSpaces: () => '清理单元格多余空白',
    fillMissing: a => `用${({ mean: '平均值', median: '中位数', mode: '众数', zero: '0' }[a.strategy] || '指定值')}填充「${a.column}」的缺失值`,
    convertNumber: a => `把「${a.column}」转为数字格式`,
    convertDate: a => `把「${a.column}」统一为日期格式`,
    removeOutliers: a => `剔除「${a.column}」的异常值`,
    dropColumn: a => `删除列「${a.column}」`,
    uppercase: a => `把「${a.column}」转为大写`,
  };

  function validateActions(list) {
    if (!Array.isArray(list)) return [];
    return list.filter(a => a && ACTION_LABEL[a.type] && (a.type === 'dropColumn' ? resolveCol(a.column) >= 0 : true))
      .map(a => Object.assign({}, a, { _col: a.column ? resolveCol(a.column) : -1 }));
  }

  function actionsCard(list) {
    const valid = validateActions(list);
    if (!valid.length) return '';
    const items = valid.map((a, i) => `<label class="action-item">
      <input type="checkbox" data-ai-action="${i}" checked>
      <span class="desc">${esc(ACTION_LABEL[a.type](a).replace('undefined', a.column || ''))}</span>
    </label>`).join('');
    return `<div class="action-card" data-actions='${esc(JSON.stringify(valid))}'>
      <div class="ac-title"><svg width="12" height="12" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><use href="#i-wand"/></svg>可执行的清洗方案（${valid.length} 步）</div>
      ${items}
      <div class="ac-foot">
        <button class="btn sm primary" data-apply-actions>应用选中操作</button>
        <button class="btn sm" data-dismiss-actions>忽略</button>
      </div>
    </div>`;
  }

  function applyActions(actions) {
    const list = actions.filter(a => a.type);
    if (!list.length) return;
    let log = [];
    A.mutate(() => {
      for (const a of list) {
        const s = A.state.sheets[A.state.active];
        const hdr = s.rows[0];
        const body = s.rows.slice(1);
        const ci = a._col != null && a._col >= 0 ? a._col : resolveCol(a.column);
        switch (a.type) {
          case 'deleteDuplicates': {
            const seen = new Set(); const keep = []; let n = 0;
            for (const r of body) {
              const k = r.map(v => A.cellText(v).trim()).join('\u0001');
              if (seen.has(k)) { n++; continue; }
              seen.add(k); keep.push(r);
            }
            s.rows = [hdr].concat(keep); log.push(`删除 ${n} 行重复`);
            break;
          }
          case 'deleteEmptyRows': {
            const keep = body.filter(r => r.some(v => A.cellText(v).trim() !== ''));
            log.push(`删除 ${body.length - keep.length} 个空行`);
            s.rows = [hdr].concat(keep);
            break;
          }
          case 'trimSpaces': {
            let n = 0;
            for (const r of body) for (let c = 0; c < r.length; c++) {
              const v = A.cellText(r[c]);
              if (!v) continue;
              const nv = v.replace(/\u3000/g, ' ').replace(/\s+/g, ' ').trim();
              if (nv !== v) { r[c] = nv; n++; }
            }
            log.push(`清理 ${n} 个单元格`);
            break;
          }
          case 'fillMissing': {
            if (ci < 0) break;
            const st = A.columnStats(ci);
            let fill = '';
            if (a.strategy === 'mean' && st.num) fill = String(Math.round(st.num.mean * 100) / 100);
            else if (a.strategy === 'median' && st.num) fill = String(st.num.median);
            else if (a.strategy === 'mode' && st.top.length) fill = st.top[0][0];
            else if (a.strategy === 'zero') fill = '0';
            let n = 0;
            for (const r of body) if (A.isEmpty(r[ci])) { r[ci] = fill; n++; }
            log.push(`填充「${hdr[ci]}」${n} 个缺失值`);
            break;
          }
          case 'convertNumber': {
            if (ci < 0) break;
            let n = 0;
            for (const r of body) {
              const v = r[ci]; if (A.isEmpty(v)) continue;
              const num = A.parseNumber(v);
              if (num !== null) { r[ci] = String(num); n++; }
            }
            log.push(`转换「${hdr[ci]}」${n} 个数字`);
            break;
          }
          case 'convertDate': {
            if (ci < 0) break;
            let n = 0;
            for (const r of body) {
              const d = A.parseDate(r[ci]);
              if (d) { r[ci] = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; n++; }
            }
            log.push(`统一「${hdr[ci]}」${n} 个日期`);
            break;
          }
          case 'removeOutliers': {
            if (ci < 0) break;
            const st = A.columnStats(ci);
            if (!st.num) break;
            const iqr = st.num.q3 - st.num.q1;
            if (iqr <= 0) break;
            const lo = st.num.q1 - 1.5 * iqr, hi = st.num.q3 + 1.5 * iqr;
            const keep = body.filter(r => {
              const v = A.parseNumber(r[ci]);
              return v === null || (v >= lo && v <= hi);
            });
            log.push(`剔除 ${body.length - keep.length} 行异常值`);
            s.rows = [hdr].concat(keep);
            break;
          }
          case 'dropColumn': {
            if (ci < 0) break;
            s.rows.forEach(r => r.splice(ci, 1));
            log.push(`删除列「${a.column}」`);
            break;
          }
          case 'uppercase': {
            if (ci < 0) break;
            for (const r of body) r[ci] = A.cellText(r[ci]).toUpperCase();
            log.push(`「${hdr[ci]}」转大写`);
            break;
          }
        }
      }
    });
    A.rerenderView();
    pushMsg('ai', mdToHtml('**已执行**：' + (log.join('；') || '无变更') + '\n\n数据已更新，体检分数同步刷新。'));
    A.toast('AI 方案已应用', 'ok');
  }

  function bindActionCards(root) {
    root.querySelectorAll('[data-apply-actions]').forEach(btn => {
      btn.onclick = () => {
        const card = btn.closest('.action-card');
        const all = JSON.parse(card.dataset.actions);
        const picked = $$('input[data-ai-action]', card).filter(i => i.checked).map(i => all[+i.dataset.aiAction]);
        if (!picked.length) { A.toast('请至少选择一项操作', 'err'); return; }
        btn.disabled = true;
        applyActions(picked);
        card.querySelectorAll('input').forEach(i => i.disabled = true);
        btn.textContent = '已应用';
      };
    });
    root.querySelectorAll('[data-dismiss-actions]').forEach(btn => {
      btn.onclick = () => { const c = btn.closest('.action-card'); c.style.opacity = '.5'; c.querySelectorAll('button,input').forEach(b => b.disabled = true); };
    });
  }

  /* ============================ 本地分析引擎 ============================ */
  function colVals(ci) {
    return A.rows().slice(1).map(r => A.cellText(r[ci]).trim()).filter(v => v !== '');
  }

  function pearson(xs, ys) {
    const n = xs.length;
    if (n < 3) return null;
    const mx = xs.reduce((a, b) => a + b, 0) / n, my = ys.reduce((a, b) => a + b, 0) / n;
    let num = 0, dx = 0, dy = 0;
    for (let i = 0; i < n; i++) {
      num += (xs[i] - mx) * (ys[i] - my);
      dx += (xs[i] - mx) ** 2; dy += (ys[i] - my) ** 2;
    }
    if (!dx || !dy) return null;
    return num / Math.sqrt(dx * dy);
  }

  function measureWeight(name) {
    if (/金额|销售额|营收|收入|总额|利润|毛利|amount|revenue|sales|gmv|total|profit/i.test(name)) return 3;
    if (/数量|销量|件数|人数|次数|qty|quantity|count|visits/i.test(name)) return 2.5;
    if (/单价|价格|均价|折扣|率|price|rate/i.test(name)) return 1;
    return 1.5;
  }
  function idLike(name) { return /编号|单号|序号|代码|ID$|^ID|no\.?$|code|uuid/i.test(String(name)); }

  function deepStats() {
    const head = A.header();
    const body = A.rows().slice(1);
    const cols = [];
    for (let c = 0; c < A.colCount(); c++) {
      cols.push({ i: c, name: head[c] || A.colLetter(c), type: A.colType(c), st: A.columnStats(c) });
    }
    const numCols = cols.filter(c => c.type === 'number' && c.st.num && c.st.num.count >= 3)
      .map(c => Object.assign(c, { additive: measureWeight(c.name) >= 2 }))
      .sort((a, b) => measureWeight(b.name) - measureWeight(a.name));
    const catCols = cols.filter(c => c.type === 'text' && c.st.unique >= 2 && c.st.unique <= 40)
      .sort((a, b) => (idLike(a.name) ? 1 : 0) - (idLike(b.name) ? 1 : 0));
    const dateCols = cols.filter(c => c.type === 'date');
    // 相关性
    const corr = [];
    for (let i = 0; i < numCols.length; i++) {
      for (let j = i + 1; j < numCols.length; j++) {
        const xs = [], ys = [];
        for (const r of body) {
          const x = A.parseNumber(r[numCols[i].i]), y = A.parseNumber(r[numCols[j].i]);
          if (x !== null && y !== null) { xs.push(x); ys.push(y); }
        }
        const rv = pearson(xs, ys);
        if (rv !== null && Math.abs(rv) >= 0.5) corr.push({ a: numCols[i].name, b: numCols[j].name, r: rv });
      }
    }
    corr.sort((x, y) => Math.abs(y.r) - Math.abs(x.r));
    // 分组贡献
    const groups = [];
    for (const cat of catCols.slice(0, 3)) {
      for (const num of numCols.slice(0, 2)) {
        const map = new Map();
        let total = 0;
        for (const r of body) {
          const k = A.cellText(r[cat.i]).trim() || '（空）';
          const v = A.parseNumber(r[num.i]);
          if (v === null) continue;
          map.set(k, (map.get(k) || 0) + v); total += v;
        }
        if (map.size < 2 || total <= 0) continue;
        const items = Array.from(map.entries()).map(([k, v]) => ({ k, v, share: v / total })).sort((a, b) => b.v - a.v);
        groups.push({ cat: cat.name, val: num.name, items, total, top3Share: items.slice(0, 3).reduce((a, b) => a + b.share, 0) });
      }
    }
    // 时间趋势
    let trend = null;
    if (dateCols.length && numCols.length) {
      const d = dateCols[0], v = numCols[0];
      const map = new Map();
      for (const r of body) {
        const dt = A.parseDate(r[d.i]);
        const val = A.parseNumber(r[v.i]);
        if (!dt || val === null) continue;
        const key = `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, '0')}`;
        map.set(key, (map.get(key) || 0) + val);
      }
      if (map.size >= 2) {
        const series = Array.from(map.entries()).sort((a, b) => a[0].localeCompare(b[0]));
        const first = series[0][1], last = series[series.length - 1][1];
        trend = {
          date: d.name, val: v.name, series,
          change: first ? (last - first) / Math.abs(first) : null,
          avg: series.reduce((a, b) => a + b[1], 0) / series.length,
        };
      }
    }
    return { head, body, cols, numCols, catCols, dateCols, corr, groups, trend };
  }

  function localQuality() {
    const h = A.health();
    const head = A.header();
    const s = A.sheet();
    const body = s.rows.slice(1);
    const issues = [];
    for (let c = 0; c < A.colCount(); c++) {
      const st = A.columnStats(c);
      const name = head[c] || A.colLetter(c);
      if (st.empty > 0) {
        const rate = st.total ? st.empty / st.total : 0;
        issues.push({ level: rate > 0.2 ? 'high' : 'mid', text: `「${name}」有 ${st.empty} 个空值（占 ${(rate * 100).toFixed(1)}%）`, act: { type: 'fillMissing', column: name, strategy: A.colType(c) === 'number' ? 'mean' : 'mode' } });
      }
      const t = A.colType(c);
      if (t === 'text') {
        let numLike = 0, spaced = 0;
        for (const r of body) {
          const v = A.cellText(r[c]);
          if (!v) continue;
          if (A.parseNumber(v) !== null) numLike++;
          if (v !== v.trim() || /\s{2,}/.test(v)) spaced++;
        }
        if (numLike > body.length * 0.5 && numLike > 2) issues.push({ level: 'mid', text: `「${name}」是文本格式的数字，无法参与求和（${numLike} 个）`, act: { type: 'convertNumber', column: name } });
        if (spaced > 0) issues.push({ level: 'low', text: `「${name}」有 ${spaced} 个单元格存在多余空格或换行`, act: { type: 'trimSpaces' } });
      }
      if (t === 'date') {
        let bad = 0;
        for (const r of body) if (!A.isEmpty(r[c]) && !A.parseDate(r[c])) bad++;
        if (bad > 1) issues.push({ level: 'low', text: `「${name}」有 ${bad} 个日期格式不统一`, act: { type: 'convertDate', column: name } });
      }
    }
    if (h && h.dup > 0) issues.unshift({ level: h.dupRate > 0.05 ? 'high' : 'mid', text: `存在 ${h.dup} 行完全重复的记录`, act: { type: 'deleteDuplicates' } });
    if (h && h.outlier > 0) {
      const numCol = A.header().findIndex((_, i) => A.colType(i) === 'number');
      if (numCol >= 0) issues.push({ level: 'mid', text: `数值列中检测到 ${h.outlier} 个偏离整体分布的异常值`, act: { type: 'removeOutliers', column: head[numCol] } });
    }
    return { h, issues };
  }

  function localReport(kind) {
    const s = A.sheet();
    if (!s) return { text: '还没有载入数据。**先导入 Excel 或 CSV 文件**，我就能开始分析。' };
    if (s.rows.length < 2) return { text: '当前工作表只有表头、没有数据行，暂时无法分析。' };
    // 有行但全是空行（比如刚新建的空白表）：也说清楚，别报"共 0 行 × 3 列"
    if (!s.rows.slice(1).some(r => (r || []).some(v => A.cellText(v).trim()))) {
      return { text: '这张表还没有数据 —— 双击单元格录入，或把 Excel / CSV 拖进来，我再帮你分析。' };
    }
    const D = deepStats();
    const head = A.header();
    const n = D.body.length;
    const md = [];
    const charts = [];

    if (kind === 'overview') {
      md.push(`### 数据概览`);
      md.push(`这份「${s.name}」共 **${n} 行 × ${head.length} 列**。其中数值列 ${D.numCols.length} 个、分类文本列 ${D.catCols.length} 个、日期列 ${D.dateCols.length} 个。`);
      if (D.numCols.length) {
        md.push(`**核心指标**`);
        D.numCols.slice(0, 4).forEach(c => {
          const n = c.st.num;
          md.push(`- ${c.name}：${c.additive ? `合计 **${A.fmt(n.sum)}**，` : ''}平均 ${A.fmt(n.mean)}，区间 ${A.fmt(n.min)} ~ ${A.fmt(n.max)}`);
        });
      }
      if (D.catCols.length) {
        md.push(`**维度分布**`);
        D.catCols.slice(0, 3).forEach(c => {
          const top = c.st.top.slice(0, 3).map(([v, cnt]) => `${v}（${cnt}）`).join('、');
          md.push(`- ${c.name}：${c.st.unique} 个取值，最多的是 ${top}`);
        });
      }
      if (D.trend) {
        md.push(`**时间跨度**：${D.trend.date} 覆盖 ${D.trend.series[0][0]} ~ ${D.trend.series[D.trend.series.length - 1][0]}，共 ${D.trend.series.length} 个月。`);
      }
      const best = D.catCols[0] && D.numCols[0] ? `${D.catCols[0].name} × ${D.numCols[0].name}` : '';
      md.push(`\n> 提示：想深入某个维度，可以直接问「按${D.catCols[0] ? D.catCols[0].name : '类别'}看${D.numCols[0] ? D.numCols[0].name : '指标'}」。`);
      if (D.catCols[0] && D.numCols[0]) {
        const c = { type: 'bar', x: D.catCols[0].i, y: D.numCols[0].i, agg: 'sum', title: `${D.numCols[0].name} 按 ${D.catCols[0].name}`, sortByValue: true };
        const data = A.prepareChartData(c);
        if (data.values.length) charts.push({ spec: c, svg: A.renderChartSVG(Object.assign({}, c, data), 352, 205) });
      }
      return { text: md.join('\n'), charts };
    }

    if (kind === 'quality') {
      const { h, issues } = localQuality();
      if (h && h.blank) {
        return { text: h.rows
          ? `这张表目前只有 ${h.rows} 行数据，样本太少，先多录几行（或导入完整数据），我再帮你做质量诊断。`
          : '这张表还是空白的，还没有可体检的数据 —— 直接双击单元格录入，或把 Excel / CSV 拖进来，我再来帮你检查空值、重复行和异常值。' };
      }
      md.push(`### 数据质量诊断`);
      md.push(`健康评分 **${h.score}/100** —— ${h.score >= 85 ? '整体可用' : h.score >= 65 ? '需要少量清洗' : '建议先系统清洗'}。`);
      md.push(`| 检查项 | 结果 |\n|---|---|\n| 有效行数 | ${h.rows} |\n| 空单元格 | ${h.emptyCells}（${(h.emptyRate * 100).toFixed(1)}%）|\n| 重复行 | ${h.dup} |\n| 异常值 | ${h.outlier} |`);
      if (issues.length) {
        md.push(`**发现的问题**`);
        issues.slice(0, 8).forEach((it, i) => md.push(`${i + 1}. ${it.text}`));
      } else {
        md.push(`没有发现明显的空值、重复或格式问题，数据可以直接用于分析。`);
      }
      return { text: md.join('\n'), actions: issues.filter(i => i.act).map(i => i.act).slice(0, 6) };
    }

    if (kind === 'clean') {
      const { h, issues } = localQuality();
      const acts = [];
      const seen = new Set();
      issues.forEach(it => {
        if (!it.act) return;
        const k = it.act.type + '|' + (it.act.column || '');
        if (seen.has(k)) return;
        seen.add(k); acts.push(it.act);
      });
      md.push(`### 清洗方案`);
      if (!acts.length) {
        md.push('这份数据相当干净：没有空值、重复行或明显的格式问题，无需清洗。');
        return { text: md.join('\n') };
      }
      md.push(`根据体检结果，建议按以下 **${acts.length} 步**处理（顺序已考虑依赖关系）：`);
      acts.forEach((a, i) => {
        const label = a.type === 'deleteDuplicates' ? '删除完全重复的记录，保留首次出现'
          : a.type === 'trimSpaces' ? '统一清理单元格首尾空格与多余空白'
            : a.type === 'convertNumber' ? `把「${a.column}」的文本型数字转换为数值，便于求和`
              : a.type === 'fillMissing' ? `用${a.strategy === 'mean' ? '平均值' : '众数'}填充「${a.column}」的 ${A.columnStats(resolveCol(a.column)).empty} 个缺失值`
                : a.type === 'removeOutliers' ? `剔除「${a.column}」中超出 1.5 倍四分位距的异常值`
                  : a.type === 'convertDate' ? `统一「${a.column}」的日期格式为 YYYY-MM-DD` : '处理数据问题';
        md.push(`${i + 1}. ${label}`);
      });
      md.push(`\n> 清洗会修改当前工作表，可用 Ctrl+Z 撤销。`);
      return { text: md.join('\n'), actions: acts };
    }

    if (kind === 'insight') {
      md.push(`### 业务洞察`);
      const pts = [];
      if (D.groups.length) {
        const g = D.groups.slice().sort((a, b) => b.top3Share - a.top3Share)[0];
        const top = g.items[0];
        pts.push(`**集中度**：按「${g.cat}」拆解「${g.val}」时，${top.k} 贡献最高（${A.fmt(top.v)}，占 ${(top.share * 100).toFixed(1)}%），前 3 名合计占 ${(g.top3Share * 100).toFixed(1)}%${g.top3Share > 0.7 ? '，结构明显集中' : '，分布相对均衡'}。`);
      }
      if (D.corr.length) {
        const c = D.corr[0];
        pts.push(`**相关关系**：「${c.a}」与「${c.b}」的相关系数为 ${c.r.toFixed(2)}，${Math.abs(c.r) > 0.8 ? '呈强' : '呈中等'}${c.r > 0 ? '正' : '负'}相关${c.r > 0 ? '，通常同向变动' : '，一方上升时另一方往往下降'}。`);
      }
      if (D.trend && D.trend.change !== null) {
        const dir = D.trend.change >= 0 ? '增长' : '下降';
        pts.push(`**趋势**：「${D.trend.val}」按 ${D.trend.date} 汇总后，从 ${D.trend.series[0][0]} 的 ${A.fmt(D.trend.series[0][1])} 变化到 ${D.trend.series[D.trend.series.length - 1][0]} 的 ${A.fmt(D.trend.series[D.trend.series.length - 1][1])}，整体${dir} ${Math.abs(D.trend.change * 100).toFixed(1)}%，月均 ${A.fmt(D.trend.avg)}。`);
      }
      if (D.numCols.length >= 2) {
        const c = D.numCols[0];
        const mean = c.st.num.mean, sd = c.st.num.sd || 0;
        const high = D.body.filter(r => (A.parseNumber(r[c.i]) || 0) > mean + sd).length;
        if (high) pts.push(`**分布**：「${c.name}」中约 ${high} 行（${(high / n * 100).toFixed(0)}%）高于平均值一个标准差以上，属于高价值记录，值得单独跟进。`);
      }
      if (!pts.length) pts.push('数据维度较少，暂时无法给出结构性结论。建议补充数值指标或时间字段后再分析。');
      md.push(pts.join('\n\n'));
      const cats = D.catCols[0], vals = D.numCols[0];
      if (cats && vals) {
        const c = { type: 'bar', x: cats.i, y: vals.i, agg: 'sum', title: `${vals.name} 按 ${cats.name}`, sortByValue: true };
        const data = A.prepareChartData(c);
        if (data.values.length) charts.push({ spec: c, svg: A.renderChartSVG(Object.assign({}, c, data), 352, 205) });
      }
      if (D.trend) {
        const c = { type: 'line', x: D.dateCols[0].i, y: D.numCols[0].i, agg: 'sum', title: `${D.numCols[0].name} 月度趋势` };
        const data = A.prepareChartData(c);
        if (data.values.length > 1) charts.push({ spec: c, svg: A.renderChartSVG(Object.assign({}, c, data), 352, 205) });
      }
      return { text: md.join('\n'), charts: charts.slice(0, 2) };
    }

    if (kind === 'chart') {
      md.push(`### 推荐图表`);
      const ideas = [];
      if (D.catCols[0] && D.numCols[0]) ideas.push({ type: 'bar', x: D.catCols[0].i, y: D.numCols[0].i, agg: 'sum', title: `${D.numCols[0].name} 按 ${D.catCols[0].name} 对比`, why: `用柱状图横向对比不同${D.catCols[0].name}的${D.numCols[0].name}总量，差异一眼可见。` });
      if (D.trend) ideas.push({ type: 'line', x: D.dateCols[0].i, y: D.numCols[0].i, agg: 'sum', title: `${D.numCols[0].name} 随时间的走势`, why: `用折线图呈现${D.numCols[0].name}在时间上的变化，适合发现趋势与拐点。` });
      if (D.catCols[1] && D.numCols[0]) ideas.push({ type: 'pie', x: D.catCols[1].i, y: D.numCols[0].i, agg: 'sum', title: `${D.catCols[1].name} 构成占比`, why: `用饼图看${D.catCols[1].name}的结构占比，类别数不宜过多。` });
      if (ideas.length === 0) md.push('当前数据列类型不足以自动推荐图表。至少需要一个分类列和一个数值列。');
      ideas.forEach((idea, i) => {
        const data = A.prepareChartData(Object.assign({}, idea, { sortByValue: i === 2 }));
        if (!data.values.length) return;
        md.push(`**${i + 1}. ${idea.title}**\n${idea.why}`);
        charts.push({ spec: idea, svg: A.renderChartSVG(Object.assign({}, idea, data), 352, 205) });
      });
      return { text: md.join('\n'), charts };
    }

    return { text: '我可以帮你做数据概览、质量诊断、清洗建议和业务洞察，直接选下方的快捷指令即可。' };
  }

  /* ============================ 渲染富文本回复 ============================ */
  function renderRich(target, raw) {
    let text = raw;
    const charts = [];
    const actions = [];

    text = text.replace(/```chart\s*([\s\S]*?)```/g, (m, body) => {
      try {
        const spec = JSON.parse(body.trim().replace(/^[^{[]*/, '').replace(/[^}\]]*$/, ''));
        charts.push(spec);
      } catch (e) { }
      return '';
    });
    text = text.replace(/```actions\s*([\s\S]*?)```/g, (m, body) => {
      try {
        const list = JSON.parse(body.trim().replace(/^[^{[]*/, '').replace(/[^}\]]*$/, ''));
        if (Array.isArray(list)) actions.push(...list);
        else if (list && Array.isArray(list.actions)) actions.push(...list.actions);
      } catch (e) { }
      return '';
    });
    // ```json {"actions":[...]} 形式
    text = text.replace(/```json\s*([\s\S]*?)```/g, (m, body) => {
      try {
        const obj = JSON.parse(body.trim());
        if (obj && Array.isArray(obj.actions)) { actions.push(...obj.actions); return ''; }
        if (obj && obj.type && obj.y) { charts.push(obj); return ''; }
      } catch (e) { }
      return m;
    });

    let html = mdToHtml(text.trim());
    charts.forEach(spec => { html += buildChart(spec) || ''; });
    if (actions.length) html += actionsCard(actions);
    target.innerHTML = html;
    bindActionCards(target);
  }

  /* ============================ 模型调用 ============================ */
  const SYSTEM_PROMPT = `你是 SheetPilot 的表格数据分析助手，帮助用户理解、诊断和处理当前打开的 Excel 数据。

回答要求：
1. 使用简体中文，结论先行，具体、直接，不说客套话。
2. 只能使用提供的数据计算，不得编造数字。数据不足以回答时，明确指出缺什么。
3. 结构化输出：一句话结论 + 2~5 条要点（用 "-" 列表）；对比数据可用 markdown 表格。不要输出原始数据大表。
4. 涉及金额、数量等指标时给出具体数值和单位；必要时给出百分比与占比。
5. 如果用户要求画图，在回答末尾追加一个 chart 代码块，格式严格如下（x/y 必须是数据中真实存在的列名）：
\`\`\`chart
{"type":"bar","x":"列名A","y":"列名B","agg":"sum","title":"标题"}
\`\`\`
type 只能取 bar / line / pie / scatter；agg 只能取 sum / avg / count。
6. 如果结论里包含数据清洗操作，在回答末尾追加 actions 代码块，用户可一键执行：
\`\`\`actions
[{"type":"deleteDuplicates"},{"type":"fillMissing","column":"列名","strategy":"mean"}]
\`\`\`
可用 type：deleteDuplicates、deleteEmptyRows、trimSpaces、fillMissing(column,strategy=mean|median|mode|zero)、convertNumber(column)、convertDate(column)、removeOutliers(column)、dropColumn(column)。
7. 不要输出 actions 或 chart 代码块的 JSON 解释，只给块本身。`;

  let history = [];
  let busy = false;

  async function callModel(messages, onDelta) {
    // 兼容两种填法：Base URL（自动补 /chat/completions）或直接填完整接口地址
    let url = cfg.baseUrl.replace(/\/+$/, '');
    if (!/\/chat\/completions$/.test(url)) url += '/chat/completions';
    const body = {
      model: cfg.model,
      messages,
      temperature: Number(cfg.temperature) || 0.3,
      stream: true,
    };
    let res;
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 90000);
    try {
      res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + cfg.apiKey },
        body: JSON.stringify(body),
        signal: ctrl.signal,
      });
    } catch (e) {
      clearTimeout(timer);
      if (e.name === 'AbortError') throw new Error('TIMEOUT');
      throw new Error('NETWORK');
    }
    clearTimeout(timer);
    if (!res.ok) {
      let msg = '';
      try { msg = (await res.text()).slice(0, 300); } catch (e) { }
      if (res.status === 401 || res.status === 403) throw new Error('API Key 无效或没有权限（HTTP ' + res.status + '）');
      if (res.status === 404) throw new Error('接口地址不存在，请检查 Base URL（HTTP 404）');
      if (res.status === 429) throw new Error('请求过于频繁或额度不足（HTTP 429）');
      throw new Error('请求失败 HTTP ' + res.status + (msg ? '：' + msg : ''));
    }
    const ctype = res.headers.get('content-type') || '';
    if (ctype.includes('application/json')) {
      const j = await res.json();
      const content = j.choices?.[0]?.message?.content || '';
      if (content) onDelta(content);
      return;
    }
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let buf = '';
    // 流式读取的空闲看门狗：模型卡住不吐字时 60 秒后中断，避免界面一直转圈
    let idle = setTimeout(() => ctrl.abort(), 60000);
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        clearTimeout(idle);
        idle = setTimeout(() => ctrl.abort(), 60000);
        buf += dec.decode(value, { stream: true });
        const lines = buf.split('\n');
        buf = lines.pop() || '';
        for (const line of lines) {
          const l = line.trim();
          if (!l.startsWith('data:')) continue;
          const data = l.slice(5).trim();
          if (!data || data === '[DONE]') continue;
          try {
            const j = JSON.parse(data);
            const d = j.choices?.[0]?.delta?.content || j.choices?.[0]?.text || '';
            if (d) onDelta(d);
          } catch (e) { }
        }
      }
    } catch (e) {
      if (e && e.name === 'AbortError') throw new Error('STALL');
      throw e;
    } finally {
      clearTimeout(idle);
    }
  }

  /* ============================ 对话主流程 ============================ */
  async function ask(text, displayText) {
    if (busy) return;
    const s = A.sheet();
    if (!s) { A.toast('请先导入数据', 'err'); return; }
    pushMsg('user', mdToHtml(displayText || text));
    busy = true;
    $('#btnSend').disabled = true;

    if (!hasKey()) {
      // 本地分析模式
      const bubble = pushTyping();
      await new Promise(r => setTimeout(r, 260));
      delete bubble.dataset.typing;
      const kind = mapLocal(text);
      const res = localReport(kind);
      let html = mdToHtml(res.text);
      if (res.charts) res.charts.forEach(c => { html += chartHtml(c.spec, c.svg); });
      if (res.actions && res.actions.length) html += actionsCard(res.actions);
      bubble.innerHTML = html;
      bindActionCards(bubble);
      bubble.insertAdjacentHTML('afterbegin', '<div style="font-size:10.5px;color:var(--muted);margin-bottom:6px">由本地分析引擎生成 · 配置模型后可获得更深入的解读</div>');
      scrollBottom();
      busy = false; $('#btnSend').disabled = false;
      return;
    }

    const bubble = pushTyping();
    let acc = '';
    let lastRender = 0;
    const msgs = [{ role: 'system', content: SYSTEM_PROMPT }];
    history.slice(-6).forEach(h => msgs.push(h));
    const userContent = cfg.includeData
      ? `以下是当前工作表的数据摘要与样例：\n\n${A.buildContext()}\n\n---\n\n用户问题：${text}`
      : `用户问题：${text}`;
    msgs.push({ role: 'user', content: userContent });

    try {
      await callModel(msgs, delta => {
        acc += delta;
        const now = Date.now();
        if (now - lastRender > 90) {
          lastRender = now;
          bubble.innerHTML = mdToHtml(acc) + '<span style="opacity:.35">▍</span>';
          scrollBottom();
        }
      });
      if (!acc.trim()) acc = '_模型没有返回内容，请检查模型名称是否可用。_';
      renderRich(bubble, acc);
      history.push({ role: 'user', content: text });
      history.push({ role: 'assistant', content: acc });
      if (history.length > 8) history = history.slice(-8);
      scrollBottom();
    } catch (err) {
      const msg = err.message === 'NETWORK'
        ? '无法连接模型接口。可能是网络问题，或该服务不允许浏览器直接调用（CORS）。可改用支持跨域的代理地址，或换一个服务商。'
        : err.message === 'TIMEOUT'
          ? '模型响应超时（90 秒）。请稍后重试，或换用响应更快的模型。'
          : err.message === 'STALL'
            ? '模型长时间没有返回数据，已自动中断。可以重试，或换一个响应更快的模型。'
            : err.message;
      bubble.innerHTML = `<div style="color:var(--red);font-weight:600;margin-bottom:4px">请求失败</div>
        <div style="font-size:12px;line-height:1.6">${esc(msg)}</div>
        <div style="margin-top:8px"><button class="btn sm" onclick="window.App.ai.openSettings()">检查模型设置</button></div>`;
    } finally {
      busy = false;
      $('#btnSend').disabled = false;
    }
  }

  function mapLocal(text) {
    const t = text;
    if (/(清洗|清理|修正|处理建?议)/.test(t)) return 'clean';
    if (/(质量|体检|问题|脏|异常|重复|空值)/.test(t)) return 'quality';
    if (/(图表|画|可视化|趋势图|柱状|折线|饼图)/.test(t)) return 'chart';
    if (/(洞察|分析|原因|为什么|规律|建议|策略|表现)/.test(t)) return 'insight';
    return 'overview';
  }

  /* ============================ 设置弹窗 ============================ */
  function openSettings() {
    const presetOpts = Object.entries(PRESETS).map(([k, v]) => `<option value="${k}" ${cfg.preset === k ? 'selected' : ''}>${v.name}</option>`).join('');
    const m = A.showModal({
      title: 'AI 模型设置', sub: '密钥仅保存在本机浏览器', width: 500,
      bodyHTML: `
        <div class="field">
          <label>服务商</label>
          <select id="aiPreset">${presetOpts}</select>
        </div>
        <div class="field">
          <label>接口地址（Base URL）</label>
          <input type="text" id="aiBase" value="${esc(cfg.baseUrl)}" placeholder="https://api.deepseek.com/v1">
          <div class="help">兼容 OpenAI 格式的 <code>/chat/completions</code> 接口，末尾不要带斜杠。</div>
        </div>
        <div class="field-row">
          <div class="field"><label>模型名称</label><input type="text" id="aiModel" value="${esc(cfg.model)}" placeholder="deepseek-chat"></div>
          <div class="field" style="flex:0 0 110px"><label>温度</label><input type="text" id="aiTemp" value="${cfg.temperature}"></div>
        </div>
        <div class="field">
          <label>API Key</label>
          <input type="password" id="aiKey" value="${esc(cfg.apiKey)}" placeholder="sk-...">
          <div class="help">保存在 localStorage，不会上传到任何第三方。不在公共电脑上使用。</div>
        </div>
        <div class="field" style="display:flex;align-items:center;gap:8px">
          <input type="checkbox" id="aiInclude" ${cfg.includeData ? 'checked' : ''} style="width:14px;height:14px;accent-color:var(--primary)">
          <label for="aiInclude" style="margin:0;font-weight:400;color:var(--text-2)">每次提问附带数据摘要与样例（推荐）</label>
        </div>
        <div id="aiTestResult" style="font-size:12px;line-height:1.6"></div>`,
      buttons: [
        { label: '测试连接', onClick: (el) => {
          const result = el.querySelector('#aiTestResult');
          const btn = el.querySelector('[data-btn="0"]');
          btn.disabled = true; btn.textContent = '测试中…';
          result.innerHTML = '';
          const backup = { baseUrl: cfg.baseUrl, model: cfg.model, apiKey: cfg.apiKey };
          applyForm(el);
          (async () => {
            try {
              let got = '';
              await callModel([
                { role: 'system', content: '你是测试助手。' },
                { role: 'user', content: '只回复两个字：正常' },
              ], d => { got += d; });
              result.innerHTML = `<span style="color:var(--green)">连接成功，模型返回：${esc(got.slice(0, 40) || '(空)')}</span>`;
            } catch (e) {
              result.innerHTML = `<span style="color:var(--red)">${esc(e.message === 'NETWORK' ? '连接失败：网络不可达或被 CORS 拦截' : e.message)}</span>`;
              cfg.baseUrl = backup.baseUrl; cfg.model = backup.model; cfg.apiKey = backup.apiKey;
            }
            btn.disabled = false; btn.textContent = '测试连接';
          })();
          return false;
        } },
        { label: '取消' },
        { label: '保存', cls: 'primary', onClick: (el) => {
          applyForm(el);
          saveCfg();
          updateModelTag();
          A.toast('模型设置已保存', 'ok');
          pushMsg('ai', mdToHtml(`已切换到 **${esc(cfg.model)}**。现在提出的问题会由该模型结合表格数据分析。`));
        } },
      ],
    });

    function applyForm(el) {
      cfg.preset = el.querySelector('#aiPreset').value;
      cfg.baseUrl = el.querySelector('#aiBase').value.trim();
      cfg.model = el.querySelector('#aiModel').value.trim();
      cfg.apiKey = el.querySelector('#aiKey').value.trim();
      cfg.temperature = parseFloat(el.querySelector('#aiTemp').value) || 0.3;
      cfg.includeData = el.querySelector('#aiInclude').checked;
    }

    m.el.querySelector('#aiPreset').onchange = e => {
      const p = PRESETS[e.target.value];
      if (!p) return;
      if (p.baseUrl) m.el.querySelector('#aiBase').value = p.baseUrl;
      if (p.model) m.el.querySelector('#aiModel').value = p.model;
    };
    return m;
  }

  /* ============================ 面板控制 ============================ */
  function openPanel() {
    $('#aiPanel').classList.remove('collapsed');
    setTimeout(() => { $('#aiInput') && $('#aiInput').focus(); }, 120);
  }
  function togglePanel() {
    const p = $('#aiPanel');
    p.classList.toggle('collapsed');
    if (!p.classList.contains('collapsed')) setTimeout(() => $('#aiInput').focus(), 150);
  }

  /* ============================ 启动 ============================ */
  function welcome() {
    const s = A.sheet();
    const body = $('#aiBody');
    if (!body || body.dataset.init) return;
    body.dataset.init = '1';
    pushMsg('ai', mdToHtml(`我是这份表格的分析助手，可以直接回答关于数据的问题、给出清洗方案、生成图表。

**可以这样问我**
- 哪个地区 / 类别的表现最好？
- 帮我找出数据里的问题并处理掉
- 按月看趋势，画一张折线图
- 这批订单有什么异常？

${hasKey() ? `当前模型：**${cfg.model}**` : '当前未配置模型，先用内置分析引擎为你服务。**配置模型**后可获得更灵活的解读。'}`));
    if (!hasKey()) {
      const bubble = pushMsg('ai', `<div style="display:flex;gap:8px;align-items:center;font-size:12px">
        <span style="color:var(--muted)">想要更深入的 AI 解读？</span>
        <button class="btn sm" onclick="window.App.ai.openSettings()">配置模型</button></div>`);
      bubble.style.background = 'transparent';
      bubble.style.border = 'none';
      bubble.style.padding = '0';
    }
    if (s) onDataLoaded();
  }

  /** 切换文件 / 工作表时只重置多轮上下文，不主动说话：用户不问，AI 不出声 */
  function onDataLoaded() {
    history = [];
  }

  /* ==================== 每个界面独立的对话 ==================== */
  /** 取当前对话快照（消息 DOM + 多轮上下文），供该界面保存 */
  function snapshot() {
    const body = $('#aiBody');
    return { html: body ? body.innerHTML : '', history: history.slice() };
  }

  /** 恢复某个界面的对话；没有快照时回到全新欢迎语（不继承上个界面） */
  function restore(snap) {
    const body = $('#aiBody');
    if (!body) return;
    if (snap && snap.html) {
      body.innerHTML = snap.html;
      body.dataset.init = '1';
      history = Array.isArray(snap.history) ? snap.history.slice() : [];
      const sc = $('#aiBody');
      if (sc) sc.scrollTop = sc.scrollHeight;
      return;
    }
    resetSession();
  }

  /** 清空对话、回到欢迎语（模型配置与 API Key 不受影响） */
  function resetSession() {
    const body = $('#aiBody');
    if (!body) return;
    history = [];
    body.innerHTML = '';
    delete body.dataset.init;
    welcome();
  }

  function quick(kind) {
    openPanel();
    const map = {
      overview: '帮我全面概览这份数据，有哪些关键指标和维度？',
      quality: '诊断一下这份数据的质量，有哪些问题？',
      clean: '给出可执行的清洗方案',
      insight: '从业务角度分析这份数据，有什么值得注意的洞察？',
      chart: '推荐适合这份数据的图表，并画出来',
    };
    ask(map[kind] || map.overview, map[kind]);
  }

  function bindUI() {
    $('#btnSend').onclick = () => {
      const ta = $('#aiInput');
      const v = ta.value.trim();
      if (!v) return;
      ta.value = ''; ta.style.height = 'auto';
      ask(v);
    };
    $('#aiInput').addEventListener('keydown', e => {
      if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); $('#btnSend').click(); }
    });
    let t;
    $('#aiInput').addEventListener('input', e => {
      clearTimeout(t);
      t = setTimeout(() => {
        e.target.style.height = 'auto';
        e.target.style.height = Math.min(120, e.target.scrollHeight) + 'px';
      }, 0);
    });
    $('#btnAISettings').onclick = openSettings;
    $('#btnAIClose').onclick = () => $('#aiPanel').classList.add('collapsed');
    $('#btnAIToggle').onclick = togglePanel;
    $('#btnAIQuick').onclick = () => { openPanel(); quick('insight'); };
    $$('#quickChips .chip').forEach(c => c.onclick = () => quick(c.dataset.prompt));
    updateModelTag();
    welcome();
  }

  window.App.ai = {
    openSettings, openPanel, togglePanel, ask, quick, onDataLoaded,
    addChartMessage, localReport, hasKey, cfg,
    snapshot, restore, resetSession,
  };

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', bindUI);
  else bindUI();
})();
