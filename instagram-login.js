function loginMode(env) {
  const mode = env.INSTAGRAM_LOGIN_MODE || 'instagram';
  if (!['instagram', 'unified'].includes(mode)) throw new Error('Unsupported Instagram login mode');
  if (mode === 'unified' && !/^\d+$/.test(env.INSTAGRAM_CONFIG_ID || '')) {
    throw new Error('Unified login requires a Meta configuration ID');
  }
  return mode;
}

function authorizationUrl(env, redirect, state) {
  const unified = loginMode(env) === 'unified';
  const url = new URL(unified ? 'https://www.facebook.com/dialog/oauth' : 'https://www.instagram.com/oauth/authorize');
  const params = { client_id: unified ? (env.META_APP_ID || env.INSTAGRAM_CLIENT_ID) : env.INSTAGRAM_CLIENT_ID,
    redirect_uri: redirect, response_type: 'code', state };
  Object.assign(params, unified ? {
    config_id: env.INSTAGRAM_CONFIG_ID, display: 'popup', override_default_response_type: 'true', prompt: 'login'
  } : { scope: 'instagram_business_basic,instagram_business_manage_messages', enable_fb_login: '0', force_authentication: '1' });
  url.search = new URLSearchParams(params).toString();
  return url.href;
}

module.exports = { loginMode, authorizationUrl };
