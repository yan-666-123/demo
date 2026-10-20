/* SheetPilot — 本地表格引擎 */
(function () {
  'use strict';

  /* ============================================================
   * 基础工具
   * ========================================================== */
  const $ = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

  function esc(v) {
    return String(v == null ? '' : v)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  function toast(msg, kind = '') {
    const wrap = $('#toastWrap');
    // 同一条提示连点时只保留一条，避免刷屏
    const last = wrap.lastElementChild;
    if (last && last.dataset.msg === msg) return;
    while (wrap.children.length >= 3) wrap.firstElementChild.remove();
    const el = document.createElement('div');
    el.className = 'toast ' + kind;
    el.dataset.msg = msg;
    el.innerHTML = (kind === 'ok' ? '<svg width="14" height="14" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><use href="#i-check"/></svg>' : '') + esc(msg);
    wrap.appendChild(el);
    setTimeout(() => { el.style.transition = 'opacity .25s'; el.style.opacity = '0'; setTimeout(() => el.remove(), 260); }, 2400);
  }

  function fmt(n, digits = 2) {
    if (n === null || n === undefined || !isFinite(n)) return '—';
    const abs = Math.abs(n);
    const d = Number.isInteger(n) ? 0 : (abs < 1 ? Math.min(4, digits + 1) : digits);
    return n.toLocaleString('zh-CN', { minimumFractionDigits: d, maximumFractionDigits: d });
  }

  function colLetter(i) {
    let s = '';
    i = i + 1;
    while (i > 0) {
      const m = (i - 1) % 26;
      s = String.fromCharCode(65 + m) + s;
      i = Math.floor((i - 1) / 26);
    }
    return s;
  }

  function textWidth(str) {
    let w = 0;
    for (const ch of String(str == null ? '' : str)) {
      w += /[\u4e00-\u9fff\u3000-\u303f\uff00-\uffef]/.test(ch) ? 12.6 : 7.1;
    }
    return w;
  }

  function debounce(fn, ms) {
    let t;
    return function () { clearTimeout(t); const a = arguments, c = this; t = setTimeout(() => fn.apply(c, a), ms); };
  }

  /* ============================================================
   * 值解析 / 类型推断 / 统计
   * ========================================================== */
  function isEmpty(v) { return v === null || v === undefined || String(v).trim() === ''; }

  function parseNumber(v) {
    if (v === null || v === undefined) return null;
    if (typeof v === 'number') return isFinite(v) ? v : null;
    let s = String(v).trim();
    if (!s) return null;
    if (/^0\d{2,}$/.test(s)) return null; // 工号、邮编等保留为文本
    if (/^[-+]?[\d,]*\.?\d+\s*%$/.test(s)) return parseFloat(s.replace(/[,%\s]/g, '')) / 100;
    s = s.replace(/[,¥$€£￥\s]/g, '');
    if (!/^[-+]?(\d+\.?\d*|\.\d+)([eE][-+]?\d+)?$/.test(s)) return null;
    if (s.replace(/[-+]/g, '').replace('.', '').length > 16) return null;
    const n = Number(s);
    return isFinite(n) ? n : null;
  }

  function parseDate(v) {
    if (v instanceof Date) return isNaN(v) ? null : v;
    const s = String(v == null ? '' : v).trim();
    if (!s) return null;
    let m = s.match(/^(\d{4})[-/年.](\d{1,2})[-/月.](\d{1,2})日?(\s+\d{1,2}:\d{2}(:\d{2})?)?$/);
    if (m) {
      const d = new Date(+m[1], +m[2] - 1, +m[3], m[4] ? +m[4].trim().split(':')[0] : 0);
      return isNaN(d) ? null : d;
    }
    m = s.match(/^(\d{4})[-/年.](\d{1,2})月?$/);
    if (m) { const d = new Date(+m[1], +m[2] - 1, 1); return isNaN(d) ? null : d; }
    m = s.match(/^(\d{1,2})[-/](\d{1,2})[-/](\d{4})$/);
    if (m) { const d = new Date(+m[3], +m[1] - 1, +m[2]); return isNaN(d) ? null : d; }
    if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(s)) { const d = new Date(s); return isNaN(d) ? null : d; }
    return null;
  }

  function cellText(v) { return v === null || v === undefined ? '' : String(v); }

  /* ============================================================
   * 状态
   * ========================================================== */
  const state = {
    fileName: '',
    fileKind: 'xlsx',
    sheets: [],          // [{ name, rows: string[][] }]
    active: 0,
    page: 1,
    pageSize: 50,
    search: '',
    filters: {},         // colIndex -> [allowed values]
    sort: null,          // { col, dir }
    history: [],
    future: [],
    sel: { r: -1, c: -1 },
    editing: false,
    editMode: false,     // 编辑模式：开启后单击单元格直接进入编辑
    manualEdit: false,   // 空白表点了「直接录入」：强制显示空白网格
    charts: [],
    docs: [],            // 多文件标签：[{ id, name, kind, sheets, active, page, search, filters, sort, history, future, sel, dirty }]
    activeDoc: -1,
    _view: null,
    _types: null,
  };
  const HISTORY_LIMIT = 20;

  function sheet() { return state.sheets[state.active] || null; }
  function rows() { const s = sheet(); return s ? s.rows : []; }
  function header() { const r = rows(); return r[0] || []; }
  function colCount() { let n = 0; for (const r of rows()) n = Math.max(n, r.length); return n; }

  function invalidate() { state._view = null; state._types = null; }

  function colType(c) {
    if (!state._types) state._types = [];
    if (state._types[c]) return state._types[c];
    const body = rows().slice(1);
    let n = 0, dates = 0, total = 0;
    const limit = Math.min(body.length, 4000);
    for (let i = 0; i < limit; i++) {
      const v = body[i][c];
      if (isEmpty(v)) continue;
      total++;
      if (parseNumber(v) !== null) n++;
      else if (parseDate(v)) dates++;
    }
    let t = 'text';
    if (!total) t = 'empty';
    else if (n / total >= 0.65) t = 'number';
    else if (dates / total >= 0.65) t = 'date';
    state._types[c] = t;
    return t;
  }

  function typeName(t) { return { number: '数字', date: '日期', text: '文本', empty: '空' }[t] || '文本'; }

  function columnStats(c) {
    const body = rows().slice(1);
    const nums = [];
    let empty = 0, nonEmpty = 0;
    const uniq = new Map();
    let dateMin = null, dateMax = null;
    for (const r of body) {
      const v = r[c];
      if (isEmpty(v)) { empty++; continue; }
      nonEmpty++;
      const key = String(v).trim();
      uniq.set(key, (uniq.get(key) || 0) + 1);
      const num = parseNumber(v);
      if (num !== null) nums.push(num);
      const d = parseDate(v);
      if (d) { if (!dateMin || d < dateMin) dateMin = d; if (!dateMax || d > dateMax) dateMax = d; }
    }
    const sorted = nums.slice().sort((a, b) => a - b);
    const sum = nums.reduce((a, b) => a + b, 0);
    const q = p => sorted.length ? sorted[Math.min(sorted.length - 1, Math.max(0, Math.floor((sorted.length - 1) * p)))] : null;
    const mean = nums.length ? sum / nums.length : null;
    const sd = nums.length > 1 ? Math.sqrt(nums.reduce((a, b) => a + (b - mean) * (b - mean), 0) / nums.length) : null;
    const st = {
      empty, nonEmpty, total: body.length,
      unique: uniq.size,
      num: nums.length ? {
        count: nums.length, sum, mean, min: sorted[0], max: sorted[sorted.length - 1],
        median: q(0.5), sd, q1: q(0.25), q3: q(0.75),
      } : null,
      dateRange: dateMin ? [dateMin, dateMax] : null,
      top: Array.from(uniq.entries()).sort((a, b) => b[1] - a[1]).slice(0, 6),
      uniqueMap: uniq,
    };
    return st;
  }

  function columnValues(c) {
    const seen = new Map();
    for (const r of rows().slice(1)) {
      const v = cellText(r[c]).trim();
      if (v === '') continue;
      seen.set(v, (seen.get(v) || 0) + 1);
    }
    return Array.from(seen.entries()).sort((a, b) => b[1] - a[1] || String(a[0]).localeCompare(String(b[0])));
  }

  /* ============================================================
   * 视图（筛选 / 搜索 / 分页）
   * ========================================================== */
  function computeView() {
    const s = sheet();
    if (!s) return { idx: [], total: 0 };
    const body = s.rows;
    let idx = [];
    for (let i = 1; i < body.length; i++) idx.push(i);
    // Set 只建一次：以前每行每列都 new 一个 Set，几万行时是明显的性能陷阱
    const activeFilters = Object.entries(state.filters)
      .filter(([, v]) => Array.isArray(v))
      .map(([c, v]) => [+c, new Set(v)]);
    if (activeFilters.length) {
      idx = idx.filter(i => activeFilters.every(([c, set]) => set.has(cellText((body[i] || [])[c]).trim())));
    }
    if (state.search) {
      const q = state.search.toLowerCase();
      idx = idx.filter(i => (body[i] || []).some(v => cellText(v).toLowerCase().includes(q)));
    }
    return { idx, total: Math.max(0, body.length - 1) };
  }

  function view() { if (!state._view) state._view = computeView(); return state._view; }
  function maxPage() { return Math.max(1, Math.ceil(view().idx.length / state.pageSize)); }

  /* ============================================================
   * 历史（撤销 / 重做）
   * ========================================================== */
  function snapshot() {
    return { sheets: JSON.parse(JSON.stringify(state.sheets)), active: state.active };
  }
  function pushHistory() {
    try {
      const cells = state.sheets.reduce((a, s) => a + s.rows.length * Math.max(1, s.rows[0] ? s.rows[0].length : 1), 0);
      if (cells > 260000) {
        // 超大表跳过快照，避免内存占用；但必须提示，否则用户会以为撤销按钮坏了
        if (Date.now() - (state._undoTipAt || 0) > 15000) {
          state._undoTipAt = Date.now();
          toast('这张表超过 26 万个单元格，为省内存不记录撤销', 'err');
        }
        updateUndoUI();
        return;
      }
      state.history.push(snapshot());
      if (state.history.length > HISTORY_LIMIT) state.history.shift();
      state.future.length = 0;
    } catch (e) { /* 快照失败则跳过快照 */ }
    updateUndoUI();
  }
  function undo() {
    if (!state.history.length) return;
    state.future.push(snapshot());
    const s = state.history.pop();
    state.sheets = s.sheets; state.active = Math.min(s.active, state.sheets.length - 1);
    invalidate(); sanitizeFilters(); refresh();
    toast('已撤销');
  }
  function redo() {
    if (!state.future.length) return;
    state.history.push(snapshot());
    const s = state.future.pop();
    state.sheets = s.sheets; state.active = Math.min(s.active, state.sheets.length - 1);
    invalidate(); sanitizeFilters(); refresh();
    toast('已重做');
  }
  function updateUndoUI() {
    $('#btnUndo').disabled = !state.history.length;
    $('#btnRedo').disabled = !state.future.length;
  }
  function mutate(fn) {
    if (!sheet()) { toast('请先导入数据或加载示例', 'err'); return false; }
    pushHistory();
    fn();
    invalidate();
    sanitizeFilters();
    if (state.page > maxPage()) state.page = maxPage();
    markDirty();
    refresh();
    return true;
  }
  function sanitizeFilters() {
    const n = colCount();
    Object.keys(state.filters).forEach(k => { if (+k >= n) delete state.filters[k]; });
  }

  /* ============================================================
   * 渲染 — 侧栏
   * ========================================================== */
  function renderSidebar() {
    const list = $('#sheetList');
    if (!state.sheets.length) {
      list.innerHTML = `<div style="color:var(--muted);font-size:12px;padding:6px 8px;line-height:1.6">${state.activeDoc >= 0 ? '这个界面还没有工作表，点「+」新建一张' : '尚未载入工作表'}</div>`;
    } else {
      list.innerHTML = state.sheets.map((s, i) => `
        <div class="sheet-item ${i === state.active ? 'active' : ''}" data-sheet="${i}" title="切换到「${esc(s.name)}」">
          <svg width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.8"><use href="#i-grid"/></svg>
          <span class="txt" style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(s.name)}</span>
          <span class="meta">${sheetBodyRows(s) || '空'}</span>
        </div>`).join('');
    }
    $('#sheetCount').textContent = state.sheets.length ? state.sheets.length + ' 个' : '';
    // 只要处在一个界面里就能新建工作表（空白界面也能建第一张）；只剩一个时不能删除
    const addBtn = $('#btnAddSheet'), delBtn = $('#btnDelSheet');
    if (addBtn) addBtn.disabled = state.activeDoc < 0;
    if (delBtn) delBtn.disabled = state.sheets.length <= 1;
  }

  /* ============================================================
   * 渲染 — 数据体检
   * ========================================================== */
  /** 某张表除表头外是否还有任何内容（新建的空白表为 false） */
  function sheetHasData(sh) {
    if (!sh || !sh.rows) return false;
    // 全表扫描（命中第一格非空即返回），不能只看前几百行，否则前面全空、后面有数据时会被误判成空白表
    for (let i = 1; i < sh.rows.length; i++) {
      const r = sh.rows[i];
      if (!r) continue;
      for (let j = 0; j < r.length; j++) if (cellText(r[j]).trim()) return true;
    }
    return false;
  }
  const hasAnyData = () => sheetHasData(sheet());

  /** 有效数据行数：从末尾去掉连续的空行，只算真正有内容的部分 */
  function sheetBodyRows(sh) {
    if (!sh || !sh.rows) return 0;
    let n = sh.rows.length - 1;
    while (n > 0) {
      const r = sh.rows[n] || [];
      let has = false;
      for (let i = 0; i < r.length; i++) if (cellText(r[i]).trim()) { has = true; break; }
      if (has) break;
      n--;
    }
    return Math.max(0, n);
  }

  function health() {
    const s = sheet();
    if (!s) return null;
    const cols = colCount();
    const body = s.rows.slice(1);
    // 只统计“有内容的行”：新建的空白行不该被算成空值，否则一张刚建的表会被打成 32 分
    const dataRows = [];
    for (const r of body) {
      const row = r || [];
      let has = false;
      for (let c = 0; c < cols; c++) if (cellText(row[c]).trim()) { has = true; break; }
      if (has) dataRows.push(row);
    }
    if (!dataRows.length) {
      return { blank: true, rows: 0, cols, emptyCells: 0, dup: 0, outlier: 0, score: 0, sampleRate: 1, emptyRate: 0, dupRate: 0, outRate: 0 };
    }
    const limit = Math.min(dataRows.length, 20000);
    // 整列都是空的列视为“未使用的列”，不计入空值率（否则只填了 A 列也会被判成大量空值）
    const usedCols = [];
    for (let c = 0; c < cols; c++) {
      for (const r of dataRows) if (cellText(r[c]).trim()) { usedCols.push(c); break; }
    }
    const usedSet = new Set(usedCols);
    let emptyCells = 0, cells = 0;
    const seen = new Set();
    let dup = 0;
    let outlier = 0;
    for (let i = 0; i < limit; i++) {
      const r = dataRows[i];
      const key = [];
      for (let c = 0; c < cols; c++) {
        const v = cellText(r[c]).trim();
        if (usedSet.has(c)) { cells++; if (!v) emptyCells++; }
        key.push(v);
      }
      const k = key.join('\u0001');
      if (seen.has(k)) dup++; else seen.add(k);
    }
    // 数据太少（少于 3 行）时同样不打分，避免刚录入两行就提示“建议清洗”
    if (dataRows.length < 3) {
      return { blank: true, rows: dataRows.length, cols, emptyCells, dup, outlier: 0, score: 0, sampleRate: 1, emptyRate: cells ? emptyCells / cells : 0, dupRate: 0, outRate: 0 };
    }
    for (let c = 0; c < cols; c++) {
      if (colType(c) !== 'number') continue;
      const st = columnStats(c);
      if (!st.num || st.num.count < 8) continue;
      const iqr = (st.num.q3 - st.num.q1);
      if (iqr <= 0) continue;
      const lo = st.num.q1 - 1.5 * iqr, hi = st.num.q3 + 1.5 * iqr;
      for (const r of dataRows) {
        const n = parseNumber(r[c]);
        if (n !== null && (n < lo || n > hi)) outlier++;
      }
    }
    const sampleRate = dataRows.length ? limit / dataRows.length : 1;
    let score = 100;
    const emptyRate = cells ? emptyCells / cells : 0;
    const dupRate = limit ? dup / limit : 0;
    const outRate = cells ? outlier / cells : 0;
    score -= Math.min(40, emptyRate * 130);
    score -= Math.min(28, dupRate * 180);
    score -= Math.min(22, outRate * 300);
    score = Math.max(5, Math.round(score));
    return {
      rows: dataRows.length, cols, emptyCells, dup, outlier, score,
      sampleRate, emptyRate, dupRate, outRate,
    };
  }

  function renderHealth() {
    const h = health();
    if (!h) {
      $('#healthScore').innerHTML = '—';
      $('#healthScore').style.color = '';
      ['hRows', 'hCols', 'hEmpty', 'hDup', 'hOutlier'].forEach(id => { const el = $('#' + id); el.textContent = '0'; el.className = ''; });
      $('#healthNote').textContent = '等待数据';
      return;
    }
    if (h.blank) {
      // 空白 / 数据太少的表不打分，避免"刚建的表就被建议清洗"
      $('#healthScore').innerHTML = '—';
      $('#healthScore').style.color = '';
      $('#hRows').textContent = fmt(h.rows, 0);
      $('#hCols').textContent = fmt(h.cols, 0);
      const e0 = $('#hEmpty'); e0.textContent = fmt(h.emptyCells, 0); e0.className = h.emptyCells > 0 ? 'warn' : '';
      $('#hDup').textContent = fmt(h.dup, 0); $('#hDup').className = '';
      $('#hOutlier').textContent = '0'; $('#hOutlier').className = '';
      $('#healthNote').textContent = h.rows ? '数据太少，暂不评估' : '等待录入数据';
      return;
    }
    $('#healthScore').innerHTML = `${h.score}<small>/100</small>`;
    $('#healthScore').style.color = h.score >= 85 ? 'var(--green)' : h.score >= 65 ? 'var(--text)' : 'var(--amber)';
    $('#healthNote').textContent = h.score >= 85 ? '数据质量良好' : h.score >= 65 ? '存在一些问题' : '建议先清洗';
    $('#hRows').textContent = fmt(h.rows, 0);
    $('#hCols').textContent = fmt(h.cols, 0);
    const e = $('#hEmpty'); e.textContent = fmt(h.emptyCells, 0); e.className = h.emptyCells > 0 ? 'warn' : '';
    const d = $('#hDup'); d.textContent = fmt(h.dup, 0); d.className = h.dup > 0 ? 'bad' : '';
    const o = $('#hOutlier'); o.textContent = fmt(h.outlier, 0); o.className = h.outlier > 0 ? 'warn' : '';
    if (h.sampleRate < 0.999) $('#healthNote').textContent = '数据质量（已抽样）';
  }

  /* ============================================================
   * 渲染 — 表格
   * ========================================================== */
  function colWrap(c) {
    const name = header()[c] || ('列' + (c + 1));
    let w = textWidth(name) + 78;
    const body = rows();
    const limit = Math.min(body.length, 60);
    for (let i = 1; i <= limit; i++) {
      const t = cellText((body[i] || [])[c]);
      w = Math.max(w, Math.min(textWidth(t), 220) + 22);
    }
    return Math.max(102, Math.min(280, Math.round(w)));
  }

  function renderTable() {
    const table = $('#grid');
    const s = sheet();
    const any = !!s && hasAnyData();      // 只算一次，下面两处都用它
    const blank = !!s && !any;
    // 没有工作表、或工作表还是空白时，都显示和起始页一样的空面板（除非用户点了「直接录入」）
    if (!s || (blank && !state.manualEdit)) {
      table.innerHTML = '';
      $('#emptyState').classList.remove('hidden');
      $('#pager').style.display = 'none';
      const bh = $('#blankHint'); if (bh) bh.style.display = 'none';
      const b = $('#btnBlank');
      if (b) {
        b.textContent = blank ? '直接录入' : (state.activeDoc >= 0 ? '新建工作表' : '新建空白表');
      }
      const tip = $('#panelTip');
      if (tip) {
        tip.style.display = blank ? 'block' : 'none';
        tip.textContent = blank ? '这是一张空白工作表：拖入文件会填到这张表里，也可以点「直接录入」自己敲。' : '';
      }
      const dz = document.querySelector('#emptyState .dz-sub');
      if (dz) {
        dz.textContent = blank
          ? '单表文件（csv / 单工作表 xlsx）会直接填进这张工作表，多工作表文件会另开一个标签'
          : '支持 .xlsx · .xls · .csv · .tsv，可一次拖入多个文件';
      }
      return;
    }
    $('#emptyState').classList.add('hidden');
    const tip0 = $('#panelTip'); if (tip0) tip0.style.display = 'none';
    // 空白表点了「直接录入」：顶部给一条轻提示，录入任意内容后自动消失
    const hint = $('#blankHint');
    if (hint) hint.style.display = any ? 'none' : 'flex';
    $('#pager').style.display = 'flex';

    const cols = colCount();
    const { idx } = view();
    state.page = Math.min(Math.max(1, state.page), maxPage());
    const start = (state.page - 1) * state.pageSize;
    const pageIdx = idx.slice(start, start + state.pageSize);
    const head = header();
    const widths = [];
    for (let c = 0; c < cols; c++) widths.push(colWrap(c));
    const totalW = 46 + widths.reduce((a, b) => a + b, 0);

    const filterCols = new Set(Object.keys(state.filters).map(Number));

    let html = '<colgroup><col style="width:46px">' + widths.map(w => `<col style="width:${w}px">`).join('') + '</colgroup><thead><tr>';
    html += '<th class="corner">#</th>';
    for (let c = 0; c < cols; c++) {
      const t = colType(c);
      const name = head[c] || '';
      const sorted = state.sort && state.sort.col === c;
      html += `<th data-col="${c}" style="width:${widths[c]}px">
        <div class="th-inner">
          <div class="th-col">
            <span>${colLetter(c)}</span>
            <span class="th-tools">
              ${filterCols.has(c) ? '<span style="color:var(--primary);font-size:9px">●</span>' : ''}
              <button class="th-menu-btn" data-menu="${c}" title="列操作"><svg width="12" height="12" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><use href="#i-more"/></svg></button>
            </span>
          </div>
          <div class="th-name">
            <span class="txt" title="${esc(name)}">${esc(name || '（未命名）')}</span>
            ${sorted ? `<span class="sort-ind">${state.sort.dir === 1 ? '▲' : '▼'}</span>` : ''}
            <span class="type-tag ${t === 'number' ? 'num' : t === 'date' ? 'date' : t === 'empty' ? 'empty' : 'text'}">${typeName(t)}</span>
          </div>
        </div>
      </th>`;
    }
    html += '</tr></thead><tbody>';

    if (!pageIdx.length) {
      html += `<tr><td class="rowhead">—</td><td colspan="${Math.max(1, cols)}" style="color:var(--muted);padding:16px 12px;text-align:left">没有符合当前筛选条件的数据</td></tr>`;
    }
    const emptyCells = [];
    for (const r of pageIdx) {
      html += `<tr data-r="${r}"><td class="rowhead">${r}</td>`;
      for (let c = 0; c < cols; c++) {
        const raw = (s.rows[r] || [])[c];
        const v = cellText(raw);
        const blank = v.trim() === '';
        const isNum = colType(c) === 'number';
        const sel = state.sel.r === r && state.sel.c === c;
        if (blank) emptyCells.push([r, c]);
        html += `<td data-r="${r}" data-c="${c}" class="${isNum ? 'num' : ''} ${blank ? 'is-null' : ''} ${sel ? 'cell-active' : ''}" title="${esc(v.length > 200 ? v.slice(0, 200) + '…' : v)}">${blank ? '—' : esc(v)}</td>`;
      }
      html += '</tr>';
    }
    html += '</tbody>';
    table.innerHTML = html;
    const wrapW = $('#tableWrap').clientWidth - 1;
    table.style.width = Math.max(totalW, wrapW) + 'px';

    $('#pageInfo').textContent = `${state.page} / ${maxPage()}${idx.length !== view().total ? ` · 筛后 ${idx.length} 行` : ''}`;
    $('#btnPrev').disabled = state.page <= 1;
    $('#btnNext').disabled = state.page >= maxPage();
    updateFilterUI();
  }

  function updateFilterUI() {
    const active = Object.keys(state.filters).length;
    const badge = $('#filterCount');
    if (active) { badge.style.display = 'inline-block'; badge.textContent = active; } else badge.style.display = 'none';
    $('#btnClearFilters').style.display = active ? 'inline-flex' : 'none';
  }

  function renderAll() {
    renderTabs();
    renderSidebar();
    renderTable();
    renderHealth();
    updateUndoUI();
  }
  function refresh() { invalidate(); renderAll(); }
  function rerenderView() { invalidate(); renderTable(); renderSidebar(); }

  /* ============================================================
   * 多文件标签（每个文件独立保存工作表 / 筛选 / 排序 / 撤销栈）
   * ========================================================== */
  let docSeq = 0;

  function curDoc() { return state.docs[state.activeDoc] || null; }

  /** 把当前活动状态写回所属文档 */
  function stashDoc() {
    const d = curDoc();
    if (!d) return;
    d.name = state.fileName;
    d.kind = state.fileKind;
    d.sheets = state.sheets;
    d.active = state.active;
    d.page = state.page;
    d.search = state.search;
    d.filters = state.filters;
    d.sort = state.sort;
    d.history = state.history;
    d.future = state.future;
    d.sel = state.sel;
    // AI 对话跟着文件走：切走时存下，切回来时还原
    if (App.ai && App.ai.snapshot) {
      try { d.ai = App.ai.snapshot(); } catch (e) { /* 忽略快照失败 */ }
    }
  }

  /** 把文档载入为活动状态 */
  function activateDoc(i) {
    const d = state.docs[i];
    if (!d) return;
    state.activeDoc = i;
    state.fileName = d.name || '未命名';
    state.fileKind = d.kind || 'xlsx';
    state.sheets = d.sheets || [];
    state.active = Math.min(d.active || 0, Math.max(0, state.sheets.length - 1));
    state.page = d.page || 1;
    state.search = d.search || '';
    state.filters = d.filters || {};
    state.sort = d.sort || null;
    state.history = d.history || [];
    state.future = d.future || [];
    state.sel = d.sel || { r: -1, c: -1 };
    state.manualEdit = false;
    const gs = $('#globalSearch');
    if (gs) gs.value = state.search;
    invalidate();
    restoreDocAI();
  }

  /** 切换到某个界面时，恢复该界面自己的 AI 对话（没有就回到全新欢迎语） */
  function restoreDocAI() {
    if (!App.ai || !App.ai.restore) return;
    const d = state.docs[state.activeDoc];
    try { App.ai.restore(d ? d.ai : null); } catch (e) { /* 忽略 */ }
  }

  function resetState() {
    state.fileName = '';
    state.fileKind = 'xlsx';
    state.sheets = [];
    state.active = 0;
    state.page = 1;
    state.search = '';
    state.filters = {};
    state.sort = null;
    state.history = [];
    state.future = [];
    state.sel = { r: -1, c: -1 };
    state.charts = [];
    state.manualEdit = false;
    const gs = $('#globalSearch');
    if (gs) gs.value = '';
    invalidate();
  }

  function renderTabs() {
    const wrap = $('#fileTabs');
    if (!wrap) return;
    // 起始页常驻在最左侧：即使已经新建了多个界面，也能一键切回空状态
    const home = `<div class="file-tab home${state.activeDoc < 0 ? ' active' : ''}" data-home="1" title="起始页：拖入文件或新建空白表">
      <svg width="12" height="12" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><use href="#i-home"/></svg>
      <span class="name">起始页</span>
    </div>`;
    wrap.innerHTML = home + state.docs.map((d, i) => {
      // 当前界面的数据是实时状态（还没 stash 回 doc），要用 state 而不是 doc 里的旧快照
      const isActive = i === state.activeDoc;
      const list = isActive ? state.sheets : (d.sheets || []);
      const s = list[isActive ? state.active : (d.active || 0)];
      const rowsN = s ? sheetBodyRows(s) : 0;
      const colsN = s ? s.rows.reduce((m, r) => Math.max(m, r.length), 0) : 0;
      // 没有实际数据时显示「空」，不给出 20 × 3 这种假的行列数
      const statTx = (s && rowsN) ? `${rowsN} × ${colsN}` : '空';
      return `<div class="file-tab ${i === state.activeDoc ? 'active' : ''}" data-doc="${i}" title="${esc(d.name)}${d.dirty ? ' · 有未保存修改' : ''}">
        <svg width="12" height="12" fill="none" stroke="currentColor" stroke-width="1.9"><use href="#i-grid"/></svg>
        <span class="name">${esc(d.name)}</span>
        ${d.dirty ? '<span class="dirty"></span>' : ''}
        <span class="stat">${statTx}</span>
        <button class="tx" data-close="${i}" title="关闭此文件"><svg width="9" height="9" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"><use href="#i-x"/></svg></button>
      </div>`;
    }).join('');
    const activeEl = wrap.querySelector('.file-tab.active');
    if (activeEl) {
      const r = activeEl.getBoundingClientRect();
      const wr = wrap.getBoundingClientRect();
      if (r.left < wr.left || r.right > wr.right) activeEl.scrollIntoView({ block: 'nearest', inline: 'center' });
    }
  }

  /** 当前是否处在一个「一张表都没有」的空白界面里 */
  function isEmptyDoc() { return !!curDoc() && !state.sheets.length; }

  /** 把数据装进当前这个空白界面（不再多开标签）；没有空白界面可装时返回 false */
  function fillEmptyDoc(sheets, name, kind) {
    const d = curDoc();
    if (!d || state.sheets.length) return false;
    state.fileName = name;
    state.fileKind = kind || 'xlsx';
    state.sheets = sheets || [];
    state.active = 0;
    state.page = 1;
    state.search = ''; state.filters = {}; state.sort = null;
    state.history = []; state.future = []; state.sel = { r: -1, c: -1 };
    const gs = $('#globalSearch'); if (gs) gs.value = '';
    d.name = name;
    d.kind = state.fileKind;
    d.dirty = false;
    stashDoc();
    refresh();
    resetScroll();
    if (App.ai && App.ai.onDataLoaded) App.ai.onDataLoaded();
    return true;
  }

  /** 新增一个文件标签并切换过去 */
  function openDoc(sheets, name, kind, opts) {
    opts = opts || {};
    stashDoc();
    finishEditing();
    const doc = {
      id: ++docSeq,
      name: name || '未命名',
      kind: kind || 'xlsx',
      sheets: sheets || [],
      active: 0, page: 1, search: '', filters: {}, sort: null,
      history: [], future: [], sel: { r: -1, c: -1 }, dirty: false,
      ai: null,          // 该界面自己的 AI 对话快照（null = 全新界面，不继承上一个界面的对话）
    };
    state.docs.push(doc);
    activateDoc(state.docs.length - 1);
    refresh();
    resetScroll();
    if (!opts.silent) {
      const n = doc.sheets[0] ? doc.sheets[0].rows.length - 1 : 0;
      toast(doc.sheets.length
        ? `已打开「${doc.name}」· ${doc.sheets.length} 个工作表 · ${n} 行`
        : `已新建空白界面「${doc.name}」`, 'ok');
    }
    return doc;
  }

  /** 切回起始页（空状态）。已打开的文件仍留在标签栏，不会丢 */
  function goHome() {
    if (state.activeDoc < 0) return;
    finishEditing();
    stashDoc();
    state.activeDoc = -1;
    resetState();
    refresh();
    resetScroll();
    if (App.ai && App.ai.resetSession) App.ai.resetSession();
  }

  function switchDoc(i) {
    if (i === state.activeDoc || !state.docs[i]) return;
    finishEditing();
    stashDoc();
    activateDoc(i);
    refresh();
    resetScroll();
  }

  function closeDoc(i, force) {
    const d = state.docs[i];
    if (!d) return;
    if (i === state.activeDoc) finishEditing();
    if (!force && d.dirty) {
      showModal({
        title: '关闭文件', sub: d.name, width: 420,
        bodyHTML: `<div style="font-size:12.5px;line-height:1.75;color:var(--text-2)">
          这个文件有未保存的修改，关闭后这些改动会丢失。<br/>
          需要保留的话，先点「导出」下载成 Excel 再关闭。</div>`,
        buttons: [
          { label: '取消' },
          { label: '仍然关闭', cls: 'danger', onClick: () => { closeDoc(i, true); } },
        ],
      });
      return;
    }
    const wasActive = i === state.activeDoc;
    state.docs.splice(i, 1);
    if (!state.docs.length) {
      state.activeDoc = -1;
      resetState();
      refresh();
      if (App.ai && App.ai.resetSession) App.ai.resetSession();
      toast('已关闭全部文件，回到起始页');
      return;
    }
    if (wasActive) {
      activateDoc(Math.min(i, state.docs.length - 1));
      refresh();
      resetScroll();
    } else {
      if (i < state.activeDoc) state.activeDoc--;
      renderTabs();
    }
  }

  function markDirty() {
    const d = curDoc();
    if (d && !d.dirty) { d.dirty = true; renderTabs(); }
  }

  /** 切换文件前把正在编辑的单元格提交掉 */
  function finishEditing() {
    if (!state.editing) return;
    const inp = document.querySelector('#grid .cell-input');
    if (inp) inp.blur();
  }

  /** 换文件后表格滚动位置要归零，否则会沿用上一个文件的偏移 */
  function resetScroll() {
    const tw = $('#tableWrap');
    if (tw) { tw.scrollLeft = 0; tw.scrollTop = 0; }
  }

  /* ============================================================
   * 弹层：模态框 / 菜单 / 筛选
   * ========================================================== */
  function showModal(opts) {
    const root = $('#layerRoot');
    const overlay = document.createElement('div');
    overlay.className = 'overlay';
    const buttons = opts.buttons || [];
    overlay.innerHTML = `<div class="modal" style="width:${opts.width || 470}px">
      <div class="modal-head"><h3>${esc(opts.title || '')}</h3>${opts.sub ? `<span class="sub">${esc(opts.sub)}</span>` : ''}
        <button class="btn ghost icon-only" data-close style="margin-left:auto;width:26px;height:26px"><svg width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><use href="#i-x"/></svg></button>
      </div>
      <div class="modal-body">${opts.bodyHTML || ''}</div>
      ${buttons.length ? `<div class="modal-foot">${buttons.map((b, i) => `<button class="btn ${b.cls || ''}" data-btn="${i}">${esc(b.label)}</button>`).join('')}</div>` : ''}
    </div>`;
    root.appendChild(overlay);
    const close = () => { overlay.remove(); document.removeEventListener('keydown', onKey); };
    const onKey = e => { if (e.key === 'Escape') close(); };
    document.addEventListener('keydown', onKey);
    overlay.addEventListener('mousedown', e => { if (e.target === overlay) close(); });
    overlay.querySelector('[data-close]').onclick = close;
    overlay.querySelectorAll('[data-btn]').forEach(btn => {
      btn.onclick = () => {
        const spec = buttons[+btn.dataset.btn];
        if (!spec.onClick) return close();
        const r = spec.onClick(overlay, close);
        if (r !== false) close();
      };
    });
    return { el: overlay, body: overlay.querySelector('.modal-body'), close };
  }

  let openMenus = [];
  function closeMenus() { openMenus.forEach(m => m.remove()); openMenus = []; }
  document.addEventListener('mousedown', e => {
    if (!e.target.closest('.menu') && !e.target.closest('.popover') && !e.target.closest('[data-menu]')) closeMenus();
  });

  function showMenu(items, x, y, width) {
    closeMenus();
    const menu = document.createElement('div');
    menu.className = 'menu';
    if (width) menu.style.minWidth = width + 'px';
    menu.innerHTML = items.map((it, i) => {
      if (it.sep) return '<div class="menu-sep"></div>';
      if (it.label && !it.action) return `<div class="menu-label">${esc(it.label)}</div>`;
      return `<div class="menu-item ${it.danger ? 'danger' : ''}" data-i="${i}">
        ${it.icon ? `<svg width="13" height="13" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><use href="#${it.icon}"/></svg>` : ''}
        <span>${esc(it.label)}</span>${it.k ? `<span class="k">${esc(it.k)}</span>` : ''}</div>`;
    }).join('');
    document.body.appendChild(menu);
    const rect = menu.getBoundingClientRect();
    menu.style.left = Math.min(x, window.innerWidth - rect.width - 8) + 'px';
    menu.style.top = Math.min(y, window.innerHeight - rect.height - 8) + 'px';
    menu.querySelectorAll('.menu-item').forEach(el => {
      el.onclick = () => { closeMenus(); const it = items[+el.dataset.i]; if (it && it.action) it.action(); };
    });
    openMenus.push(menu);
    return menu;
  }

  function showPopover(html, x, y, width, onMount) {
    closeMenus();
    const pop = document.createElement('div');
    pop.className = 'popover';
    if (width) pop.style.width = width + 'px';
    pop.innerHTML = html;
    document.body.appendChild(pop);
    const r = pop.getBoundingClientRect();
    pop.style.left = Math.min(x, window.innerWidth - r.width - 8) + 'px';
    pop.style.top = Math.min(y, window.innerHeight - r.height - 8) + 'px';
    openMenus.push(pop);
    if (onMount) onMount(pop);
    return pop;
  }

  /* ============================================================
   * 列操作
   * ========================================================== */
  function doSort(col, dir) {
    if (dir === 0) {
      if (!state.sort) return;
      mutate(() => { state.sort = null; });
      return;
    }
    const t = colType(col);
    const body = rows().slice(1);
    body.sort((a, b) => {
      const va = a[col], vb = b[col];
      const ea = isEmpty(va), eb = isEmpty(vb);
      if (ea && eb) return 0;
      if (ea) return 1;
      if (eb) return -1;
      if (t === 'number') return (parseNumber(va) - parseNumber(vb)) * dir;
      if (t === 'date') return (parseDate(va) - parseDate(vb)) * dir;
      return String(va).localeCompare(String(vb), 'zh-CN') * dir;
    });
    mutate(() => {
      const hdr = rows()[0];
      const out = [hdr].concat(body.map(r => r));
      // 保证每行列数与表头一致
      const width = Math.max(colCount(), hdr.length);
      out.forEach(r => { while (r.length < width) r.push(''); });
      state.sheets[state.active].rows = out;
      state.sort = { col, dir };
    });
    toast(`已按「${header()[col] || colLetter(col)}」${dir === 1 ? '升序' : '降序'}排序`, 'ok');
  }

  function openColumnMenu(col, x, y) {
    const t = colType(col);
    const name = header()[col] || colLetter(col);
    showMenu([
      { label: '列操作 · ' + name },
      { label: '升序排序', icon: 'i-sort-asc', action: () => doSort(col, 1) },
      { label: '降序排序', icon: 'i-sort-desc', action: () => doSort(col, -1) },
      { label: '取消排序', action: () => doSort(col, 0) },
      { sep: true },
      { label: '按此列筛选', icon: 'i-filter', action: () => openFilter(col, x, y + 20) },
      { label: '列统计', icon: 'i-stats', action: () => showColumnStats(col) },
      { sep: true },
      { label: '重命名列', icon: 'i-types', action: () => renameColumn(col) },
      { label: '向左插入列', action: () => insertColumn(col, 'left') },
      { label: '向右插入列', action: () => insertColumn(col, 'right') },
      { label: '复制此列', icon: 'i-copy', action: () => duplicateColumn(col) },
      { label: t === 'number' ? '按数字格式化' : '文本转数字', icon: 'i-types', action: () => convertToNumber(col) },
      { label: '统一为日期格式', action: () => convertToDate(col) },
      { sep: true },
      { label: '清空整列内容', danger: true, action: () => clearColumn(col) },
      { label: '删除此列', danger: true, icon: 'i-trash', action: () => deleteColumn(col) },
    ], x, y, 200);
  }

  function openFilter(col, x, y) {
    const vals = columnValues(col);
    const cur = state.filters[col];
    const allowed = cur ? new Set(cur) : null;
    const rowsHtml = vals.slice(0, 400).map(([v, n]) => `
      <label class="pop-item"><input type="checkbox" value="${esc(v)}" ${!allowed || allowed.has(v) ? 'checked' : ''}>
        <span style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(v)}</span><span class="cnt">${n}</span></label>`).join('');
    showPopover(`<div class="pop-search"><input type="text" placeholder="搜索取值…" data-fsearch></div>
      <div class="pop-list" data-flist>${rowsHtml || '<div style="padding:10px;color:var(--muted)">该列没有可筛选的值</div>'}</div>
      <div class="pop-foot"><button class="btn" data-fclear>清除</button><button class="btn primary" data-fok>应用</button></div>`,
      x, y, 240, pop => {
        const list = pop.querySelector('[data-flist]');
        pop.querySelector('[data-fsearch]').addEventListener('input', e => {
          const q = e.target.value.toLowerCase();
          $$('.pop-item', list).forEach(it => {
            it.style.display = it.textContent.toLowerCase().includes(q) ? '' : 'none';
          });
        });
        pop.querySelector('[data-fclear]').onclick = () => {
          delete state.filters[col];
          closeMenus(); state.page = 1; invalidate(); renderTable();
          toast('已清除该列筛选');
        };
        pop.querySelector('[data-fok]').onclick = () => {
          const checked = $$('input:checked', list).map(i => i.value);
          const all = $$('input', list).length;
          if (checked.length === 0) { toast('至少选择一个值', 'err'); return; }
          if (checked.length === all) delete state.filters[col];
          else state.filters[col] = checked;
          closeMenus(); state.page = 1; invalidate(); renderTable();
          toast(`筛选：${header()[col] || colLetter(col)}`, 'ok');
        };
      });
  }

  function showColumnStats(col) {
    const st = columnStats(col);
    const t = colType(col);
    const rowsHtml = [];
    rowsHtml.push(['列名', header()[col] || '（未命名）']);
    rowsHtml.push(['类型', typeName(t)]);
    rowsHtml.push(['非空 / 总行数', `${st.nonEmpty} / ${st.total}`]);
    rowsHtml.push(['空值', st.empty]);
    rowsHtml.push(['唯一值', st.unique]);
    if (st.num) {
      rowsHtml.push(['合计', fmt(st.num.sum)]);
      rowsHtml.push(['平均值', fmt(st.num.mean)]);
      rowsHtml.push(['中位数', fmt(st.num.median)]);
      rowsHtml.push(['最小值', fmt(st.num.min)]);
      rowsHtml.push(['最大值', fmt(st.num.max)]);
      rowsHtml.push(['标准差', fmt(st.num.sd)]);
    }
    if (st.dateRange) {
      rowsHtml.push(['最早日期', st.dateRange[0].toLocaleDateString('zh-CN')]);
      rowsHtml.push(['最晚日期', st.dateRange[1].toLocaleDateString('zh-CN')]);
    }
    const topHtml = st.top.length && t !== 'number'
      ? `<div style="margin-top:8px;border-top:1px solid var(--border);padding-top:8px">
          <div style="font-size:11px;color:var(--muted);margin:0 10px 4px;font-weight:600">高频取值</div>
          ${st.top.map(([v, n]) => `<div class="row"><span style="max-width:150px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(v)}</span><b>${n} 次</b></div>`).join('')}
        </div>` : '';
    const box = showPopover(`<div class="stat-pop">
      <div style="padding:7px 10px;border-bottom:1px solid var(--border);font-weight:600;font-size:12px">${esc(header()[col] || colLetter(col))}</div>
      ${rowsHtml.map(([k, v]) => `<div class="row"><span>${esc(k)}</span><b>${esc(v)}</b></div>`).join('')}
      ${topHtml}</div>`, window.innerWidth / 2 - 125, 160, 250);
    return box;
  }

  function renameColumn(col) {
    const cur = header()[col] || '';
    const m = showModal({
      title: '重命名列', width: 380,
      bodyHTML: `<div class="field"><label>列名称</label><input type="text" id="colNameInput" value="${esc(cur)}" placeholder="例如：销售额"></div>`,
      buttons: [
        { label: '取消' },
        { label: '保存', cls: 'primary', onClick: (el) => {
          const v = el.querySelector('#colNameInput').value.trim();
          if (!v) { toast('名称不能为空', 'err'); return false; }
          mutate(() => { rows()[0][col] = v; });
          toast('列名已更新', 'ok');
        } },
      ],
    });
    setTimeout(() => { const i = m.el.querySelector('#colNameInput'); i.focus(); i.select(); }, 30);
  }

  function insertColumn(col, side) {
    const at = side === 'left' ? col : col + 1;
    mutate(() => {
      const width = Math.max(1, colCount());
      const idx = Math.max(0, Math.min(at, width));   // 先按当前宽度补齐，避免长短行插出参差的列
      rows().forEach((r, i) => {
        while (r.length < width) r.push('');
        r.splice(idx, 0, i === 0 ? `新列${idx + 1}` : '');
      });
    });
    toast('已插入列', 'ok');
  }

  function duplicateColumn(col) {
    mutate(() => {
      rows().forEach((r, i) => {
        r.splice(col + 1, 0, i === 0 ? `${header()[col] || '列'} 副本` : cellText(r[col]));
      });
    });
    toast('已复制列', 'ok');
  }

  function deleteColumn(col) {
    if (colCount() <= 1) { toast('至少保留一列', 'err'); return; }
    mutate(() => { rows().forEach(r => r.splice(col, 1)); });
    toast('已删除列', 'ok');
  }

  function clearColumn(col) {
    mutate(() => { rows().forEach((r, i) => { if (i > 0) r[col] = ''; }); });
    toast('已清空该列内容', 'ok');
  }

  function convertToNumber(col) {
    let n = 0, bad = 0;
    mutate(() => {
      rows().forEach((r, i) => {
        if (i === 0) return;
        const v = r[col];
        if (isEmpty(v)) return;
        const num = parseNumber(v);
        if (num === null) { bad++; return; }
        r[col] = String(num);
        n++;
      });
    });
    toast(`已转换 ${n} 个数字${bad ? `，${bad} 个无法识别保留原样` : ''}`);
  }

  function convertToDate(col) {
    let n = 0;
    mutate(() => {
      rows().forEach((r, i) => {
        if (i === 0) return;
        const d = parseDate(r[col]);
        if (d) { r[col] = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; n++; }
      });
    });
    toast(`已统一 ${n} 个日期为 YYYY-MM-DD`);
  }

  /* ============================================================
   * 行操作 / 清洗
   * ========================================================== */
  function addRow() {
    mutate(() => {
      const cols = Math.max(1, colCount());
      const r = new Array(cols).fill('');
      const at = state.sel.r > 0 ? state.sel.r + 1 : rows().length;
      rows().splice(at, 0, r);
      state.sel = { r: at, c: 0 };
    });
    toast('已插入空行', 'ok');
  }

  function addColumn() {
    mutate(() => {
      const c = colCount();
      rows().forEach((r, i) => { while (r.length < c) r.push(''); r.push(i === 0 ? `新列${c + 1}` : ''); });
    });
    toast('已添加新列', 'ok');
  }

  function deleteSelectedRow() {
    if (state.sel.r <= 0) { toast('请先选中一行', 'err'); return; }
    const r = state.sel.r;
    mutate(() => { rows().splice(r, 1); state.sel = { r: -1, c: state.sel.c }; });
    toast('已删除该行', 'ok');
  }

  function dedupe() {
    const body = rows().slice(1);
    const seen = new Set();
    const keep = [];
    let removed = 0;
    for (const r of body) {
      const k = r.map(v => cellText(v).trim()).join('\u0001');
      if (seen.has(k)) { removed++; continue; }
      seen.add(k);
      keep.push(r);
    }
    if (!removed) { toast('没有发现重复行'); return; }
    mutate(() => { state.sheets[state.active].rows = [rows()[0]].concat(keep); });
    toast(`已删除 ${removed} 行重复数据`, 'ok');
  }

  function dropEmptyRows() {
    const body = rows().slice(1);
    const keep = body.filter(r => r.some(v => cellText(v).trim() !== ''));
    const removed = body.length - keep.length;
    if (!removed) { toast('没有空白行'); return; }
    mutate(() => { state.sheets[state.active].rows = [rows()[0]].concat(keep); });
    toast(`已删除 ${removed} 个空白行`, 'ok');
  }

  function trimSpaces() {
    let n = 0;
    mutate(() => {
      rows().forEach((r, i) => {
        if (i === 0) return;
        for (let c = 0; c < r.length; c++) {
          const v = cellText(r[c]);
          if (!v) continue;
          const nv = v.replace(/\u3000/g, ' ').replace(/\s+/g, ' ').trim();
          if (nv !== v) { r[c] = nv; n++; }
        }
      });
    });
    toast(n ? `已清理 ${n} 个单元格的空白字符` : '没有需要清理的空白字符', 'ok');
  }

  function convertAllNumeric() {
    let n = 0;
    const cols = colCount();
    const targets = [];
    for (let c = 0; c < cols; c++) if (colType(c) === 'text') targets.push(c);
    mutate(() => {
      rows().forEach((r, i) => {
        if (i === 0) return;
        targets.forEach(c => {
          const v = r[c];
          if (isEmpty(v)) return;
          const num = parseNumber(v);
          if (num !== null && /[,\s¥$￥]/.test(String(v))) { r[c] = String(num); n++; }
        });
      });
    });
    toast(n ? `已转换 ${n} 个文本型数字` : '未发现需要转换的文本型数字', 'ok');
  }

  function fillMissing(col, strategy) {
    const st = columnStats(col);
    let fill = '';
    if (strategy === 'mean' && st.num) fill = String(Math.round(st.num.mean * 100) / 100);
    else if (strategy === 'median' && st.num) fill = String(st.num.median);
    else if (strategy === 'mode' && st.top.length) fill = st.top[0][0];
    else if (strategy === 'zero') fill = '0';
    else if (strategy === 'empty') fill = '';
    let n = 0;
    mutate(() => {
      rows().forEach((r, i) => {
        if (i === 0) return;
        if (isEmpty(r[col])) { r[col] = fill; n++; }
      });
    });
    toast(n ? `已填充 ${n} 个缺失值为「${fill}」` : '该列没有缺失值', 'ok');
  }

  function removeOutliers(col) {
    const st = columnStats(col);
    if (!st.num) { toast('该列不是数值列', 'err'); return; }
    const iqr = st.num.q3 - st.num.q1;
    if (iqr <= 0) { toast('该列数据过于集中，无法识别异常值', 'err'); return; }
    const lo = st.num.q1 - 1.5 * iqr, hi = st.num.q3 + 1.5 * iqr;
    let removed = 0;
    mutate(() => {
      const body = rows().slice(1).filter(r => {
        const v = parseNumber(r[col]);
        if (v === null) return true;
        if (v < lo || v > hi) { removed++; return false; }
        return true;
      });
      state.sheets[state.active].rows = [rows()[0]].concat(body);
    });
    toast(removed ? `已剔除 ${removed} 行异常值（阈值 ${fmt(lo)} ~ ${fmt(hi)}）` : '没有识别到异常值', 'ok');
  }

  /* ============================================================
   * 图表
   * ========================================================== */
  function prepareChartData(cfg) {
    const xi = cfg.x === '' || cfg.x == null ? -1 : +cfg.x;
    const yi = cfg.y === '' || cfg.y == null ? -1 : +cfg.y;
    const agg = cfg.agg || 'sum';
    const body = rows().slice(1);
    if (yi < 0) return { labels: [], values: [] };
    if (xi < 0) {
      const vals = body.map(r => parseNumber(r[yi])).filter(v => v !== null);
      return { labels: [header()[yi] || '数值'], values: [agg === 'count' ? vals.length : vals.reduce((a, b) => a + b, 0)] };
    }
    const groups = new Map();
    const isDate = xi >= 0 && colType(xi) === 'date';
    let dateFmt = 'month';
    if (isDate) {
      let min = null, max = null;
      for (const r of body) {
        const d = parseDate(r[xi]);
        if (!d) continue;
        if (!min || d < min) min = d;
        if (!max || d > max) max = d;
      }
      if (min && max && (max - min) < 1000 * 60 * 60 * 24 * 120) dateFmt = 'day';
    }
    const keyOf = r => {
      const raw = cellText(r[xi]).trim();
      if (!isDate) return raw || '（空）';
      const d = parseDate(raw);
      if (!d) return raw || '（空）';
      const mm = String(d.getMonth() + 1).padStart(2, '0');
      return dateFmt === 'month' ? `${d.getFullYear()}-${mm}` : `${d.getFullYear()}-${mm}-${String(d.getDate()).padStart(2, '0')}`;
    };
    for (const r of body) {
      let key = keyOf(r);
      const v = parseNumber(r[yi]);
      if (!groups.has(key)) groups.set(key, { sum: 0, count: 0, n: 0, max: null, min: null });
      const g = groups.get(key);
      if (v !== null) {
        g.sum += v; g.n++;
        g.max = g.max === null ? v : Math.max(g.max, v);
        g.min = g.min === null ? v : Math.min(g.min, v);
      }
      g.count++;
    }
    let arr = Array.from(groups.entries()).map(([label, g]) => ({
      label,
      value: agg === 'sum' ? g.sum
        : agg === 'avg' ? (g.n ? g.sum / g.n : 0)
          : agg === 'max' ? (g.max === null ? 0 : g.max)
            : agg === 'min' ? (g.min === null ? 0 : g.min)
              : g.count,
      sum: g.sum, n: g.n, count: g.count,
    }));
    arr.sort((a, b) => {
      const na = parseNumber(a.label), nb = parseNumber(b.label);
      if (na !== null && nb !== null) return na - nb;
      const da = parseDate(a.label), db = parseDate(b.label);
      if (da && db) return da - db;
      return b.value - a.value;
    });
    if (cfg.sortByValue) arr.sort((a, b) => b.value - a.value);
    if (arr.length > 18) arr = arr.slice(0, 18);
    return { labels: arr.map(o => o.label), values: arr.map(o => o.value) };
  }

  function renderChartSVG(spec, w = 420, h = 240) {
    const { type = 'bar', labels = [], values = [], title = '' } = spec;
    const padL = 54, padR = 16, padT = title ? 30 : 14, padB = 46;
    const iw = Math.max(40, w - padL - padR);
    const ih = Math.max(40, h - padT - padB);
    const palette = ['#2563eb', '#7c3aed', '#0891b2', '#0f9d58', '#d97706', '#dc2626', '#4f46e5', '#0d9488', '#c2410c', '#be185d'];
    let body = '';
    const maxV = Math.max(...values, 0);
    const minV = Math.min(...values, 0);
    const fmtV = v => Math.abs(v) >= 10000 ? (v / 10000).toFixed(1) + '万' : Math.abs(v) >= 100 ? Math.round(v) : (Math.round(v * 100) / 100);

    if (type === 'pie') {
      const total = values.reduce((a, b) => a + Math.max(0, b), 0) || 1;
      const cx = w * 0.36, cy = h / 2 + 4, R = Math.min(w * 0.3, h * 0.36);
      let ang = -Math.PI / 2;
      const legendX = w * 0.63;
      values.forEach((v, i) => {
        const a = Math.max(0, v) / total * Math.PI * 2;
        const x1 = cx + R * Math.cos(ang), y1 = cy + R * Math.sin(ang);
        const x2 = cx + R * Math.cos(ang + a), y2 = cy + R * Math.sin(ang + a);
        const large = a > Math.PI ? 1 : 0;
        body += `<path d="M${cx} ${cy} L${x1.toFixed(1)} ${y1.toFixed(1)} A${R} ${R} 0 ${large} 1 ${x2.toFixed(1)} ${y2.toFixed(1)} Z" fill="${palette[i % palette.length]}" stroke="#fff" stroke-width="1.5"/>`;
        ang += a;
        if (i < 6) {
          body += `<rect x="${legendX}" y="${padT + i * 17}" width="8" height="8" rx="2" fill="${palette[i % palette.length]}"/>`;
          body += `<text x="${legendX + 13}" y="${padT + i * 17 + 7.5}" font-size="10" fill="#475467">${esc(String(labels[i] ?? '').slice(0, 10))} ${(v / total * 100).toFixed(0)}%</text>`;
        }
      });
      if (title) body += `<text x="${padL - 30}" y="16" font-size="11.5" font-weight="600" fill="#1a1d21">${esc(title)}</text>`;
      return `<svg viewBox="0 0 ${w} ${h}" width="100%" height="${h}" xmlns="http://www.w3.org/2000/svg" font-family="inherit">${body}</svg>`;
    }

    if (type === 'scatter') {
      // labels 为 x 值
      const xs = labels.map(Number), ys = values;
      const xMax = Math.max(...xs), xMin = Math.min(...xs);
      const yMax = Math.max(...ys), yMin = Math.min(...ys);
      const sx = x => padL + ((x - xMin) / (xMax - xMin || 1)) * iw;
      const sy = y => padT + ih - ((y - yMin) / (yMax - yMin || 1)) * ih;
      for (let i = 0; i <= 4; i++) {
        const y = padT + (ih / 4) * i;
        body += `<line x1="${padL}" y1="${y}" x2="${padL + iw}" y2="${y}" stroke="#eef1f4"/>`;
        body += `<text x="${padL - 6}" y="${y + 3}" font-size="9.5" fill="#8a94a6" text-anchor="end">${fmtV(yMax - (yMax - yMin) / 4 * i)}</text>`;
      }
      xs.forEach((x, i) => {
        body += `<circle cx="${sx(x).toFixed(1)}" cy="${sy(ys[i]).toFixed(1)}" r="3.2" fill="#2563eb" fill-opacity=".55" stroke="#2563eb" stroke-width="1"/>`;
      });
      if (title) body += `<text x="${padL}" y="16" font-size="11.5" font-weight="600" fill="#1a1d21">${esc(title)}</text>`;
      return `<svg viewBox="0 0 ${w} ${h}" width="100%" height="${h}" xmlns="http://www.w3.org/2000/svg" font-family="inherit">${body}</svg>`;
    }

    const range = (maxV - minV) || 1;
    const y0 = padT + ih * (maxV / range);
    for (let i = 0; i <= 4; i++) {
      const y = padT + (ih / 4) * i;
      body += `<line x1="${padL}" y1="${y}" x2="${padL + iw}" y2="${y}" stroke="#eef1f4" stroke-width="1"/>`;
      body += `<text x="${padL - 7}" y="${y + 3.5}" font-size="9.5" fill="#8a94a6" text-anchor="end">${fmtV(maxV - (range / 4) * i)}</text>`;
    }
    const n = values.length || 1;
    const step = iw / n;
    const bw = Math.min(34, step * 0.62);
    if (type === 'line') {
      const pts = values.map((v, i) => [padL + step * (i + 0.5), padT + ih - ((v - minV) / range) * ih]);
      body += `<polyline points="${pts.map(p => p.map(x => x.toFixed(1)).join(',')).join(' ')}" fill="none" stroke="#2563eb" stroke-width="2" stroke-linejoin="round"/>`;
      body += `<polygon points="${pts.map(p => p.map(x => x.toFixed(1)).join(',')).join(' ')} ${padL + step * (n - 0.5)},${y0} ${padL + step * 0.5},${y0}" fill="#2563eb" fill-opacity=".08"/>`;
      pts.forEach((p, i) => {
        body += `<circle cx="${p[0].toFixed(1)}" cy="${p[1].toFixed(1)}" r="2.8" fill="#fff" stroke="#2563eb" stroke-width="2"/>`;
      });
    } else {
      values.forEach((v, i) => {
        const hgt = Math.abs((v - (minV < 0 ? 0 : minV)) / range) * ih;
        const x = padL + step * i + (step - bw) / 2;
        const y = v >= 0 ? padT + ih - hgt : y0;
        body += `<rect x="${x.toFixed(1)}" y="${y.toFixed(1)}" width="${bw.toFixed(1)}" height="${Math.max(1, hgt).toFixed(1)}" rx="2" fill="url(#barGrad)" opacity="${0.95 - (i % 3) * 0.06}"/>`;
      });
      body += `<defs><linearGradient id="barGrad" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stop-color="#3b82f6"/><stop offset="100%" stop-color="#2563eb"/></linearGradient></defs>`;
    }
    body += `<line x1="${padL}" y1="${y0.toFixed(1)}" x2="${padL + iw}" y2="${y0.toFixed(1)}" stroke="#d0d5dd"/>`;
    const maxLabels = Math.max(2, Math.floor(iw / 46));
    const labelStep = Math.max(1, Math.ceil(n / maxLabels));
    labels.forEach((l, i) => {
      if (i % labelStep !== 0) return;
      const lx = (padL + step * (i + 0.5)).toFixed(1);
      const ly = (padT + ih + 15).toFixed(1);
      body += `<text x="${lx}" y="${ly}" font-size="9.5" fill="#667085" text-anchor="end" transform="rotate(-40 ${lx} ${ly})">${esc(String(l).slice(0, 9))}</text>`;
    });
    if (title) body += `<text x="${padL}" y="16" font-size="11.5" font-weight="600" fill="#1a1d21">${esc(title)}</text>`;
    return `<svg viewBox="0 0 ${w} ${h}" width="100%" height="${h}" xmlns="http://www.w3.org/2000/svg" font-family="inherit">${body}</svg>`;
  }

  function openChartModal(preset) {
    if (!sheet()) { toast('请先导入数据', 'err'); return; }
    if (!hasAnyData()) { toast('这张表还没有数据，先录入或导入数据再出图', 'err'); return; }
    const cols = colCount();
    const head = [];
    for (let c = 0; c < cols; c++) head.push({ i: c, name: header()[c] || colLetter(c), type: colType(c) });
    const numCols = head.filter(c => c.type === 'number');
    const catCols = head.filter(c => c.type !== 'number');
    const dimCand = catCols.filter(c => {
      const u = columnValues(c.i).length;
      return u >= 2 && u <= 30;
    });
    const defX = preset?.x != null ? preset.x : (dimCand[0]?.i ?? catCols[0]?.i ?? head[1]?.i ?? 0);
    const defY = preset?.y != null ? preset.y : (numCols[0]?.i ?? head[1]?.i ?? 0);
    const typeOpts = [['bar', '柱状图'], ['line', '折线图'], ['pie', '饼图'], ['scatter', '散点图']];
    const m = showModal({
      title: '生成图表', sub: '基于当前工作表', width: 620,
      bodyHTML: `
        <div class="field-row" style="margin-bottom:10px">
          <div class="field"><label>图表类型</label><select id="chType">${typeOpts.map(([v, l]) => `<option value="${v}" ${preset?.type === v ? 'selected' : ''}>${l}</option>`).join('')}</select></div>
          <div class="field"><label>分类轴（X）</label><select id="chX">${head.map(c => `<option value="${c.i}" ${c.i === defX ? 'selected' : ''}>${esc(c.name)}</option>`).join('')}</select></div>
          <div class="field"><label>数值轴（Y）</label><select id="chY">${head.map(c => `<option value="${c.i}" ${c.i === defY ? 'selected' : ''}>${esc(c.name)}</option>`).join('')}</select></div>
          <div class="field" style="flex:0 0 100px"><label>聚合</label><select id="chAgg"><option value="sum">求和</option><option value="avg">平均</option><option value="count">计数</option></select></div>
        </div>
        <div class="field"><label>标题</label><input type="text" id="chTitle" value="${esc(preset?.title || '')}" placeholder="图表标题（可选）"></div>
        <div id="chPreview" style="border:1px solid var(--border);border-radius:8px;padding:8px;background:#fff;min-height:250px"></div>`,
      buttons: [
        { label: '关闭' },
        { label: '下载 SVG', onClick: (el) => {
          const svg = el.querySelector('#chPreview svg');
          if (!svg) return false;
          downloadBlob(new Blob([svg.outerHTML], { type: 'image/svg+xml' }), 'chart.svg');
          return false;
        } },
        { label: '插入到 AI 面板', cls: 'primary', onClick: (el) => {
          const cfg = readCfg(el);
          const data = prepareChartData(cfg);
          App.ai && App.ai.addChartMessage && App.ai.addChartMessage({ ...cfg, ...data, svg: el.querySelector('#chPreview').innerHTML });
        } },
      ],
    });
    function readCfg(el) {
      return {
        type: el.querySelector('#chType').value,
        x: el.querySelector('#chX').value,
        y: el.querySelector('#chY').value,
        agg: el.querySelector('#chAgg').value,
        title: el.querySelector('#chTitle').value || `${header()[+el.querySelector('#chY').value] || ''} 按 ${header()[+el.querySelector('#chX').value] || ''}`,
      };
    }
    const draw = () => {
      const cfg = readCfg(m.el);
      const data = prepareChartData({ ...cfg, sortByValue: cfg.type === 'pie' });
      m.el.querySelector('#chPreview').innerHTML = renderChartSVG({ ...cfg, ...data }, 560, 250);
    };
    ['#chType', '#chX', '#chY', '#chAgg', '#chTitle'].forEach(s => {
      m.el.querySelector(s).addEventListener('change', draw);
      m.el.querySelector(s).addEventListener('input', draw);
    });
    draw();
  }

  /* ============================================================
   * 全表统计
   * ========================================================== */
  function openStatsModal() {
    if (!sheet()) { toast('请先导入数据', 'err'); return; }
    if (!hasAnyData()) { toast('这张表还没有数据，统计暂时没有内容', 'err'); return; }
    const cols = colCount();
    let html = '<div style="max-height:52vh;overflow:auto"><table style="width:100%;border-collapse:collapse;font-size:12px">';
    html += '<thead><tr style="position:sticky;top:0;background:#f8f9fb">' +
      ['列名', '类型', '非空', '空值', '唯一值', '合计', '平均', '最小', '最大'].map(h => `<th style="text-align:left;padding:6px 8px;border-bottom:1px solid var(--border);font-weight:600;color:var(--text-2)">${h}</th>`).join('') + '</tr></thead><tbody>';
    for (let c = 0; c < cols; c++) {
      const st = columnStats(c);
      const n = st.num;
      html += `<tr>
        <td style="padding:5px 8px;border-bottom:1px solid #f2f4f7">${esc(header()[c] || colLetter(c))}</td>
        <td style="padding:5px 8px;border-bottom:1px solid #f2f4f7;color:var(--muted)">${typeName(colType(c))}</td>
        <td style="padding:5px 8px;border-bottom:1px solid #f2f4f7">${st.nonEmpty}</td>
        <td style="padding:5px 8px;border-bottom:1px solid #f2f4f7;color:${st.empty ? 'var(--amber)' : 'inherit'}">${st.empty}</td>
        <td style="padding:5px 8px;border-bottom:1px solid #f2f4f7">${st.unique}</td>
        <td style="padding:5px 8px;border-bottom:1px solid #f2f4f7;text-align:right;font-variant-numeric:tabular-nums">${n ? fmt(n.sum) : '—'}</td>
        <td style="padding:5px 8px;border-bottom:1px solid #f2f4f7;text-align:right;font-variant-numeric:tabular-nums">${n ? fmt(n.mean) : '—'}</td>
        <td style="padding:5px 8px;border-bottom:1px solid #f2f4f7;text-align:right;font-variant-numeric:tabular-nums">${n ? fmt(n.min) : '—'}</td>
        <td style="padding:5px 8px;border-bottom:1px solid #f2f4f7;text-align:right;font-variant-numeric:tabular-nums">${n ? fmt(n.max) : '—'}</td>
      </tr>`;
    }
    html += '</tbody></table></div>';
    showModal({ title: '全表统计', sub: `${view().total} 行 × ${cols} 列`, width: 700, bodyHTML: html, buttons: [{ label: '关闭', cls: 'primary' }] });
  }

  /* ============================================================
   * 导入 / 导出
   * ========================================================== */
  function downloadBlob(blob, name) {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = name;
    document.body.appendChild(a);
    a.click();
    setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
  }

  function normalizeSheet(rowsAoa) {
    const out = rowsAoa.map(r => {
      const arr = Array.isArray(r) ? r.slice() : [];
      return arr.map(v => {
        if (v == null) return '';
        if (v instanceof Date) {
          return `${v.getFullYear()}-${String(v.getMonth() + 1).padStart(2, '0')}-${String(v.getDate()).padStart(2, '0')}`;
        }
        return String(v);
      });
    });
    const cols = out.reduce((m, r) => Math.max(m, r.length), 0);
    if (!cols) return [];
    out.forEach(r => { while (r.length < cols) r.push(''); });
    // 表头补全
    out[0] = out[0].map((v, i) => (v && v.trim()) ? v.trim() : `列${i + 1}`);
    return out;
  }

  /** 文本类文件解码：优先 UTF-8，失败回退 GBK（Excel 导出的中文 CSV 常见） */
  function decodeText(buf) {
    const bytes = new Uint8Array(buf);
    let out;
    try {
      out = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    } catch (e) {
      try { out = new TextDecoder('gbk').decode(bytes); }
      catch (e2) { out = new TextDecoder('utf-8').decode(bytes); }
    }
    return out.replace(/^\uFEFF/, '');
  }

  /** 解析单个文件为 [{name, rows}]，返回 Promise */
  function readSheets(file) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onerror = () => reject(new Error('文件读取失败'));
      reader.onload = e => {
        try {
          const isText = /\.(csv|txt|tsv)$/i.test(file.name);
          const wb = isText
            ? XLSX.read(decodeText(e.target.result), { type: 'string', cellDates: true, cellText: true })
            : XLSX.read(new Uint8Array(e.target.result), { type: 'array', cellDates: true, cellText: true });
          const sheets = [];
          wb.SheetNames.forEach(name => {
            const ws = wb.Sheets[name];
            if (!ws) return;
            const aoa = XLSX.utils.sheet_to_json(ws, { header: 1, defval: '', raw: false, blankrows: false });
            const norm = normalizeSheet(aoa);
            if (norm.length) sheets.push({ name, rows: norm });
          });
          if (!sheets.length) { reject(new Error('文件中没有可读取的数据')); return; }
          resolve({ sheets, kind: isText ? 'csv' : 'xlsx' });
        } catch (err) {
          reject(err);
        }
      };
      reader.readAsArrayBuffer(file);
    });
  }

  /** 把一张表的数据灌进当前空白工作表（不新开标签），用来实现"拖到这张空表里" */
  function fillBlankSheet(data) {
    const s = sheet();
    if (!s || hasAnyData() || !data || !data.rows) return false;
    pushHistory();
    s.rows = data.rows;
    state.page = 1;
    state.search = ''; state.filters = {}; state.sort = null; state.sel = { r: -1, c: -1 };
    state.manualEdit = false;
    const gs = $('#globalSearch'); if (gs) gs.value = '';
    invalidate();
    markDirty();
    refresh();
    resetScroll();
    if (App.ai && App.ai.onDataLoaded) App.ai.onDataLoaded();
    return true;
  }

  /** 批量导入：每个文件开一个标签（若当前界面/当前工作表是空白的，直接装进去） */
  async function importFiles(files) {
    const list = Array.from(files || []);
    if (!list.length) return;
    let ok = 0;
    for (const f of list) {
      try {
        const { sheets, kind } = await readSheets(f);
        // 当前是一张空白工作表（且文件只有一张表）：直接填进这张表
        if (sheets.length === 1 && fillBlankSheet(sheets[0])) {
          if (list.length === 1) toast(`已载入「${f.name}」到当前工作表`, 'ok');
          ok++;
          continue;
        }
        // 当前界面还是空的（没有任何工作表）：把文件装进这个界面，不再多开一个标签
        if (fillEmptyDoc(sheets, f.name, kind)) {
          if (list.length === 1) toast(`已载入「${f.name}」· ${sheets.length} 个工作表`, 'ok');
          ok++;
          continue;
        }
        openDoc(sheets, f.name, kind, { silent: list.length > 1 });
        ok++;
      } catch (err) {
        console.error(err);
        toast(`「${f.name}」解析失败：${err.message}`, 'err');
      }
    }
    if (list.length > 1 && ok) toast(`已打开 ${ok} 个文件`, 'ok');
  }

  function loadFile(file) { return importFiles([file]); }

  function aoaForExport(src) {
    return src.map(r => r.map(v => {
      const s = cellText(v).trim();
      if (!s) return '';
      if (/^0\d+$/.test(s)) return s;
      const n = parseNumber(s);
      return n !== null ? n : s;
    }));
  }

  /** 导出即视为已保存：把标签上的"未保存"小圆点去掉 */
  function markSaved() {
    const d = curDoc();
    if (d && d.dirty) { d.dirty = false; renderTabs(); }
  }

  function exportFile(kind) {
    if (!sheet()) { toast('没有可导出的数据', 'err'); return; }
    const base = (state.fileName || '工作表').replace(/\.[^.]+$/, '');
    if (kind === 'csv') {
      const { idx } = view();
      const head = rows()[0];
      const lines = [head].concat(idx.map(i => rows()[i] || []));
      const csvRows = lines.map(r => {
        const arr = [];
        for (let c = 0; c < head.length; c++) arr.push(cellText(r[c]));
        return arr;
      });
      downloadBlob(new Blob(['\ufeff' + toCSV(csvRows)], { type: 'text/csv;charset=utf-8' }), `${base}_导出.csv`);
      toast('已导出 CSV', 'ok');
      markSaved();
      return;
    }
    const wb = XLSX.utils.book_new();
    const used = new Set();
    const uniqueName = name => {
      const base = String(name || 'Sheet').replace(/[\\/?*[\]:]/g, '_').slice(0, 28) || 'Sheet';
      let n = base, i = 2;
      while (used.has(n)) { n = base.slice(0, 26) + '(' + i + ')'; i++; }
      used.add(n);
      return n;
    };
    if (kind === 'current') {
      const { idx } = view();
      const src = idx.length === view().total ? rows() : [rows()[0]].concat(idx.map(i => rows()[i]));
      XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(aoaForExport(src)), uniqueName(sheet().name));
    } else {
      state.sheets.forEach(s => {
        XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(aoaForExport(s.rows)), uniqueName(s.name));
      });
    }
    XLSX.writeFile(wb, `${base}_已处理.xlsx`);
    toast('已导出 Excel', 'ok');
    markSaved();
  }

  function toCSV(arr) {
    return arr.map(r => r.map(v => {
      const s = cellText(v);
      return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    }).join(',')).join('\r\n');
  }

  /* ============================================================
   * 示例数据
   * ========================================================== */
  function makeSample() {
    const regions = ['华东', '华北', '华南', '西南', '华中'];
    const products = ['智能音箱', '无线耳机', '机械键盘', '显示器', '移动电源'];
    const reps = ['张伟', '李娜', '王强', '刘洋', '陈静', '赵磊'];
    const grades = ['A', 'B', 'C'];
    let seed = 20241020;
    const rnd = () => { seed = (seed * 1664525 + 1013904223) % 4294967296; return seed / 4294967296; };
    const pick = arr => arr[Math.floor(rnd() * arr.length)];
    const data = [['订单号', '下单日期', '地区', '产品', '销售员', '数量', '单价', '金额', '客户评级']];
    const basePrice = { '智能音箱': 399, '无线耳机': 699, '机械键盘': 459, '显示器': 1299, '移动电源': 159 };
    for (let i = 1; i <= 158; i++) {
      const d = new Date(2024, Math.floor(rnd() * 6), 1 + Math.floor(rnd() * 28));
      const product = pick(products);
      const qty = 1 + Math.floor(rnd() * 9);
      const price = basePrice[product];
      const amount = qty * price;
      data.push([
        'SO' + String(10000 + i),
        `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`,
        pick(regions), product, pick(reps),
        String(qty), String(price), String(amount),
        rnd() > 0.78 ? 'A' : rnd() > 0.5 ? 'B' : 'C',
      ]);
    }
    // 混入脏数据：重复行 / 空值 / 异常值
    data.push(data[11].slice(), data[24].slice(), data[57].slice());
    data.push(['SO10160', '2024-03-05', '华东', '无线耳机', '张伟', '2', '', '1398', 'B']);
    data.push(['SO10161', '2024-04-11', '', '显示器', '刘洋', '3', '1299', '', 'A']);
    data.push(['SO10162', '2024-05-20', '华南', '机械键盘', '陈静', '420', '459', '192780', 'C']);
    return [{ name: '销售明细', rows: data }];
  }

  function loadSample() {
    const sheets = makeSample();
    // 当前是空白工作表：直接填进这张表
    if (fillBlankSheet(sheets[0])) {
      toast('已载入示例数据：158 条销售记录（含少量脏数据）', 'ok');
      return;
    }
    if (!fillEmptyDoc(sheets, '示例_销售明细.xlsx', 'xlsx')) {
      openDoc(sheets, '示例_销售明细.xlsx', 'xlsx', { silent: true });
    }
    toast('已载入示例数据：158 条销售记录（含少量脏数据）', 'ok');
  }

  /** 新建界面：完全空白，不带任何工作表（和起始页一样），数据靠导入或点侧栏「+」自己建 */
  function loadBlank() {
    // 同名界面自动编号
    let n = 0;
    for (const d of state.docs) if (/^新建界面/.test(d.name)) n++;
    const name = n ? `新建界面${n + 1}` : '新建界面';
    openDoc([], name, 'xlsx', { silent: true });
    toast('已新建空白界面');
  }

  /** 新增工作表：一张全新的空白表（不继承当前表的表头与数据），和起始页一样干净 */
  function addSheet() {
    if (state.activeDoc < 0) { toast('请先新建界面或导入数据', 'err'); return; }
    // 统一的空白表：3 列通用表头 + 20 行可录入的空行
    const COLS = 3, ROWS = 20;
    const blank = [['列1', '列2', '列3']];
    for (let i = 0; i < ROWS; i++) blank.push(new Array(COLS).fill(''));
    const used = new Set(state.sheets.map(s => s.name));
    let n = state.sheets.length + 1;
    while (used.has('Sheet' + n)) n++;
    const name = 'Sheet' + n;

    pushHistory();
    state.sheets.push({ name, rows: blank });
    state.active = state.sheets.length - 1;
    state.page = 1;
    state.search = ''; state.filters = {}; state.sort = null; state.sel = { r: -1, c: -1 };
    state.manualEdit = false;   // 新建后先显示空白面板，和起始页一致
    const gs = $('#globalSearch'); if (gs) gs.value = '';
    invalidate();
    markDirty();
    refresh();
    resetScroll();
    if (App.ai && App.ai.onDataLoaded) App.ai.onDataLoaded();
    toast(`已新建工作表「${name}」：拖入文件填入，或点「直接录入」`, 'ok');
  }

  /** 删除当前工作表（至少保留一个） */
  function deleteSheet() {
    if (!state.sheets.length) { toast('当前没有工作表', 'err'); return; }
    if (state.sheets.length === 1) { toast('这是最后一个工作表，不能删除', 'err'); return; }
    const name = sheet().name;
    mutate(() => {
      state.sheets.splice(state.active, 1);
      state.active = Math.max(0, Math.min(state.active, state.sheets.length - 1));
      state.page = 1;
    });
    toast(`已删除工作表「${name}」，Ctrl+Z 可撤销`, 'ok');
  }

  /** 在浏览器里再开一份完整界面（全新状态，等同“复制一个界面”） */
  function openNewWindow() {
    let w = null;
    try { w = window.open(location.href, '_blank'); } catch (e) { w = null; }
    if (!w) toast('新窗口被浏览器拦截了，请允许弹窗后重试', 'err');
  }

  /* ============================================================
   * 帮助
   * ========================================================== */
  function openHelp() {
    const row = (k, v) => `<div style="display:flex;gap:14px;padding:5px 0;border-bottom:1px solid #f2f4f7"><b style="flex:0 0 150px;color:var(--text);font-weight:600">${k}</b><span>${v}</span></div>`;
    showModal({
      title: '使用说明', sub: 'SheetPilot', width: 560,
      bodyHTML: `
        <div style="font-size:12.5px;line-height:1.7;color:var(--text-2)">
          <h4 style="margin:0 0 6px;font-size:12.5px;color:var(--text)">表格处理</h4>
          ${row('导入', '拖拽文件到窗口任意位置，或点击「导入文件」。支持 xlsx / xls / csv / tsv，可一次选多个文件，每个文件开一个标签。')}
          ${row('多文件', '顶部标签栏切换文件，最左边的「起始页」是初始界面，随时可以点回去（已打开的文件不会丢失）。每个界面完全独立：各自的表格数据、工作表、筛选、排序、搜索、撤销历史，连 AI 对话也各自保存——新建界面不会带上一个界面的内容，切回去还能看到当时的对话。模型配置和 API Key 是全局设置，新建界面后仍然保留。点标签上的 × 关闭当前文件（有未保存改动会二次确认）；点右边的「+ 新建界面」直接多开一个空白界面（Ctrl+T）。标签上出现橙色圆点表示该文件有未保存的修改。')}
          ${row('工作表', '左侧「工作表」标题右侧的 + 新建工作表：新建出来的表和起始页一样是空的（不继承当前表头），拖文件进去会填到这张表里，点「直接录入」则显示空白网格自己敲；垃圾桶删除当前工作表（Ctrl+Z 可撤销）；点击列表项即可切换工作表，每个工作表的数据互不影响。')}
          ${row('编辑', '点顶部「编辑」进入编辑模式后，单击任意单元格就能直接改；关闭编辑模式时用双击也可以改。Enter 确认、Esc 取消，选中格按 Delete 清空，Ctrl+V 可整块粘贴。')}
          ${row('列操作', '鼠标移到列头，点右侧「⋯」：排序、筛选、统计、重命名、插入/复制/删除列。')}
          ${row('筛选', '「筛选」按钮按列勾选取值；筛选只影响视图，导出时默认只导出筛选后的行。')}
          ${row('导出', '「导出」可选择当前表（含筛选）、全部工作表或 CSV。导出成功后标签上的「未保存」圆点会消失。')}
          ${row('数据保存', '表格和修改只保存在当前页面的内存里，刷新或关闭页面就会丢失（模型配置除外）。要留存请先「导出」成 Excel。')}
          <h4 style="margin:14px 0 6px;font-size:12.5px;color:var(--text)">AI 分析</h4>
          ${row('开箱可用', '未配置模型时使用内置分析引擎：数据概览、质量诊断、清洗方案、业务洞察、推荐图表。')}
          ${row('接入大模型', '点 AI 面板右上角齿轮，填入任意 OpenAI 兼容接口的 Base URL、模型名和 Key，支持 DeepSeek、Kimi、通义、GLM、OpenAI 等。')}
          ${row('可执行建议', 'AI 给出的清洗方案会变成勾选卡片，确认后一键执行，可用 Ctrl+Z 撤销。')}
          ${row('隐私', '表格数据只在本机浏览器中解析；仅在提问时把数据摘要发送给你配置的模型服务商。')}
          <h4 style="margin:14px 0 6px;font-size:12.5px;color:var(--text)">快捷键</h4>
          ${row('Ctrl + Z / Ctrl + Shift + Z', '撤销 / 重做（最多 20 步）')}
          ${row('Ctrl + F', '聚焦搜索框')}
          ${row('Ctrl + O', '打开文件（可多选）')}
          ${row('Ctrl + T', '新建一个空白界面')}
          ${row('Ctrl + S', '导出当前工作表')}
          ${row('Enter / Esc', '编辑时确认 / 取消')}
          <div style="margin-top:12px;padding:9px 11px;background:var(--panel-2);border:1px solid var(--border);border-radius:7px;color:var(--muted)">
            提示：本工具为单页应用，直接双击 index.html 即可离线使用（AI 功能需联网）。
          </div>
        </div>`,
      buttons: [{ label: '知道了', cls: 'primary' }],
    });
  }

  /* ============================================================
   * 事件绑定
   * ========================================================== */
  function bind() {
    $('#btnImport').onclick = () => $('#fileInput').click();
    $('#btnPick').onclick = () => $('#fileInput').click();
    $('#fileInput').onchange = e => {
      const fs = Array.from(e.target.files || []);
      if (fs.length) importFiles(fs);
      e.target.value = '';
    };

    // 标签栏：切换 / 关闭 / 中键关闭
    const tabsEl = $('#fileTabs');
    tabsEl.addEventListener('click', e => {
      const x = e.target.closest('[data-close]');
      if (x) { e.stopPropagation(); closeDoc(+x.dataset.close); return; }
      const tab = e.target.closest('.file-tab');
      if (!tab) return;
      if (tab.dataset.home) { goHome(); return; }
      switchDoc(+tab.dataset.doc);
    });
    tabsEl.addEventListener('auxclick', e => {
      if (e.button !== 1) return;
      const tab = e.target.closest('.file-tab');
      if (tab) { e.preventDefault(); closeDoc(+tab.dataset.doc); }
    });
    tabsEl.addEventListener('wheel', e => {
      if (Math.abs(e.deltaY) < Math.abs(e.deltaX)) return;
      if (tabsEl.scrollWidth <= tabsEl.clientWidth) return;
      tabsEl.scrollLeft += e.deltaY;
      e.preventDefault();
    }, { passive: false });

    // 「+」：直接开一个空白界面（等同再开一份同样的工作台）
    $('#btnNewTab').onclick = () => loadBlank();
    // 「+」右侧小箭头：文件与示例入口
    $('#btnNewMore').onclick = e => {
      const r = e.currentTarget.getBoundingClientRect();
      showMenu([
        { label: '导入文件（可多选）', icon: 'i-upload', action: () => $('#fileInput').click() },
        { label: '载入示例数据', icon: 'i-sparkles', action: loadSample },
        { sep: true },
        { label: '在新窗口打开一份', icon: 'i-copy', action: openNewWindow },
      ], r.left - 148, r.bottom + 6, 178);
    };

    const dz = $('#dropZone');
    ['dragenter', 'dragover'].forEach(ev => dz.addEventListener(ev, e => { e.preventDefault(); dz.classList.add('dragover'); }));
    ['dragleave', 'drop'].forEach(ev => dz.addEventListener(ev, e => { e.preventDefault(); dz.classList.remove('dragover'); }));
    dz.addEventListener('drop', e => {
      if (e.dataTransfer.files.length) importFiles(e.dataTransfer.files);
    });
    document.addEventListener('dragover', e => e.preventDefault());
    document.addEventListener('drop', e => {
      if (e.target.closest('.drop-zone')) return;
      if (!e.dataTransfer.files.length) return;
      e.preventDefault();
      importFiles(e.dataTransfer.files);
    });

    $('#btnSample').onclick = loadSample;
    $('#btnHelp').onclick = openHelp;
    $('#btnBlank').onclick = () => {
      const s = sheet();
      // 已经在一个空白工作表里：切到"直接录入"，显示空白网格
      if (s && !hasAnyData()) { state.manualEdit = true; refresh(); return; }
      if (state.activeDoc >= 0) addSheet(); else loadBlank();
    };
    $('#btnAddRow').onclick = e => {
      const r = e.currentTarget.getBoundingClientRect();
      showMenu([
        { label: '行操作' },
        { label: '插入空行', icon: 'i-plus', action: addRow },
        { label: '删除选中行', icon: 'i-trash', danger: true, action: deleteSelectedRow },
        { sep: true },
        { label: '删除所有空白行', action: dropEmptyRows },
      ], r.left, r.bottom + 4, 170);
    };
    $('#btnAddCol').onclick = e => {
      const r = e.currentTarget.getBoundingClientRect();
      const c = state.sel.c >= 0 ? state.sel.c : colCount() - 1;
      showMenu([
        { label: '列操作' },
        { label: '在末尾添加列', icon: 'i-plus', action: addColumn },
        { label: '在左侧插入列', action: () => insertColumn(c, 'left') },
        { label: '在右侧插入列', action: () => insertColumn(c, 'right') },
        { sep: true },
        { label: '删除选中列', icon: 'i-trash', danger: true, action: () => {
          if (state.sel.c < 0) { toast('请先选中该列的任意单元格', 'err'); return; }
          deleteColumn(state.sel.c);
        } },
      ], r.left, r.bottom + 4, 180);
    };
    $('#btnUndo').onclick = undo;
    $('#btnRedo').onclick = redo;
    $('#btnEditMode').onclick = () => setEditMode(!state.editMode);

    // 窗口尺寸变化后重算列宽，避免网格右侧留白或横向滚动条不消失
    let rsTimer = 0;
    window.addEventListener('resize', () => {
      clearTimeout(rsTimer);
      rsTimer = setTimeout(() => { if (!state.editing && sheet()) renderTable(); }, 150);
    });

    // 数据只在内存里：刷新/关闭页面前提醒一次，避免整份表格白做
    window.addEventListener('beforeunload', e => {
      const liveHasData = !!curDoc() && hasAnyData();
      const anySaved = state.docs.some(d => d.dirty || sheetHasData((d.sheets || [])[d.active || 0]));
      if (liveHasData || anySaved) { e.preventDefault(); e.returnValue = ''; }
    });
    $('#btnSortAsc').onclick = () => {
      const c = state.sel.c >= 0 ? state.sel.c : 0;
      const cur = state.sort && state.sort.col === c ? state.sort.dir : 0;
      doSort(c, cur === 1 ? -1 : 1);
    };
    $('#btnFilterAll').onclick = e => {
      const cols = colCount();
      const items = [{ label: '按列筛选' }];
      for (let c = 0; c < cols; c++) {
        items.push({ label: (header()[c] || colLetter(c)) + (state.filters[c] ? ' ●' : ''), action: () => openFilter(c, e.clientX - 100, e.clientY + 8) });
      }
      showMenu(items, e.clientX - 100, e.clientY + 8, 180);
    };
    $('#btnClearFilters').onclick = () => { state.filters = {}; state.page = 1; invalidate(); renderTable(); toast('已清除全部筛选'); };
    $('#btnExport').onclick = e => {
      showMenu([
        { label: '导出当前工作表（含筛选）', icon: 'i-download', action: () => exportFile('current') },
        { label: '导出全部工作表', action: () => exportFile('all') },
        { sep: true },
        { label: '导出为 CSV（当前视图）', action: () => exportFile('csv') },
      ], e.clientX - 120, e.clientY + 28, 220);
    };
    $('#btnRecheck').onclick = () => { invalidate(); renderHealth(); toast('体检已更新'); };
    $('#btnStats') && ($('#btnStats').onclick = openStatsModal);

    $('#search'); // noop
    const doSearch = debounce(v => {
      state.search = v.trim();
      state.page = 1;
      invalidate(); renderTable(); renderSidebar();
    }, 220);
    $('#globalSearch').addEventListener('input', e => doSearch(e.target.value));
    $('#btnFindNext').onclick = () => {
      if (!state.search) { $('#globalSearch').focus(); return; }
      state.page = state.page >= maxPage() ? 1 : state.page + 1;
      renderTable();
      toast(`第 ${state.page} / ${maxPage()} 页`);
    };

    $('#btnPrev').onclick = () => { if (state.page > 1) { state.page--; renderTable(); } };
    $('#btnNext').onclick = () => { if (state.page < maxPage()) { state.page++; renderTable(); } };
    $('#pageSize').onchange = e => { state.pageSize = +e.target.value; state.page = 1; renderTable(); };

    $('#btnAddSheet').onclick = addSheet;
    $('#btnDelSheet').onclick = deleteSheet;

    $('#sheetList').addEventListener('click', e => {
      const it = e.target.closest('[data-sheet]');
      if (!it) return;
      state.active = +it.dataset.sheet;
      // 换表时把视图状态一起清掉：否则上一张表的排序箭头会残留在这张表的列头上
      state.page = 1; state.filters = {}; state.search = ''; state.sort = null; state.sel = { r: -1, c: -1 };
      state.manualEdit = false;
      $('#globalSearch').value = '';
      invalidate(); refresh();
      App.ai && App.ai.onDataLoaded && App.ai.onDataLoaded();
    });

    // 编辑模式下的「单击即改」放在 mousedown：否则先 blur 提交上一格 → 重渲染 → click 落在已替换的节点上，第二个格子点不开
    $('#tableWrap').addEventListener('mousedown', e => {
      if (!state.editMode || e.button !== 0) return;
      const td = e.target.closest('td[data-c]');
      if (!td || td.querySelector('input.cell-input')) return;   // 点在正在编辑的格子上，保留原输入框
      e.preventDefault();
      const r = +td.dataset.r, c = +td.dataset.c;
      // 先提交上一格（blur → mutate → 重渲染），再按坐标重新取节点
      if (state.editing) {
        const inp = document.querySelector('#grid input.cell-input');
        if (inp) inp.blur();
      }
      state.sel = { r, c };
      const fresh = document.querySelector(`#grid td[data-r="${r}"][data-c="${c}"]`);
      if (!fresh) return;
      $$('#grid td.cell-active').forEach(x => x.classList.remove('cell-active'));
      fresh.classList.add('cell-active');
      startEdit(fresh);
    });

    $('#tableWrap').addEventListener('click', e => {
      const menuBtn = e.target.closest('[data-menu]');
      if (menuBtn) {
        const r = menuBtn.getBoundingClientRect();
        openColumnMenu(+menuBtn.dataset.menu, r.left - 170, r.bottom + 4);
        return;
      }
      const td = e.target.closest('td[data-c]');
      if (td) {
        state.sel = { r: +td.dataset.r, c: +td.dataset.c };
        $$('#grid td.cell-active').forEach(x => x.classList.remove('cell-active'));
        td.classList.add('cell-active');
        // 兜底：某些环境不会派发 mousedown（如脚本触发 click）
        if (state.editMode && !state.editing) startEdit(td);
      }
    });
    $('#tableWrap').addEventListener('dblclick', e => {
      if (e.target.closest('[data-menu]')) return;
      const th = e.target.closest('th[data-col]');
      if (th) { renameColumn(+th.dataset.col); return; }
      const td = e.target.closest('td[data-c]');
      if (td) startEdit(td);
    });

    const qa = action => {
      switch (action) {
        case 'dedupe': dedupe(); break;
        case 'dropEmpty': dropEmptyRows(); break;
        case 'trim': trimSpaces(); break;
        case 'numeric': convertAllNumeric(); break;
        case 'chart': openChartModal(); break;
        case 'stats': openStatsModal(); break;
      }
    };
    $$('.quick-actions .qa').forEach(b => b.onclick = () => qa(b.dataset.action));

    document.addEventListener('keydown', e => {
      const tag = (e.target.tagName || '').toLowerCase();
      const typing = tag === 'input' || tag === 'textarea' || e.target.isContentEditable;
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z') {
        if (typing) return;
        e.preventDefault(); e.shiftKey ? redo() : undo(); return;
      }
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'y') { if (typing) return; e.preventDefault(); redo(); return; }
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'f') { e.preventDefault(); $('#globalSearch').focus(); return; }
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'o') { e.preventDefault(); $('#fileInput').click(); return; }
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 't') { e.preventDefault(); loadBlank(); return; }
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') { e.preventDefault(); exportFile('current'); return; }
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'c' && state.sel.r > 0) {
        const v = cellText(rows()[state.sel.r]?.[state.sel.c]);
        if (v) {
          navigator.clipboard?.writeText(v).then(() => toast('已复制单元格内容'), () => { });
        }
        return;
      }
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'v' && state.sel.r > 0 && !e.target.closest('input, textarea')) {
        navigator.clipboard?.readText().then(txt => {
          if (!txt) return;
          const lines = txt.replace(/\r/g, '').split('\n').filter((l, i, a) => l !== '' || i < a.length - 1);
          const grid = lines.map(l => l.split('\t'));
          mutate(() => {
            const r0 = state.sel.r, c0 = state.sel.c;
            const width = colCount();
            const need = r0 + grid.length - rows().length;
            for (let i = 0; i < need; i++) rows().push(new Array(width).fill(''));
            grid.forEach((row, dr) => {
              row.forEach((v, dc) => {
                const ci = c0 + dc;
                if (ci < width) rows()[r0 + dr][ci] = v;
              });
            });
          });
          toast(`已粘贴 ${grid.length} 行 × ${Math.max(...grid.map(g => g.length))} 列`, 'ok');
        }, () => { });
        return;
      }
      if (typing) return;
      if (document.querySelector('.overlay')) return;
      // Esc 退出编辑模式（正在编辑单元格时 Esc 由输入框自己处理为取消）
      if (e.key === 'Escape' && state.editMode && !state.editing) { setEditMode(false); return; }
      if (e.key === 'Delete' && state.sel.r > 0) {
        const { r, c } = state.sel;
        mutate(() => { rows()[r][c] = ''; });
        toast('已清空单元格');
        return;
      }
      if (e.key === 'Enter' && state.sel.r > 0) {
        e.preventDefault();
        const td = $(`#grid td[data-r="${state.sel.r}"][data-c="${state.sel.c}"]`);
        if (td) startEdit(td);
        return;
      }
      const moves = { ArrowUp: [-1, 0], ArrowDown: [1, 0], ArrowLeft: [0, -1], ArrowRight: [0, 1] };
      if (moves[e.key] && sheet()) {
        e.preventDefault();
        const [dr, dc] = moves[e.key];
        let { r, c } = state.sel;
        if (r < 0) { r = view().idx[0] ?? 1; c = 0; }
        else {
          const pos = view().idx.indexOf(r);
          const nr = pos + dr;
          if (nr >= 0 && nr < view().idx.length) r = view().idx[nr];
          c = Math.min(colCount() - 1, Math.max(0, c + dc));
        }
        state.sel = { r, c };
        state.page = Math.floor(view().idx.indexOf(r) / state.pageSize) + 1;
        renderTable();
        const td = $(`#grid td[data-r="${r}"][data-c="${c}"]`);
        if (td) td.scrollIntoView({ block: 'nearest', inline: 'nearest' });
      }
    });
  }

  /** 编辑模式开关：开启后单击单元格即可直接改内容（关闭时用双击） */
  function setEditMode(on) {
    if (on && !sheet()) { toast('请先导入文件或新建工作表', 'err'); return; }
    state.editMode = !!on;
    const btn = $('#btnEditMode');
    if (btn) {
      btn.classList.toggle('active', state.editMode);
      btn.title = state.editMode
        ? '编辑模式已开启：单击单元格直接修改（Esc 退出）'
        : '编辑模式：开启后单击单元格即可直接修改内容（关闭时双击修改）';
    }
    const tw = $('#tableWrap');
    if (tw) tw.classList.toggle('edit-mode', state.editMode);
    toast(state.editMode ? '编辑模式已开启：单击单元格即可修改' : '编辑模式已关闭');
  }

  function startEdit(td) {
    if (state.editing) return;
    if (!td || !td.isConnected) return;          // 已在重渲染中被替换掉的旧节点
    const r = +td.dataset.r, c = +td.dataset.c;
    if (!rows()[r]) { renderTable(); return; }   // 行可能已被删除/撤销掉
    const val = cellText((rows()[r] || [])[c]);
    const inp = document.createElement('input');
    inp.className = 'cell-input';
    inp.value = val;
    td.classList.add('editing');
    td.textContent = '';
    td.appendChild(inp);
    state.editing = true;
    inp.focus();
    inp.select();
    let finished = false;
    const finish = commit => {
      if (finished) return;
      finished = true;
      state.editing = false;
      const nv = inp.value;
      if (commit && nv !== val) {
        mutate(() => { rows()[r][c] = nv; });
      } else {
        renderTable();
      }
    };
    inp.addEventListener('blur', () => finish(true));
    inp.addEventListener('keydown', e => {
      e.stopPropagation();
      if (e.key === 'Enter') { e.preventDefault(); finish(true); }
      else if (e.key === 'Escape') { e.preventDefault(); finish(false); }
      else if (e.key === 'Tab') {
        e.preventDefault(); finish(true);
        const nr = $(`#grid td[data-r="${r}"][data-c="${Math.min(colCount() - 1, c + 1)}"]`);
        if (nr) { state.sel = { r, c: c + 1 }; startEdit(nr); }
      }
    });
  }

  /* ============================================================
   * 暴露 API
   * ========================================================== */
  const App = {
    state, sheet, rows, header, colCount, colType, typeName, columnStats, columnValues,
    cellText, isEmpty, parseNumber, parseDate, fmt, esc, toast, refresh, rerenderView,
    invalidate, mutate, pushHistory, snapshot, colLetter,
    buildContext, renderChartSVG, prepareChartData, openChartModal, showModal, showMenu,
    showPopover, exportFile, downloadBlob, toCSV, dedupe, dropEmptyRows, trimSpaces,
    convertAllNumeric, fillMissing, removeOutliers, convertToNumber, convertToDate,
    addRow, openFilter, health, makeSample, loadSample, openStatsModal, doSort,
    startEdit, undo, redo, loadFile, addColumn, deleteColumn, renameColumn, insertColumn,
    openDoc, switchDoc, closeDoc, importFiles, renderTabs, activateDoc,
    addSheet, deleteSheet, goHome, sheetBodyRows, sheetHasData,
  };

  function buildContext() {
    const s = sheet();
    if (!s || s.rows.length < 2) return '当前没有可分析的数据。';
    const head = s.rows[0];
    const body = s.rows.slice(1);
    const n = body.length;
    const out = [];
    out.push(`工作表：${s.name}`);
    out.push(`规模：${n} 行数据，${head.length} 列`);
    out.push('');
    out.push('【列概况】列名 | 类型 | 非空/总行 | 唯一值 | 示例值 | 数值统计');
    head.forEach((h, i) => {
      const st = columnStats(i);
      const samples = [];
      for (const r of body) {
        const v = cellText(r[i]).trim();
        if (v) { samples.push(v); if (samples.length >= 4) break; }
      }
      let line = `- ${h || '列' + (i + 1)} | ${typeName(colType(i))} | ${st.nonEmpty}/${body.length} | 唯一 ${st.unique} | ${samples.join(' / ') || '（空）'}`;
      if (st.num) line += ` | 合计 ${fmt(st.num.sum, 2)}，均值 ${fmt(st.num.mean, 2)}，最小 ${fmt(st.num.min, 2)}，最大 ${fmt(st.num.max, 2)}`;
      if (st.dateRange) line += ` | 区间 ${st.dateRange[0].toLocaleDateString('zh-CN')} ~ ${st.dateRange[1].toLocaleDateString('zh-CN')}`;
      out.push(line);
    });
    const sample = n <= 16 ? body : body.slice(0, 11).concat(body.slice(-4));
    out.push('');
    out.push(`【数据样例】CSV 格式，共 ${sample.length} 行（${n > 16 ? '首尾抽样' : '全部'}）`);
    out.push(toCSV([head].concat(sample)));
    let text = out.join('\n');
    if (text.length > 10000) text = text.slice(0, 10000) + '\n…（内容过长已截断）';
    return text;
  }

  /* ============================================================
   * 启动
   * ========================================================== */
  bind();
  renderAll();
  window.App = App;
  if (/[?&]demo=1/.test(location.search)) loadSample();
  if (window.innerWidth < 1180) $('#aiPanel').classList.add('collapsed');
})();
