// Review only: no bucket objects are removed by this module.
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
