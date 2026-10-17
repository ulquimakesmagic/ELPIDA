import {startRehearsalServer} from '../apps/api/holder-rehearsal-server.mjs';
const app=await startRehearsalServer();
console.log('Local holder rehearsal: '+app.url);
console.log('Private Hardhat chain only. No wallet connection, external RPC or real funds.');
for(const signal of ['SIGINT','SIGTERM'])process.once(signal,async()=>{await app.close();process.exit(0);});
