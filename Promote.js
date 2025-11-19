// promote.js
// MultiDrilldown with enhanced promote behavior:
// - On promote, read /api/tasks (projectTasks.json)
// - Find all tasks with same flow as promoted record
// - Evaluate criteria array against promoted record data
// - Update task.status to complete or incomplete
// - Write updated tasks back via PUT /api/tasks
// - Build promote payload with three counters before updatedAt

import { TableBuilder } from './tableBuilder.js';

export class MultiDrilldown {
  constructor({
    container = '#grid',
    name = 'mainGrid',
    csv,
    groupByIdx = [],
    statusIdx = null,
    colorColsIdx = [],
    defColumn = {},
    promoteIdx = null,
    promoteCheck = [],
    promoteData = [],
    promoteDataFiles = [],
    sep = '_',
    debug = true,
    defaultSearches = {}
  } = {}) {
    if (!csv) throw new Error('csv (main table) is required');
    this.container = container;
    this.name = name;
    this.csv = csv;
    this.groupByIdx = groupByIdx;
    this.statusIdx = Array.isArray(statusIdx) ? statusIdx : (statusIdx == null ? [] : [statusIdx]);
    this.colorColsIdx = colorColsIdx;
    this.defColumn = defColumn || {};
    this.sep = sep;
    this.debug = debug;

    this.promoteIdx       = Number.isInteger(promoteIdx) ? promoteIdx : null;
    this.promoteCheck     = Array.isArray(promoteCheck) ? promoteCheck : [];
    this.promoteData      = Array.isArray(promoteData)  ? promoteData  : [];
    this.promoteDataFiles = Array.isArray(promoteDataFiles) ? promoteDataFiles : [];

    this.defaultSearches = defaultSearches || {};

    this._openOnce = false;
    // stack item shape:
    // { step, rules, rulesUsed[], contexts, title, triggerCol, selectionValue }
    this._stack = [];
    this._idx = -1;
    this._level0Fields = [];
  }

  /* ======================= PUBLIC ======================= */
  async init() {
    if (!window.w2ui || !window.w2popup) {
      this.warn('w2ui or w2popup not found. Include w2ui before this module.');
      return;
    }

    const tb = new TableBuilder({
      dataCsv: this.csv,
      box: this.container,
      name: this.name,
      groupByIdx: this.groupByIdx,
      statusIdx: this.statusIdx.length ? this.statusIdx[0] : null,
      colorColsIdx: this.colorColsIdx
    });
    await tb.build();

    const grid = w2ui[this.name];
    if (!grid) { this.warn(`Grid "${this.name}" not found.`); return; }

    this._level0Fields = grid.columns.map(c => c.field);

    this._enableRightClickCopy(this.name);

    if (Number.isInteger(this.promoteIdx) &&
        this.promoteIdx >= 0 && this.promoteIdx < grid.columns.length) {
      this._setupPromoteOnMainGrid(grid);
    }

    this._ensureToolbar(grid);
    this._installToolbarPreset(grid, this.defaultSearches?.main || [], `${grid.name}-preset`);
    this._applyPresetList(grid, this.defaultSearches?.main || [], true);

    // Main grid click
    grid.on('click', async (ev) => {
      const col = ev.detail?.column ?? ev.column;
      const recid = ev.detail?.recid ?? ev.recid;
      if (col == null || recid == null) return;

      // Promote button
      if (Number.isInteger(this.promoteIdx) && col === this.promoteIdx) {
        const oe = ev.detail?.originalEvent || ev.originalEvent;
        const target = oe?.target || window.event?.target;
        if (target && target.closest && target.closest('.btn-promote')) {
          await this._handlePromoteClick(grid, recid);
          return;
        }
      }

      const rules = Array.isArray(this.defColumn[col]) ? this.defColumn[col] : null;
      if (!rules || !rules.length) return;

      const rec = grid.get(recid);
      if (!rec) return;

      const rowIndex = this._rowIndexOf(grid, recid);
      const rulesL1 = this._pickRules({
        rules,
        level: 1,
        clickRowIndex: rowIndex,
        clickColIndex: col
      });

      if (!rulesL1.length) return;

      // selected cell value from main grid
      const fields = grid.columns.map(c => c.field);
      const selectionValue = rec[fields[col]];

      const mainCtx = this._valuesFromRecord(rec, this._level0Fields);
      const title = grid.columns[col]?.text || grid.columns[col]?.caption || `Col ${col}`;

      await this._openSequence({
        rules,
        startRules: rulesL1,
        contexts: [mainCtx],
        title,
        triggerCol: col,
        selectionValue
      });
    });
  }

