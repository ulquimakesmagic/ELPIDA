import assert from 'node:assert/strict';
import {mkdirSync,writeFileSync} from 'node:fs';
import {network} from 'hardhat';
import {BrowserProvider,JsonRpcSigner,Contract,parseUnits,toBeHex,ZeroAddress} from 'ethers';
import {compileContracts} from './compile.mjs';
import {baseSepoliaDex,v3Artifacts} from '../packages/core/uniswap.mjs';

// All writes use an in-process simulated provider. The upstream RPC is read-only.
const TOKEN='0xacaf8a75eefed9d824b1de809305feb5af8b149a';
const CURVE='0x9dc75d4cdf6871520706658a052262bbe37c78c6';
const USDC='0x036CbD53842c5426634e7929541eC2318f3dCF7e';
const rpc=process.env.ELPIDA_BASE_FORK_RPC??'https://sepolia.base.org';
async function remote(method,params=[]){const r=await fetch(rpc,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({jsonrpc:'2.0',id:1,method,params}),signal:AbortSignal.timeout(20000)});const data=await r.json();if(data.error)throw new Error('Upstream read failed: '+data.error.message);return data.result;}
assert.equal(Number(BigInt(await remote('eth_chainId'))),84532,'upstream must be Base Sepolia');
const block=process.env.ELPIDA_BASE_FORK_BLOCK?Number(process.env.ELPIDA_BASE_FORK_BLOCK):Number(BigInt(await remote('eth_blockNumber')))-10;
assert.ok(Number.isSafeInteger(block)&&block>0);
console.log(JSON.stringify({stage:'fork_start',block,scope:'local fork only',token:TOKEN}));
const compiled=compileContracts(),art=n=>compiled['contracts/evm/src/'+n+'.sol'][n];
const connection=await network.create({network:'localTest',override:{chainId:31337,hardfork:'cancun',forking:{url:rpc,blockNumber:block}}});
const provider=new BrowserProvider(connection.provider,undefined,{cacheTimeout:-1});provider.pollingInterval=10;
const report={scope:'LOCAL FORK ONLY — public token unchanged',upstreamChain:84532,block,token:TOKEN,curve:CURVE,transactions:[],checks:[]};
const send=async(label,tx)=>{const receipt=await(await tx).wait();assert.equal(receipt.status,1);report.transactions.push({action:label,hash:receipt.hash,gas:receipt.gasUsed.toString()});console.log(JSON.stringify({stage:label,status:'passed'}));return receipt;};
try{
 assert.equal(Number((await provider.getNetwork()).chainId),31337,'mutations must stay on the simulated chain');
 await provider.send('hardhat_metadata',[]); // Refuse any provider without the local testing API.
 await provider.send('evm_mine',[]); // Execute against a local block, not upstream hardfork history.
 const signer=await provider.getSigner(0),account=await signer.getAddress();
 const curve=new Contract(CURVE,art('ElpidaDexCurve').abi,signer),token=new Contract(TOKEN,art('ElpidaToken').abi,signer);
 const coin=new Contract(USDC,['function masterMinter() view returns(address)','function configureMinter(address,uint256) returns(bool)','function mint(address,uint256) returns(bool)','function approve(address,uint256) returns(bool)','function balanceOf(address) view returns(uint256)','function decimals() view returns(uint8)'],signer);
 assert.equal((await curve.token()).toLowerCase(),TOKEN);assert.equal((await curve.quote()).toLowerCase(),USDC.toLowerCase());assert.equal(await coin.decimals(),6n);
 assert.equal(await curve.pool(),ZeroAddress);assert.equal(await curve.complete(),false);
 const adapter=new Contract(await curve.migrationAdapter(),art('ElpidaV3MigrationAdapter').abi,provider);
 assert.equal((await adapter.manager()).toLowerCase(),baseSepoliaDex.manager.toLowerCase());assert.equal((await adapter.dexFactory()).toLowerCase(),baseSepoliaDex.factory.toLowerCase());
 const master=await coin.masterMinter();
 await provider.send('hardhat_impersonateAccount',[master]);await provider.send('hardhat_setBalance',[master,toBeHex(parseUnits('10',18))]);
 await send('local minter setup',coin.connect(new JsonRpcSigner(provider,master)).configureMinter(account,parseUnits('20000',6)));
 await send('local USDC funding',coin.mint(account,parseUnits('20000',6)));
 await provider.send('hardhat_stopImpersonatingAccount',[master]);
 const remaining=await curve.completionQuote();report.completionUsdc=remaining.toString();
 const expected=await curve.quoteBuy(remaining);await send('bounded curve approval',coin.approve(CURVE,remaining));
 await send('complete curve',curve.buy(remaining,expected[0]*99n/100n));assert.equal(await curve.complete(),true);
 const terminalQ=await curve.virtualQuote()+await curve.realReserve(),terminalT=await curve.virtualToken()-await curve.sold();
 await send('graduate to public DEX copy',curve.graduate({gasLimit:15000000}));
 const poolAddress=await curve.pool();assert.notEqual(poolAddress,ZeroAddress);
 const manager=new Contract(baseSepoliaDex.manager,v3Artifacts.manager.abi,signer),pool=new Contract(poolAddress,v3Artifacts.pool.abi,provider);
 const lockerAddress=await curve.locker(),id=await curve.positionId(),locker=new Contract(lockerAddress,art('ElpidaV3FeeLocker').abi,signer);
 assert.equal((await manager.ownerOf(id)).toLowerCase(),lockerAddress.toLowerCase());assert.equal(await locker.locked(),true);
 const liquidity=(await manager.positions(id)).liquidity;assert.ok(liquidity>0n);
 const tokenFirst=(await pool.token0()).toLowerCase()===TOKEN,sqrt=(await pool.slot0())[0],n=tokenFirst?sqrt*sqrt:2n**192n,d=tokenFirst?2n**192n:sqrt*sqrt;
 const actual=n*10n**30n/d,expectedPrice=terminalQ*10n**30n/terminalT;
 assert.ok((actual>expectedPrice?actual-expectedPrice:expectedPrice-actual)*1000000n<=expectedPrice,'terminal price continuity');
 report.pool=poolAddress;report.locker=lockerAddress;report.positionId=id.toString();report.checks.push('terminal price continuity','position permanently locked');
 const router=new Contract(baseSepoliaDex.router,v3Artifacts.router.abi,signer),buy=parseUnits('100',6);
 await send('bounded DEX buy approval',coin.approve(router.target,buy));
 const args={tokenIn:USDC,tokenOut:TOKEN,fee:10000,recipient:account,amountIn:buy,amountOutMinimum:0,sqrtPriceLimitX96:0};
 const out=await router.exactInputSingle.staticCall(args);assert.ok(out>0n);
 await send('post graduation buy',router.exactInputSingle({...args,amountOutMinimum:out*99n/100n}));
 const sell=parseUnits('1000000',18);await send('bounded DEX sell approval',token.approve(router.target,sell));
 const sellArgs={...args,tokenIn:TOKEN,tokenOut:USDC,amountIn:sell};const sellOut=await router.exactInputSingle.staticCall(sellArgs),balance=await coin.balanceOf(account);assert.ok(sellOut>0n);
 await send('post graduation sell',router.exactInputSingle({...sellArgs,amountOutMinimum:sellOut*99n/100n}));assert.ok(await coin.balanceOf(account)>balance);
 await send('collect locked position fees',locker.collectFees());
 const splitter=new Contract(await curve.feeSplitter(),art('ElpidaFeeSplitter').abi,signer);
 const recipients=[...new Set([await curve.protocolTreasury(),await curve.creatorRewardVault()].map(a=>a.toLowerCase()))];
 for(const asset of [TOKEN,USDC])for(const recipient of recipients){const owed=await splitter.claimable(asset,recipient);assert.ok(owed>0n);const assetContract=asset===TOKEN?token:coin,before=await assetContract.balanceOf(recipient);await send('claim position fees',splitter.claim(asset,recipient));assert.equal(await assetContract.balanceOf(recipient)-before,owed);assert.equal(await splitter.claimable(asset,recipient),0n);}
 await send('claim curve fees',curve.withdrawFees());assert.equal(await curve.creatorFees(),0n);assert.equal(await curve.protocolFees(),0n);
 assert.equal((await manager.positions(id)).liquidity,liquidity);assert.equal((await manager.ownerOf(id)).toLowerCase(),lockerAddress.toLowerCase());
 await assert.rejects(manager.decreaseLiquidity.staticCall({tokenId:id,liquidity,amount0Min:0,amount1Min:0,deadline:Math.floor(Date.now()/1000)+3600}));
 report.checks.push('both DEX trade directions','creator and protocol fee payouts','principal unchanged after collection','unauthorized liquidity withdrawal rejected');report.result='PASS';
}catch(error){report.result='FAIL';report.error=error.shortMessage??error.message;throw error;}
finally{mkdirSync('backups/base-fork',{recursive:true});writeFileSync('backups/base-fork/lifecycle-report.json',JSON.stringify(report,null,2));provider.destroy();await connection.close();console.log(JSON.stringify({stage:'report',result:report.result,path:'backups/base-fork/lifecycle-report.json'}));}
