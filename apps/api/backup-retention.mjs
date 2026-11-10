// reviewRetention: a read-only report. retentionPlan: which snapshot sets the backup runner deletes after a newer one is
// verified (Malik, 10 November: 30 daily full copies had filled 27 GB because nothing was ever removed).
export function reviewRetention(objects,{now=Date.now(),days=30,keep=7}={}){
 if(!Number.isSafeInteger(now)||!Number.isInteger(days)||days<7||days>3650||!Number.isInteger(keep)||keep<2||keep>3650)throw new Error('Invalid retention review policy');
 const groups=new Map();let unrecognizedObjects=0;
 for(const object of objects){
  const m=object.key.match(/^elpida-backups\/(ops-(\d{13})-[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})\/(.+)$/);
  if(!m){unrecognizedObjects++;continue;}
  const g=groups.get(m[1])??{id:m[1],createdAt:Number(m[2]),objects:0,bytes:0,manifestPresent:false};g.objects++;g.bytes+=object.size;if(m[3]==='MANIFEST.json.enc')g.manifestPresent=true;groups.set(g.id,g);
 }
 const committed=[...groups.values()].filter(g=>g.manifestPresent&&g.createdAt<=now).sort((a,b)=>b.createdAt-a.createdAt||b.id.localeCompare(a.id)),protectedIds=new Set(committed.slice(0,keep).map(g=>g.id));
 const candidates=committed.filter(g=>!protectedIds.has(g.id)&&now-g.createdAt>days*86400000),ids=new Set(candidates.map(g=>g.id));
 return {mode:'review-only',policy:{olderThanDays:days,minimumCommittedSnapshots:keep},checkedAt:new Date(now).toISOString(),committedSnapshots:committed.length,candidates,retained:[...groups.values()].filter(g=>!ids.has(g.id)).map(g=>({...g,reason:!g.manifestPresent?'incomplete-needs-review':g.createdAt>now?'future-dated-needs-review':protectedIds.has(g.id)?'newest-protected':'within-retention'})),unrecognizedObjects,note:'Manifest presence is a completion marker, not a new restore verification. No objects deleted. Review recovery requirements and verify retained snapshots before any separately approved cleanup.'};
}

const SNAPSHOT=/^elpida-backups\/(ops-(\d{13})-[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})\/(.+)$/;
const DAY=86400000,week=t=>Math.floor((t/DAY+3)/7),month=t=>{const d=new Date(t);return d.getUTCFullYear()*12+d.getUTCMonth();};
/**
 * Keeps the newest `daily` complete snapshots, the newest in each of the last `weekly` weeks and `monthly` months (UTC),
 * and never fewer than 2. Deletes the other complete ones, and incomplete sets (no manifest, so unrestorable) older than
 * `incompleteDays` and older than the newest complete one. Objects it does not recognise and future-dated sets are kept.
 * Returns { delete: [{id, keys, bytes}], keep: [id] }.
 */
export function retentionPlan(objects,{now=Date.now(),daily=7,weekly=4,monthly=3,incompleteDays=7}={}){
 for(const v of [daily,weekly,monthly])if(!Number.isInteger(v)||v<0||v>3650)throw new Error('Invalid retention policy');
 if(!Number.isSafeInteger(now)||!Number.isInteger(incompleteDays)||incompleteDays<1)throw new Error('Invalid retention policy');
 const groups=new Map();
 for(const o of objects){const m=String(o.key).match(SNAPSHOT);if(!m)continue;const g=groups.get(m[1])??{id:m[1],createdAt:Number(m[2]),keys:[],bytes:0,complete:false};g.keys.push(o.key);g.bytes+=o.size??0;if(m[3]==='MANIFEST.json.enc')g.complete=true;groups.set(g.id,g);}
 const all=[...groups.values()].filter(g=>g.createdAt<=now),complete=all.filter(g=>g.complete).sort((a,b)=>b.createdAt-a.createdAt||b.id.localeCompare(a.id));
 const keep=new Set(complete.slice(0,Math.max(2,daily)).map(g=>g.id));
 for(const [n,bucketOf] of [[weekly,week],[monthly,month]]){const seen=new Set();for(const g of complete){const b=bucketOf(g.createdAt);if(seen.has(b))continue;seen.add(b);if(seen.size>n)break;keep.add(g.id);}}
 const newest=complete[0]?.createdAt??-Infinity;
 const drop=all.filter(g=>g.complete?!keep.has(g.id):now-g.createdAt>incompleteDays*DAY&&g.createdAt<newest);
 return {delete:drop.map(g=>({id:g.id,keys:g.keys,bytes:g.bytes})),keep:[...groups.values()].filter(g=>!drop.includes(g)).map(g=>g.id)};
}
