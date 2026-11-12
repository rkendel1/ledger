// Charts as view trees (docs/charts.md). Native SVG, no dependencies: every
// renderer (dom.js, html.js, the React binding, the classic build) draws the
// same structure, so a chart looks and behaves the same in every product.
//
// Charts present numbers a product has already computed. They never compute
// authoritative values: they position marks, sum stacks to place them, and
// format text. Inputs are validated and never mutated.
//
// Interaction needs no script: each category (or slice) is a focusable mark
// whose tooltip CSS shows on hover and keyboard focus. Every chart also carries
// its data as a table, so nothing is conveyed only by colour or by pointer.
//
// Names in this file are prefixed (ch*) because the classic build places every
// core source in one scope (scripts/build.mjs).

import { EmptyState, ErrorPanel, Loading } from './view.js';

const chNode = (t, a, c, k) => ({ t, a: a || {}, c: c === undefined ? [] : [].concat(c), ...(k === undefined || k === null ? {} : { k: String(k) }) });
const chCx = (...names) => names.filter(Boolean).join(' ');
const chPresent = (value) => value !== null && value !== undefined && value !== '';
const chPassthrough = (attrs) => {
  const out = {};
  for (const [key, value] of Object.entries(attrs || {})) {
    if (/^(data-|aria-)/.test(key) || key === 'id' || key === 'title') out[key] = value;
  }
  return out;
};
/// Coordinates with two decimals: identical text in every renderer.
const chR = (value) => Math.round(value * 100) / 100;

/// Number of series colours in the palette (--stack-color-chart-1 … -8).
export const CHART_PALETTE_SIZE = 8;
const CH_FONT = 12;
const CH_CHAR = 0.6;
const CH_DEFAULT_WIDTH = 640;
const CH_MAX_FOCUSABLE = 60;
const CH_MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/// Estimated width of a label at the chart font size. Deterministic: layout must
/// not depend on font metrics that differ between renderers and machines.
const chTextWidth = (text, size = CH_FONT) => String(text).length * size * CH_CHAR;
const chFit = (text, width, size = CH_FONT) => {
  const s = String(text);
  if (chTextWidth(s, size) <= width) return s;
  const keep = Math.max(1, Math.floor(width / (size * CH_CHAR)) - 1);
  return `${s.slice(0, keep)}…`;
};

// ---- Formatting ---------------------------------------------------------------

const CH_CURRENCY = { USD: '$', EUR: '€', GBP: '£', JPY: '¥', CAD: 'CA$', AUD: 'A$', NZD: 'NZ$', CHF: 'CHF ', INR: '₹', CNY: 'CN¥', MXN: 'MX$', BRL: 'R$' };
const CH_ZERO_DECIMAL = new Set(['JPY']);
const CH_COMPACT = [[1e12, 'T'], [1e9, 'B'], [1e6, 'M'], [1e3, 'K']];

/// en-US digits for a non-negative number: comma groups, rounded half away from
/// zero to `max` decimals, trailing zeros trimmed down to `min`.
function chDigits(abs, min, max) {
  const factor = 10 ** max;
  const scaled = Math.round(abs * factor + abs * factor * Number.EPSILON);
  const whole = Math.floor(scaled / factor);
  let frac = max ? String(scaled - whole * factor).padStart(max, '0') : '';
  while (frac.length > min && frac.endsWith('0')) frac = frac.slice(0, -1);
  const grouped = String(whole).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return frac ? `${grouped}.${frac}` : grouped;
}

/// Text for a value: a function, or { style: 'number'|'currency'|'percent',
/// currency, divisor, minimumFractionDigits, maximumFractionDigits, compact,
/// suffix }. Written in en-US without Intl, so the text (and the layout that
/// depends on it) is identical in every renderer, browser and Node version.
/// `divisor` changes only the presentation (minor units to major units);
/// percent expects fractions (0.25 → 25%). Missing values are "—".
export function formatChartValue(value, format) {
  if (value === null || value === undefined) return '—';
  if (typeof format === 'function') return String(format(value));
  const f = format || {};
  const style = f.style === 'currency' || f.style === 'percent' ? f.style : 'number';
  let shown = f.divisor ? value / f.divisor : value;
  if (style === 'percent') shown *= 100;
  const negative = shown < 0;
  let abs = Math.abs(shown);
  const code = f.currency || 'USD';
  const base = style === 'currency' ? (CH_ZERO_DECIMAL.has(code) ? 0 : 2) : style === 'percent' ? 1 : 2;
  let max = f.maximumFractionDigits !== undefined ? f.maximumFractionDigits : base;
  let min = f.minimumFractionDigits !== undefined ? f.minimumFractionDigits : (style === 'currency' ? Math.min(base, max) : 0);
  let unit = '';
  if (f.compact) {
    max = f.maximumFractionDigits !== undefined ? f.maximumFractionDigits : 1;
    min = 0;
    // The largest unit the value still shows at least 1 of once rounded (999.95 → 1K).
    const factor = 10 ** max;
    const step = CH_COMPACT.find(([size]) => Math.round((abs / size) * factor) >= factor);
    if (step) { abs /= step[0]; unit = step[1]; }
  }
  if (max < min) max = min;
  let digits = chDigits(abs, min, max);
  if (digits.replace(/[0.,]/g, '') === '') digits = chDigits(0, min, max);
  const zero = digits.replace(/[0.,]/g, '') === '';
  const sign = negative && !zero ? '-' : '';
  const symbol = style === 'currency' ? (CH_CURRENCY[code] || `${code} `) : '';
  return `${sign}${symbol}${digits}${unit}${style === 'percent' ? '%' : ''}${f.suffix || ''}`;
}

