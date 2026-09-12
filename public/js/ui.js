/** DOM + component helpers shared by every screen (no framework, no build step). */
import { statusInfo } from './api.js';

/* ------------------------------------------------------------------ dom */
export function h(tag, props, ...children) {
  const el = document.createElement(tag);
  for (const [key, value] of Object.entries(props || {})) {
    if (value === null || value === undefined || value === false) continue;
    if (key === 'class') el.className = value;
    else if (key === 'html') el.innerHTML = value;
    else if (key === 'dataset') Object.assign(el.dataset, value);
    else if (key === 'style') el.setAttribute('style', value);
    else if (key.startsWith('on') && typeof value === 'function') el.addEventListener(key.slice(2), value);
    else if (value === true) el.setAttribute(key, '');
    else el.setAttribute(key, String(value));
  }
  append(el, children);
  return el;
}

function append(el, children) {
  for (const child of children.flat(4)) {
    if (child === null || child === undefined || child === false) continue;
    el.appendChild(child instanceof Node ? child : document.createTextNode(String(child)));
  }
}

export function render(target, ...content) {
  const el = typeof target === 'string' ? document.querySelector(target) : target;
  el.replaceChildren();
  append(el, content);
  return el;
}

export const clear = (el) => (typeof el === 'string' ? document.querySelector(el) : el)?.replaceChildren();

/* ------------------------------------------------------------- elements */
export const icon = (name) => h('span', { class: 'ico', 'aria-hidden': 'true' }, name || '•');

export function badge(text, kind = '') {
  return h('span', { class: `badge ${kind}` }, text);
}

export function statusBadge(code) {
  const info = statusInfo(code);
  return h('span', { class: 'badge status', style: `--badge-color:${info.color}` }, `${info.dot} ${info.label}`);
}

export function pill(label, value, kind = '') {
  return h('span', { class: `pill ${kind}` }, h('b', null, label), ' ', String(value));
}

export function card(props, ...children) {
  const { title, subtitle, actions, kind = '', footer, dense = false } = props || {};
  return h(
    'section',
    { class: `card ${kind} ${dense ? 'dense' : ''}` },
    title || actions
      ? h('header', { class: 'card-head' }, h('div', null, h('h3', null, title ?? ''), subtitle ? h('p', { class: 'muted small' }, subtitle) : null), actions ? h('div', { class: 'card-actions' }, actions) : null)
      : null,
    h('div', { class: 'card-body' }, children),
    footer ? h('footer', { class: 'card-foot' }, footer) : null,
  );
}

export function button(label, props = {}) {
  const { kind = 'primary', onClick, icon: ic, type = 'button', disabled, href, title } = props;
  if (href) return h('a', { class: `btn ${kind}`, href, title }, ic ? `${ic} ` : '', label);
  return h('button', { class: `btn ${kind}`, type, disabled, title, onclick: onClick }, ic ? h('span', { class: 'btn-ico' }, `${ic} `) : null, label);
}

export function buttons(list) {
  const toNode = (item) => {
    if (!item) return null;
    if (item instanceof Node) return item;
    if (Array.isArray(item)) return h('span', { class: 'btn-group' }, item.map(toNode).filter(Boolean));
    if (typeof item === 'string') return button(item, { kind: 'ghost' });
    return button(item.label ?? item.text ?? 'button', item);
  };
  return h('div', { class: 'btn-row' }, (list || []).map(toNode).filter(Boolean));
}

export function empty(message, hint) {
  return h('div', { class: 'empty' }, h('p', null, message), hint ? h('p', { class: 'muted small' }, hint) : null);
}

export function spinner(label = 'Working…') {
  return h('div', { class: 'loading' }, h('span', { class: 'spin' }), label);
}

export function errorBox(err) {
  const details = Array.isArray(err?.details) ? err.details : err?.details?.errors;
  return h(
    'div',
    { class: 'alert error' },
    h('b', null, err?.status ? `${err.status}` : 'Error'),
    ' ',
    err?.message || String(err),
    err?.status === 403 ? h('div', { class: 'tiny' }, 'this action belongs to another role - ask an administrator if you need it') : null,
    Array.isArray(details) && details.length ? h('ul', null, details.map((d) => h('li', null, typeof d === 'string' ? d : JSON.stringify(d)))) : null,
  );
}

export function notice(kind, text) {
  return h('div', { class: `alert ${kind}` }, text);
}

/* --------------------------------------------------------------- layout */
export function grid(cols, ...children) {
  return h('div', { class: `grid g-${cols}` }, children);
}

