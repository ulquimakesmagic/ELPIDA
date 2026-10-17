import test from 'node:test';
import assert from 'node:assert/strict';
import {Wallet,verifyMessage} from 'ethers';
import {signChatText} from '../apps/web/chat-signature.mjs';

test('browser chat signing sends the exact post or report text to the selected EVM wallet',async()=>{
 const signer=Wallet.createRandom();let checks=0;const ctx={wallet:{checkNetwork:async()=>{checks++;},signer}};
 for(const text of ['Elpida holder chat\nPublic message','Elpida chat report\nPrivate report']){const signature=await signChatText(ctx,text,p=>p);assert.equal(verifyMessage(text,signature),signer.address);}
 assert.equal(checks,2);
});
test('browser chat signing preserves Solana bytes and supports both wallet return formats',async()=>{
 for(const wrapped of [true,false]){const wallet={provider:{signMessage:async(bytes)=>{assert.equal(new TextDecoder().decode(bytes),'Report 🎉');const signature=new Uint8Array(64).fill(7);return wrapped?{signature}:signature;}}};assert.equal(await signChatText({wallet,solWallet:wallet},'Report 🎉',p=>p),Buffer.alloc(64,7).toString('base64'));}
 const wallet={provider:{}};await assert.rejects(signChatText({wallet,solWallet:wallet},'Report',p=>p),/does not support/);
});
