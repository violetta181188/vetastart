const path=require('node:path');

function inspectConfiguration(env,{profile='runtime',nodeVersion=process.versions.node}={}){
 if(!['runtime','pilot'].includes(profile))throw new Error('Unknown readiness profile');
 const checks=[];
 const add=(name,ok)=>checks.push({name,status:ok?'ok':'missing_or_invalid'});
 const present=name=>typeof env[name]==='string'&&env[name].length>0;
 const numeric=name=>/^\d+$/.test(env[name]||'');
 const production=env.NODE_ENV==='production';
 add('NODE_VERSION',Number(nodeVersion.split('.')[0])>=24);
 const originOk=(()=>{try{const u=new URL(env.VETASTART_PUBLIC_ORIGIN);return u.origin===env.VETASTART_PUBLIC_ORIGIN&&
  (u.protocol==='https:'||(!production&&u.protocol==='http:'&&['localhost','127.0.0.1'].includes(u.hostname)));}catch{return false;}})();
 if(production||profile==='pilot')add('VETASTART_PUBLIC_ORIGIN',originOk);
 if(production&&env.DATABASE_URL){
  let valid=false;try{const url=new URL(env.DATABASE_URL);valid=['postgres:','postgresql:'].includes(url.protocol)&&!!url.hostname;}catch{}
  add('DATABASE_URL',valid);
  add('VETASTART_PG_SCHEMA',/^vetastart_[a-z0-9_]{1,32}$/.test(env.VETASTART_PG_SCHEMA||'vetastart_pilot'));
  add('VETASTART_AUTH_DEV_MODE',env.VETASTART_AUTH_DEV_MODE!=='true');
 }else if(production){
  add('VETASTART_DB_PATH',present('VETASTART_DB_PATH')&&path.isAbsolute(env.VETASTART_DB_PATH));
  const root=env.VETASTART_PERSISTENT_DATA_DIR,db=env.VETASTART_DB_PATH;
  add('VETASTART_PERSISTENT_DATA_DIR',!!root&&!!db&&path.isAbsolute(root)&&path.isAbsolute(db)&&
    path.relative(root,db)!==''&&!path.relative(root,db).startsWith('..')&&!path.isAbsolute(path.relative(root,db)));
  add('VETASTART_AUTH_DEV_MODE',env.VETASTART_AUTH_DEV_MODE!=='true');
 }
 if(profile==='pilot'||env.VETASTART_SIGNUP_ENABLED==='true'||env.VETASTART_MAIL_ENABLED==='true'){
  add('VETASTART_MAIL_ENABLED',env.VETASTART_MAIL_ENABLED==='true');
  if (present('RESEND_API_KEY')) {
   add('RESEND_API_KEY', true);
  } else {
   for(const name of ['SMTP_HOST','SMTP_USER','SMTP_PASSWORD'])add(name,present(name));
   add('SMTP_PORT',['465','587'].includes(env.SMTP_PORT||'465'));
  }
  add('MAIL_FROM',/^\S+@[^\s@]+\.[^\s@]+$/.test(env.MAIL_FROM||''));
 }
 if(profile==='pilot'||env.VETASTART_SEND_ENABLED==='true'||env.VETASTART_API_POLL_ENABLED==='true'){
  add('INSTAGRAM_LOGIN_MODE',env.INSTAGRAM_LOGIN_MODE==='unified');
  for(const name of ['META_APP_ID','INSTAGRAM_CONFIG_ID','META_CLIENT_BUSINESS_ID'])add(name,numeric(name));
  for(const name of ['META_APP_SECRET','INSTAGRAM_VERIFY_TOKEN'])add(name,present(name));
  add('META_GRAPH_API_VERSION',/^v\d+\.\d+$/.test(env.META_GRAPH_API_VERSION||''));
  add('VETASTART_ADMIN_TOKEN',(env.VETASTART_ADMIN_TOKEN||'').length>=32);
  add('VETASTART_TOKEN_KEY',Buffer.from(env.VETASTART_TOKEN_KEY||'','base64').length===32);
  add('INSTAGRAM_REDIRECT_URI',originOk&&env.INSTAGRAM_REDIRECT_URI===env.VETASTART_PUBLIC_ORIGIN+'/auth/instagram/callback');
 }
 if(env.VETASTART_SEND_ENABLED==='true'&&(present('VETASTART_SEND_ACCOUNT_ID')||present('VETASTART_SEND_SINCE_MS'))){
  let valid=false;
  try{valid=Boolean(require('./postgres-app/outbound-scope').outboundScope(env));}catch{}
  add('VETASTART_SEND_SCOPE',valid && Boolean(env.DATABASE_URL));
 }
 if(env.VETASTART_AUTOMATION_ENABLED==='true'){
  const interval=Number(env.VETASTART_AUTOMATION_INTERVAL_MS||10000);
  add('VETASTART_AUTOMATION_INTERVAL_MS',Number.isInteger(interval)&&interval>=1000);
 }
 if(env.VETASTART_API_POLL_ENABLED==='true'){
  add('API_POLL_POSTGRESQL',present('DATABASE_URL'));
  add('VETASTART_API_POLL_ACCOUNT_ID',numeric('VETASTART_API_POLL_ACCOUNT_ID'));
  const interval=Number(env.VETASTART_API_POLL_INTERVAL_MS||60000);
  add('VETASTART_API_POLL_INTERVAL_MS',Number.isSafeInteger(interval)&&interval>=60000&&interval<=3600000);
  add('API_POLL_UNIFIED',env.INSTAGRAM_LOGIN_MODE==='unified');
  add('API_POLL_RUNNER_ENABLED',env.VETASTART_AUTOMATION_ENABLED==='true');
 }
 if(env.ROBOKASSA_ENABLED==='true'){
  add('ROBOKASSA_MERCHANT_LOGIN',present('ROBOKASSA_MERCHANT_LOGIN'));
  add('ROBOKASSA_HASH_ALGORITHM',['md5','sha256','sha512'].includes(env.ROBOKASSA_HASH_ALGORITHM));
  const test=env.ROBOKASSA_TEST_MODE!=='false';
  for(const name of test?['ROBOKASSA_TEST_PASSWORD1','ROBOKASSA_TEST_PASSWORD2']:['ROBOKASSA_PASSWORD1','ROBOKASSA_PASSWORD2'])add(name,present(name));
  if(!test)add('ROBOKASSA_LIVE_ENABLED',env.ROBOKASSA_LIVE_ENABLED==='true');
 }
 return {profile,ok:checks.every(c=>c.status==='ok'),checks,
   externalServicesVerified:false};
}

function databaseReady(store){
 const db=store.db;
 let begun=false;
 try{
  db.exec('BEGIN IMMEDIATE');begun=true;
  db.exec('CREATE TABLE IF NOT EXISTS service_probe (id INTEGER PRIMARY KEY); INSERT OR REPLACE INTO service_probe VALUES (1)');
  db.exec('ROLLBACK');return true;
 }catch{if(begun)try{db.exec('ROLLBACK');}catch{}return false;}
}

function main(){
 const args=process.argv.slice(2);
 const profile=args.length===0?'runtime':args.length===2&&args[0]==='--profile'?args[1]:null;
 if(!profile)throw new Error('Usage: npm run doctor -- --profile pilot');
 const report=inspectConfiguration(process.env,{profile});
 console.log(JSON.stringify(report,null,2));if(!report.ok)process.exitCode=1;
}
if(require.main===module)try{main();}catch{console.error('Configuration check failed: use runtime or pilot profile');process.exitCode=1;}
module.exports={inspectConfiguration,databaseReady};
