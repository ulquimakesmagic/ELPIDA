// Lets Node tests import browser modules from apps/web. The browser loads a few modules from absolute paths that the
// server maps (see `vendorFiles` in apps/api/server.mjs); this resolve hook maps the same paths for Node.
import { register } from 'node:module';

const hooks = `
const map = {
  '/vendor/ethers.js': 'ethers',
  '/pairs.mjs': ${JSON.stringify(new URL('../../packages/core/pairs.mjs', import.meta.url).href)},
  '/curve-model.mjs': ${JSON.stringify(new URL('../../packages/core/curve-model.mjs', import.meta.url).href)},
  '/dex-router.mjs': ${JSON.stringify(new URL('../../packages/core/dex-router.mjs', import.meta.url).href)},
  '/elpida-solana.mjs': ${JSON.stringify(new URL('../../packages/solana/client.mjs', import.meta.url).href)},
  '/paced-rpc.mjs': ${JSON.stringify(new URL('../../apps/web/paced-rpc.mjs', import.meta.url).href)},
  '/vendor/pumpswap.mjs': ${JSON.stringify(new URL('../../apps/web/vendor/pumpswap.mjs', import.meta.url).href)},
};
export async function resolve(specifier, context, next) {
  return map[specifier] ? next(map[specifier], context) : next(specifier, context);
}`;
register('data:text/javascript,' + encodeURIComponent(hooks), import.meta.url);
