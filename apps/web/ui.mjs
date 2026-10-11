// Small DOM and formatting helpers shared by every Elpida view. All dynamic text goes through
// textContent; no untrusted value is ever inserted as HTML.
import { normalizeMetadata } from './metadata.mjs';

export const $ = selector => document.querySelector(selector);
export const $$ = selector => [...document.querySelectorAll(selector)];
const SVG = 'http://www.w3.org/2000/svg';

/** h('div.class#id', {attrs, on: {click}}, ...children). Strings become text nodes. */
export function h(spec, attrs, ...children) {
  if (attrs === null || typeof attrs !== 'object' || attrs instanceof Node || Array.isArray(attrs)) { if (attrs !== undefined && attrs !== null) children.unshift(attrs); attrs = {}; }
  const [, tag = 'div', rest = ''] = spec.match(/^([a-z0-9-]*)(.*)$/i);
  const node = document.createElement(tag || 'div');
  for (const part of rest.match(/[.#][^.#]+/g) ?? []) part[0] === '.' ? node.classList.add(part.slice(1)) : (node.id = part.slice(1));
  for (const [key, value] of Object.entries(attrs)) {
    if (value === undefined || value === null || value === false) continue;
    if (key === 'on') for (const [event, handler] of Object.entries(value)) node.addEventListener(event, handler);
    else if (key === 'class') node.className += ` ${value}`;
    else if (key === 'text') node.textContent = value;
    else if (key in node && !key.startsWith('aria') && !key.startsWith('data') && key !== 'list' && key !== 'for') { try { node[key] = value; } catch { node.setAttribute(key, value); } }
    else node.setAttribute(key, value === true ? '' : value);
  }
  append(node, children);
  return node;
}
export function append(node, children) {
  for (const child of children.flat(Infinity)) {
    if (child === undefined || child === null || child === false) continue;
    node.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return node;
}
export function icon(name, cls = '') {
  const svg = document.createElementNS(SVG, 'svg');
  svg.setAttribute('class', `icon ${cls}`.trim()); svg.setAttribute('aria-hidden', 'true');
  const use = document.createElementNS(SVG, 'use'); use.setAttribute('href', `/assets/icons.svg#i-${name}`);
  svg.append(use); return svg;
}
export const short = value => value ? `${value.slice(0, 6)}…${value.slice(-4)}` : '—';
export const number = (value, max = 2) => Number(value || 0).toLocaleString('en-US', { maximumFractionDigits: max });
export const compact = value => Number(value || 0).toLocaleString('en-US', { notation: 'compact', maximumFractionDigits: 2 });
const SUBSCRIPT = '₀₁₂₃₄₅₆₇₈₉';
/** DEX-style price: $0.0₅51 means $0.0000051. */
export function formatPrice(value, prefix = '$') {
  if (!Number.isFinite(value) || value <= 0) return '—';
  if (value >= 0.01) return `${prefix}${number(value, 4)}`;
  const [mantissa, exponent] = value.toExponential(3).split('e');
  const zeros = -Number(exponent) - 1;
  if (zeros < 4) return `${prefix}${Number(value.toPrecision(4))}`;
  return `${prefix}0.0${[...String(zeros)].map(d => SUBSCRIPT[d]).join('')}${mantissa.replace('.', '').replace(/0+$/, '')}`;
}
/** Price and market values for a token, in its trading pair (the native coin or the paired asset). No dollar conversion. */
export function pricing(token) {
  const supply = Number(token.supply), sold = Number(token.sold), reserve = Number(token.reserve);
  const price = token.spotPrice ?? (supply - sold > 0 ? reserve / (supply - sold) : 0);
  const circulating = Number(token.circulatingSupply ?? token.sold);
  return { price, fdv: price * supply, marketCap: price * circulating, circulating, supply };
}
export const fmtPrice = token => `${formatPrice(pricing(token).price, '')} ${token.quoteSymbol ?? ''}`.trim();
export const fmtValue = (value, token) => `${compact(value)} ${token.quoteSymbol ?? ''}`.trim();
export function progressOf(token) {
  const cap = Number(token.saleCap ?? token.supply);
  return Math.min(100, Math.max(0, cap > 0 ? Number(token.sold) / cap * 100 : 0));
}
/** Lifecycle in plain words, shared by cards, the token page and the portfolio. */
export function lifecycle(token) {
  if (token.graduated) return { key: 'dex', label: `Trading on ${token.venue ?? token.dex ?? 'the DEX'}`, chip: 'chip-positive' };
  if (token.complete) return { key: 'complete', label: 'Ready to graduate', chip: 'chip-dawn' };
  return { key: 'curve', label: 'On bonding curve', chip: '' };
}
export function bar(percent, done = false, label = 'Bonding curve progress') {
  const track = h('div.bar', { role: 'progressbar', 'aria-valuemin': '0', 'aria-valuemax': '100', 'aria-valuenow': String(Math.round(percent)), 'aria-label': label, 'data-state': done ? 'done' : 'open' });
  const fill = h('span'); track.append(fill);
  requestAnimationFrame(() => { fill.style.width = `${percent}%`; });
  return track;
}
export function safeImage(src) { try { return normalizeMetadata({ image: src }).image; } catch { return ''; } }
export function avatar(token, cls = '') {
  const box = h(`div.avatar${cls ? '.' + cls : ''}`);
  const image = safeImage(token?.metadata?.image ?? token?.image ?? '');
  const initials = h('span.initials', { text: (token?.symbol || token?.name || '?').slice(0, 2).toUpperCase() });
  if (image) {
    const img = h('img', { alt: '', src: image, referrerPolicy: 'no-referrer', loading: 'lazy' });
    img.addEventListener('error', () => { img.replaceWith(initials); });
    box.append(img);
  } else box.append(initials);
  return box;
}
export function metadataLinks(metadata) {
  const links = h('div.links');
  let safe; try { safe = normalizeMetadata(metadata ?? {}); } catch { return links; }
  for (const [field, label, glyph] of [['website', 'Website', 'globe'], ['twitter', 'X', 'at-sign'], ['telegram', 'Telegram', 'send'], ['discord', 'Discord', 'message-circle']]) {
    if (!safe[field]) continue;
    links.append(h('a', { href: safe[field], target: '_blank', rel: 'noopener noreferrer' }, icon(glyph, 'icon-sm'), label));
  }
  return links;
}
export function copyButton(value, label = short(value)) {
  return h('button.copy', { type: 'button', 'aria-label': `Copy ${value}`, on: { click: async () => { try { await navigator.clipboard.writeText(value); toast('Copied to clipboard.', { kind: 'success' }); } catch { toast(value); } } } }, label, icon('copy', 'icon-sm'));
}
export function callout(kind, glyph, ...content) { return h(`div.callout${kind ? '.callout-' + kind : ''}`, { role: kind === 'error' ? 'alert' : undefined }, icon(glyph), h('div', ...content)); }
export function field({ label, optional, hint, control, error, id }) {
  // Wrappers (an input with a unit suffix) label their inner form control.
  const target = control.matches('input, select, textarea') ? control : control.querySelector('input, select, textarea') ?? control;
  const fid = id ?? (target.id || `f-${Math.random().toString(36).slice(2, 8)}`);
  target.id = fid;
  const hintNode = hint ? h('p.hint', { id: `${fid}-hint` }, hint) : null;
  const errorNode = h('p.error-text', { id: `${fid}-error`, role: 'alert' }, error ?? '');
  target.setAttribute('aria-describedby', [hintNode && `${fid}-hint`, `${fid}-error`].filter(Boolean).join(' '));
  return h('div.field', h('label', { for: fid }, label, optional ? h('span.opt', 'Optional') : null), control, hintNode, errorNode);
}
export function setError(control, message) {
  const node = document.getElementById(`${control.id}-error`);
  if (node) node.textContent = message ?? '';
  control.setAttribute('aria-invalid', message ? 'true' : 'false');
}
export function errorText(error) {
  if (error?.code === 4001 || error?.code === 'ACTION_REJECTED' || /user rejected|rejected the request|denied/i.test(error?.message ?? '')) return 'You cancelled the request in your wallet. Nothing was submitted.';
  const text = error?.reason ?? error?.shortMessage ?? error?.message ?? 'Something went wrong. Try again.';
  if (/insufficient funds/i.test(text)) return 'Your wallet does not have enough funds for this transaction and its network fee.';
  return text;
}

let toastId = 0;
/** Notifications: kind = info | success | error; link = {href, label}. */
export function toast(message, { kind = 'info', link, duration } = {}) {
  const region = $('#toasts'); if (!region) return;
  const id = ++toastId;
  const item = h('div.toast', { 'data-kind': kind, 'data-id': String(id) }, icon(kind === 'error' ? 'circle-alert' : kind === 'success' ? 'circle-check' : 'info'),
    h('div', h('span.toast-text', message), link ? h('div', h('a', { href: link.href, target: '_blank', rel: 'noopener noreferrer' }, link.label ?? 'View transaction')) : null),
    h('button', { type: 'button', 'aria-label': 'Dismiss', on: { click: () => item.remove() } }, icon('x', 'icon-sm')));
  region.append(item);
  while (region.children.length > 3) region.firstChild.remove();
  setTimeout(() => item.remove(), duration ?? (kind === 'error' ? 12000 : link ? 14000 : 6000));
  return item;
}
export function closeOnBackdrop(dialog) {
  dialog.addEventListener('click', event => {
    if (event.target !== dialog) return;
    const r = dialog.getBoundingClientRect();
    if (event.clientX < r.left || event.clientX > r.right || event.clientY < r.top || event.clientY > r.bottom) dialog.close();
  });
}
export const storage = {
  get(key) { try { return JSON.parse(sessionStorage.getItem(key)); } catch { return null; } },
  set(key, value) { try { sessionStorage.setItem(key, JSON.stringify(value)); } catch {} },
  remove(key) { try { sessionStorage.removeItem(key); } catch {} },
};