  /* ======================= PROMOTE (main table only) ======================= */
  _setupPromoteOnMainGrid(grid) {
    const col = grid.columns[this.promoteIdx];

    const yesMatcher = (v) => {
      const s = String(v ?? '').trim().toLowerCase();
      return s === 'yes' || s === 'y' || s === 'true' || s === '1';
    };

    const originalRender = col.render;
    col.render = (rec) => {
      const isChild   = !!(rec?.w2ui?.parent_recid);
      const isSummary = !!(rec?.w2ui?.summary);
      if (isChild || isSummary) return '';

      const field = col.field;
      const val = field ? rec[field] : '';
      if (!yesMatcher(val)) return '';
      void originalRender;
      return `<button class="w2ui-btn btn-promote" data-recid="${rec.recid}" title="Promote this row">promote</button>`;
    };

    try { grid.refresh(); } catch {}
  }

  // New promote behavior
  async _handlePromoteClick(grid, recid) {
    const rec = grid.get(recid);
    if (!rec) return;

    const fields = grid.columns.map(c => c.field);

    // 1) Get flow name from the promoted record
    const flowName = this._getFlowFromRecord(grid, rec);
    if (!flowName) {
      console.warn('Promote: could not find flow column for this record');
      this._toast(grid.box, 'No flow found for this row');
      return;
    }

    // 2) Load projectTasks.json via /api/tasks
    let allTasks = [];
    try {
      const rsp = await fetch('/api/tasks');
      if (rsp.ok) {
        const json = await rsp.json();
        if (Array.isArray(json)) allTasks = json;
      }
    } catch (e) {
      console.error('Promote: failed to load /api/tasks', e);
      this._toast(grid.box, 'Failed to read tasks');
      return;
    }

    const flowKey = String(flowName).trim();
    const msPerDay = 24 * 60 * 60 * 1000;
    const today = new Date();
    today.setHours(0, 0, 0, 0);

    const updatedTasks = [];
    let completedCount = 0;
    let incompleteCount = 0;
    let dueSoonNotCompletedCount = 0;

    for (const rawTask of allTasks) {
      const t = { ...rawTask };

      if (String(t.flow || '').trim() === flowKey) {
        const status = this._computeTaskStatusFromRecord(t, rec, grid.columns);
        t.status = status;

        if (status === 'complete') {
          completedCount++;
        } else {
          incompleteCount++;
          if (t.end) {
            const endDate = new Date(t.end);
            endDate.setHours(0, 0, 0, 0);
            const diffDays = Math.round((endDate - today) / msPerDay);
            if (diffDays >= 0 && diffDays <= 7) {
              dueSoonNotCompletedCount++;
            }
          }
        }
      }

      updatedTasks.push(t);
    }

    // Write updated tasks back to projectTasks.json
    try {
      const putRsp = await fetch('/api/tasks', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(updatedTasks)
      });
      if (!putRsp.ok) {
        console.error('Promote: PUT /api/tasks failed with', putRsp.status);
        this._toast(grid.box, 'Failed to update tasks');
      }
    } catch (e) {
      console.error('Promote: PUT /api/tasks error', e);
      this._toast(grid.box, 'Failed to update tasks');
    }

    // 3) Build promote payload with counters and original promoteData fields

    const getVal = (idx) => rec[fields[idx]];
    const keyParts = this.promoteCheck.map(getVal).map(v => String(v ?? '').trim());
    const key = (keyParts.length <= 1) ? (keyParts[0] ?? '') : keyParts.join('_');

    const bodyObj = {
      completedTasks: completedCount,
      incompleteTasks: incompleteCount,
      dueWithinOneWeekIncompleteTasks: dueSoonNotCompletedCount
    };

    // Existing promoteData into payload
    for (const idx of this.promoteData) {
      const header = grid.columns[idx]?.text || grid.columns[idx]?.caption || fields[idx] || `c${idx}`;
      bodyObj[header] = rec[fields[idx]];
    }

    // Existing file pattern resolution
    this.promoteDataFiles.forEach((pattern, i) => {
      const resolved = this._resolvePromotePattern(String(pattern ?? ''), rec, fields);
      bodyObj[`f${i + 1}`] = resolved;
    });

    // updatedAt comes last
    bodyObj.updatedAt = new Date().toISOString();