export function statTile(props) {
  const { label, value, sub, tone = '', href, icon: ic } = props;
  const inner = [h('span', { class: 'tile-value' }, value), h('span', { class: 'tile-label' }, ic ? `${ic} ${label}` : label), sub ? h('span', { class: 'tile-sub muted' }, sub) : null];
  const el = href ? h('a', { class: `tile ${tone}`, href }) : h('div', { class: `tile ${tone}` });
  append(el, inner);
  return el;
}

export function kv(pairs, props = {}) {
  const rows = pairs.filter(([, value]) => value !== null && value !== undefined && value !== '');
  if (!rows.length) return h('p', { class: 'muted small' }, props.emptyText || 'nothing recorded');
  return h(
    'dl',
    { class: `kv ${props.class || ''}` },
    rows.map(([key, value]) => h('div', { class: 'kv-row' }, h('dt', null, key), h('dd', null, value instanceof Node ? value : String(value)))),
  );
}

/** Responsive table: real <table> on wide screens, stacked cards on a phone. */
export function table(columns, rows, props = {}) {
  if (!rows?.length) return empty(props.emptyText || 'Nothing here yet');
  const head = h('thead', null, h('tr', null, columns.map((c) => h('th', { style: c.width ? `width:${c.width}` : null }, c.label))));
  const body = h(
    'tbody',
    null,
    rows.map((row, index) =>
      h(
        'tr',
        {
          class: props.onRowOpen ? 'clickable' : '',
          onclick: props.onRowOpen ? () => props.onRowOpen(row, index) : null,
        },
        columns.map((c) => {
          const value = c.render ? c.render(row, index) : row[c.key];
          return h('td', { class: c.class || '', 'data-col': c.label }, value instanceof Node ? value : value === null || value === undefined ? h('span', { class: 'muted' }, '-') : String(value));
        }),
      ),
    ),
  );
  const mobile = h(
    'div',
    { class: 'cards' },
    rows.map((row, index) =>
      h(
        'div',
        { class: 'row-card', onclick: props.onRowOpen ? () => props.onRowOpen(row, index) : null },
        h('div', { class: 'row-card-top' }, columns[0].render ? columns[0].render(row, index) : String(row[columns[0].key] ?? '')),
        h(
          'div',
          { class: 'row-card-cols' },
          columns.slice(1).map((c) => h('div', null, h('span', { class: 'muted small' }, c.label), h('div', null, c.render ? c.render(row, index) : String(row[c.key] ?? '-')))),
        ),
      ),
    ),
  );
  return h('div', { class: 'table-wrap' }, h('table', { class: 'table' }, head, body), mobile);
}

export function pager({ page, size, total }, onChange) {
  const pages = Math.max(1, Math.ceil(total / size));
  return h(
    'div',
    { class: 'pager' },
    h('span', { class: 'muted small' }, `${total} record(s) · page ${page} of ${pages}`),
    h(
      'div',
      null,
      button('‹ prev', { kind: 'ghost', disabled: page <= 1, onClick: () => onChange(page - 1) }),
      ' ',
      button('next ›', { kind: 'ghost', disabled: page >= pages, onClick: () => onChange(page + 1) }),
    ),
  );
}

/* --------------------------------------------------------------- charts */
export function barChart(items, props = {}) {
  const data = (items || []).filter((i) => i && (i.value || i.count));
  if (!data.length) return empty(props.emptyText || 'no data to chart yet');
  const max = Math.max(...data.map((d) => Number(d.value ?? d.count)), 1);
  return h(
    'div',
    { class: 'chart' },
    data.map((d) =>
      h(
        'div',
        { class: 'bar-row', title: `${d.label}: ${d.value ?? d.count}` },
        h('span', { class: 'bar-label' }, d.icon ? `${d.icon} ` : '', d.label),
        h('span', { class: 'bar-track' }, h('span', { class: 'bar-fill', style: `width:${Math.max(2, (Number(d.value ?? d.count) / max) * 100)}%; background:${d.color || 'var(--accent)'}` })),
        h('b', { class: 'bar-value' }, String(d.value ?? d.count)),
      ),
    ),
  );
}

/* ------------------------------------------------------------ fill meter */
export function meter(value, max, label) {
  const pct = max ? Math.min(100, Math.round((value / max) * 100)) : 0;
  const tone = pct >= 90 ? 'danger' : pct >= 70 ? 'warn' : 'ok';
  return h('div', { class: `meter ${tone}` }, h('div', { class: 'meter-bar' }, h('span', { style: `width:${pct}%` })), h('span', { class: 'meter-label' }, label ?? `${value}/${max} (${pct}%)`));
}

