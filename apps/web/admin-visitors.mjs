import { h, icon, short, number, errorText } from './ui.mjs';
import { chainIcon } from './chain-ui.mjs';

// Operator panel, Visitors tab (#/monkey?tab=visitors): opt-in site analytics from /api/admin/visitors
// (apps/api/site-analytics.mjs). Only visitors who allowed analytics are counted; the consent tile shows how many
// declined, so the totals can be read as a lower bound.

const PERIODS = [[1, 'Today'], [7, '7 days'], [30, '30 days'], [90, '90 days']];
const PAGE_NAMES = { explore: 'Explore', launch: 'Create', portfolio: 'Portfolio', rewards: 'Rewards', analytics: 'Analytics', docs: 'Docs', partners: 'Partners', token: 'Token pages', terms: 'Terms of Use', notfound: 'Not found' };
const DEVICE_NAMES = { mobile: 'Phone', tablet: 'Tablet', desktop: 'Computer', unknown: 'Unknown' };
let regionNames = null;
try { regionNames = new Intl.DisplayNames(['en'], { type: 'region' }); } catch {}
const countryName = code => { try { return regionNames?.of(code) ?? code; } catch { return code; } };
// Rounded, but never to 100% (or 0%) while some of the whole is missing (or present).
const pct = (part, whole) => whole > 0 ? `${Math.min(part < whole ? 99 : 100, Math.max(part > 0 ? 1 : 0, Math.round(part / whole * 100)))}%` : '—';

/** Day labels for the chart: "Oct 30" from "2026-10-30". */
const dayLabel = day => new Date(`${day}T00:00:00Z`).toLocaleDateString('en', { month: 'short', day: 'numeric', timeZone: 'UTC' });

function chart(daily) {
  const max = Math.max(1, ...daily.map(d => d.pageviews));
  const bars = daily.map(d => {
    const views = h('span.vs-bar-views'), people = h('span.vs-bar-people');
    views.style.height = `${d.pageviews / max * 100}%`; people.style.height = `${d.visitors / max * 100}%`;
    return h('div.vs-col', { title: `${dayLabel(d.day)}: ${number(d.visitors, 0)} visitors, ${number(d.pageviews, 0)} page views` }, h('div.vs-bar', views, people));
  });
  const step = Math.max(1, Math.ceil(daily.length / 6));
  return h('div.vs-chart-wrap',
    h('div.vs-legend', h('span.vs-key.vs-key-people', 'Visitors'), h('span.vs-key.vs-key-views', 'Page views'), h('span.muted', `Peak ${number(max, 0)} views a day`)),
    h('div.vs-chart', { role: 'img', 'aria-label': `Daily visitors and page views, ${daily.length} days` }, bars),
    h('div.vs-axis', daily.map((d, i) => h('span', i % step === 0 || i === daily.length - 1 ? dayLabel(d.day) : ''))));
}

function ranked(rows, name, { empty = 'Nothing yet.', total } = {}) {
  if (!rows?.length) return h('p.small.muted', empty);
  const top = Math.max(1, ...rows.map(r => r.visitors));
  return h('ol.vs-rank', rows.map(r => {
    const fill = h('span.vs-fill'); fill.style.width = `${r.visitors / top * 100}%`;
    return h('li', h('div.vs-rank-bar', fill), h('span.vs-rank-name', name(r)), h('span.vs-rank-num', number(r.visitors, 0), total ? h('small', ` ${pct(r.visitors, total)}`) : null));
  }));
}