const chIsoDay = (ms) => new Date(ms).toISOString().slice(0, 10);
/// Time labels in UTC: "Jan 2026" when every point is the first of a month, else "2026-01-15".
const chTimeFormatter = (values) => {
  const monthly = values.every((ms) => { const d = new Date(ms); return d.getUTCDate() === 1 && d.getUTCHours() === 0; });
  return monthly ? (ms) => { const d = new Date(ms); return `${CH_MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}`; } : chIsoDay;
};

// ---- Validation and normalization ---------------------------------------------

const chFail = (kind, message) => { throw new TypeError(`${kind}: ${message}`); };

function chToTime(kind, x) {
  const ms = typeof x === 'number' ? x : Date.parse(x);
  if (!Number.isFinite(ms)) chFail(kind, `x value ${JSON.stringify(x)} is not a time (use epoch milliseconds or an ISO date)`);
  return ms;
}

/// Checks the series contract and builds the chart's table: ordered x keys and
/// one value per series per key (null where a series has no value). Throws a
/// TypeError naming the problem for input a chart cannot represent faithfully.
export function normalizeSeries(kind, series, xType = 'category') {
  if (!Array.isArray(series)) chFail(kind, 'series must be an array');
  if (!['category', 'time', 'number'].includes(xType)) chFail(kind, `xType must be "category", "time" or "number", not ${JSON.stringify(xType)}`);
  const ids = new Set();
  const keys = [];
  const index = new Map();
  const rows = series.map((s, i) => {
    if (!s || typeof s !== 'object') chFail(kind, `series[${i}] must be an object`);
    if (typeof s.id !== 'string' || !s.id) chFail(kind, `series[${i}] needs a non-empty string id`);
    if (ids.has(s.id)) chFail(kind, `series id "${s.id}" is used twice`);
    ids.add(s.id);
    if (typeof s.label !== 'string' || !s.label) chFail(kind, `series "${s.id}" needs a label`);
    if (!Array.isArray(s.data)) chFail(kind, `series "${s.id}" data must be an array`);
    const seen = new Set();
    const values = new Map();
    s.data.forEach((p, j) => {
      if (!p || typeof p !== 'object') chFail(kind, `series "${s.id}" point ${j} must be an object`);
      const okX = typeof p.x === 'string' || (typeof p.x === 'number' && Number.isFinite(p.x));
      if (!okX) chFail(kind, `series "${s.id}" point ${j} has an invalid x`);
      if (!(p.y === null || (typeof p.y === 'number' && Number.isFinite(p.y)))) {
        chFail(kind, `series "${s.id}" point ${j} y must be a finite number or null, not ${JSON.stringify(p.y)}`);
      }
      let key;
      if (xType === 'time') key = chToTime(kind, p.x);
      else if (xType === 'number') {
        if (typeof p.x !== 'number') chFail(kind, `series "${s.id}" point ${j} x must be a number for xType "number"`);
        key = p.x;
      } else key = String(p.x);
      if (seen.has(key)) chFail(kind, `series "${s.id}" has two points at x ${JSON.stringify(p.x)}`);
      seen.add(key);
      values.set(key, p.y);
      if (!index.has(key)) { index.set(key, keys.length); keys.push(key); }
    });
    const palette = Number.isInteger(s.palette) && s.palette >= 1 && s.palette <= CHART_PALETTE_SIZE ? s.palette : (i % CHART_PALETTE_SIZE) + 1;
    return { id: s.id, label: s.label, hidden: Boolean(s.hidden), palette, dash: i % 4, values };
  });
  if (xType !== 'category') keys.sort((a, b) => a - b);
  return {
    keys,
    series: rows.map((r) => ({ ...r, y: keys.map((k) => (r.values.has(k) ? r.values.get(k) : null)) })),
  };
}

// ---- Scales -------------------------------------------------------------------

/// Round tick values covering [min, max] in steps of 1, 2 or 5 × 10^k.
export function niceTicks(min, max, count = 5) {
  if (!(Number.isFinite(min) && Number.isFinite(max))) return { min: 0, max: 1, ticks: [0, 1] };
  if (min === max) {
    if (min === 0) return { min: 0, max: 1, ticks: [0, 0.5, 1] };
    const pad = Math.abs(min) * 0.5;
    return niceTicks(Math.min(0, min - pad), Math.max(0, max + pad), count);
  }
  const span = max - min;
  const raw = span / Math.max(1, count);
  const magnitude = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * magnitude).find((s) => span / s <= count) || 10 * magnitude;
  const lo = Math.floor(min / step) * step;
  const hi = Math.ceil(max / step) * step;
  const ticks = [];
  for (let v = lo; v <= hi + step / 2; v += step) ticks.push(Math.abs(v) < step / 1e6 ? 0 : Number(v.toPrecision(12)));
  return { min: lo, max: hi, ticks };
}

