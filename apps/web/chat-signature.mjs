export async function signChatText(ctx,message,withWalletTimeout){let signature;
   if(ctx.wallet===ctx.solWallet){
    if(!ctx.wallet.provider.signMessage)throw new Error('This Solana wallet does not support message signing.');
    const result=await withWalletTimeout(ctx.wallet.provider.signMessage(new TextEncoder().encode(message),'utf8'),ctx.wallet.walletName);signature=btoa(String.fromCharCode(...(result.signature??result)));
   }else{await ctx.wallet.checkNetwork();signature=await withWalletTimeout(ctx.wallet.signer.signMessage(message),ctx.wallet.walletName);}
   return signature;
 }