export function renderVisitors(ctx, { getJson }) {
  const root = h('div.op-dash.vs');
  let days = 30;
  try { days = Number(sessionStorage.getItem('elpida:visitors-days')) || 30; } catch {}

  async function load() {
    root.replaceChildren(h('p.muted', 'Loading visitors…'));
    try {
      const d = await getJson(`admin/visitors?days=${days}`);
      root.replaceChildren(...view(d));
    } catch (e) {
      root.replaceChildren(h('div.pf-empty', h('h2', 'Visitors unavailable'), h('p', errorText(e)), h('button.btn.btn-secondary', { type: 'button', on: { click: load } }, 'Retry')));
    }
  }

  function view(d) {
    const t = d.totals ?? {}, period = t.period ?? { visitors: 0, pageviews: 0, sessions: 0 };
    const tile = (label, value, note) => h('div.tk-strip-tile', h('span', label), h('strong', value, note ? h('small', ` ${note}`) : null));
    const consentTotal = (d.consent?.accepted ?? 0) + (d.consent?.declined ?? 0);
    const filters = h('div.analytics-filters.vs-periods', { role: 'group', 'aria-label': 'Period' }, PERIODS.map(([value, label]) =>
      h('button.btn', { type: 'button', 'aria-pressed': String(value === d.days), on: { click: () => { days = value; try { sessionStorage.setItem('elpida:visitors-days', String(value)); } catch {} load(); } } }, label)));
    const card = (title, ...content) => h('section.tk-card.op-card', h('h2.tk-h', title), ...content);
    const pageviewsPerVisit = period.sessions ? (period.pageviews / period.sessions).toFixed(1) : '—';
    return [
      h('header.op-head',
        h('div', h('h1', 'Visitors'), h('p.small.muted', 'Only visitors who allowed analytics are counted. Kept ', number(d.retainDays ?? 90, 0), ' days. Days are UTC.')),
        h('div.op-actions', filters, h('button.btn.btn-secondary.btn-sm', { type: 'button', on: { click: load } }, icon('refresh-cw', 'icon-sm'), 'Refresh'))),
      h('section.tk-strip.op-strip', { 'aria-label': 'Visitor totals' },
        tile('Visitors today', number(t.today?.visitors ?? 0, 0), `${number(t.today?.pageviews ?? 0, 0)} views`),
        tile('Visitors 7d', number(t.d7?.visitors ?? 0, 0), `${number(t.d7?.pageviews ?? 0, 0)} views`),
        tile('Visitors 30d', number(t.d30?.visitors ?? 0, 0), `${number(t.d30?.pageviews ?? 0, 0)} views`),
        tile('Pages per visit', pageviewsPerVisit, `${number(period.sessions ?? 0, 0)} visits`),
        tile('Returning', number(d.returning?.returning ?? 0, 0), `${number(d.returning?.new ?? 0, 0)} new`), // returning: seen before this period began
        tile('Allowed analytics', pct(d.consent?.accepted ?? 0, consentTotal), consentTotal ? `${number(d.consent.declined, 0)} declined` : 'no choices yet')),
      card(`Daily, last ${d.days === 1 ? 'day' : `${d.days} days`}`, chart(d.daily ?? [])),
      h('div.op-grid',
        card('Pages', ranked(d.pages, r => PAGE_NAMES[r.key] ?? r.key, { total: period.visitors })),
        card('Tokens viewed', ranked(d.tokens, r => h('span.op-net', r.network ? chainIcon(r.network) : null, r.label ? h('strong', r.label) : null, h('span.mono.muted', short(r.token))), { empty: 'No token pages viewed yet.' }))),
      h('div.op-grid.op-grid-3',
        card('Sources', ranked(d.sources, r => r.key, { empty: 'No referrers yet. Add ?ref=name to links you share to see them here.', total: period.visitors })),
        card('Countries', ranked(d.countries, r => countryName(r.key), { empty: 'No country data. It comes from Cloudflare.', total: period.visitors })),
        card('Devices', ranked(d.devices, r => DEVICE_NAMES[r.key] ?? r.key, { total: period.visitors }))),
      h('div.op-grid',
        card('Networks', ranked(d.networks, r => h('span.op-net', chainIcon(r.key), r.key), { empty: 'No network chosen yet.', total: period.visitors })),
        card('Choices', h('dl.op-kv',
          h('dt', 'Terms accepted'), h('dd', number(d.terms?.accepted ?? 0, 0)),
          h('dt', 'Terms declined'), h('dd', number(d.terms?.declined ?? 0, 0)),
          h('dt', 'Analytics allowed'), h('dd', number(d.consent?.accepted ?? 0, 0)),
          h('dt', 'Essential only'), h('dd', number(d.consent?.declined ?? 0, 0))),
          h('p.meta', 'Counted per choice, with no id: one person who changes their mind counts twice.'))),
    ];
  }

  queueMicrotask(load);
  return root;
}