/* ------------------------------------------------------------------ form */
const FIELD_DEFAULTS = { text: '', number: '', select: '', multiselect: [], textarea: '', checkbox: false, date: '', datetime: '', time: '', photo: null, tags: '', list: [], color: '' };

/**
 * Declarative form. spec: [{ key, label, type, options, required, help, min, max, step, placeholder, rows }]
 * Returns { node, values(), setValues(), validate(), error(message) }
 */
export function form(spec, initial = {}, props = {}) {
  const inputs = new Map();
  const fields = spec.filter(Boolean);
  const nodes = fields.map((field) => {
    const value = initial[field.key] ?? FIELD_DEFAULTS[field.type] ?? '';
    let input;
    const id = `f-${field.key}-${Math.random().toString(36).slice(2, 7)}`;
    const common = { id, name: field.key, placeholder: field.placeholder || '', required: field.required, disabled: field.disabled, autocomplete: 'off' };
    switch (field.type) {
      case 'select':
        input = h(
          'select',
          common,
          field.empty === false ? null : h('option', { value: '' }, field.emptyLabel || '— any —'),
          (field.options || []).map((opt) => {
            const o = typeof opt === 'string' ? { value: opt, label: opt } : opt;
            return h('option', { value: o.value, selected: String(o.value) === String(value) }, o.label ?? String(o.value));
          }),
        );
        break;
      case 'multiselect':
        input = h(
          'select',
          { ...common, multiple: true, size: Math.min(6, Math.max(2, (field.options || []).length)) },
          (field.options || []).map((opt) => {
            const o = typeof opt === 'string' ? { value: opt, label: opt } : opt;
            return h('option', { value: o.value, selected: (value || []).map(String).includes(String(o.value)) }, o.label ?? String(o.value));
          }),
        );
        break;
      case 'checkbox':
        input = h('input', { ...common, type: 'checkbox', checked: value === true || value === 1 || value === '1' });
        break;
      case 'textarea':
        input = h('textarea', { ...common, rows: field.rows || 3 }, String(value));
        break;
      case 'number':
        input = h('input', { ...common, type: 'number', value: String(value), min: field.min, max: field.max, step: field.step ?? 'any' });
        break;
      case 'date':
      case 'datetime':
      case 'time':
        input = h('input', { ...common, type: field.type === 'datetime' ? 'datetime-local' : field.type, value: String(value).slice(0, field.type === 'date' ? 10 : 16) });
        break;
      case 'photo':
        input = photoInput(field, value);
        break;
      case 'list':
        input = listInput(field, value);
        break;
      default:
        input = h('input', { ...common, type: 'text', value: String(value) });
    }
    inputs.set(field.key, { field, input, id });
    return h(
      'div',
      { class: `field ${field.wide ? 'wide' : ''} ${field.type === 'checkbox' ? 'inline' : ''}` },
      field.type === 'checkbox' ? h('label', { for: id, class: 'check' }, input, ' ', field.label) : h('label', { for: id }, field.label, field.required ? h('span', { class: 'req' }, ' *') : null),
      field.type === 'checkbox' ? null : input,
      field.help ? h('small', { class: 'muted' }, field.help) : null,
      h('small', { class: 'field-error' }),
    );
  });
  const node = h('form', { class: `form ${props.class || ''}`, onsubmit: (e) => e.preventDefault() }, nodes);
  return {
    node,
    inputs,
    values() {
      const out = {};
      for (const [key, { field, input }] of inputs) {
        if (field.type === 'checkbox') out[key] = input.checked;
        else if (field.type === 'multiselect') out[key] = [...input.selectedOptions].map((o) => o.value);
        else if (field.type === 'number') out[key] = input.value === '' ? null : Number(input.value);
        else if (field.type === 'photo') out[key] = input.__files || null;
        else if (field.type === 'list') out[key] = input.__items?.() || [];
        else out[key] = input.value.trim();
        if (out[key] === '' && field.type !== 'checkbox') out[key] = null;
      }
      return out;
    },
    setValues(next) {
      for (const [key, value] of Object.entries(next || {})) {
        const entry = inputs.get(key);
        if (!entry) continue;
        const { field, input } = entry;
        if (field.type === 'checkbox') input.checked = Boolean(value);
        else if (field.type === 'list') input.__set?.(value || []);
        else input.value = value === null || value === undefined ? '' : Array.isArray(value) ? value.join(',') : String(value);
      }
    },
    validate() {
      let ok = true;
      for (const [key, { field, input }] of inputs) {
        const wrap = input.closest('.field');
        const err = wrap?.querySelector('.field-error');
        let message = '';
        const value = field.type === 'checkbox' ? input.checked : field.type === 'number' ? input.value : String(input.value ?? '').trim();
        if (field.required && (value === '' || value === null || value === false)) message = `${field.label} is required`;
        else if (field.type === 'number' && value !== '' && !Number.isFinite(Number(value))) message = `${field.label} must be a number`;
        else if (field.type === 'number' && value !== '' && field.min !== undefined && Number(value) < field.min) message = `${field.label} must be at least ${field.min}`;
        else if (field.type === 'number' && value !== '' && field.max !== undefined && Number(value) > field.max) message = `${field.label} must be at most ${field.max}`;
        else if (field.maxlength && value && String(value).length > field.maxlength) message = `${field.label} is too long (max ${field.maxlength})`;
        else if (field.pattern && value && !new RegExp(field.pattern).test(value)) message = field.patternMessage || `${field.label} format is not valid`;
        if (err) err.textContent = message;
        wrap?.classList.toggle('invalid', Boolean(message));
        if (message) ok = false;
      }
      return ok;
    },
    error(message) {
      const old = node.querySelector('.form-error');
      old?.remove();
      if (message) node.insertBefore(h('div', { class: 'alert error form-error' }, message), node.firstChild);
    },
  };
}