const chLinear = (d0, d1, r0, r1) => (v) => (d1 === d0 ? (r0 + r1) / 2 : r0 + ((v - d0) / (d1 - d0)) * (r1 - r0));

// ---- Shared structure ---------------------------------------------------------

const chSize = (props, defaults) => {
  const width = Math.max(120, Math.round(Number(props.width) || CH_DEFAULT_WIDTH));
  const ratio = Number(props.aspectRatio) > 0 ? Number(props.aspectRatio) : defaults.aspectRatio;
  const height = Math.round(Number(props.height) > 0 ? Number(props.height) : Math.min(defaults.maxHeight, Math.max(defaults.minHeight, width / ratio)));
  return { width, height };
};

function chFigure(kind, props, body) {
  const busy = Boolean(props.loading);
  return chNode('figure', {
    class: chCx('stack-chart', `stack-chart--${kind}`, props.className),
    'data-chart': kind,
    'data-chart-state': body.state,
    ...(busy ? { 'aria-busy': 'true' } : {}),
    ...chPassthrough(props.attrs),
  }, [
    chNode('figcaption', { class: 'stack-chart__header' }, [
      props.headingLevel
        ? chNode(`h${Math.min(6, Math.max(1, Number(props.headingLevel) || 3))}`, { class: 'stack-chart__title' }, props.title)
        : chNode('span', { class: 'stack-chart__title' }, props.title),
      chPresent(props.description) ? chNode('span', { class: 'stack-chart__description' }, props.description) : null,
    ]),
    body.content,
  ]);
}

/// The loading, error and empty states every chart shares, or null when ready.
function chState(kind, props, hasData) {
  if (props.error) {
    const e = typeof props.error === 'string' ? { message: props.error } : props.error;
    return { state: 'error', content: chNode('div', { class: 'stack-chart__state' }, ErrorPanel({ title: props.errorTitle || 'Could not show this chart', message: e.message, code: e.code, requestId: e.requestId, onRetry: props.onRetry })) };
  }
  if (props.loading) return { state: 'loading', content: chNode('div', { class: 'stack-chart__state' }, Loading({ what: props.loadingWhat || 'chart data', long: props.loadingLong })) };
  if (!hasData) {
    return { state: 'empty', content: chNode('div', { class: 'stack-chart__state' }, EmptyState({ title: props.emptyTitle || 'No data to show', body: props.emptyBody, headingLevel: (Number(props.headingLevel) || 2) + 1 })) };
  }
  return null;
}

function chLegend(kind, rows, props) {
  const toggle = typeof props.onToggleSeries === 'function' ? props.onToggleSeries : null;
  return chNode('ul', { class: 'stack-chart__legend', 'aria-label': props.legendLabel || 'Series' }, rows.map((r) => {
    const swatch = chNode('span', { class: chCx('stack-chart__swatch', kind === 'line' || kind === 'sparkline' ? 'stack-chart__swatch--line' : null, `stack-chart__s${r.palette}`, `stack-chart__d${r.dash}`), 'aria-hidden': 'true' });
    const content = [swatch, chNode('span', { class: 'stack-chart__legend-label' }, r.label), r.note ? chNode('span', { class: 'stack-chart__legend-note' }, r.note) : null];
    const item = toggle
      ? { ...chNode('button', { type: 'button', class: 'stack-chart__legend-toggle', 'aria-pressed': r.hidden ? 'false' : 'true' }, content), on: { click: () => toggle(r.id) } }
      : content;
    return chNode('li', { class: chCx('stack-chart__legend-item', r.hidden ? 'stack-chart__legend-item--hidden' : null), 'data-series': r.id }, item, r.id);
  }));
}

function chTable(props, columns, rows) {
  const open = props.table === 'visible';
  const head = chNode('thead', {}, chNode('tr', {}, columns.map((c, i) => chNode('th', { scope: 'col', class: i ? 'stack-chart__num' : null }, c, i))));
  const body = chNode('tbody', {}, rows.map((r, i) => chNode('tr', {}, r.map((cell, j) => (j === 0
    ? chNode('th', { scope: 'row' }, cell, j)
    : chNode('td', { class: 'stack-chart__num', ...(cell === '—' ? { 'data-missing': 'true' } : {}) }, cell, j))), i)));
  const table = chNode('div', { class: 'stack-chart__table-wrap' }, chNode('table', { class: 'stack-chart__table' }, [
    chNode('caption', { class: 'stack-visually-hidden' }, props.title), head, body,
  ]));
  if (props.table === 'none') return null;
  return chNode('details', { class: 'stack-chart__data', ...(open ? { open: true } : {}) }, [
    chNode('summary', { class: 'stack-chart__data-summary' }, props.tableLabel || 'Data table'), table,
  ]);
}

