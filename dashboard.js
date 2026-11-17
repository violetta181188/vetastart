'use strict';
/* VetaStart staging. Account and funnel data are stored in PostgreSQL.
   The preview and metrics above remain demonstrations; Instagram delivery is disabled. */
(() => {
  const $ = (id) => document.getElementById(id);
  const dataFields = ['branch-intro','branch-message-2','branch-message-3','branch-message-4','branch-message-5'];
  const status = (message) => { $('cabinet-status').textContent = message; };
  const value = (id) => $(id)?.value || '';
  let user = null, accounts = [], scenarios = [], accountId = null, scenarioId = null;
  let pristine = true;
  const seed = {
    name: 'Приветствие', keyword: 'СТАРТ',
    messages: ['Привет! 💜 Что тебе интересно? Выбери вариант ниже:'],
    choices: [
      {label:'ПРОМТ',reply:'Лови полезный промт! ✨',url:''},
      {label:'КУРС',reply:'Вот ссылка на обучение 💜',url:''},
      {label:'ЛК',reply:'Хочешь личную консультацию? Напиши мне в Telegram.',url:''}
    ]
  };

  async function api(path, method='GET', payload) {
    let res, body;
    try {
      res = await fetch(path, {method, credentials:'same-origin',
        headers:payload ? {'Content-Type':'application/json'} : {},
        body:payload ? JSON.stringify(payload) : undefined});
    } catch { throw new Error('Сервер недоступен. Попробуйте обновить страницу.'); }
    try { body = await res.json(); }
    catch { throw new Error('Сервер вернул неожиданный ответ.'); }
    if (!res.ok) throw new Error(body.error || 'Ошибка запроса');
    return body;
  }
  function fillSelect(element, rows, emptyText, getLabel) {
    element.replaceChildren();
    if (!rows.length) {
      const opt = document.createElement('option'); opt.value = ''; opt.textContent = emptyText;
      element.append(opt);
    } else rows.forEach(row => {
      const opt = document.createElement('option'); opt.value = row.id;
      opt.textContent = getLabel(row); element.append(opt);
    });
  }
  function set(id, text) {
    const el = $(id);
    if (!el) return;
    el.value = String(text ?? '');
    el.dispatchEvent(new Event('input', {bubbles:true}));
  }
  function previewRefresh() {
    $('follow-gate').dispatchEvent(new Event('change', {bubbles:true}));
    $('message-count').dispatchEvent(new Event('change', {bubbles:true}));
    $('branch-intro').dispatchEvent(new Event('input', {bubbles:true}));
  }
  function readBuilder() {
    const choices = [...document.querySelectorAll('#branch-editor .branch-choice')];
    const n = Math.max(1, Math.min(5, Number(value('message-count')) || 1));
    return {
      name:value('scenario-name').trim() || 'Новый сценарий',
      keyword:value('branch-trigger').trim(),
      trigger_source:$('branch-comment').checked && $('branch-dm').checked ? 'both' :
        $('branch-comment').checked ? 'comment' : 'dm',
      follow_gate:$('follow-gate').checked,
      enabled:$('db-enable-scenario').checked,
      messages:dataFields.slice(0,n).map(value),
      choices:choices.map(c => ({label:c.querySelector('.branch-label').value,
        reply:c.querySelector('.branch-reply').value,
        url:c.querySelector('.branch-url').value}))
    };
  }
  function hydrate(s, scroll=false) {
    if (!s) return;
    scenarioId = s.id || null;
    set('scenario-name',s.name);
    set('branch-trigger',s.keyword);
    $('branch-comment').checked = s.trigger_source !== 'dm';
    $('branch-dm').checked = s.trigger_source !== 'comment';
    $('follow-gate').checked = !!s.follow_gate;
    $('db-enable-scenario').checked = !!s.enabled;
    set('message-count', String(s.messages.length));
    dataFields.forEach((id,i) => set(id,s.messages[i] || ''));
    document.querySelectorAll('#branch-editor .branch-choice').forEach((node,i) => {
      const ch = s.choices[i] || {label:'',reply:'',url:''};
      setIn(node,'.branch-label',ch.label);
      setIn(node,'.branch-reply',ch.reply);
      setIn(node,'.branch-url',ch.url);
    });
    previewRefresh();
    pristine = true;
    if(scenarioId && $('db-scenario').querySelector('option[value="' + scenarioId + '"]'))
      $('db-scenario').value = scenarioId;
    renderScenarios();
    if (scroll) $('builder').scrollIntoView({behavior:'smooth',block:'start'});
  }
  function setIn(node,selector,text) {
    const el=node.querySelector(selector);
    if (el) {el.value=String(text ?? '');el.dispatchEvent(new Event('input',{bubbles:true}));}
  }
  function newDraft(scroll=false) {
    hydrate({id:null,name:'Новый сценарий',keyword:'СТАРТ',trigger_source:'both',
      enabled:false,follow_gate:false,messages:[seed.messages[0]],choices:seed.choices},scroll);
    status('Новая воронка: настрой поля и нажми «Сохранить текущую воронку».');
  }
  function accountPrice(n) {
    return 990 + Math.max(0, n-3)*299;
  }
  function updateEstimate() {
    const chosen = Math.max(1,Math.min(100,Number($('bill-accounts').value)||1));
    $('bill-total').textContent = accountPrice(chosen).toLocaleString('ru-RU') + ' ₽/мес';
    $('bill-details').textContent = 'До 3 аккаунтов включено, далее +299 ₽ за каждый. Это расчёт, не списание.';
  }
  function showAuth(next) {
    user = next;
    $('cabinet-guest').hidden = !!user;
    $('cabinet-user').hidden = !user;
    $('cabinet-projects').hidden = !user;
    $('cabinet-indicator').textContent = user ? 'Аккаунт активен' : 'Вход не выполнен';
    if (user) $('cabinet-greeting').textContent = 'Здравствуйте, ' + user.name + '!';
    $('account-add').disabled = !user;
    $('account-remove').disabled = !user;
    $('scenario-add').disabled = !user;
    $('mock-saving-status').textContent = user
      ? 'Сценарии сохраняются на сервере. Отправка в Instagram пока не подключена.'
      : 'Демонстрация. Для сохранения сценариев войди в личный кабинет.';
  }
  function renderAccounts() {
    const current = accounts.find(a=>a.id===accountId);
    for (const id of ['account-select','db-account']) {
      fillSelect($(id),accounts,'Нет проектов',a=>a.name);
      if(current) $(id).value=current.id;
    }
    $('account-count').textContent = accounts.length + ' аккаунт(ов)';
    $('account-add').disabled = !user || accounts.length >=100;
    $('account-remove').disabled = !user || accounts.length<=1;
    $('db-delete-account').disabled = !user || accounts.length<=1;
    $('db-price').textContent = 'Расчёт: ' + accountPrice(accounts.length).toLocaleString('ru-RU')
      + ' ₽/месяц. Оплата ещё не подключена.';
    $('bill-accounts').value = String(Math.max(1,accounts.length));
    updateEstimate();
  }
  function renderScenarios() {
    const list = $('scenario-list'); list.replaceChildren();
    for (const s of scenarios) {
      const row=document.createElement('div'); row.className='scenario-item';
      const active=document.createElement('input');
      active.type='checkbox'; active.className='scenario-active'; active.checked=!!s.enabled;
      active.setAttribute('aria-label','Включить сценарий ' + s.name);
      active.addEventListener('change',()=>toggleScenario(s,active));
      const select=document.createElement('button');
      select.type='button'; select.className='scenario-pick'+(s.id===scenarioId?' selected':'');
      select.textContent=s.name + ' · ' + s.keyword;
      select.addEventListener('click',()=>hydrate(s,true));
      row.append(active,select); list.append(row);
    }
    const activeCount=scenarios.filter(s=>s.enabled).length;
    $('scenario-counter').textContent=activeCount+' из 10 активных · всего '+scenarios.length;
    $('scenario-add').disabled=!user || scenarios.length>=50;
    fillSelect($('db-scenario'),scenarios,'Нет сохранённых сценариев',s=>s.name+' · '+s.keyword);
    if (scenarioId && scenarios.some(s=>s.id===scenarioId)) $('db-scenario').value=scenarioId;
    $('db-open-scenario').disabled = !scenarios.length;
    $('db-update-scenario').disabled = !scenarioId;
    $('db-delete-scenario').disabled = !scenarioId;
  }
  async function loadScenarios(preferred) {
    scenarios = [];
    if (accountId) {
      const r=await api('/api/accounts/'+accountId+'/scenarios');
      scenarios=r.scenarios;
    }
    scenarioId=null;
    const chosen=scenarios.find(s=>s.id===preferred) || scenarios[0];
    if(chosen) hydrate(chosen);
    else newDraft();
    renderScenarios();
  }
  async function loadAccounts(preferred) {
    const r=await api('/api/accounts'); accounts=r.accounts;
    accountId=accounts.find(a=>a.id===preferred)?.id||accounts[0]?.id||null;
    renderAccounts();
    await loadScenarios();
  }
  async function toggleScenario(s,checkbox) {
    checkbox.disabled=true;
    try {
      await api('/api/scenarios/'+s.id,'PATCH',{name:s.name,keyword:s.keyword,
        trigger_source:s.trigger_source,follow_gate:s.follow_gate,
        enabled:checkbox.checked,messages:s.messages,choices:s.choices});
      const keep=scenarioId;
      await loadScenarios(keep||s.id);
      status('Активность сценария сохранена. Без подключения Meta сообщения не отправляются.');
    } catch(e) {
      checkbox.checked=!!s.enabled; checkbox.disabled=false; status(e.message);
    }
  }
  async function saveScenario(forceCreate=false) {
    if (!user) return status('Сначала войди или зарегистрируйся.');
    if (!accountId) return status('Добавь проект Instagram.');
    const data=readBuilder();
    const creation=forceCreate||!scenarioId;
    try {
      const r=await api(creation?'/api/accounts/'+accountId+'/scenarios':'/api/scenarios/'+scenarioId,
        creation?'POST':'PATCH',data);
      await loadScenarios(r.id);
      status('Воронка сохранена в базе данных. Реальная отправка сообщений не включена.');
      pristine=true;
    } catch(e) {status(e.message);}
  }
  async function removeScenario() {
    if (!scenarioId) return status('Сначала выбери сценарий');
    if(!confirm('Удалить выбранную воронку?')) return;
    try {
      await api('/api/scenarios/'+scenarioId,'DELETE');
      await loadScenarios();
      status('Воронка удалена.');
    } catch(e) {status(e.message);}
  }
  async function changeAccount(nextId) {
    if(nextId===accountId)return;
    accountId=nextId;
    renderAccounts();
    try{await loadScenarios();status('Открыт проект '+(accounts.find(a=>a.id===accountId)?.name||''));}
    catch(e){status(e.message);}
  }
  async function addAccount() {
    if(!user)return status('Для создания проектов войди в кабинет.');
    const name=prompt('Название нового проекта Instagram (до 50 символов):');
    if(!name)return;
    try {
      const r=await api('/api/accounts','POST',{name});
      await loadAccounts(r.account.id);
      status('Черновик аккаунта создан. Подключение Meta пока не выполнено.');
    }catch(e){status(e.message);}
  }
  async function removeAccount() {
    if(!accountId)return;
    if(!confirm('Удалить этот проект Instagram вместе с сохранёнными воронками?'))return;
    try {
      await api('/api/accounts/'+accountId,'DELETE');
      await loadAccounts();
      status('Проект удалён.');
    }catch(e){status(e.message);}
  }
  // The same account, scenario and save controls operate in the builder and dashboard.
  $('bill-accounts').addEventListener('input',updateEstimate);
  ['account-select','db-account'].forEach(id => $(id).addEventListener('change',
    e=>changeAccount(e.target.value)));
  ['account-add','db-add-account'].forEach(id => $(id).addEventListener('click',addAccount));
  ['account-remove','db-delete-account'].forEach(id => $(id).addEventListener('click',removeAccount));
  $('scenario-add').addEventListener('click',()=>newDraft(true));
  $('db-open-scenario').addEventListener('click',()=>{
    const s=scenarios.find(s=>s.id===$('db-scenario').value);
    if(s)hydrate(s,true);else status('Сначала выбери сохранённую воронку.');
  });
  $('db-scenario').addEventListener('change',()=>{
    const s=scenarios.find(s=>s.id===$('db-scenario').value);
    if(s)hydrate(s);
  });
  $('db-save-scenario').addEventListener('click',()=>saveScenario(true));
  $('db-update-scenario').addEventListener('click',()=>saveScenario(false));
  $('db-delete-scenario').addEventListener('click',removeScenario);
  $('db-enable-scenario').addEventListener('change',()=>{pristine=false;});
  document.querySelectorAll('#builder input,#builder textarea,#builder select').forEach(el=>{
    el.addEventListener('input',()=>{pristine=false;});
  });

  for(const id of ['cabinet-register','cabinet-login']) {
    $(id).addEventListener('submit',async e=>{
      e.preventDefault();
      const form=e.currentTarget;
      const data=Object.fromEntries(new FormData(form));
      status('Проверка данных…');
      try {
        const r=await api('/api/auth/'+(id==='cabinet-register'?'register':'login'),'POST',data);
        showAuth(r.user); await loadAccounts();
        form.reset(); status('Вход выполнен. Сценарии теперь хранятся в PostgreSQL.');
      }catch(e){status(e.message);}
    });
  }
  $('cabinet-logout').addEventListener('click',async()=>{
    try{
      await api('/api/auth/logout','POST');
      showAuth(null); accounts=[]; scenarios=[]; accountId=null; scenarioId=null;
      renderAccounts(); renderScenarios();
      status('Вы вышли из личного кабинета.');
    }catch(e){status(e.message);}
  });
  showAuth(null); renderAccounts(); renderScenarios();
  // Default is a preview, not a user-owned saved scenario.
  set('scenario-name',seed.name);
  const indicator=$('scenario-error');
  if(indicator)indicator.textContent='Для серверного сохранения войдите в кабинет.';
  (async()=>{
    try{
      const r=await api('/api/auth/me');
      showAuth(r.user||null);
      if(r.user){await loadAccounts();status('Личный кабинет подключён к базе данных.');}
    }catch(e){status('Сервер кабинета пока недоступен: '+e.message);}
  })();
})();