function listInput(field, value) {
  const state = { items: Array.isArray(value) ? [...value] : [] };
  const list = h('div', { class: 'chips' }, ...[]);
  const redraw = () => {
    list.replaceChildren(
      ...state.items.map((item, index) =>
        h(
          'span',
          { class: 'chip' },
          typeof item === 'string' || typeof item === 'number' ? String(item) : item.label ?? JSON.stringify(item),
          h('button', { type: 'button', class: 'chip-x', 'aria-label': 'remove', onclick: () => (state.items.splice(index, 1), redraw()) }, '×'),
        ),
      ),
      state.items.length === 0 ? h('span', { class: 'muted small' }, field.emptyText || 'none yet') : null,
    );
  };
  redraw();
  const adder = h('div', { class: 'chip-add' }, h('input', { type: 'text', placeholder: field.addPlaceholder || 'add and press Enter', onkeydown: (e) => { if (e.key === 'Enter') { e.preventDefault(); add(); } } }), button('add', { kind: 'ghost', onClick: add }));
  function add() {
    const input = adder.querySelector('input');
    const raw = input.value.trim();
    if (!raw) return;
    if (field.toItem) state.items.push(field.toItem(raw));
    else raw.split(',').map((s) => s.trim()).filter(Boolean).forEach((v) => state.items.push(v));
    input.value = '';
    redraw();
  }
  const wrap = h('div', { class: 'list-input' }, list, adder);
  wrap.__items = () => state.items;
  wrap.__set = (items) => ((state.items = Array.isArray(items) ? [...items] : []), redraw());
  return wrap;
}

function photoInput(field, value) {
  const input = h('input', { type: 'file', accept: field.accept || 'image/*', capture: field.camera ? 'environment' : null, multiple: field.multiple !== false, class: 'file' });
  const preview = h('div', { class: 'photo-preview' });
  const files = [];
  input.__files = files;
  const objectUrls = [];
  input.addEventListener('change', () => {
    files.length = 0;
    objectUrls.forEach(URL.revokeObjectURL);
    objectUrls.length = 0;
    for (const file of input.files || []) {
      files.push(file);
      const url = URL.createObjectURL(file);
      objectUrls.push(url);
      preview.appendChild(h('img', { src: url, alt: file.name }));
    }
    preview.classList.toggle('has', files.length > 0);
    const sizeLine = preview.querySelector('.size-line');
    sizeLine?.remove();
    if (files.length) preview.appendChild(h('small', { class: 'size-line muted' }, `${files.length} file(s), ${(files.reduce((s, f) => s + f.size, 0) / 1024 / 1024).toFixed(2)} MB`));
  });
  if (value) preview.appendChild(h('small', { class: 'muted' }, 'existing photos stay unless you tick "replace"'));
  return h('div', { class: 'photo-input' }, preview, input);
}