/// A tooltip box: a heading row and value rows, kept inside [0, width].
function chTooltip(anchorX, top, width, heading, rows) {
  const lineH = 16;
  const pad = 8;
  const textW = Math.max(chTextWidth(heading), ...rows.map((r) => chTextWidth(r.text) + (r.palette ? 14 : 0)));
  const boxW = Math.min(width - 4, textW + pad * 2);
  const boxH = pad * 2 + lineH * (rows.length + 1) - 4;
  let x = anchorX + 10;
  if (x + boxW > width - 2) x = anchorX - 10 - boxW;
  if (x < 2) x = 2;
  const inner = boxW - pad * 2;
  return chNode('g', { class: 'stack-chart__tip', 'aria-hidden': 'true' }, [
    chNode('rect', { class: 'stack-chart__tip-box', x: chR(x), y: chR(top), width: chR(boxW), height: chR(boxH), rx: 4 }),
    chNode('text', { class: 'stack-chart__tip-title', x: chR(x + pad), y: chR(top + pad + 10) }, chFit(heading, inner)),
    rows.map((r, i) => [
      r.palette ? chNode('rect', { class: chCx('stack-chart__tip-swatch', `stack-chart__s${r.palette}`), x: chR(x + pad), y: chR(top + pad + lineH * (i + 1) + 1), width: 9, height: 9, rx: 2 }, [], `s${i}`) : null,
      chNode('text', { class: 'stack-chart__tip-row', x: chR(x + pad + (r.palette ? 14 : 0)), y: chR(top + pad + lineH * (i + 1) + 10) }, chFit(r.text, inner - (r.palette ? 14 : 0)), `t${i}`),
    ]),
  ]);
}

// ---- Cartesian charts (line, area, bar) ---------------------------------------

function chXLabels(normalized, xType, props) {
  if (typeof props.xFormat === 'function') return normalized.keys.map((k) => String(props.xFormat(k)));
  if (xType === 'time') { const f = chTimeFormatter(normalized.keys); return normalized.keys.map(f); }
  if (xType === 'number') return normalized.keys.map((k) => formatChartValue(k, props.xFormat));
  return normalized.keys.map(String);
}

const chAxisFormat = (props, extent) => props.axisFormat
  || (props.format && typeof props.format === 'object' && Math.max(Math.abs(extent.min), Math.abs(extent.max)) >= 10000 ? { ...props.format, compact: true, minimumFractionDigits: undefined, maximumFractionDigits: undefined } : props.format);

/// Value extent of what is drawn: grouped values, or the positive and negative stacks.
function chExtent(rows, n, stacked, zero) {
  let min = Infinity;
  let max = -Infinity;
  for (let i = 0; i < n; i++) {
    if (stacked) {
      let pos = 0;
      let neg = 0;
      for (const r of rows) { const v = r.y[i]; if (v === null) continue; if (v >= 0) pos += v; else neg += v; }
      max = Math.max(max, pos); min = Math.min(min, neg);
    } else {
      for (const r of rows) { const v = r.y[i]; if (v === null) continue; max = Math.max(max, v); min = Math.min(min, v); }
    }
  }
  if (zero) { min = Math.min(min, 0); max = Math.max(max, 0); }
  return { min, max };
}

/// Lower and upper value of each series at each x when stacked (positives up, negatives down).
function chStack(rows, n) {
  const pos = new Array(n).fill(0);
  const neg = new Array(n).fill(0);
  return rows.map((r) => r.y.map((v, i) => {
    if (v === null) return null;
    if (v >= 0) { const lo = pos[i]; pos[i] += v; return [lo, pos[i]]; }
    const hi = neg[i]; neg[i] += v; return [neg[i], hi];
  }));
}