    const payload = { [key]: bodyObj };

    try {
      const rsp = await fetch('/api/promote', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });
      if (!rsp.ok) throw new Error(`HTTP ${rsp.status}`);
      this._toast(grid.box, 'Promoted');
    } catch (e) {
      console.error('Promote failed:', e);
      this._toast(grid.box, 'Promote failed');
    }
  }

  // Helper to get flow from record
  _getFlowFromRecord(grid, rec) {
    if (!grid || !rec) return null;
    const cols = grid.columns || [];

    // Try by field or header text matching "flow"
    let flowField = null;
    for (const c of cols) {
      const field = String(c.field || '').trim().toLowerCase();
      const text = String(c.text || c.caption || '').trim().toLowerCase();
      if (field === 'flow' || text === 'flow') {
        flowField = c.field;
        break;
      }
    }

    // Fallback: use first promoteCheck col as flow
    if (!flowField && Array.isArray(this.promoteCheck) && this.promoteCheck.length) {
      const idx = this.promoteCheck[0];
      const fieldName = cols[idx]?.field;
      if (fieldName) flowField = fieldName;
    }

    if (!flowField) return null;
    return rec[flowField];
  }

  // Compute status for one task based on its criteria and promoted record
  _computeTaskStatusFromRecord(task, rec, columns) {
    const criteria = Array.isArray(task.criteria) ? task.criteria : [];
    if (!criteria.length) return 'incomplete'; // or 'complete' if you prefer

    for (const crit of criteria) {
      if (!this._evaluateCriterionOnRecord(crit, rec, columns)) {
        return 'incomplete';
      }
    }
    return 'complete';
  }

  _evaluateCriterionOnRecord(crit, rec, columns) {
    if (!crit) return false;
    const colName = String(crit.taskCriteriaName || '').trim();
    if (!colName) return false;

    const datatype = String(crit.taskCriteriaDatatype || '').trim().toLowerCase();
    const op = String(crit.operator || '').trim();

    const cols = columns || [];
    let fieldName = null;

    // Match by header text or field
    for (const c of cols) {
      const header = String(c.text || c.caption || c.field || '').trim().toLowerCase();
      if (header === colName.toLowerCase()) {
        fieldName = c.field;
        break;
      }
    }

    if (!fieldName) {
      return false;
    }

    const recordVal = rec[fieldName];
    const expectedVal = crit.value;

    return this._compareValues(recordVal, expectedVal, op, datatype);
  }

  _compareValues(leftRaw, rightRaw, op, datatype) {
    const normBool = (v) => {
      const s = String(v ?? '').trim().toLowerCase();
      if (!s) return null;
      if (['true', '1', 'y', 'yes'].includes(s)) return true;
      if (['false', '0', 'n', 'no'].includes(s)) return false;
      return null;
    };

    let left = leftRaw;
    let right = rightRaw;

    if (datatype === 'number') {
      const ln = Number(leftRaw);
      const rn = Number(rightRaw);
      if (Number.isNaN(ln) || Number.isNaN(rn)) return false;
      left = ln;
      right = rn;
    } else if (datatype === 'boolean') {
      const lb = normBool(leftRaw);
      const rb = normBool(rightRaw);
      if (lb == null || rb == null) return false;
      left = lb;
      right = rb;
    } else {
      left = String(leftRaw ?? '');
      right = String(rightRaw ?? '');
    }

    switch (op) {
      case '<':  return left <  right;
      case '<=': return left <= right;
      case '>':  return left >  right;
      case '>=': return left >= right;
      case '==': return left === right;
      case '!=': return left !== right;
      default:
        return left === right;
    }
  }

  /* ======================= RULED SEQUENCE NAV ======================= */
  async _openSequence({ rules, startRules, contexts, title, triggerCol, selectionValue }) {
    await this._ensurePopup(title, this._crumbsFor({ step: 0, rules, rulesUsed: startRules, contexts }));
    await this._renderStep({ step: 0, rules, rulesUsed: startRules, contexts, title, triggerCol, selectionValue }, false);
    this._stack = [{ step: 0, rules, rulesUsed: startRules, contexts, title, triggerCol, selectionValue }];
    this._idx = 0;
    this._updateNavButtons();
  }

  async _advance({ current, rowCtx, clickColIndex, clickRowIndex, clickedCellValue }) {
    const nextStep = current.step + 1;
    const nextLevel = nextStep + 1;
    const nextRules = current.rules;

    const rulesNext = this._pickRules({
      rules: nextRules,
      level: nextLevel,
      clickRowIndex,
      clickColIndex
    });

    if (!rulesNext.length) return;

    const nextContexts = [...current.contexts, rowCtx];
    const nextState = {
      step: nextStep,
      rules: nextRules,
      rulesUsed: rulesNext,
      contexts: nextContexts,
      title: current.title,
      triggerCol: current.triggerCol,
      selectionValue: clickedCellValue
    };

    await this._renderStep(nextState, true);
    this._stack = this._stack.slice(0, this._idx + 1);
    this._stack.push(nextState);
    this._idx = this._stack.length - 1;
    this._updateNavButtons();
  }

  async _go(delta) {
    const ni = this._idx + delta;
    if (ni < 0 || ni >= this._stack.length) return;
    this._idx = ni;
    const st = this._stack[this._idx];
    await this._ensurePopup(st.title, this._crumbsFor(st));
    await this._renderStep(st, false, false);
    this._updateNavButtons();
  }

  /* ======================= RENDER ONE STEP WITH MULTIPLE RULES ======================= */
  async _renderStep(state, replaceForward = false, noWire = false) {
    const { step, rulesUsed, contexts } = state;
    if (!Array.isArray(rulesUsed) || !rulesUsed.length) return;

    this._replaceBody(`<div id="dd-body-inner" style="height:100%;overflow:auto;"></div>`);
    const host = document.getElementById('dd-body-inner');
    if (!host) return;

    this._destroyDDGrids();

    const containers = [];
    rulesUsed.forEach((rule, idx) => {
      const rid = `dd-view-${step}-${idx}`;
      const header = `
        <div class="dd-view-header" style="padding:6px 8px;border-bottom:1px solid #e5e7eb;background:#fafafa;">
          <span style="font-weight:600;">Level ${step + 1} • ${this._esc(String(rule.filetype || '').toUpperCase())}</span>
          <span style="opacity:.7;margin-left:8px;">${this._esc(this._basename(this._resolvePattern(rule.fileformat, contexts)))}</span>
        </div>`;
      const body = `<div id="${rid}" class="dd-view-body" style="min-height:220px;"></div>`;
      const card = document.createElement('div');
      card.className = 'dd-view';
      card.style.border = '1px solid #e5e7eb';
      card.style.borderRadius = '8px';
      card.style.margin = '8px';
      card.style.overflow = 'hidden';
      card.innerHTML = header + body;
      host.appendChild(card);
      containers.push({ rule, rid, idx });
    });

    for (const { rule, rid, idx } of containers) {
      await this._renderOneViewer({
        state,
        rule,
        containerId: rid,
        viewerIndex: idx,
        noWire
      });
    }

    const firstUrl = this._resolvePattern(rulesUsed[0].fileformat, contexts);
    this._setCrumbs(this._crumbsFor(state, firstUrl));

    w2popup.on?.('resize', () => {
      Object.keys(w2ui).forEach(k => {
        if (k.startsWith('ddGrid_')) {
          const g = w2ui[k];
          try { g?.resize(); } catch {}
        }
      });
    });
  }

  async _renderOneViewer({ state, rule, containerId, viewerIndex, noWire }) {
    const { step, contexts, selectionValue } = state;
    const url = this._resolvePattern(rule.fileformat, contexts);
    const container = document.getElementById(containerId);
    if (!container) return;

    const type = String(rule.filetype || '').toLowerCase();

    if (type === 'shell') {
      const filename = String(selectionValue ?? '').trim() || url;
      await this._runShellWithFile(filename, rule.commands);
      container.innerHTML = `<div style="padding:12px;">Shell command sent for <code>${this._esc(filename)}</code></div>`;
      return;
    }

    if (!(await this._exists(url))) {
      container.innerHTML = `<div style="padding:12px;color:#b91c1c;">File not found: ${this._esc(url)}</div>`;
      return;
    }

    const ext = this._extFromUrl(url);

    if (['csv','tsv'].includes(ext) || type === 'csv') {
      const gname = `ddGrid_${step}_${viewerIndex}`;
      container.innerHTML = `<div id="${gname}_box" style="height:520px;"></div>`;
      await this._raf2();

      if (w2ui[gname]) try { w2ui[gname].destroy(); } catch {}
      const tb = new TableBuilder({ dataCsv: url, box: `#${gname}_box`, name: gname });
      await tb.build();
      try { w2ui[gname]?.resize(); } catch {}

      this._enableRightClickCopy(gname);

      const dd = w2ui[gname];
      this._ensureToolbar(dd);
      const presets = this._searchPresetsFor(state);
      this._installToolbarPreset(dd, presets, `${gname}-preset`);
      this._applyPresetList(dd, presets, true);

      if (!noWire) {
        dd.on('click', async (ev) => {
          const recid = ev.detail?.recid ?? ev.recid;
          const colIndex = ev.detail?.column ?? ev.column;
          const rec = dd.get(recid);
          if (!rec) return;

          const fields = dd.columns.map(c => c.field);
          const rowCtx = this._valuesFromRecord(rec, fields);
          const rowIndex = this._rowIndexOf(dd, recid);
          const clickedCellValue = rec[fields[colIndex]];

          await this._advance({
            current: state,
            rowCtx,
            clickColIndex: colIndex,
            clickRowIndex: rowIndex,
            clickedCellValue
          });
        });
      }
      return;
    }

    if (['html','htm','pdf'].includes(ext) || type === 'html') {
      container.innerHTML = `
        <div style="height:100%;display:flex;flex-direction:column;">
          <div style="flex:1 1 auto;min-height:420px;">
            <iframe src="${this._esc(url)}" title="preview" style="border:0;width:100%;height:100%;"></iframe>
          </div>
        </div>`;
      return;
    }

    if (['png','jpg','jpeg','gif','bmp','webp','svg'].includes(ext) || ['png','jpg','jpeg','gif','bmp','webp','svg'].includes(type)) {
      container.innerHTML = `
        <div style="height:100%;display:flex;align-items:center;justify-content:center;padding:8px;overflow:auto;">
          <img src="${this._esc(url)}" alt="image" style="max-width:100%;max-height:100%;object-fit:contain;">
        </div>`;
      return;
    }

    if (['mp4','webm','ogg'].includes(ext) || ['mp4','webm','ogg'].includes(type)) {
      container.innerHTML = `
        <div style="height:100%;display:flex;align-items:center;justify-content:center;padding:8px;">
          <video src="${this._esc(url)}" controls style="max-width:100%;max-height:100%;"></video>
        </div>`;
      return;
    }

    if (['mp3','wav','flac','m4a','aac','oga'].includes(ext) || ['mp3','wav','flac','m4a','aac','oga'].includes(type)) {
      container.innerHTML = `
        <div style="height:100%;display:flex;align-items:center;justify-content:center;padding:8px;">
          <audio src="${this._esc(url)}" controls></audio>
        </div>`;
      return;
    }

    container.innerHTML = `
      <div style="padding:12px;display:flex;gap:12px;align-items:center;flex-wrap:wrap;">
        <a href="${this._esc(url)}" target="_blank" class="w2ui-btn">Open file</a>
        <div style="flex:1 1 100%;">
          <iframe src="${this._esc(url)}" title="preview" style="border:0;width:100%;height:60vh;"></iframe>
        </div>
      </div>`;
  }

  /* ======================= RULE PICKING AND RANGES ======================= */
  _pickRules({ rules, level, clickRowIndex, clickColIndex }) {
    if (!Array.isArray(rules)) return [];
    const sameLevel = rules.filter(r => Number(r?.level) === Number(level));
    if (!sameLevel.length) return [];

    const cache = new Map();
    const parse = (spec) => {
      const key = String(spec ?? '');
      if (!cache.has(key)) cache.set(key, this._parseRange(key));
      return cache.get(key);
    };

    const out = [];
    for (const r of sameLevel) {
      const ev = String(r.event || '').toLowerCase();
      const rangeSpec = String(r.range || '').trim();
      const pr = parse(rangeSpec);

      if (ev === 'row') {
        if (!Number.isInteger(clickRowIndex) || clickRowIndex < 0) continue;
        if (pr.all || pr.set.has(clickRowIndex)) out.push(r);
      } else if (ev === 'col') {
        if (!Number.isInteger(clickColIndex) || clickColIndex < 0) continue;
        if (pr.all || pr.set.has(clickColIndex)) out.push(r);
      } else {
        continue;
      }
    }

    return out;
  }

  _parseRange(spec) {
    const out = { all: false, set: new Set() };
    const s = String(spec || '').trim();
    if (!s) { out.all = true; return out; }
    for (const partRaw of s.split(',')) {
      const part = partRaw.trim();
      if (!part) continue;
      const m = part.match(/^(\d+)\s*-\s*(\d+)$/);
      if (m) {
        const a = Number(m[1]), b = Number(m[2]);
        const lo = Math.min(a, b), hi = Math.max(a, b);
        for (let i = lo; i <= hi; i++) out.set.add(i);
      } else {
        const n = Number(part);
        if (!Number.isNaN(n)) out.set.add(n);
      }
    }
    return out;
  }

  /* ======================= TOKEN RESOLUTION ======================= */
  _resolvePattern(pattern, contexts) {
    const mapLetterToIndex = (ch) => ch.toLowerCase().charCodeAt(0) - 97;
    const safePart = (s) =>
      String(s ?? '').replace(/[^\w\-./]+/g, '_').replace(/^_+|_+$/g, '');
    return String(pattern ?? '').replace(/([a-zA-Z])(\d+)/g, (_, letter, idxStr) => {
      const ctxIndex = mapLetterToIndex(letter);
      const row = contexts[ctxIndex] || [];
      return safePart(row[Number(idxStr)]);
    });
  }

  /* ======================= POPUP SHELL + CRUMBS ======================= */
  async _ensurePopup(title, crumbs) {
    const shell = `
      <div id="dd-wrap" style="padding:8px; display:flex; flex-direction:column; gap:8px; height:100%; box-sizing:border-box;">
        <div id="dd-bar" style="display:flex; align-items:center; gap:8px; flex:0 0 auto;">
          <button id="dd-back" class="w2ui-btn">◀ Back</button>
          <button id="dd-fwd"  class="w2ui-btn">Forward ▶</button>
          <div id="dd-crumbs" style="margin-left:8px; flex:1;"></div>
        </div>
        <div id="dd-body" style="flex:1 1 auto; min-height:400px; overflow:hidden;"></div>
      </div>`;
    if (!this._openOnce) {
      await new Promise(resolve => {
        w2popup.open({
          title, body: shell, modal: true, showMax: true, width: 980, height: 640,
          onOpen(evt){ evt.onComplete = resolve; }
        });
      });
      document.getElementById('dd-back')?.addEventListener('click', () => this._go(-1));
      document.getElementById('dd-fwd') ?.addEventListener('click', () => this._go(+1));
      this._openOnce = true;
      w2popup.on?.('resize', () => {
        Object.keys(w2ui).forEach(k => {
          if (k.startsWith('ddGrid_')) {
            const g = w2ui[k];
            try { g?.resize(); } catch {}
          }
        });
      });
    } else {
      w2popup.title?.(title);
    }
    this._setCrumbs(crumbs);
  }

  _crumbsFor(state, url = '') {
    const parts = [];
    parts.push({ label: 'Main', go: () => this._closePopup() });
    if (state?.step >= 0) {
      const ctx0 = state.contexts?.[0] ?? [];
      const compact = this._safeJoin([ctx0[0], ctx0[1], ctx0[2]].filter(Boolean)).slice(0, 48);
      if (compact) parts.push({ label: compact, go: () => this._popBackToStep(0) });
      if (url) parts.push({ label: this._basename(url) });
    }
    return parts;
  }

  async _popBackToStep(step) {
    for (let i = this._idx; i >= 0; i--) {
      if (this._stack[i].step === step) {
        this._idx = i;
        const st = this._stack[i];
        await this._ensurePopup(st.title, this._crumbsFor(st));
        await this._renderStep(st, false, false);
        this._updateNavButtons();
        return;
      }
    }
  }

  setCrumbs(...args) { return this._setCrumbs(...args); }
  _setCrumbs(items = []) {
    const host = document.getElementById('dd-crumbs');
    if (!host) return;
    host.innerHTML = '';

    items.forEach((it, idx) => {
      const isLink = typeof it.go === 'function';
      const node = document.createElement(isLink ? 'a' : 'span');
      node.textContent = String(it.label ?? '');
      node.style.marginRight = '6px';
      if (isLink) {
        node.href = 'javascript:void(0)';
        node.style.textDecoration = 'underline';
        node.addEventListener('click', (e) => { e.preventDefault(); it.go(); });
      } else {
        node.style.opacity = 0.85;
      }
      host.appendChild(node);

      if (idx < items.length - 1) {
        const sep = document.createElement('span');
        sep.textContent = '›';
        sep.style.margin = '0 6px';
        sep.style.opacity = 0.6;
        host.appendChild(sep);
      }
    });
  }

  /* ======================= Toolbar Presets ======================= */
  _ensureToolbar(grid) {
    if (!grid) return;
    grid.show = grid.show || {};
    grid.show.toolbar = true;
    try { grid.refresh?.(); } catch {}
  }

  _installToolbarPreset(grid, presets, selectId) {
    if (!grid || !grid.toolbar) return;
    if (grid._mdPresetToolbarAdded) return;

    try {
      grid.toolbar.add([
        { type: 'break', id: 'mdspacer' },
        {
          type: 'html',
          id: 'mdpreset',
          html: () => {
            const opts = Array.isArray(presets) ? presets : [];
            const options = opts.map((p, i) =>
              `<option value="${i}">${this._esc(p.text ?? `Preset ${i + 1}`)}</option>`
            ).join('');
            return `
              <div style="padding:4px 8px;">
                <label style="font-size:12px;margin-right:6px;">Preset:</label>
                <select id="${selectId}" class="w2ui-input" style="max-width:260px;">${options || '<option>No presets</option>'}</select>
              </div>
            `;
          }
        }
      ]);

      const bind = () => {
        const sel = document.getElementById(selectId);
        if (!sel) return;
        sel.onchange = () => {
          const idx = Number(sel.value);
          const preset = (Array.isArray(presets) && presets[idx]) || null;
          this._applyPreset(grid, preset);
        };
      };

      requestAnimationFrame(() => bind());
      grid.on('refresh', () => { requestAnimationFrame(() => bind()); });

      grid._mdPresetToolbarAdded = true;
    } catch (e) {
      console.warn('Failed to add preset control to toolbar:', e);
    }
  }

  _searchPresetsFor(state) {
    const colIdx = state?.triggerCol;
    const step   = state?.step ?? 0;
    const arr = this.defaultSearches?.byCol?.[colIdx]?.[step];
    return Array.isArray(arr) ? arr : [];
  }

  _applyPresetList(grid, presets, autoApplyFirst = true) {
    if (!grid) return;
    if (Array.isArray(presets) && presets.length && autoApplyFirst) {
      this._applyPreset(grid, presets[0]);
      const sel = document.getElementById(`${grid.name}-preset`) || document.getElementById('ddGrid-preset');
      if (sel) sel.selectedIndex = 0;
    }
  }

  _applyPreset(grid, preset) {
    if (!grid || !preset || !Array.isArray(preset.data)) return;
    const norm = [];
    for (const d of preset.data) {
      const field = d.field;
      if (!field) continue;
      const operator = d.operator || 'contains';

      if (operator === 'between' && (Array.isArray(d.value) || d.value2 !== undefined)) {
        const v1 = Array.isArray(d.value) ? d.value[0] : d.value;
        const v2 = Array.isArray(d.value) ? d.value[1] : d.value2;
        norm.push({ field, operator: 'between', value: v1, value2: v2 });
      } else if ((operator === 'in' || operator === 'not in') && Array.isArray(d.value)) {
        norm.push({ field, operator, value: d.value });
      } else {
        norm.push({ field, operator, value: d.value });
      }
    }
    const logic = (preset.logic || 'AND').toUpperCase();

    try {
      if (typeof grid.search === 'function' && grid.search.length >= 2) {
        grid.search(norm, logic);
      } else if (typeof grid.search === 'function') {
        grid.search(norm);
        if (grid.last) grid.last.logic = logic;
        grid.refresh?.();
      } else {
        grid.searchData = norm;
        if (grid.last) grid.last.logic = logic;
        grid.refresh?.();
      }
    } catch (e) {
      console.warn('Apply preset failed:', e);
    }
  }

  /* ======================= Right click copy ======================= */
  _enableRightClickCopy(gridName) {
    const grid = w2ui[gridName];
    if (!grid || !grid.box) return;
    if (grid._rc_copy_bound) return;
    grid._rc_copy_bound = true;

    grid.box.addEventListener('contextmenu', async (e) => {
      const td = e.target.closest('td.w2ui-grid-data');
      if (!td) return;
      e.preventDefault();

      const col = Number(td.getAttribute('col'));
      if (Number.isNaN(col)) return;

      const tr = td.parentElement;
      let recid = tr?.getAttribute('recid');
      if (!recid && tr?.id) {
        const m = tr.id.match(/_rec_(.*)$/);
        if (m) recid = m[1];
      }
      if (recid == null) return;

      const grid2 = w2ui[gridName];
      const rec = grid2.get(recid);
      if (!rec) return;

      const field = grid2.columns[col]?.field;
      const value = (field != null) ? rec[field] : '';
      const text = String(value ?? '');

      try {
        await navigator.clipboard.writeText(text);
        this._toast(grid2.box, 'Copied');
      } catch {
        const sel = window.getSelection();
        const range = document.createRange();
        range.selectNodeContents(td);
        sel.removeAllRanges();
        sel.addRange(range);
        try { document.execCommand('copy'); this._toast(grid2.box, 'Copied'); }
        catch { this._toast(grid2.box, 'Copy failed'); }
        sel.removeAllRanges();
      }
    }, { passive: false });
  }

  _toast(containerEl, msg = 'Copied') {
    const host = document.createElement('div');
    host.textContent = msg;
    Object.assign(host.style, {
      position: 'absolute',
      right: '12px',
      bottom: '12px',
      padding: '6px 10px',
      background: 'rgba(0,0,0,0.7)',
      color: '#fff',
      borderRadius: '6px',
      fontSize: '12px',
      zIndex: 99999,
      pointerEvents: 'none',
      transition: 'opacity .2s',
      opacity: '0'
    });
    const parent = containerEl.closest('.w2ui-grid') || containerEl;
    const prevPos = parent.style.position;
    if (!prevPos) parent.style.position = 'relative';
    parent.appendChild(host);
    requestAnimationFrame(() => { host.style.opacity = '1'; });
    setTimeout(() => {
      host.style.opacity = '0';
      setTimeout(() => {
        try { parent.removeChild(host); } catch {}
        if (!prevPos) parent.style.position = '';
      }, 200);
    }, 900);
  }

  /* ======================= Utils ======================= */
  _replaceBody(html) {
    const body = document.getElementById('dd-body');
    if (!body) return;
    body.innerHTML = html;
  }

  _closePopup() {
    try { w2popup.close(); } catch {}
    this._openOnce = false;
    this._stack = [];
    this._idx = -1;
    this._destroyDDGrids();
  }

  _destroyDDGrids() {
    Object.keys(w2ui).forEach(k => {
      if (k.startsWith('ddGrid_')) {
        try { w2ui[k].destroy(); } catch {}
      }
    });
  }

  _updateNavButtons() {
    const back = document.getElementById('dd-back');
    const fwd  = document.getElementById('dd-fwd');
    if (back) back.disabled = !(this._idx > 0);
    if (fwd)  fwd.disabled  = !(this._idx >= 0 && this._idx < this._stack.length - 1);
  }

  _valuesFromRecord(rec, fields) { return fields.map(f => rec[f]); }
  async _raf2(){ await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r))); }

  async _exists(url) {
    try {
      const g = await fetch(url, { method:'GET' });
      return g.ok;
    } catch { return false; }
  }

  _missing(url) { w2alert(`File not found:\n${url}`); }
  _basename(p){ return (p.split('/').pop() || p); }
  _esc(s){ return String(s ?? '').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])); }
  _safeJoin(arr){ return arr.map(v => String(v ?? '').replace(/[^\w\-]+/g,'_')).join(this.sep); }
  _extFromUrl(u){ const m = String(u||'').toLowerCase().match(/\.([a-z0-9]+)(?:\?|#|$)/); return m ? m[1] : ''; }

  _rowIndexOf(grid, recid) {
    const recs = grid.records || [];
    for (let i = 0; i < recs.length; i++) {
      if (String(recs[i].recid) === String(recid)) return i;
    }
    return -1;
  }

  /* ======================= Shell runner ======================= */
  async _runShellWithFile(filename, commands) {
    const cmds = Array.isArray(commands) && commands.length
      ? commands.slice()
      : [
          'pkill -f "ttyd" || true',
          'ttyd -p 7681 gvim {filename}'
        ];
    const filled = cmds.map(c => String(c).replaceAll('{filename}', filename));
    try {
      const rsp = await fetch('/api/shell', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ commands: filled })
      });
      if (!rsp.ok) throw new Error(`HTTP ${rsp.status}`);
    } catch (e) {
      console.error('Shell run failed:', e);
      w2alert('Shell command failed. See console for details.');
    }
  }

  log(...a){ if(this.debug) console.log('[MultiDrilldown]', ...a); }
  warn(...a){ console.warn('[MultiDrilldown]', ...a); }
}
