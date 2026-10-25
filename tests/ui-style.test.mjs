// A style passed to `h()` must reach the element through CSSOM, never as a style attribute.
//
// `element.style` is read-only, so `node.style = 'width:40%'` throws; the old catch fell back to
// `setAttribute('style', …)`, which this app's own `style-src 'self'` blocks. The Explore progress bar therefore
// rendered without a width until the next refresh, and no test could see it because the suite has no DOM.
// This file supplies the smallest fake DOM that `h()` needs and asserts the contract directly.
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync,readdirSync} from 'node:fs';
import {fileURLToPath} from 'node:url';

class FakeNode {
  constructor(){this._style={cssText:''};}
  // Getter only, like a real element: assigning `node.style` throws in strict mode, which is the trap `h()` hit.
  get style(){return this._style;}
}
globalThis.Node = FakeNode;

function makeNode(tag){
  const node=new FakeNode();
  node.tagName=tag; node.id=''; node.className=''; node.attributes={};
  node.classList={add:name=>{node.className+=` ${name}`;}};
  node.setAttribute=(key,value)=>{node.attributes[key]=value;};
  node.addEventListener=()=>{};
  node.append=()=>{};
  return node;
}

globalThis.document={createElement:makeNode,createTextNode:text=>({text})};
const {h}=await import('../apps/web/ui.mjs');

test('a string style is written through CSSOM, not as an attribute',()=>{
  const fill=h('span',{style:'width:40%'});
  assert.equal(fill.style.cssText,'width:40%');
  assert.equal(fill.attributes.style,undefined,'a style attribute would be blocked by style-src self');
});

test('an object style sets individual properties',()=>{
  const node=h('span',{style:{width:'12.5%',opacity:'0.5'}});
  assert.equal(node.style.width,'12.5%');
  assert.equal(node.style.opacity,'0.5');
  assert.equal(node.attributes.style,undefined);
});

test('ordinary attributes, data and aria still go through setAttribute',()=>{
  const node=h('span.x',{'data-state':'open','aria-label':'Progress',title:'hello'},'text');
  assert.equal(node.attributes['data-state'],'open');
  assert.equal(node.attributes['aria-label'],'Progress');
  assert.equal(node.attributes.title,'hello');
  assert.match(node.className,/x/);
});

test('no browser module reintroduces a style attribute',()=>{
  const dir=fileURLToPath(new URL('../apps/web/',import.meta.url));
  const offenders=readdirSync(dir).filter(name=>name.endsWith('.mjs'))
    .filter(name=>/setAttribute\(\s*['"]style['"]/.test(readFileSync(dir+name,'utf8')));
  assert.deepEqual(offenders,[],'these modules set a style attribute, which the CSP blocks');
});
