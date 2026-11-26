const { test } = require('node:test');
const assert = require('node:assert/strict');
const { connectUnified } = require('../unified-auth');
const { authorizationUrl } = require('../instagram-login');
const { AutomationStore } = require('../automation');
const { initialize, seal, connectedToken, refreshConnections } = require('../instagram-auth');
const { sendDrafts } = require('../sender');
const env = { INSTAGRAM_LOGIN_MODE: 'unified', INSTAGRAM_CONFIG_ID: '12', META_APP_ID: '123',
  META_APP_SECRET: 'test-secret', META_CLIENT_BUSINESS_ID: '456', INSTAGRAM_ACCOUNT_ID: '789',
  META_GRAPH_API_VERSION: 'v27.0', INSTAGRAM_REDIRECT_URI:'https://app.example/auth/instagram/callback',
  VETASTART_TOKEN_KEY: Buffer.alloc(32, 2).toString('base64') };
test('Unified exchanges Meta credentials then selects assigned Instagram ID, not /me ID', async () => {
  const calls = [];
  const result = await connectUnified(env, 'one-time-code', async (url, init) => {
    calls.push(url);
    assert.equal(new URL(url).hostname, 'graph.facebook.com');
    if (url.includes('/oauth/access_token')) {
      assert.equal(new URL(url).searchParams.get('client_id'), '123');
      assert.equal(new URL(url).searchParams.get('client_secret'), 'test-secret');
      const login = new URL(authorizationUrl(env, new URL(env.INSTAGRAM_REDIRECT_URI).href, 'state'));
      assert.equal(new URL(url).searchParams.get('redirect_uri'), login.searchParams.get('redirect_uri'));
      return Response.json({ access_token: 'suat', expires_in: 86400 });
    }
    if(url.endsWith('/subscribed_apps'))return Response.json({success:true});
    assert.equal(url, 'https://graph.facebook.com/v27.0/me/assigned_instagram_accounts');
    assert.equal(init.headers.Authorization, 'Bearer suat');
    return Response.json({ data: [{ id: '789' }] });
  }, () => 1000);
  assert.equal(result.businessId, '456'); assert.equal(result.configId, '12');
  assert.equal(result.accountId, '789'); assert.equal(result.expiresAt, 86401000);
  assert.equal(calls.length, 3);
});
test('Unified refuses missing or unsafe callback before exchanging the code', async () => {
  for (const uri of [undefined, 'http://app.example/auth/instagram/callback',
    'https://app.example/other', 'https://user:password@app.example/auth/instagram/callback',
    'https://app.example/auth/instagram/callback?unexpected=1']) {
    await assert.rejects(connectUnified({...env, INSTAGRAM_REDIRECT_URI:uri}, 'code',
      () => assert.fail('must not exchange a code with an invalid redirect')));
  }
});
test('Unified rejects unverified missing expiry and accepts explicit configuration', async () => {
  const fake = async url => Response.json(url.includes('/oauth/') ? { access_token: 'suat' } : url.endsWith('/subscribed_apps')?{success:true}:{ data: [{ id: '789' }] });
  await assert.rejects(connectUnified(env, 'code', fake), /expiration/);
  assert.equal((await connectUnified({ ...env, META_SUAT_NON_EXPIRING: 'true' }, 'code', fake)).expiresAt, 0);
  await assert.rejects(connectUnified({ ...env, META_CLIENT_BUSINESS_ID: '' }, 'code', fake));
  await assert.rejects(connectUnified({ ...env, INSTAGRAM_ACCOUNT_ID: '999' }, 'code', fake));
});
test('Unified verifies omitted expiry with Meta and respects data access expiry', async () => {
  for (const [expires_at, data_access_expires_at, expected] of [[0, 0, 0], [0, 100, 100000], [200, 100, 100000]]) {
    const result = await connectUnified(env, 'code', async (url, options) => {
      if (url.includes('/oauth/')) return Response.json({access_token:'private-suat'});
      if (url.includes('/debug_token')) {
        assert.equal(new URL(url).searchParams.get('input_token'), 'private-suat');
        assert.equal(options.headers.Authorization, 'Bearer 123|test-secret');
        return Response.json({data:{is_valid:true,app_id:'123',expires_at,data_access_expires_at}});
      }
      return Response.json(url.endsWith('/subscribed_apps') ? {success:true} : {data:[{id:'789'}]});
    }, () => 1000);
    assert.equal(result.expiresAt, expected);
  }
});
test('Unified rejects invalid, foreign-app, missing and expired inspected tokens', async () => {
  for (const details of [{is_valid:false,app_id:'123',expires_at:0},
    {is_valid:true,app_id:'999',expires_at:0}, {is_valid:true,app_id:'123'},
    {is_valid:true,app_id:'123',expires_at:1},
    {is_valid:true,app_id:'123',expires_at:0,data_access_expires_at:1}]) {
    await assert.rejects(connectUnified(env,'code',async url => Response.json(
      url.includes('/oauth/') ? {access_token:'private-suat'} : {data:details}), () => 1000));
  }
});
test('Unified diagnostics retain stage and numeric Meta codes without response secrets', async () => {
  await assert.rejects(connectUnified(env,'private-code',async () => Response.json(
    {error:{code:190,error_subcode:123,message:'private-suat private-code test-secret'}},{status:400})), error => {
    assert.deepEqual(error.oauthDiagnostic,{stage:'exchange',status:400,metaCode:190,metaSubcode:123});
    assert.doesNotMatch(error.message + JSON.stringify(error.oauthDiagnostic), /private|test-secret/);
    return true;
  });
});
test('Unified token is never renewed through Instagram endpoints and sends through Facebook Graph', async t => {
  const store = new AutomationStore(':memory:'); t.after(() => store.close()); initialize(store.db);
  store.db.prepare(`INSERT INTO instagram_connections
    (account_id, token_cipher, expires_at, token_mode, long_lived, issued_at) VALUES ('789', ?, 0, 'unified', 1, 1)`)
    .run(seal('suat', env));
  assert.equal(connectedToken(store, '789', env), 'suat');
  assert.throws(() => connectedToken(store, '789', { ...env, INSTAGRAM_LOGIN_MODE: 'instagram' }));
  assert.equal((await refreshConnections(store, { env, fetchImpl: () => assert.fail('wrong refresh') })).skipped, 1);
  const payload = { entry: [{ id: '789', messaging: [{ timestamp: Date.now(), sender: { id: '321' },
    recipient: { id: '789' }, message: { mid: 'm', text: 'гайд' } }] }] };
  store.receive(Buffer.from(JSON.stringify(payload)), payload);
  store.process([{ id: 'rule', accountId: '789', trigger: 'message', keyword: 'гайд', reply: 'Ссылка' }]);
  assert.equal((await sendDrafts(store, { env: { ...env, VETASTART_SEND_ENABLED: 'true' }, fetchImpl: async url => {
    assert.equal(url, 'https://graph.facebook.com/v27.0/789/messages');
    return Response.json({ message_id: 'confirmed' });
  } })).sent, 1);
});

test('revoked Unified token halts the queue and future passes require reauthorization', async t => {
  const store = new AutomationStore(':memory:'); t.after(()=>store.close()); initialize(store.db);
  store.db.prepare(`INSERT INTO instagram_connections
    (account_id,token_cipher,expires_at,token_mode) VALUES ('789',?,0,'unified')`).run(seal('revoked-suat',env));
  const payload={entry:[{id:'789',messaging:['m1','m2'].map(mid=>({timestamp:Date.now(),sender:{id:'321'},
    recipient:{id:'789'},message:{mid,text:'гайд'}}))}]};
  store.receive(Buffer.from(JSON.stringify(payload)),payload);
  store.process([{id:'guide',accountId:'789',trigger:'message',keyword:'гайд',reply:'Ссылка'}]);
  let calls=0;
  const options={env:{...env,VETASTART_SEND_ENABLED:'true'},fetchImpl:async()=>{
    calls++; return Response.json({error:{code:190}},{status:400});
  }};
  assert.equal((await sendDrafts(store,options)).failed,1);
  assert.equal(store.db.prepare("SELECT count(*) AS n FROM drafts WHERE status='draft'").get().n,1);
  await assert.rejects(sendDrafts(store,options));
  assert.equal(calls,1);
});
