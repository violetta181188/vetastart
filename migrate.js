'use strict';
const fs=require('fs');const path=require('path');const {Pool}=require('pg');
if(!process.env.DATABASE_URL){console.error('DATABASE_URL is required');process.exit(1);}
const pool=new Pool({connectionString:process.env.DATABASE_URL,
 ssl:process.env.DATABASE_SSL==='true'?{rejectUnauthorized:true}:undefined});
(async()=>{
 const client=await pool.connect();
 try{await client.query('BEGIN');await client.query(fs.readFileSync(path.join(__dirname,'schema.sql'),'utf8'));
   await client.query('COMMIT');console.log('Schema migrated');}
 catch(e){await client.query('ROLLBACK');throw e;}finally{client.release();}
})().catch(e=>{console.error('Migration failed:',e.code||e.message);process.exitCode=1}).finally(()=>pool.end());
