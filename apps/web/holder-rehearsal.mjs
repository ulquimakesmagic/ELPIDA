let state,csrf,busy=false;
const $=s=>document.querySelector(s);
const allowed={setup:['empty'],trade:['initialized'],sync:['traded'],snapshot:['synced'],fund:['verified'],advance:['funded'],pay:['ready','partial'],retry:['complete']};
function draw(){
 $('#status').textContent='Session: '+state.phase+(busy?' · running step…':'');
 for(const button of document.querySelectorAll('[data-action]'))button.disabled=busy||!allowed[button.dataset.action].includes(state.phase);
 const balances=$('#balances');balances.replaceChildren();
 for(const [label,value] of Object.entries(state.balances??{})){const card=document.createElement('div'),name=document.createElement('span'),amount=document.createElement('strong');name.textContent=label.replace(/[A-Z]/g,c=>' '+c.toLowerCase());amount.textContent=value;card.append(name,amount);balances.append(card);}
 $('#holders').replaceChildren(...(state.holders??[]).map(h=>{const row=document.createElement('tr');for(const value of [h.address,h.snapshotHolding,h.currentHolding,h.entitlement,h.received,h.paid?'Yes':'No']){const cell=document.createElement('td');cell.textContent=value;row.append(cell);}return row;}));
 $('#checks').replaceChildren(...Object.entries(state.checks).map(([check,passed])=>{const li=document.createElement('li');li.textContent=(passed?'PASS · ':'FAIL · ')+check.replace(/[A-Z]/g,c=>' '+c.toLowerCase());return li;}));
 $('#events').replaceChildren(...state.events.map(event=>{const li=document.createElement('li');li.textContent=event.message;return li;}));
 $('#manifest').hidden=!state.manifest;
 $('#commitment').textContent=state.manifest?'Snapshot block: '+state.manifest.snapshotBlock+'\nBlock hash: '+state.snapshotHash+'\nMerkle root: '+state.manifest.root:'';
}
async function request(path,action){const r=await fetch(path,action?{method:'POST',headers:{'Content-Type':'application/json','X-Rehearsal-Token':csrf},body:JSON.stringify({action})}:{});const data=await r.json();if(!r.ok)throw new Error(data.error);state=data;csrf=data.csrf;}
$('#actions').addEventListener('click',async event=>{const action=event.target.closest('[data-action]')?.dataset.action;if(!action||busy)return;busy=true;$('#error').textContent='';draw();try{await request('/api/action',action);}catch(error){$('#error').textContent=error.message;try{await request('/api/state');}catch{}}finally{busy=false;draw();}});
try{await request('/api/state');draw();}catch(error){$('#error').textContent=error.message;}
