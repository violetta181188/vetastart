'use strict';
function cleanName(val,max){return typeof val==='string'&&val.trim().length>=1&&val.trim().length<=max?val.trim():null;}
function plan(n){return {monthly_rub:990+299*Math.max(0,n-3),accounts:n,included_accounts:3,extra_accounts:Math.max(0,n-3),
  base_rub:990,extra_account_rub:299,payments_enabled:false,subscription_status:'not_available'};}
function normalizeScenario(b){
  const name=cleanName(b.name,48),keyword=cleanName(b.keyword,40)?.toLocaleUpperCase('ru-RU');
  const source=b.trigger_source||'both',enabled=b.enabled===true,follow_gate=b.follow_gate===true;
  const messages=b.messages,choices=b.choices;
  if(!name||!keyword||!['comment','dm','both'].includes(source)||!Array.isArray(messages)||messages.length<1||messages.length>5||
     !messages.every(m=>typeof m==='string'&&m.trim()&&m.length<=2000)||!Array.isArray(choices)||choices.length!==3||
     !choices.every(c=>c&&cleanName(c.label,20)&&typeof c.reply==='string'&&c.reply.length<=2000&&typeof c.url==='string'&&c.url.length<=2048))return null;
  for(const c of choices)if(c.url){try{const u=new URL(c.url);if(!['https:','http:'].includes(u.protocol))return null;}catch{return null;}}
  return {name,keyword,source,enabled,follow_gate,messages:messages.map(m=>m.trim()),choices:choices.map(c=>({label:c.label.trim(),reply:c.reply.trim(),url:c.url.trim()}))};
}
module.exports={plan,normalizeScenario,cleanName};
