import {createServer} from 'node:http';
import {randomBytes} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import {HolderRehearsal} from './holder-rehearsal.mjs';

/** Standalone loopback server. Never mounted by the production API. */
export async function startRehearsalServer({port=0}={}){
 const csrf=randomBytes(32).toString('hex');const rehearsal=new HolderRehearsal();let busy=false;
 const files=new Map([['/',['holder-rehearsal.html','text/html']],['/holder-rehearsal.mjs',['holder-rehearsal.mjs','text/javascript']],['/holder-rehearsal.css',['holder-rehearsal.css','text/css']]]);
 const server=createServer(async(req,res)=>{
  const send=(code,data)=>{res.writeHead(code,{'Content-Type':'application/json'});res.end(JSON.stringify(data));};
  res.setHeader('Cache-Control','no-store');res.setHeader('X-Content-Type-Options','nosniff');res.setHeader('Content-Security-Policy',"default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
  const origin='http://127.0.0.1:'+server.address().port;
  // Reject DNS rebinding, forwarded hosts, cross-origin reads and every cross-origin mutation.
  if(req.headers.host!==new URL(origin).host||req.headers.origin&&req.headers.origin!==origin)return send(403,{error:'Loopback rehearsal origin required.'});
  const url=new URL(req.url,origin);
  try{
   if(req.method==='GET'){
    if(url.pathname==='/api/state'){
     if(busy)return send(409,{error:'A rehearsal step is running.'});
     return send(200,{...await rehearsal.state(),csrf});
    }
    if(url.pathname==='/api/manifest')return rehearsal.manifest?send(200,rehearsal.manifest):send(404,{error:'Verify the snapshot first.'});
    const file=files.get(url.pathname);if(!file)return send(404,{error:'Not found.'});
    res.writeHead(200,{'Content-Type':file[1]+'; charset=utf-8'});return res.end(await readFile(new URL('../web/'+file[0],import.meta.url)));
   }
   if(req.method!=='POST'||url.pathname!=='/api/action')return send(405,{error:'Method not allowed.'});
   if(req.headers.origin!==origin||req.headers['x-rehearsal-token']!==csrf||req.headers['content-type']!=='application/json')return send(403,{error:'Rehearsal token and matching origin required.'});
   if(busy)return send(409,{error:'A rehearsal step is running.'});
   let size=0,body='';for await(const chunk of req){size+=chunk.length;if(size>1024)return send(413,{error:'Request too large.'});body+=chunk;}
   const input=JSON.parse(body);
   if(!['setup','trade','sync','snapshot','fund','advance','pay','retry'].includes(input.action)||Object.keys(input).some(k=>k!=='action'))return send(400,{error:'Only fixed local rehearsal actions are allowed.'});
   // Recheck after asynchronous body reading to serialize concurrent mutations.
   if(busy)return send(409,{error:'A rehearsal step is running.'});
   busy=true;try{return send(200,{...await rehearsal.act(input.action),csrf});}finally{busy=false;}
  }catch(error){return send(400,{error:String(error.message).slice(0,500)});}
 });
 await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(port,'127.0.0.1',resolve);});
 return {url:'http://127.0.0.1:'+server.address().port,rehearsal,close:async()=>{await new Promise(resolve=>server.close(resolve));await rehearsal.close();}};
}
