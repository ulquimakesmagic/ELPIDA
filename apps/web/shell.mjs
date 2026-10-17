import {bindSearch} from './search.mjs';
// App shell behaviour: the dock (collapsed, widened on hover or focus, or pinned), the colour theme,
// keyboard search (Ctrl/⌘ K), the phone search sheet and the "Last sale" strip in the top bar.
// Views and data stay in app.mjs; this module only drives the frame around them.
import { $, $$, h, avatar } from './ui.mjs';
import { nowSeconds } from './clock.mjs';

const store = {
  get(key) { try { return localStorage.getItem(key); } catch { return null; } },
  set(key, value) { try { localStorage.setItem(key, value); } catch {} },
};

/* ---------- Theme ---------- */
export function currentTheme() { return document.documentElement.getAttribute('data-theme') === 'light' ? 'light' : 'dark'; }
export function setTheme(theme) {
  document.documentElement.setAttribute('data-theme', theme);
  store.set('elpida:theme', theme);
  $$('[data-theme-toggle]').forEach(button => button.setAttribute('aria-label', theme === 'light' ? 'Switch to dark mode' : 'Switch to light mode'));
  document.querySelector('meta[name="theme-color"]')?.setAttribute('content', theme === 'light' ? '#f7f8f3' : '#08090b');
}

/* ---------- Dock ---------- */
function initDock() {
  const shell = $('#app-shell'), dock = $('#dock'), pin = $('#dock-pin');
  if (!shell || !dock) return;
  const root = document.documentElement;
  let hovered = false, timer = null;
  const pinned = () => root.hasAttribute('data-dock-pinned');
  const apply = () => { shell.dataset.dock = pinned() || hovered || dock.contains(document.activeElement) ? 'open' : 'closed'; };
  const later = (fn, ms) => { clearTimeout(timer); timer = setTimeout(fn, ms); };
  dock.addEventListener('mouseenter', () => { hovered = true; later(apply, 70); });
  dock.addEventListener('mouseleave', () => { hovered = false; later(apply, 140); });
  dock.addEventListener('focusin', () => { clearTimeout(timer); apply(); });
  dock.addEventListener('focusout', event => { if (!dock.contains(event.relatedTarget)) later(apply, 0); });
  pin?.addEventListener('click', () => {
    const next = !pinned();
    root.toggleAttribute('data-dock-pinned', next);
    store.set('elpida:dock', next ? 'pinned' : 'auto');
    pin.setAttribute('aria-pressed', String(next));
    pin.setAttribute('aria-label', next ? 'Let the sidebar collapse' : 'Keep the sidebar open');
    apply();
  });
  pin?.setAttribute('aria-pressed', String(pinned()));
  apply();
}

/* ---------- Search ---------- */
function initSearch(onSearch){bindSearch({input:$('#top-search-input'),sheet:$('#search-dialog'),sheetInput:$('#sheet-search-input'),topForm:$('#top-search'),sheetForm:$('#sheet-search'),mobileButton:$('#mobile-search-button'),document,onSearch});}
/** Keeps the top bar search in step with a query typed elsewhere (the Explore filter). */
export function syncSearch(value) { for (const field of [$('#top-search-input'), $('#sheet-search-input')]) if (field && field.value !== value) field.value = value; }

/* ---------- Last sale strip ---------- */
const ago = seconds => { const s = Math.max(0, Math.round(seconds)); return s < 60 ? `${s}s ago` : s < 3600 ? `${Math.floor(s / 60)}m ago` : s < 86400 ? `${Math.floor(s / 3600)}h ago` : `${Math.floor(s / 86400)}d ago`; };
let saleSignature = '';
/** trades: [{network, address, name, symbol, image, side, timestamp}] newest first. Empty hides the strip. */
export function renderLastSale(trades, { href }) {
  const strip = $('#last-sale'), items = $('#last-sale-items');
  if (!strip || !items) return;
  const list = (trades ?? []).filter(t => t.side === 'buy').slice(0, 12);
  strip.hidden = !list.length;
  if (!list.length) { items.replaceChildren(); saleSignature = ''; return; }
  const now = nowSeconds();
  const item = t => h('a.sale-item', { href: href(t), title: `${t.name ?? t.symbol} · bought ${ago(now - t.timestamp)}` },
    avatar({ symbol: t.symbol, name: t.name, metadata: { image: t.image ?? '' } }), h('strong', t.symbol ?? t.name ?? 'Token'), h('span', { 'data-side': t.side }, `Bought ${ago(now - t.timestamp)}`));
  const signature = JSON.stringify(list.map(t => [t.network, t.address, t.timestamp]));
  const rows = list.map(item);
  items.replaceChildren(...rows);
  items.removeAttribute('data-scroll');
  // Scroll only when the strip overflows: a duplicate set makes the loop seamless; ~40px per second.
  requestAnimationFrame(() => {
    const track = items.parentElement, width = items.scrollWidth;
    if (!track || width <= track.clientWidth + 4) return;
    const copies = list.map(item); copies.forEach(node => { node.setAttribute('aria-hidden', 'true'); node.tabIndex = -1; });
    items.append(...copies);
    const gap = parseFloat(getComputedStyle(items).columnGap) || 26;
    items.style.setProperty('--marquee-shift', `-${width + gap}px`);
    items.style.setProperty('--marquee-duration', `${Math.max(18, Math.round((width + gap) / 40))}s`);
    if (signature !== saleSignature || !items.hasAttribute('data-scroll')) items.setAttribute('data-scroll', '');
  });
  saleSignature = signature;
}

/* ---------- Start ---------- */
export function initShell({ onSearch = () => {}, onHow = () => {} } = {}) {
  setTheme(currentTheme());
  $$('[data-theme-toggle]').forEach(button => button.addEventListener('click', () => setTheme(currentTheme() === 'light' ? 'dark' : 'light')));
  $$('[data-open-how]').forEach(button => button.addEventListener('click', onHow));
  initDock();
  initSearch(onSearch);
}
