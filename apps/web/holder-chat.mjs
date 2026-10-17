import {h,short,errorText} from './ui.mjs';
import {withWalletTimeout} from './wallet.mjs';
const drafts=new Map();

/** Public messages; signing and live holder eligibility are required for posting. */
export function holderChat(ctx,token){
 const network=ctx.currentChain(),author=ctx.mode==='testnet'?ctx.wallet.address:null,key=`${network}:${token.address}:${author??'guest'}`;
 if(drafts.size>100)drafts.delete(drafts.keys().next().value);
 const draft=drafts.get(key)??{text:'',replyTo:null,pending:false};drafts.set(key,draft);
 let alive=true,reading=false,canPost=false,nextBefore=null,timer=null,browsingHistory=false;
 const messages=new Map(),list=h('div.chat-messages',{role:'log','aria-label':'Holder messages'}),status=h('p.small',{role:'status','aria-live':'polite'}),hint=h('p.hint'),reply=h('div.chat-reply'),count=h('span.hint'),input=h('textarea.input',{rows:3,maxLength:1000,'aria-label':'Chat message',placeholder:`Message ${token.symbol} holders…`}),send=h('button.btn.btn-primary',{type:'button'},'Send message');
 input.value=draft.text;
 const refresh=h('button.btn.btn-secondary.btn-sm',{type:'button',on:{click:()=>load()}},'Refresh');
 const older=h('button.btn.btn-secondary.btn-sm',{type:'button',hidden:true,on:{click:()=>load(nextBefore)}},'Load older messages');
 const box=h('div.holder-chat',h('p.small.muted','Public chat. Current token holders can post and reply with a wallet signature. No gas fee or token transfer. Messages remain visible if the author later sells.'),h('div.chat-toolbar',refresh,older),list,h('div.chat-composer',reply,input,h('div.chat-compose-actions',count,send),hint,status));
 function drawComposer(){
  input.disabled=draft.pending||!canPost;send.disabled=draft.pending||!canPost||!draft.text.trim();send.textContent=draft.pending?'Waiting for signature…':'Send message';count.textContent=`${draft.text.length}/1,000`;
  hint.textContent=!author?'Connect a wallet holding this token to chat.':canPost?'Sign each message in your selected wallet. Allow 15 seconds between messages.':'Hold this token in the connected wallet to post. Reading is public.';
  reply.replaceChildren(...(draft.replyTo?[h('span',`Replying to message #${draft.replyTo}`),h('button.link-button',{type:'button',disabled:draft.pending,on:{click:()=>{draft.replyTo=null;drawComposer();}}},'Cancel reply')]:[]));
 }
 function drawMessages(){
  const height=list.scrollHeight,atBottom=height-list.scrollTop-list.clientHeight<48;
  const sorted=[...messages.values()].sort((a,b)=>a.id-b.id);
  list.replaceChildren(...(sorted.length?sorted.map(m=>h('article.chat-message',h('div.chat-byline',h('strong',{title:m.author},short(m.author)),h('time',{dateTime:new Date(m.created).toISOString()},new Date(m.created).toLocaleString())),m.reply?h('blockquote',`${short(m.reply.author)} · ${m.reply.text}`):null,h('p.chat-text',m.text),h('button.link-button',{type:'button',disabled:!canPost||draft.pending,on:{click:()=>{draft.replyTo=m.id;drawComposer();input.focus();}}},'Reply'))):[h('p.muted','No messages yet. Hold this token and start the conversation.')]));
  older.hidden=!nextBefore;
  if(browsingHistory)list.scrollTop+=list.scrollHeight-height;
  else if(atBottom)list.scrollTop=list.scrollHeight;
 }
 async function load(before=null){
  if(!alive||reading)return;reading=true;refresh.disabled=true;older.disabled=true;
  try{
   const data=await ctx.api(`chat?network=${encodeURIComponent(network)}&token=${encodeURIComponent(token.address)}${author?`&author=${encodeURIComponent(author)}`:''}${before?`&before=${before}`:''}`);
   if(!alive||!box.isConnected)return;
   if(!before)messages.clear();
   for(const message of data.messages)messages.set(message.id,message);
   nextBefore=data.nextBefore;browsingHistory=!!before;
   canPost=!!author&&ctx.mode==='testnet'&&!!data.canPost;drawMessages();drawComposer();
  }catch(error){if(alive){status.textContent='Chat could not refresh: '+errorText(error);canPost=false;drawComposer();}}
  finally{reading=false;refresh.disabled=false;older.disabled=false;}
 }
 input.addEventListener('input',()=>{draft.text=input.value;drawComposer();});
 send.addEventListener('click',async()=>{
  if(draft.pending||!canPost||!draft.text.trim())return;
  draft.pending=true;status.textContent='Preparing your public message…';drawComposer();drawMessages();
  try{
   const body={network,token:token.address,author,text:draft.text,replyTo:draft.replyTo},prepared=await ctx.api('chat/prepare',body);
   status.textContent='Confirm “Elpida holder chat” in your selected wallet. This posts text publicly; it does not move funds.';let signature;
   if(ctx.wallet===ctx.solWallet){
    if(!ctx.wallet.provider.signMessage)throw new Error('This Solana wallet does not support message signing.');
    const result=await withWalletTimeout(ctx.wallet.provider.signMessage(new TextEncoder().encode(prepared.message),'utf8'),ctx.wallet.walletName);signature=btoa(String.fromCharCode(...(result.signature??result)));
   }else{await ctx.wallet.checkNetwork();signature=await withWalletTimeout(ctx.wallet.signer.signMessage(prepared.message),ctx.wallet.walletName);}
   if(ctx.wallet.address!==author||ctx.currentChain()!==network)throw new Error('Wallet or network changed. Reopen this token before sending.');
   await ctx.api('chat/save',{...body,nonce:prepared.nonce,signature});draft.text='';draft.replyTo=null;input.value='';status.textContent='Message posted.';await load();
  }catch(error){status.textContent=errorText(error);}finally{draft.pending=false;if(alive){drawComposer();drawMessages();}if(!box.isConnected)ctx.refresh();}
 });
 function poll(){timer=setTimeout(async()=>{if(!alive||!box.isConnected){alive=false;return;}if(!document.hidden&&!draft.pending&&!browsingHistory)await load();if(alive)poll();},15000);}
 drawComposer();queueMicrotask(()=>{load();poll();});
 return {element:box,dispose(){alive=false;clearTimeout(timer);}};
}