function cartesian(kind, props) {
  const xType = props.xType || 'category';
  const normalized = normalizeSeries(kindName(kind), props.series, xType);
  const all = normalized.series;
  const rows = all.filter((r) => !r.hidden);
  const n = normalized.keys.length;
  const hasData = rows.some((r) => r.y.some((v) => v !== null));
  const pending = chState(kind, props, hasData);
  const legendRows = all.map((r) => ({ id: r.id, label: r.label, palette: r.palette, dash: r.dash, hidden: r.hidden }));
  const showLegend = props.legend === false ? false : (props.legend === true || all.length > 1);
  if (pending) return chFigure(kind, props, { state: pending.state, content: [showLegend && pending.state === 'empty' ? chLegend(kind, legendRows, props) : null, pending.content] });

  const horizontal = kind === 'bar' && props.orientation === 'horizontal';
  const stacked = Boolean(props.stacked);
  const bars = kind === 'bar';
  // Horizontal bars grow with the number of categories, not the width.
  const rowHeight = stacked ? 30 : Math.max(24, 12 * rows.length + 12);
  const fitted = Math.max(120, n * rowHeight + 48);
  const { width, height } = chSize(props, horizontal
    ? { aspectRatio: 0.01, minHeight: fitted, maxHeight: fitted }
    : { aspectRatio: 2, minHeight: 180, maxHeight: 420 });
  const xLabels = chXLabels(normalized, xType, props);
  const zero = kind !== 'line' || props.zeroBaseline !== false;
  const extent = chExtent(rows, n, stacked, zero);
  const valueSpan = horizontal ? width : height;
  const scaleTicks = niceTicks(extent.min, extent.max, Math.max(2, Math.min(8, Math.floor(valueSpan / (horizontal ? 90 : 48)))));
  const axisFmt = chAxisFormat(props, extent);
  const tickText = scaleTicks.ticks.map((t) => formatChartValue(t, axisFmt));
  const font = CH_FONT;

  // Margins from the labels they hold, so nothing is clipped.
  const yLabelSpace = props.yLabel ? font + 8 : 0;
  const xLabelSpace = props.xLabel ? font + 10 : 0;
  let left;
  let bottom;
  const top = 10;
  let right = 12;
  if (horizontal) {
    const longest = Math.max(...xLabels.map((l) => chTextWidth(l)));
    left = Math.round(Math.min(width * 0.4, longest + 12) + yLabelSpace);
    bottom = font + 12 + xLabelSpace;
    right = Math.round(Math.max(12, chTextWidth(tickText[tickText.length - 1]) / 2 + 4));
  } else {
    left = Math.round(Math.max(...tickText.map((t) => chTextWidth(t))) + 12 + yLabelSpace);
    bottom = font + 14 + xLabelSpace;
    if (!bars && xType !== 'category' && n) right = Math.round(Math.max(12, chTextWidth(xLabels[n - 1]) / 2 + 4));
  }
  const plot = { x0: left, x1: Math.max(left + 20, width - right), y0: top, y1: Math.max(top + 20, height - bottom) };
  const plotW = plot.x1 - plot.x0;
  const plotH = plot.y1 - plot.y0;

  // Scales: value axis and category/position axis.
  const value = horizontal ? chLinear(scaleTicks.min, scaleTicks.max, plot.x0, plot.x1) : chLinear(scaleTicks.min, scaleTicks.max, plot.y1, plot.y0);
  const band = (horizontal ? plotH : plotW) / Math.max(1, n);
  let position;
  if (bars || xType === 'category') {
    position = (i) => (horizontal ? plot.y0 : plot.x0) + band * (i + 0.5);
  } else {
    const lin = chLinear(normalized.keys[0], normalized.keys[n - 1], plot.x0, plot.x1);
    position = (i) => lin(normalized.keys[i]);
  }

  const parts = [];
  // Grid and value axis.
  const grid = props.grid !== false;
  parts.push(chNode('g', { class: 'stack-chart__axis stack-chart__axis--value', 'aria-hidden': 'true' }, scaleTicks.ticks.map((t, i) => {
    const p = chR(value(t));
    return [
      grid ? chNode('line', horizontal
        ? { class: chCx('stack-chart__grid', t === 0 ? 'stack-chart__zero' : null), x1: p, x2: p, y1: plot.y0, y2: plot.y1 }
        : { class: chCx('stack-chart__grid', t === 0 ? 'stack-chart__zero' : null), x1: plot.x0, x2: plot.x1, y1: p, y2: p }, [], `g${i}`) : null,
      chNode('text', horizontal
        ? { class: 'stack-chart__tick stack-chart__tick--middle', x: p, y: chR(plot.y1 + font + 4) }
        : { class: 'stack-chart__tick stack-chart__tick--end', x: chR(plot.x0 - 6), y: chR(p + 4) }, tickText[i], `t${i}`),
    ];
  })));
  // Category / time axis labels: placed left to right (top to bottom) at their real
  // positions, skipping any that would touch the previous one, so labels never overlap
  // even when time points are unevenly spaced. The first label is always placed.
  const labelRoom = horizontal ? left - yLabelSpace - 8 : Math.min(140, Math.max(24, plotW / 2));
  let lastEdge = -Infinity;
  parts.push(chNode('g', { class: 'stack-chart__axis stack-chart__axis--category', 'aria-hidden': 'true' }, xLabels.map((label, i) => {
    const p = chR(position(i));
    const text = chFit(label, labelRoom);
    if (horizontal) {
      if (p - font / 2 < lastEdge + 4) return null;
      lastEdge = p + font / 2;
      return chNode('text', { class: 'stack-chart__tick stack-chart__tick--end', x: chR(plot.x0 - 8), y: chR(p + 4) }, text, i);
    }
    // Edge labels are aligned to the chart's edge instead of spilling past it.
    const w = chTextWidth(text);
    let x0 = p - w / 2;
    let anchor = 'middle';
    let at = p;
    if (x0 < 0) { x0 = 0; anchor = 'start'; at = 0; } else if (x0 + w > width) { x0 = width - w; anchor = 'end'; at = width; }
    if (x0 < lastEdge + 8 || x0 < 0) return null;
    lastEdge = x0 + w;
    return chNode('text', { class: `stack-chart__tick stack-chart__tick--${anchor}`, x: chR(at), y: chR(plot.y1 + font + 6) }, text, i);
  })));
  if (props.yLabel) {
    const mid = chR((plot.y0 + plot.y1) / 2);
    parts.push(chNode('text', { class: 'stack-chart__axis-label stack-chart__tick--middle', x: chR(font), y: mid, transform: `rotate(-90 ${chR(font)} ${mid})` }, props.yLabel));
  }
  if (props.xLabel) parts.push(chNode('text', { class: 'stack-chart__axis-label stack-chart__tick--middle', x: chR((plot.x0 + plot.x1) / 2), y: chR(height - 4) }, props.xLabel));

  // Marks.
  const stacks = stacked ? chStack(rows, n) : null;
  const marks = [];
  if (bars) {
    const groupW = band * 0.72;
    const each = stacked ? groupW : groupW / Math.max(1, rows.length);
    rows.forEach((r, j) => {
      const rects = r.y.map((v, i) => {
        if (v === null) return null;
        const [lo, hi] = stacked ? stacks[j][i] : (v >= 0 ? [0, v] : [v, 0]);
        const a = value(lo);
        const b = value(hi);
        const start = position(i) - groupW / 2 + (stacked ? 0 : j * each);
        const size = Math.abs(b - a);
        if (size === 0) return null;
        return horizontal
          ? chNode('rect', { class: 'stack-chart__bar', x: chR(Math.min(a, b)), y: chR(start + 0.5), width: chR(size), height: chR(Math.max(1, each - 1)) }, [], i)
          : chNode('rect', { class: 'stack-chart__bar', x: chR(start + 0.5), y: chR(Math.min(a, b)), width: chR(Math.max(1, each - 1)), height: chR(size) }, [], i);
      });
      marks.push(chNode('g', { class: chCx('stack-chart__series', `stack-chart__s${r.palette}`, `stack-chart__d${r.dash}`), 'data-series': r.id }, rects, r.id));
    });
  } else {
    rows.forEach((r, j) => {
      const segments = [];
      let current = [];
      r.y.forEach((v, i) => {
        if (v === null) { if (current.length) segments.push(current); current = []; return; }
        const [lo, hi] = stacked ? stacks[j][i] : [0, v];
        current.push({ i, x: position(i), y: value(stacked ? (v >= 0 ? hi : lo) : v), base: value(stacked ? (v >= 0 ? lo : hi) : Math.max(scaleTicks.min, Math.min(0, scaleTicks.max))) });
      });
      if (current.length) segments.push(current);
      const children = [];
      const step = props.curve === 'step';
      segments.forEach((seg, s) => {
        // A step holds each value until the next x (a balance between postings), then moves.
        const path = step ? seg.flatMap((p, k) => (k ? [{ ...p, y: seg[k - 1].y, base: seg[k - 1].base }, p] : [p])) : seg;
        const line = path.map((p, k) => `${k ? 'L' : 'M'}${chR(p.x)} ${chR(p.y)}`).join(' ');
        if (kind === 'area' && seg.length > 1) {
          const back = [...path].reverse().map((p) => `L${chR(p.x)} ${chR(p.base)}`).join(' ');
          children.push(chNode('path', { class: 'stack-chart__area', d: `${line} ${back} Z` }, [], `a${s}`));
        }
        if (seg.length > 1) children.push(chNode('path', { class: 'stack-chart__line', d: line }, [], `l${s}`));
        // A point with no neighbour would be invisible as a line: always mark it.
        if (seg.length === 1 || props.points) {
          seg.forEach((p) => children.push(chNode('circle', { class: 'stack-chart__point', cx: chR(p.x), cy: chR(p.y), r: 3.5 }, [], `p${s}-${p.i}`)));
        }
      });
      marks.push(chNode('g', { class: chCx('stack-chart__series', `stack-chart__s${r.palette}`, `stack-chart__d${r.dash}`), 'data-series': r.id }, children, r.id));
    });
  }
  parts.push(chNode('g', { class: 'stack-chart__marks' }, marks));

  // One focusable target per category: hover or focus shows every series' value.
  const fmt = props.format;
  const focusable = n <= CH_MAX_FOCUSABLE;
  parts.push(chNode('g', { class: 'stack-chart__targets' }, normalized.keys.map((_, i) => {
    const centre = position(i);
    let lo;
    let hi;
    if (bars || xType === 'category') { lo = centre - band / 2; hi = centre + band / 2; } else {
      lo = i === 0 ? plot.x0 : (position(i - 1) + centre) / 2;
      hi = i === n - 1 ? plot.x1 : (centre + position(i + 1)) / 2;
    }
    const valueRows = rows.map((r) => ({ palette: r.palette, text: `${r.label}: ${formatChartValue(r.y[i], fmt)}` }));
    const label = `${xLabels[i]}: ${rows.map((r) => `${r.label} ${formatChartValue(r.y[i], fmt)}`).join(', ')}`;
    const area = horizontal
      ? { x: plot.x0, y: chR(lo), width: chR(plotW), height: chR(Math.max(1, hi - lo)) }
      : { x: chR(lo), y: plot.y0, width: chR(Math.max(1, hi - lo)), height: chR(plotH) };
    return chNode('g', { class: 'stack-chart__target', ...(focusable ? { tabindex: '0' } : {}), role: 'img', 'aria-label': label }, [
      chNode('rect', { class: 'stack-chart__target-area', ...area }),
      bars ? null : chNode('line', { class: 'stack-chart__cursor', x1: chR(centre), x2: chR(centre), y1: plot.y0, y2: plot.y1 }),
      chTooltip(horizontal ? Math.min(width - 20, plot.x0 + plotW / 2) : centre, horizontal ? chR(Math.min(lo + band, height - 16 * (rows.length + 2))) : plot.y0, width, xLabels[i], valueRows),
    ], i);
  })));

  const svg = chNode('svg', {
    class: 'stack-chart__svg', viewBox: `0 0 ${width} ${height}`, width, height,
    role: 'group', 'aria-label': `${props.title}. ${focusable ? 'Use Tab to read each value, or open the data table.' : 'Open the data table to read the values.'}`,
  }, parts);
  const table = chTable(props, [props.xLabel || (xType === 'time' ? 'Date' : 'Category'), ...rows.map((r) => r.label)],
    normalized.keys.map((_, i) => [xLabels[i], ...rows.map((r) => formatChartValue(r.y[i], fmt))]));
  return chFigure(kind, props, {
    state: 'ready',
    content: [showLegend ? chLegend(kind, legendRows, props) : null, chNode('div', { class: 'stack-chart__plot' }, svg), table],
  });
}

