export function evaluateOperations({now=Date.now(),startedAt=now,storage={},networks={},prices={},backup={},graduation,durable=false}={}){
 const incidents=[],add=(code,severity,message)=>incidents.push({code,severity,message});
 if(!durable)add('storage_ephemeral','warning','Persistent storage is not configured.');
 for(const [field,cap,code] of [['bytes','maxBytes','storage_capacity'],['pendingBytes','maxPendingBytes','pending_capacity']])if(storage[cap]>0&&storage[field]/storage[cap]>=0.8)add(code,storage[field]>=storage[cap]?'critical':'warning','Metadata storage is approaching its limit.');
 if(storage.expiredPendingBytes>0)add('pending_review','warning','Old provisional uploads need review; they have not been deleted.');
 const warm=now-startedAt<180000;
 if(graduation){
  if(!graduation.enabled)add('graduation_disabled','warning','Automatic Base Sepolia graduation needs an operator gas wallet.');
  else if(graduation.state==='retrying'||graduation.reason)add('graduation_delayed','critical','Automatic graduation needs operator attention: '+(graduation.reason??'transaction reverted')+'.');
 }
 for(const [name,n] of Object.entries(networks))if(n.enabled){
  if(!warm&&(n.error||!Number.isFinite(Date.parse(n.lastSuccess))||now-Date.parse(n.lastSuccess)>180000||Number(n.lag)>100))add('indexer_'+name,'critical','Public indexing is behind or unavailable on '+name+'.');
  const p=prices[name];if(!warm&&(!p||p.status!=='fresh'||!Number.isFinite(p.usd)||p.usd<=0||now/1000-p.updatedAt>(p.maxAge??180)))add('price_'+name,'warning','A fresh display price is unavailable on '+name+'. On-chain launch pricing is checked separately.');
 }
 if(backup.lastError)add('backup_failed','critical','The last backup attempt or configuration failed.');
 else if(!backup.enabled)add('backup_disabled','warning','Automatic off-site backups are not configured.');
 else if(!warm&&backup.running&&!backup.lastSuccess&&now-Date.parse(backup.lastAttempt)<3600000)add('backup_initializing','warning','The first off-site backup is being verified.');
 else if(!warm&&(!Number.isFinite(Date.parse(backup.lastSuccess))||now-Date.parse(backup.lastSuccess)>backup.intervalMs*2))add('backup_overdue','critical','A verified off-site backup is overdue.');
 // A mirror problem is a warning: the primary backup still protects against data loss, but not a provider outage.
 if(backup.mirror?.enabled&&!backup.lastError&&backup.enabled){
  if(backup.mirror.lastError)add('backup_mirror_failed','warning','The second-provider backup copy failed; the primary backup is unaffected.');
  else if(!warm&&backup.lastSuccess&&!backup.mirror.current&&now-Date.parse(backup.lastSuccess)>3*3600000)add('backup_mirror_behind','warning','The latest backup has not reached the second provider yet.');
 }
 return {status:incidents.some(i=>i.severity==='critical')?'critical':incidents.length?'degraded':'ok',checkedAt:new Date(now).toISOString(),incidents};
}
export class OperationsMonitor{
 constructor({read,log=console.log,now=Date.now}={}){this.read=read;this.log=log;this.now=now;this.active=new Map();}
 tick(){const status=evaluateOperations({...this.read(),now:this.now()});const next=new Map(status.incidents.map(i=>[i.code,i]));for(const [code,i] of next)if(this.active.get(code)?.severity!==i.severity)this.log(JSON.stringify({event:'operations_incident',state:'active',...i}));for(const [code,i] of this.active)if(!next.has(code))this.log(JSON.stringify({event:'operations_incident',state:'resolved',code,severity:i.severity}));this.active=next;return status;}
}