/* ------------------------------------------------------------- photos */
export function photoGrid(images, props = {}) {
  if (!images?.length) return empty(props.emptyText || 'no photos yet', props.hint);
  return h(
    'div',
    { class: 'photos' },
    images.map((image) =>
      h(
        'figure',
        { class: `photo ${image.is_primary ? 'primary' : ''}`, onclick: props.onOpen ? () => props.onOpen(image) : null, title: image.caption || image.filename || '' },
        h('img', { src: image.url || image.src, alt: image.caption || 'photo', loading: 'lazy', decoding: 'async' }),
        h('figcaption', null, image.view_type ? badge(image.view_type.replace('_', ' '), 'tiny') : null, image.is_primary ? badge('primary', 'tiny ok') : null),
      ),
    ),
  );
}

export function lightbox(src, caption) {
  const box = h('div', { class: 'lightbox', onclick: () => box.remove() }, h('img', { src, alt: caption || 'photo' }), caption ? h('p', null, caption) : null, h('span', { class: 'muted small' }, 'tap anywhere to close'));
  document.body.appendChild(box);
  const onKey = (e) => {
    if (e.key === 'Escape') {
      box.remove();
      document.removeEventListener('keydown', onKey);
    }
  };
  document.addEventListener('keydown', onKey);
}

/* ------------------------------------------------------------- overlays */
let toastTimer = null;
export function toast(message, kind = 'ok', ms = 4200) {
  let host = document.querySelector('.toasts');
  if (!host) {
    host = h('div', { class: 'toasts', role: 'status', 'aria-live': 'polite' });
    document.body.appendChild(host);
  }
  host.replaceChildren(h('div', { class: `toast ${kind}` }, message));
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => host.replaceChildren(), ms);
}

export function modal(props) {
  const { title, subtitle, body, actions, wide = false, onClose } = props;
  const back = h('div', { class: 'modal-back', onclick: (e) => e.target === back && close() });
  const box = h(
    'div',
    { class: `modal ${wide ? 'wide' : ''}`, role: 'dialog', 'aria-modal': 'true', 'aria-label': title },
    h('header', null, h('h3', null, title), subtitle ? h('p', { class: 'muted small' }, subtitle) : null, h('button', { class: 'x', 'aria-label': 'close', onclick: () => close() }, '×')),
    h('div', { class: 'modal-body' }, body),
    actions ? h('footer', null, actions) : null,
  );
  back.appendChild(box);
  document.body.appendChild(back);
  document.body.classList.add('locked');
  function close() {
    back.remove();
    document.body.classList.remove('locked');
    document.removeEventListener('keydown', onKey);
    onClose?.();
  }
  const onKey = (e) => e.key === 'Escape' && close();
  document.addEventListener('keydown', onKey);
  requestAnimationFrame(() => box.querySelector('input,select,textarea,button')?.focus());
  return { close, box };
}

/** Dialog whose footer buttons resolve the returned promise. */
export function formDialog({ title, subtitle, fields, initial, submitLabel = 'save', wide = false }) {
  return new Promise((resolve) => {
    const f = form(fields, initial, {});
    const dialog = modal({
      title,
      subtitle,
      wide,
      body: f.node,
      actions: h(
        'div',
        { class: 'btn-row end' },
        button('cancel', { kind: 'ghost', onClick: () => (dialog.close(), resolve(null)) }),
        button(submitLabel, {
          kind: 'primary',
          onClick: () => {
            if (!f.validate()) return;
            const values = f.values();
            for (const [key, value] of Object.entries(values)) if (value === null && !fields.find((x) => x?.key === key)?.required) delete values[key];
            dialog.close();
            resolve(values);
          },
        }),
      ),
    });
    f.node.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && e.target.tagName !== 'TEXTAREA') {
        e.preventDefault();
        dialog.box.querySelector('.modal-body')?.closest('.modal')?.querySelector('footer .btn-primary')?.click();
      }
    });
  });
}

export function confirmDialog(message, { title = 'please confirm', danger = false, confirmLabel = 'yes' } = {}) {
  return new Promise((resolve) => {
    const dialog = modal({
      title,
      body: h('p', null, message),
      actions: h(
        'div',
        { class: 'btn-row end' },
        button('cancel', { kind: 'ghost', onClick: () => (dialog.close(), resolve(false)) }),
        button(confirmLabel, { kind: danger ? 'danger' : 'primary', onClick: () => (dialog.close(), resolve(true)) }),
      ),
    });
  });
}

/* --------------------------------------------------------------- units */
export function unitPreference() {
  return localStorage.getItem('sp.unit') || 'mm';
}