const kindName = (kind) => ({ line: 'LineChart', area: 'AreaChart', bar: 'BarChart' }[kind] || kind);

/// Lines over categories or time; `points` marks every value, `zeroBaseline: false` fits the axis to the data,
/// `curve: 'step'` holds each value until the next (balances).
export function LineChart(props) { return cartesian('line', props || {}); }
/// Filled areas from zero; `stacked` stacks the series (positives up, negatives down); `curve: 'step'`.
export function AreaChart(props) { return cartesian('area', props || {}); }
/// Grouped bars; `orientation: 'horizontal'`; `stacked` stacks the series.
export function BarChart(props) { return cartesian('bar', props || {}); }
/// BarChart with `stacked: true`.
export function StackedBarChart(props) { return cartesian('bar', { ...(props || {}), stacked: true }); }

// ---- Donut --------------------------------------------------------------------

const chArc = (cx, cy, r0, r1, a0, a1) => {
  const p = (r, a) => `${chR(cx + r * Math.sin(a))} ${chR(cy - r * Math.cos(a))}`;
  const large = a1 - a0 > Math.PI ? 1 : 0;
  return `M${p(r1, a0)} A${chR(r1)} ${chR(r1)} 0 ${large} 1 ${p(r1, a1)} L${p(r0, a1)} A${chR(r0)} ${chR(r0)} 0 ${large} 0 ${p(r0, a0)} Z`;
};

