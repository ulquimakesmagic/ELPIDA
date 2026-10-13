import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {readFileSync,mkdirSync,writeFileSync,copyFileSync} from 'node:fs';
import {resolve,dirname,join} from 'node:path';
import {fileURLToPath} from 'node:url';
import solc from 'solc';

const root=fileURLToPath(new URL('../',import.meta.url));
const git=(...args)=>execFileSync('git',args,{cwd:root,encoding:'utf8'}).trim();
const files=git('ls-files').split('\n').filter(p=>/^(contracts\/evm\/.*\.sol|apps\/(api|web)\/.*\.(mjs|html|css|svg|png|woff2|webmanifest|txt)|packages\/.*\.(mjs|json)|tests\/.*\.(mjs|sol)|scripts\/.*\.mjs)$/.test(p)||['package.json','package-lock.json','hardhat.config.js','hardhat.config.mjs','config/native-pricing.json','docs/BASE_MAINNET_REVIEW.md','docs/BASE_FORK_LIFECYCLE.md','docs/LAUNCH_CONFIRMATION.md','docs/TESTNET_LIFECYCLE_VERIFICATION.md'].includes(p));
const stamp=new Date().toISOString().replace(/[:.]/g,'-');
const output=join(root,'backups','security-review',stamp);mkdirSync(output,{recursive:true});
const hashes=[];
for(const p of files){const src=resolve(root,p),dest=resolve(output,p);if(!src.startsWith(root)||!dest.startsWith(output+'\\')&&!dest.startsWith(output+'/'))throw new Error('Export path escaped the selected directory');mkdirSync(dirname(dest),{recursive:true});copyFileSync(src,dest);hashes.push({path:p,sha256:createHash('sha256').update(readFileSync(src)).digest('hex')});}
const manifest={createdAt:new Date().toISOString(),commit:git('rev-parse','HEAD'),workingTreeChanges:git('status','--porcelain').split('\n').filter(Boolean),compiler:solc.version(),settings:{optimizer:{enabled:true,runs:1},evmVersion:'shanghai'},scope:'Base model-9 review; includes compatibility sources for context; no mainnet deployment approval',exclusions:['credentials','private keys','recovery files','local data','fork caches','backups','synced project sources'],files:hashes};
writeFileSync(join(output,'MANIFEST.json'),JSON.stringify(manifest,null,2));
writeFileSync(join(output,'README.txt'),'Start with docs/BASE_MAINNET_REVIEW.md. Verify MANIFEST.json hashes and install locked dependencies with npm ci. The package is a review snapshot, not an audit certificate. Fork results are documented separately. No user secrets are included.\n');
console.log(JSON.stringify({output,commit:manifest.commit,files:files.length,compiler:manifest.compiler}));
