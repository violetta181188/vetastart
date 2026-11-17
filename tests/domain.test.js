'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const {plan,normalizeScenario}=require('../domain');
const valid={name:'Тест',keyword:'старт',trigger_source:'both',enabled:false,follow_gate:false,
  messages:['Привет!'],choices:[{label:'ПРОМТ',reply:'Лови!',url:'https://example.com/guide'},
  {label:'КУРС',reply:'Курс',url:''},{label:'ЛК',reply:'Пиши',url:'https://t.me/example'}]};
test('тариф 990 ₽ до 3 аккаунтов',()=>{for(const n of [1,2,3])assert.equal(plan(n).monthly_rub,990);});
test('доплата 299 ₽ за каждый следующий',()=>{assert.equal(plan(4).monthly_rub,1289);assert.equal(plan(5).monthly_rub,1588);});
test('кодовое слово нормализуется',()=>{assert.equal(normalizeScenario(valid).keyword,'СТАРТ');});
test('разрешено не более 5 сообщений',()=>{assert.ok(normalizeScenario({...valid,messages:Array(5).fill('Текст')}));assert.equal(normalizeScenario({...valid,messages:Array(6).fill('Текст')}),null);});
test('нужно 3 варианта выбора',()=>{assert.equal(normalizeScenario({...valid,choices:valid.choices.slice(0,2)}),null);});
test('запрет javascript: ссылок',()=>{const choices=valid.choices.map((c,i)=>i===0?{...c,url:'javascript:alert(1)'}:c);assert.equal(normalizeScenario({...valid,choices}),null);});
test('пустое ключевое слово запрещено',()=>{assert.equal(normalizeScenario({...valid,keyword:' '}),null);});
