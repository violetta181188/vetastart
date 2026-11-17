'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const vm=require('node:vm');
const page=fs.readFileSync(path.join(__dirname,'..','index.html'),'utf8');
const controller=fs.readFileSync(path.join(__dirname,'..','dashboard.js'),'utf8');
test('dashboard script and target are both included',()=>{
  assert.match(page,/<script src="\/dashboard\.js" defer><\/script>/);
  assert.match(page,/\bid="builder"/);
  assert.match(page,/href="#builder"/);
  assert.match(controller,/\$\('builder'\)/);
});
test('every dashboard element referenced by ID exists exactly once',()=>{
  const ids=[...page.matchAll(/\bid="([^"]+)"/g)].map(x=>x[1]);
  const used=[...controller.matchAll(/\$\('([^']+)'\)/g)].map(x=>x[1]);
  for(const id of new Set(used)) {
    assert.equal(ids.filter(x=>x===id).length,1,'Incorrect DOM ID '+id);
  }
  assert.equal(ids.length,new Set(ids).size,'Repeated HTML ID');
});
test('client-side controller is syntactically valid',()=>{
  new vm.Script(controller,{filename:'dashboard.js'});
  const inline=[...page.matchAll(/<script>([\s\S]*?)<\/script>/g)];
  for(const [i,section] of inline.entries())new vm.Script(section[1],{filename:'index-inline-'+i});
});
test('old parallel in-browser scenario data store has been removed',()=>{
  assert.doesNotMatch(page,/vetastart_scenarios_demo_v1/);
  assert.doesNotMatch(page,/vetastart_accounts_demo_v1/);
  assert.match(controller,/\/api\/accounts/);
  assert.match(controller,/\/api\/scenarios/);
});
test('no Facebook login button pretends to connect an Instagram account',()=>{
  assert.doesNotMatch(page,/href="https:\/\/www\.facebook\.com\/"[^>]*>Подключить Instagram/);
});
