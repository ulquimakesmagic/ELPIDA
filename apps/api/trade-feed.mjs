// A tiny server-sent-events feed. It carries only what the REST endpoints already publish — public trades — and it
// never accepts input from a client beyond the connection itself.
//
// The browser holds one long connection instead of polling, so a trade reaches the screen as soon as the indexer
// sees it. Everything here is bounded: connections per address, total connections, what a slow client may buffer.

/** Event payloads are trimmed to what the strip and the live feed render, so a message stays small. */
const tradeFields = trade => ({
  address: trade.address, network: trade.network, symbol: trade.symbol, name: trade.name, image: typeof trade.image === 'string' && !trade.image.startsWith('data:') ? trade.image : null,
  side: trade.side, priceQuote: trade.priceQuote, quoteSymbol: trade.quoteSymbol, quoteAmount: trade.quoteAmount ?? null, tokenAmount: trade.tokenAmount ?? null,
  account: trade.account ?? null, venue: trade.venue ?? null, launch: Boolean(trade.launch),
  timestamp: trade.timestamp, tx: trade.tx, height: trade.height, index: trade.index ?? 0,
});

export class TradeFeed {
  static MAX_CLIENTS = 200;
  static MAX_PER_ADDRESS = 8;
  /** A client that stops reading is dropped rather than buffered without limit. */
  static MAX_BUFFERED = 1 << 20;

  constructor({ heartbeatMs = 15000, maxClients = TradeFeed.MAX_CLIENTS, maxPerAddress = TradeFeed.MAX_PER_ADDRESS, log = () => {} } = {}) {
    this.clients = new Set();
    this.byAddress = new Map();
    this.published = 0;
    this.dropped = 0;
    this.heartbeatMs = heartbeatMs;
    this.maxClients = maxClients;
    this.maxPerAddress = maxPerAddress;
    this.log = log;
    this.timer = null;
    this.closed = false;
  }

  /** Writes one event to one client; returns false when the socket should be dropped. */
  write(client, chunk) {
    try {
      if (client.res.writableEnded || client.res.destroyed) return false;
      if ((client.res.writableLength ?? 0) > TradeFeed.MAX_BUFFERED) return false;
      client.res.write(chunk);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Attaches a response as a client. Returns `{ok:true}` or `{ok:false, status, error}` so the caller decides how to
   * answer; this function never writes an error body.
   */
  subscribe({ res, address = '' }) {
    if (this.closed) return { ok: false, status: 503, error: 'Feed is shutting down.' };
    if (this.clients.size >= this.maxClients) return { ok: false, status: 503, error: 'Feed is at capacity. Retry shortly.' };
    const forAddress = this.byAddress.get(address) ?? 0;
    if (forAddress >= this.maxPerAddress) return { ok: false, status: 429, error: 'Too many open streams from this address.' };

    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      // Proxies must not cache or transform a stream, and must not buffer it.
      'Cache-Control': 'no-store, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    res.write('retry: 3000\n\n');
    res.write(`event: ready\ndata: ${JSON.stringify({ heartbeatMs: this.heartbeatMs })}\n\n`);

    const client = { res, address };
    this.clients.add(client);
    this.byAddress.set(address, forAddress + 1);
    res.on?.('close', () => this.remove(client));
    res.on?.('error', () => this.remove(client));
    this.startHeartbeat();
    return { ok: true, clients: this.clients.size };
  }

  remove(client) {
    if (!this.clients.delete(client)) return;
    const remaining = (this.byAddress.get(client.address) ?? 1) - 1;
    if (remaining <= 0) this.byAddress.delete(client.address); else this.byAddress.set(client.address, remaining);
    if (!this.clients.size) this.stopHeartbeat();
  }

  startHeartbeat() {
    if (this.timer || this.heartbeatMs <= 0) return;
    this.timer = setInterval(() => {
      for (const client of [...this.clients]) {
        if (!this.write(client, ': ping\n\n')) this.drop(client, 'unresponsive');
      }
    }, this.heartbeatMs);
    this.timer.unref?.();
  }

  stopHeartbeat() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  drop(client, reason) {
    this.dropped++;
    this.remove(client);
    try { client.res.destroy?.(); } catch { /* already gone */ }
    this.log(JSON.stringify({ event: 'trade_feed_dropped', reason }));
  }

  /** Publishes public trades grouped by network. An empty or oversized batch is trimmed, never queued. */
  publish(network, trades) {
    if (this.closed || !this.clients.size || !trades?.length) return 0;
    const batch = trades.slice(0, 20).map(trade => tradeFields(trade));
    const chunk = `event: trades\ndata: ${JSON.stringify({ network, trades: batch })}\n\n`;
    let sent = 0;
    for (const client of [...this.clients]) {
      if (this.write(client, chunk)) sent++;
      else this.drop(client, 'backpressure');
    }
    this.published += sent;
    return sent;
  }

  status() {
    return { clients: this.clients.size, published: this.published, dropped: this.dropped, heartbeatMs: this.heartbeatMs };
  }

  close() {
    this.closed = true;
    this.stopHeartbeat();
    for (const client of [...this.clients]) {
      try { client.res.end(); } catch { /* already gone */ }
      this.remove(client);
    }
  }
}
