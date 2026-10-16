// Server-anchored clock. Chain, oracle and server timestamps are compared with this instead of the
// visitor's PC clock, so a wrong system clock or time zone cannot make fresh prices look stale.
let skew = 0;
/** Records the offset between this device and the server (seconds), from a response sent at `sentAt` ms. */
export function syncClock(serverTime, sentAt = Date.now()) {
  if (!Number.isFinite(serverTime) || serverTime <= 0) return;
  skew = (sentAt + Date.now()) / 2000 - serverTime;
}
/** Current time in Unix seconds, corrected to the server's clock. */
export const nowSeconds = () => Date.now() / 1000 - skew;
