async function importLegacyUsers(db){
 const exists=await db.query("SELECT to_regclass('public.users') AS name");
 if(!exists.rows[0].name)return {imported:0};
 const shape=await db.query(`SELECT column_name FROM information_schema.columns WHERE table_schema='public' AND table_name='users'`);
 if(!['id','email','password_hash'].every(name=>shape.rows.some(c=>c.column_name===name)))throw new Error('Legacy users schema differs');
 // Copy hashes only inside PostgreSQL. Old sessions are never imported.
 const result=await db.query(`INSERT INTO customers(id,email,salt,password_hash,email_verified_at)
   SELECT 'legacy:'||id::text,lower(btrim(email)),split_part(password_hash,':',1),split_part(password_hash,':',2),NULL
   FROM public.users WHERE password_hash ~ '^[0-9a-f]{32}:[0-9a-f]{128}$' ON CONFLICT DO NOTHING`);
 return {imported:result.rowCount};
}
async function legacyProjects(db,email){
 const tables=await db.query("SELECT to_regclass('public.instagram_accounts') AS accounts,to_regclass('public.scenarios') AS scenarios");
 if(!tables.rows[0].accounts||!tables.rows[0].scenarios)return [];
 const accounts=await db.query(`SELECT a.id,a.name FROM public.instagram_accounts a JOIN public.users u ON u.id=a.user_id
  WHERE lower(btrim(u.email))=$1 ORDER BY a.id`,[email]);
 const scenarios=await db.query(`SELECT s.* FROM public.scenarios s JOIN public.instagram_accounts a ON a.id=s.account_id
  JOIN public.users u ON u.id=a.user_id WHERE lower(btrim(u.email))=$1 ORDER BY s.id`,[email]);
 return accounts.rows.map(a=>({id:String(a.id),name:a.name,readOnly:true,
  scenarios:scenarios.rows.filter(s=>String(s.account_id)===String(a.id)).map(s=>({
   name:s.name,keyword:s.keyword,triggerSource:s.trigger_source,messages:s.messages,choices:s.choices,followGate:s.follow_gate
  }))}));
}
module.exports={importLegacyUsers,legacyProjects};