/// Parts of a whole: one series whose x values name the slices. Negative values
/// cannot be parts of a whole: the chart says so instead of drawing them.
export function DonutChart(props) {
  const p = props || {};
  const normalized = normalizeSeries('DonutChart', p.series, 'category');
  const visible = normalized.series.filter((r) => !r.hidden);
  if (visible.length > 1) chFail('DonutChart', 'shows exactly one series; hide the others or use another chart');
  const s = visible[0];
  const fmt = p.format;
  const slices = s ? normalized.keys.map((k, i) => ({ id: k, label: k, value: s.y[i], palette: (i % CHART_PALETTE_SIZE) + 1, dash: i % 4 })) : [];
  const negative = slices.filter((x) => x.value !== null && x.value < 0);
  const total = slices.reduce((t, x) => t + (x.value && x.value > 0 ? x.value : 0), 0);
  const pending = chState('donut', p, total > 0 && !negative.length);
  if (pending && !(negative.length && !p.error && !p.loading)) return chFigure('donut', p, pending);
  if (negative.length) {
    return chFigure('donut', p, {
      state: 'unsupported',
      content: chNode('div', { class: 'stack-chart__state' }, chNode('div', { class: 'stack-unavailable stack-unavailable--unsupported', role: 'note', 'data-capability-status': 'unsupported' }, [
        chNode('p', { class: 'stack-unavailable__title' }, 'This data cannot be shown as parts of a whole'),
        chNode('p', { class: 'stack-unavailable__reason' }, `Negative values: ${negative.map((x) => `${x.label} (${formatChartValue(x.value, fmt)})`).join(', ')}. Use a bar chart.`),
      ])),
    });
  }
  const { width, height } = chSize({ ...p, width: Math.min(Number(p.width) || 320, 360) }, { aspectRatio: 1, minHeight: 160, maxHeight: 360 });
  const size = Math.min(width, height);
  const cx = width / 2;
  const cy = height / 2;
  const r1 = size / 2 - 4;
  const r0 = r1 * (Number(p.innerRatio) > 0 && Number(p.innerRatio) < 0.95 ? Number(p.innerRatio) : 0.62);
  const share = (v) => (v && v > 0 ? v / total : 0);
  const pct = (v) => `${(share(v) * 100).toFixed(1)}%`;
  let angle = 0;
  const marks = [];
  slices.forEach((x, i) => {
    if (!(x.value > 0)) return;
    const sweep = share(x.value) * Math.PI * 2;
    // A full circle cannot be one arc: draw two halves.
    const d = sweep >= Math.PI * 2 - 1e-9
      ? `${chArc(cx, cy, r0, r1, 0, Math.PI)} ${chArc(cx, cy, r0, r1, Math.PI, Math.PI * 2)}`
      : chArc(cx, cy, r0, r1, angle, angle + sweep);
    const mid = angle + sweep / 2;
    marks.push(chNode('g', { class: chCx('stack-chart__slice', `stack-chart__s${x.palette}`), tabindex: '0', role: 'img', 'aria-label': `${x.label}: ${formatChartValue(x.value, fmt)}, ${pct(x.value)}`, 'data-slice': x.id }, [
      chNode('path', { class: 'stack-chart__arc', d }),
      chTooltip(chR(cx + (r1 * 0.6) * Math.sin(mid)), chR(Math.max(2, Math.min(height - 54, cy - r1 * 0.6 * Math.cos(mid) - 20))), width, x.label, [{ text: `${formatChartValue(x.value, fmt)} · ${pct(x.value)}` }]),
    ], i));
    angle += sweep;
  });
  const centreValue = chPresent(p.centerValue) ? String(p.centerValue) : formatChartValue(total, fmt);
  const centre = p.center === false ? null : chNode('g', { class: 'stack-chart__center', 'aria-hidden': 'true' }, [
    chNode('text', { class: 'stack-chart__center-value stack-chart__tick--middle', x: chR(cx), y: chR(cy + 2) }, chFit(centreValue, r0 * 1.8, 16)),
    chNode('text', { class: 'stack-chart__center-label stack-chart__tick--middle', x: chR(cx), y: chR(cy + 18) }, chFit(p.centerLabel || 'Total', r0 * 1.8)),
  ]);
  const svg = chNode('svg', { class: 'stack-chart__svg stack-chart__svg--donut', viewBox: `0 0 ${width} ${height}`, width, height, role: 'group', 'aria-label': `${p.title}. Use Tab to read each part, or open the data table.` }, [chNode('g', { class: 'stack-chart__marks' }, marks), centre]);
  const legendRows = slices.map((x) => ({ id: x.id, label: x.label, palette: x.palette, dash: x.dash, note: x.value === null ? '—' : `${formatChartValue(x.value, fmt)} · ${pct(x.value)}` }));
  const table = chTable(p, [p.xLabel || 'Category', s.label, p.shareLabel || 'Share'], slices.map((x) => [x.label, formatChartValue(x.value, fmt), x.value === null ? '—' : pct(x.value)]));
  return chFigure('donut', p, {
    state: 'ready',
    content: [chNode('div', { class: 'stack-chart__donut' }, [chNode('div', { class: 'stack-chart__plot stack-chart__plot--donut' }, svg), p.legend === false ? null : chLegend('donut', legendRows, { ...p, onToggleSeries: undefined })]), table],
  });
}