export function setUnit(unit) {
  localStorage.setItem('sp.unit', unit);
}

export function mm(value, unit = unitPreference()) {
  const n = Number(value);
  if (!Number.isFinite(n) || value === null || value === undefined) return '-';
  if (unit === 'cm') return `${(n / 10).toFixed(1)} cm`;
  if (unit === 'in') return `${(n / 25.4).toFixed(2)} in`;
  return `${Number(n.toFixed(1))} mm`;
}

export function sizeString(dims, keys = ['overall_length_mm', 'overall_width_mm', 'overall_height_mm'], unit = unitPreference()) {
  if (!dims) return '-';
  const values = keys.map((k) => dims[k]).filter((v) => v !== null && v !== undefined);
  const diameter = dims.overall_diameter_mm ?? dims.outer_diameter_mm;
  if (!values.length) return diameter ? `Ø ${mm(diameter, unit)}` : '-';
  const base = values.map((v) => mm(v, unit).replace(/ (mm|cm|in)$/, '')).join(' × ');
  const suffix = unit === 'mm' ? ' mm' : unit === 'cm' ? ' cm' : ' in';
  return diameter ? `${base}${suffix}  (Ø ${mm(diameter, unit)})` : `${base}${suffix}`;
}

export function UnitToggle(onChange) {
  const wrap = h('div', { class: 'unit-toggle', role: 'group', 'aria-label': 'measurement unit' });
  const units = [
    { value: 'mm', label: 'mm' },
    { value: 'cm', label: 'cm' },
    { value: 'in', label: 'in' },
  ];
  const paint = () => {
    wrap.replaceChildren(
      ...units.map((u) =>
        h('button', {
          type: 'button',
          class: u.value === unitPreference() ? 'on' : '',
          onclick: () => {
            setUnit(u.value);
            paint();
            onChange?.(u.value);
          },
        }, u.label),
      ),
    );
  };
  paint();
  return wrap;
}

/* --------------------------------------------------------------- dates */
export function when(value) {
  if (!value) return '-';
  const date = new Date(String(value).replace(' ', 'T'));
  if (Number.isNaN(date.getTime())) return String(value);
  const diff = (Date.now() - date.getTime()) / 1000;
  if (Math.abs(diff) < 3600) return `${Math.round(diff / 60)} min ago`;
  if (Math.abs(diff) < 86400 * 2) return `${Math.round(diff / 3600)} h ago`;
  return date.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: '2-digit' }) + (String(value).length > 10 ? ` ${date.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })}` : '');
}

export function dateOnly(value) {
  if (!value) return '-';
  return String(value).slice(0, 10);
}

export function daysUntil(value) {
  if (!value) return null;
  const date = new Date(`${String(value).slice(0, 10)}T00:00:00`);
  return Math.round((date.getTime() - Date.now()) / 86400000);
}

/* ------------------------------------------------------------- printing */
export function printHtml(html) {
  const frame = h('iframe', { class: 'print-frame', title: 'print preview' });
  document.body.appendChild(frame);
  frame.onload = () => {
    frame.contentDocument.open();
    frame.contentDocument.write(html);
    frame.contentDocument.close();
    setTimeout(() => {
      frame.contentWindow.focus();
      frame.contentWindow.print();
    }, 250);
  };
  frame.srcdoc = html;
  const close = h('button', { class: 'btn ghost print-close', onclick: () => frame.remove() }, 'close preview');
  document.body.appendChild(close);
  setTimeout(() => {
    close.remove();
    frame.remove();
  }, 60000);
}

/** Small helper for screens that fetch + render + handle errors uniformly. */
export async function load(container, fn) {
  container.replaceChildren(spinner());
  try {
    const node = await fn();
    render(container, node ?? null);
  } catch (err) {
    if (err?.status === 401) {
      location.hash = '#/login';
      return;
    }
    render(container, errorBox(err));
  }
}

export function tabs(items, active, onSelect) {
  return h(
    'div',
    { class: 'tabs', role: 'tablist' },
    items.map((item) => h('button', { class: `tab ${item.key === active ? 'on' : ''}`, role: 'tab', 'aria-selected': item.key === active, onclick: () => onSelect(item.key) }, item.label, item.count !== undefined ? h('span', { class: 'count' }, item.count) : null)),
  );
}

export function sectionNav(items) {
  return h(
    'nav',
    { class: 'subnav' },
    items.map((item) => h('a', { href: item.href }, item.label, item.count ? h('span', { class: 'count' }, item.count) : null)),
  );
}
