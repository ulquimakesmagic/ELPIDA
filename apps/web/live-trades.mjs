// A server-sent-events connector for the live trade feed.
//
// Kept free of app state so it can be driven by a fake EventSource in tests: it reports what arrived and leaves the
// rendering to the caller. Reconnects with a backoff that doubles to 30 s, because a deploy drops every stream at once.

export function connectTradeStream({
  url = '/api/public/stream',
  onTrades = () => {},
  onOpen = () => {},
  onError = () => {},
  EventSourceImpl = globalThis.EventSource,
  schedule = setTimeout,
  cancel = clearTimeout,
  minDelay = 1000,
  maxDelay = 30000,
} = {}) {
  if (typeof EventSourceImpl !== 'function') return { supported: false, close() {}, get open() { return false; } };

  let source = null, timer = null, delay = minDelay, closed = false;

  const scheduleRetry = () => {
    if (closed) return;
    timer = schedule(() => { timer = null; open(); }, delay);
    delay = Math.min(delay * 2, maxDelay);
  };

  function open() {
    if (closed) return;
    source = new EventSourceImpl(url);
    source.addEventListener?.('ready', () => { delay = minDelay; onOpen(); });
    source.addEventListener?.('trades', event => {
      let payload;
      try { payload = JSON.parse(event.data); } catch { return; } // a malformed frame is ignored, never fatal
      if (Array.isArray(payload?.trades) && payload.trades.length) onTrades(payload.trades, payload.network);
    });
    source.addEventListener?.('error', () => {
      // Browsers also fire this while reconnecting on their own; closing and retrying ourselves keeps one path.
      closeSource();
      onError();
      scheduleRetry();
    });
  }

  function closeSource() {
    try { source?.close(); } catch { /* already closed */ }
    source = null;
  }

  open();

  return {
    supported: true,
    get open() { return Boolean(source); },
    /** Drops the connection and stops retrying (used when the tab is hidden). */
    close() {
      closed = true;
      if (timer) cancel(timer);
      timer = null;
      closeSource();
    },
    /** Closes the connection but keeps the retry loop, for a tab that becomes hidden and visible again. */
    pause() {
      if (timer) cancel(timer);
      timer = null;
      closeSource();
    },
    resume() {
      if (closed || source || timer) return;
      delay = minDelay;
      open();
    },
  };
}

/**
 * Merges streamed trades into the list already on screen: newest first, no duplicates, capped.
 *
 * The stream can deliver a trade the poll already showed, and two networks can deliver at once, so identity is the
 * transaction hash plus the log index, not the timestamp.
 */
export function mergeTrades(existing = [], incoming = [], limit = 20) {
  const seen = new Set(existing.map(t => `${t?.tx}:${t?.height}`));
  const fresh = incoming.filter(t => t && t.tx != null && !seen.has(`${t.tx}:${t.height}`));
  if (!fresh.length) return { trades: existing, added: 0 };
  const trades = [...fresh, ...existing]
    .sort((a, b) => (b.timestamp ?? 0) - (a.timestamp ?? 0))
    .slice(0, limit);
  return { trades, added: fresh.length };
}
