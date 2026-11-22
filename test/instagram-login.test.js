const { test } = require('node:test');
const assert = require('node:assert/strict');
const { authorizationUrl, loginMode } = require('../instagram-login');

test('Unified login matches the configuration link supplied by Meta, with fresh state', () => {
  const env = { INSTAGRAM_LOGIN_MODE: 'unified', INSTAGRAM_CLIENT_ID: '1810672910147174',
    INSTAGRAM_CONFIG_ID: '1674463687685006' };
  const redirect = 'https://vetastart-app-2026.onrender.com/auth/instagram/callback';
  const url = new URL(authorizationUrl(env, redirect, 'one-time-browser-state'));
  assert.equal(url.origin + url.pathname, 'https://www.facebook.com/dialog/oauth');
  assert.deepEqual(Object.fromEntries(url.searchParams), { client_id: env.INSTAGRAM_CLIENT_ID,
    redirect_uri: redirect, response_type: 'code', state: 'one-time-browser-state', config_id: env.INSTAGRAM_CONFIG_ID,
    display: 'popup', override_default_response_type: 'true', prompt: 'login' });
  assert.ok(!url.href.includes('%3CSTATE%3E'));
});

test('unknown mode and missing Unified configuration fail closed', () => {
  assert.throws(() => loginMode({ INSTAGRAM_LOGIN_MODE: 'unified' }));
  assert.throws(() => loginMode({ INSTAGRAM_LOGIN_MODE: 'other' }));
});
