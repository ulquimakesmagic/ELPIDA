import {existsSync} from 'node:fs';
import {resolve} from 'node:path';
import {HolderChat} from '../apps/api/holder-chat.mjs';

// Run only on the trusted server host against its existing persistent database.
const [path,action,id,...reason]=process.argv.slice(2);
if(!path||!['reports','audit','hide','restore'].includes(action)||!existsSync(resolve(path)))throw new Error('Usage: node scripts/chat-moderation.mjs <existing database> reports|audit|hide|restore [message ID] [reason]');
const chat=new HolderChat({path:resolve(path),holding:async()=>false});
try{
 if(action==='reports')console.log(JSON.stringify(chat.db.prepare('SELECT r.*,m.text,m.author AS message_author FROM chat_reports r JOIN chat_messages m ON m.id=r.message_id ORDER BY r.id DESC LIMIT 100').all(),null,2));
 else if(action==='audit')console.log(JSON.stringify(chat.db.prepare('SELECT * FROM chat_moderation ORDER BY id DESC LIMIT 100').all(),null,2));
 else console.log(JSON.stringify(chat.moderate(Number(id),action==='hide',reason.join(' '))));
}finally{chat.close();}
