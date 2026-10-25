import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,rmSync,readFileSync,writeFileSync,copyFileSync,existsSync,utimesSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {DatabaseSync} from 'node:sqlite';
import {MetadataStore} from '../apps/api/metadata-store.mjs';
import {createPublicBackup,restorePublicBackup,cleanupDuplicateTemps} from '../apps/api/storage-operations.mjs';
test('online backup restores WAL state, metadata and retention into a fresh directory; corruption and overwrite fail closed',async t=>{
 const dir=mkdtempSync(join(tmpdir(),'elpida-restore-'));let db,thesisDb;t.after(()=>{db?.close();thesisDb?.close();rmSync(dir,{recursive:true,force:true});});const source=join(dir,'data');mkdirSync(source);
 const store=new MetadataStore({path:join(source,'ipfs-content'),jwt:null,chainBound:true});const published=await store.publish({name:'Backup',symbol:'BACK',description:'Persistent metadata'});store.retainPublished(published.uri);
 writeFileSync(join(source,'circle-test-wallets.json'),'DO NOT EXPORT');writeFileSync(join(source,'.env'),'DO NOT EXPORT');
 const dbName='public-84532-0x'+'11'.repeat(20)+'.sqlite';db=new DatabaseSync(join(source,dbName));db.exec('PRAGMA journal_mode=WAL; CREATE TABLE tokens(address TEXT);');db.prepare('INSERT INTO tokens VALUES(?)').run('verified-token');
 thesisDb=new DatabaseSync(join(source,'public-theses.sqlite'));thesisDb.exec("PRAGMA journal_mode=WAL; CREATE TABLE thesis_revisions(text TEXT); INSERT INTO thesis_revisions VALUES('Saved holder thesis');");
 const snapshot=join(dir,'snapshot'),manifest=await createPublicBackup(source,snapshot);assert.ok(!manifest.files.some(f=>f.path.includes('circle')||f.path.includes('.env')));
 const restored=join(dir,'restored');restorePublicBackup(snapshot,restored);assert.equal((await new MetadataStore({path:join(restored,'ipfs-content'),jwt:null}).resolve(published.uri)).description,'Persistent metadata');
 const reader=new DatabaseSync(join(restored,dbName));assert.equal(reader.prepare('SELECT address FROM tokens').get().address,'verified-token');reader.close();const restoredThesis=new DatabaseSync(join(restored,'public-theses.sqlite'));assert.equal(restoredThesis.prepare('SELECT text FROM thesis_revisions').get().text,'Saved holder thesis');restoredThesis.close();
 assert.throws(()=>restorePublicBackup(snapshot,restored),/overwrite/);assert.equal(new MetadataStore({path:join(restored,'ipfs-content'),jwt:null}).status().storage.pendingBytes,0);
 writeFileSync(join(snapshot,manifest.files[0].path),'corrupt');const bad=join(dir,'bad');assert.throws(()=>restorePublicBackup(snapshot,bad),/integrity/);assert.equal(existsSync(bad),false);
});
test('cleanup only removes old identical temporary duplicates and preserves uncertain content',async t=>{
 const dir=mkdtempSync(join(tmpdir(),'elpida-cleanup-'));t.after(()=>rmSync(dir,{recursive:true,force:true}));const store=new MetadataStore({path:dir,jwt:null});const p=await store.publish({name:'Keep',symbol:'KEEP'}),file=store.file(p.uri.slice(7));copyFileSync(file,file+'.tmp');utimesSync(file+'.tmp',new Date(0),new Date(0));
 const other=store.file('b'+'a'.repeat(40))+'.tmp';writeFileSync(other,'uncertain');utimesSync(other,new Date(0),new Date(0));
 assert.equal(cleanupDuplicateTemps(dir).length,1);assert.equal(existsSync(file+'.tmp'),true);assert.equal(cleanupDuplicateTemps(dir,{apply:true}).length,1);assert.equal(existsSync(file),true);assert.equal(existsSync(other),true);assert.equal((await store.resolve(p.uri)).symbol,'KEEP');
});
test('the simulation journal and token metadata are backed up, and wallet records are not',async t=>{
 const dir=mkdtempSync(join(tmpdir(),'elpida-journal-'));t.after(()=>rmSync(dir,{recursive:true,force:true}));
 const source=join(dir,'data');mkdirSync(source);
 const journal='{"action":"launch"}\n{"action":"buy","amount":"1"}\n';
 writeFileSync(join(source,'simulation-journal-v2.jsonl'),journal);
 writeFileSync(join(source,'token-metadata.json'),'{"0xabc":{"name":"Hope"}}');
 writeFileSync(join(source,'circle-test-wallets.json'),'DO NOT EXPORT');
 const snapshot=join(dir,'snapshot'),manifest=await createPublicBackup(source,snapshot);
 assert.ok(manifest.files.some(f=>f.path==='simulation-journal-v2.jsonl'),'the journal must be in the backup');
 assert.ok(manifest.files.some(f=>f.path==='token-metadata.json'));
 assert.ok(!manifest.files.some(f=>f.path==='circle-test-wallets.json'),'wallet records stay out');
 const restored=join(dir,'restored');restorePublicBackup(snapshot,restored);
 assert.equal(readFileSync(join(restored,'simulation-journal-v2.jsonl'),'utf8'),journal,'the demo economy survives a restore');
});
