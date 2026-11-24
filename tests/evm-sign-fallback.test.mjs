import test from 'node:test';
import assert from 'node:assert/strict';
import { errorText } from '../apps/web/ui.mjs';

test('"could not coalesce error" shows the wallet\'s own words, or a plain next step', () => {
  assert.equal(errorText({ message: 'could not coalesce error (error={ "code": -32603 })', error: { message: 'Chain 4663 is not supported' } }), 'Your wallet refused: Chain 4663 is not supported');
  assert.match(errorText({ message: 'could not coalesce error' }), /could not read\. Unlock it/);
  assert.match(errorText({ code: 'ACTION_REJECTED', message: 'user rejected' }), /cancelled/);
});
