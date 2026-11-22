const fs=require('node:fs');
const path=require('node:path');
const {DatabaseSync}=require('node:sqlite');

function validateDatabase(filename){
 const db=new DatabaseSync(filename,{readOnly:true});
 try{
  const integrity=db.prepare('PRAGMA integrity_check').all();
  if(integrity.length!==1||Object.values(integrity[0])[0]!=='ok')throw new Error('Database integrity failed');
  for(const name of ['deliveries','events','drafts'])
   if(!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name))throw new Error('Not a VetaStart database');
 }finally{db.close();}
}

function backupDatabase(source,destination){
 validateDatabase(source);
 fs.mkdirSync(path.dirname(destination),{recursive:true,mode:0o700});
 // Refuse overwrite and symlinks. Creating the empty destination first keeps
 // permissions private throughout VACUUM INTO, not just after copying secrets.
 fs.closeSync(fs.openSync(destination,'wx',0o600));
 let db;
 try{
  db=new DatabaseSync(source,{readOnly:true});
  db.prepare('VACUUM INTO ?').run(destination);db.close();db=null;
  validateDatabase(destination);
 }catch(error){db?.close();fs.rmSync(destination,{force:true});throw error;}
}

function restoreDatabase(source,destination){
 validateDatabase(source);
 fs.mkdirSync(path.dirname(destination),{recursive:true,mode:0o700});
 fs.closeSync(fs.openSync(destination,'wx',0o600));
 try{
  const input=fs.openSync(source,'r'),output=fs.openSync(destination,'r+');
  try{
   const buffer=Buffer.alloc(65536);let count;
   while((count=fs.readSync(input,buffer,0,buffer.length,null))>0){
    let offset=0;while(offset<count)offset+=fs.writeSync(output,buffer,offset,count-offset);
   }
   fs.fsyncSync(output);
  }finally{fs.closeSync(input);fs.closeSync(output);}
  validateDatabase(destination);
 }catch(error){fs.rmSync(destination,{force:true});throw error;}
}

if(require.main===module){
 const [mode,source,destination,...extra]=process.argv.slice(2);
 try{
  if(!source||!destination||extra.length||!['backup','restore'].includes(mode))throw new Error('Invalid command');
  (mode==='backup'?backupDatabase:restoreDatabase)(source,destination);
  console.log('Database operation completed and integrity verified');
 }catch{console.error('Database operation failed: check paths, permissions and database integrity; existing files are never overwritten');process.exitCode=1;}
}
module.exports={backupDatabase,restoreDatabase,validateDatabase};
