// Trust only the configured public origin; proxy headers cannot expand this list.
export function publicOrigin(env = process.env) {
  const value = env.ELPIDA_PUBLIC_URL || (env.RAILWAY_PUBLIC_DOMAIN ? `https://${env.RAILWAY_PUBLIC_DOMAIN}` : '');
  if (!value) return null;
  const url = new URL(value);
  if (url.protocol !== 'https:' || url.username || url.password || url.pathname !== '/' || url.search || url.hash) {
    throw new Error('ELPIDA_PUBLIC_URL must be an HTTPS origin without credentials, a path, query or fragment.');
  }
  return url.origin;
}

export function acceptsRequest({ host, origin, method, path, port, publicUrl }) {
  const hosts = [`localhost:${port}`, `127.0.0.1:${port}`];
  const origins = hosts.map(value => `http://${value}`);
  if (publicUrl) { hosts.push(new URL(publicUrl).host); origins.push(publicUrl); }
  // Railway's special hostname is admitted only to the readiness endpoint.
  const healthcheck = method === 'GET' && path === '/health' && host === 'healthcheck.railway.app';
  return (hosts.includes(host) || healthcheck) && (!origin || origins.includes(origin));
}