// ---- Sparkline ----------------------------------------------------------------

/// A compact trend: one series, no axes, no legend. An image with a text summary
/// (first, last, lowest and highest value); `endpoints` marks the first and last points.
export function Sparkline(props) {
  const p = props || {};
  if (!chPresent(p.label)) chFail('Sparkline', 'needs a label (its accessible name)');
  const normalized = normalizeSeries('Sparkline', [{ id: 'spark', label: p.label, data: p.data || [] }], p.xType || 'category');
  const ys = normalized.series[0].y;
  const n = ys.length;
  const width = Math.max(24, Math.round(Number(p.width) || 120));
  const height = Math.max(12, Math.round(Number(p.height) || 32));
  const fmt = p.format;
  const present = ys.map((v, i) => ({ v, i })).filter((x) => x.v !== null);
  const cls = chCx('stack-sparkline', p.className);
  if (!present.length) {
    return chNode('span', { class: chCx(cls, 'stack-sparkline--empty'), role: 'img', 'aria-label': `${p.label}: no data`, ...chPassthrough(p.attrs) }, chNode('span', { class: 'stack-sparkline__empty', 'aria-hidden': 'true' }, '—'));
  }
  let min = Math.min(...present.map((x) => x.v));
  let max = Math.max(...present.map((x) => x.v));
  if (min === max) { min -= 1; max += 1; }
  const pad = 3;
  const x = (i) => (n === 1 ? width / 2 : pad + (i / (n - 1)) * (width - pad * 2));
  const y = chLinear(min, max, height - pad, pad);
  const segments = [];
  let cur = [];
  ys.forEach((v, i) => { if (v === null) { if (cur.length) segments.push(cur); cur = []; } else cur.push(i); });
  if (cur.length) segments.push(cur);
  const first = present[0];
  const last = present[present.length - 1];
  const summary = `${p.label}: ${formatChartValue(first.v, fmt)} to ${formatChartValue(last.v, fmt)}, low ${formatChartValue(Math.min(...present.map((q) => q.v)), fmt)}, high ${formatChartValue(Math.max(...present.map((q) => q.v)), fmt)}${present.length < n ? `, ${n - present.length} missing` : ''}`;
  const trend = last.v > first.v ? 'up' : last.v < first.v ? 'down' : 'flat';
  return chNode('span', { class: cls, 'data-trend': trend, ...chPassthrough(p.attrs) }, chNode('svg', {
    class: 'stack-sparkline__svg', viewBox: `0 0 ${width} ${height}`, width, height, role: 'img', 'aria-label': summary,
  }, [
    segments.map((seg, s) => (seg.length > 1
      ? chNode('path', { class: 'stack-sparkline__line', d: seg.map((i, k) => `${k ? 'L' : 'M'}${chR(x(i))} ${chR(y(ys[i]))}`).join(' ') }, [], s)
      : chNode('circle', { class: 'stack-sparkline__point', cx: chR(x(seg[0])), cy: chR(y(ys[seg[0]])), r: 1.75 }, [], s))),
    p.endpoints ? [first, last].map((q, k) => chNode('circle', { class: 'stack-sparkline__endpoint', cx: chR(x(q.i)), cy: chR(y(q.v)), r: 2.5 }, [], `e${k}`)) : null,
  ]));
}

export const CHARTS = Object.freeze({ LineChart, AreaChart, BarChart, StackedBarChart, DonutChart, Sparkline });
