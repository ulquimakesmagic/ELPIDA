import test from 'node:test';
import assert from 'node:assert/strict';
import {bindSearch} from '../apps/web/search.mjs';

class Element extends EventTarget {
 value='';open=false;offsetParent={};focus(){this.focused=true;}select(){this.selected=true;}
 showModal(){if(this.open)throw Error('Already open');this.open=true;}close(){this.open=false;}
}
function setup(){const names=['input','sheet','sheetInput','topForm','sheetForm','mobileButton','document'],args=Object.fromEntries(names.map(n=>[n,new Element()])),calls=[];bindSearch({...args,onSearch:(...values)=>calls.push(values)});return {...args,calls};}
function submit(form){const e=new Event('submit',{cancelable:true});form.dispatchEvent(e);assert.equal(e.defaultPrevented,true);}
test('desktop typing syncs mobile search; submit activates results even for an unchanged or empty query',()=>{
 const s=setup();s.input.value='VAST';s.input.dispatchEvent(new Event('input'));assert.equal(s.sheetInput.value,'VAST');assert.deepEqual(s.calls.at(-1),['VAST',{submit:false}]);submit(s.topForm);assert.deepEqual(s.calls.at(-1),['VAST',{submit:true}]);s.input.value='';submit(s.topForm);assert.deepEqual(s.calls.at(-1),['',{submit:true}]);
});
test('mobile opens a searchable sheet and submits its own text before closing',()=>{
 const s=setup();s.mobileButton.dispatchEvent(new Event('click'));assert.equal(s.sheet.open,true);assert.equal(s.sheetInput.focused,true);s.mobileButton.dispatchEvent(new Event('click'));s.sheetInput.value='0x123';submit(s.sheetForm);assert.equal(s.sheet.open,false);assert.equal(s.input.value,'0x123');assert.deepEqual(s.calls.at(-1),['0x123',{submit:true}]);
});
test('Ctrl/Cmd K focuses desktop or opens the mobile sheet without duplicate modal errors',()=>{
 const s=setup();const hotkey=()=>{const e=new Event('keydown',{cancelable:true});Object.assign(e,{key:'k',ctrlKey:true});s.document.dispatchEvent(e);assert.equal(e.defaultPrevented,true);};hotkey();assert.equal(s.input.focused,true);assert.equal(s.input.selected,true);s.input.offsetParent=null;hotkey();hotkey();assert.equal(s.sheet.open,true);assert.equal(s.sheetInput.focused,true);
});
