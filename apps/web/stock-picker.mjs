// Tokenized-stock dropdown for the launch flow: the chosen stock as a button, and a searchable list of every stock this
// launchpad has approved, each with its issuer icon, company and type. Scales from one test stock to hundreds.
import { h, icon } from './ui.mjs';
import { assetIcon } from './chain-ui.mjs';
import { stockIdentity, catalogMap, searchStocks } from '/stock-catalog.mjs';

let catalog = null, loading = null;
/** Ondo's display catalog (company names and types), loaded once per page. Resolves to a Map, or null when unavailable. */
export function loadStockCatalog() {
  if (catalog) return Promise.resolve(catalog);
  loading ??= fetch('/api/public/stock-catalog', { signal: AbortSignal.timeout(15000) }).then(r => r.ok ? r.json() : null)
    .then(summary => { catalog = summary?.assets?.length ? catalogMap(summary) : null; return catalog; }).catch(() => null).finally(() => { loading = null; });
  return loading;
}
export const stockCatalog = () => catalog;

const rowText = (a, id) => [
  h('span.stock-option-head', h('strong', a.symbol), h('span.chip.chip-xs', id.type), a.test ? h('span.chip.chip-xs.chip-test', 'Test') : null),
  h('span.stock-option-company', id.company ?? a.name),
];

/**
 * `assets`: the approved stock quotes ({ id, symbol, name, test, stock }); `selectedId`; `onSelect(asset)`.
 * Returns the dropdown element. Keyboard: arrows move, Enter chooses, Escape closes; typing filters.
 */
export function stockPicker({ assets, selectedId, onSelect, label = 'Tokenized stock to pair with', noun = 'stock', emptyText = 'No approved stock matches. Only stocks approved on this launchpad can be paired.' }) {
  // Mixed lists (the reward asset picker, Swap): an asset with a `kind` other than xstock is a coin (native or USDC).
  const stockish = a => !a.kind || a.kind === 'xstock';
  const items = assets.map(a => { const id = stockish(a) ? stockIdentity(a.symbol, { provider: a.stock?.provider, name: a.name, catalog }) : { ticker: a.symbol, company: a.name ?? a.symbol, type: a.kind === 'usdc' ? 'Stablecoin' : 'Coin' }; return { asset: a, id, symbol: a.symbol, ticker: id.ticker, company: id.company ?? a.name, stock: stockish(a) }; });
  const plural = n => `${n} ${noun}${n === 1 ? '' : 's'}`;
  const selected = items.find(it => it.asset.id === selectedId) ?? items[0];
  const listId = `stock-options-${Math.random().toString(36).slice(2, 8)}`;
  const trigger = h('button.stock-select-trigger', { type: 'button', 'aria-haspopup': 'listbox', 'aria-expanded': 'false', 'aria-controls': listId, 'aria-label': `${label}: ${selected.symbol}${selected.company ? ', ' + selected.company : ''}` },
    assetIcon(selected.symbol, selected.stock, { size: 'md', provider: selected.asset.stock?.provider, name: selected.asset.name, catalog }),
    h('span.stock-select-text', ...rowText(selected.asset, selected.id)),
    h('span.stock-select-count', items.length > 1 ? plural(items.length) : null),
    icon('chevron-down', 'icon-sm stock-select-chevron'));
  const search = h('input.input.stock-select-search', { type: 'search', placeholder: `Search ${plural(items.length)} by name or ticker`, 'aria-label': `Search ${noun}s`, 'aria-controls': listId, autocomplete: 'off', spellcheck: false });
  const list = h('ul.stock-select-list', { role: 'listbox', id: listId, 'aria-label': label });
  const empty = h('p.small.muted.stock-select-empty', { hidden: true }, emptyText);
  const panel = h('div.stock-select-panel', { hidden: true }, search, list, empty);
  const root = h('div.stock-select', trigger, panel);
  let shown = items, active = Math.max(0, items.indexOf(selected));

  const choose = it => { close(); onSelect(it.asset); };
  const paint = () => {
    list.replaceChildren(...shown.map((it, i) => h('li.stock-option', {
      role: 'option', id: `${listId}-${i}`, 'aria-selected': String(it === selected), 'data-active': i === active ? 'true' : undefined,
      on: { click: () => choose(it), mousemove: () => { if (active !== i) { active = i; mark(); } } },
    }, assetIcon(it.symbol, it.stock, { size: 'md', provider: it.asset.stock?.provider, name: it.asset.name, catalog }), h('span.stock-option-text', ...rowText(it.asset, it.id)), it === selected ? icon('check', 'icon-sm stock-option-check') : null)));
    empty.hidden = shown.length > 0;
    mark();
  };
  const mark = () => {
    [...list.children].forEach((li, i) => li.toggleAttribute('data-active', i === active));
    const li = list.children[active]; if (li) { search.setAttribute('aria-activedescendant', li.id); li.scrollIntoView?.({ block: 'nearest' }); }
  };
  const open = () => { panel.hidden = false; trigger.setAttribute('aria-expanded', 'true'); search.value = ''; shown = items; active = Math.max(0, items.indexOf(selected)); paint(); search.focus(); };
  const close = () => { panel.hidden = true; trigger.setAttribute('aria-expanded', 'false'); };
  trigger.addEventListener('click', () => panel.hidden ? open() : close());
  search.addEventListener('input', () => { shown = searchStocks(items, search.value); active = 0; paint(); });
  search.addEventListener('keydown', e => {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { e.preventDefault(); if (shown.length) { active = (active + (e.key === 'ArrowDown' ? 1 : -1) + shown.length) % shown.length; mark(); } }
    else if (e.key === 'Enter') { e.preventDefault(); if (shown[active]) choose(shown[active]); }
    else if (e.key === 'Escape') { e.preventDefault(); close(); trigger.focus(); }
  });
  document.addEventListener('click', e => { if (!root.isConnected) return; if (!root.contains(e.target)) close(); });
  return root;
}
