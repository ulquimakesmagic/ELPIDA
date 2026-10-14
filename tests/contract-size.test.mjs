import test from 'node:test';
import assert from 'node:assert/strict';
import {compileContracts} from '../scripts/compile.mjs';

// EIP-170 caps deployed runtime code at 24,576 bytes and EIP-3860 caps initcode at 49,152 bytes.
// Release contracts keep a safety margin under 24,000 bytes so small fixes do not push them over.
const RELEASE=['ElpidaDexFactory','ElpidaDexCurveDeployer','ElpidaDexCurve','ElpidaToken','ElpidaV3MigrationAdapter','ElpidaV3FeeLocker','ElpidaFeeSplitter'];
test('every deployable contract fits the EVM size limits; release contracts keep a margin',()=>{
 const compiled=compileContracts({includeMocks:false});
 const sizes={};
 for(const entries of Object.values(compiled))for(const [name,a] of Object.entries(entries)){
  const runtime=a.evm.deployedBytecode.object.length/2,init=a.evm.bytecode.object.length/2;if(!runtime)continue;
  sizes[name]=runtime;
  assert.ok(runtime<=24576,`${name} runtime ${runtime} bytes exceeds EIP-170`);
  assert.ok(init<=49152,`${name} initcode ${init} bytes exceeds EIP-3860`);
 }
 for(const name of RELEASE){assert.ok(sizes[name],`${name} compiled`);assert.ok(sizes[name]<=24000,`${name} runtime ${sizes[name]} bytes is over the 24,000-byte release margin`);}
});
