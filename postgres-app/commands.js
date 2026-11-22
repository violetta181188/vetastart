const {prepareStore}=require('./start');
const {processPending}=require('./worker');
const {sendDrafts}=require('./sender');
const {refreshConnections}=require('./instagram-auth');
const {runCycle,createRunner}=require('./automation-runner');
async function execute(mode){
 if(mode==='send'&&process.env.VETASTART_SEND_ENABLED!=='true')throw new Error('Sending disabled');
 if(mode==='automation'&&process.env.VETASTART_AUTOMATION_ENABLED!=='true')throw new Error('Automation disabled');
 const store=await prepareStore(process.env);
 if(mode==='automation'){
  let runner;
  try{runner=createRunner({intervalMs:Number(process.env.VETASTART_AUTOMATION_INTERVAL_MS||10000),cycle:()=>runCycle(store),
   report:result=>console.log(JSON.stringify(result)),onError:()=>console.error('PostgreSQL automation cycle failed')});}
  catch(error){await store.close();throw error;}
  let closing=false;const stop=async()=>{if(closing)return;closing=true;await runner.stop();await store.close();};
  process.once('SIGTERM',stop);process.once('SIGINT',stop);runner.start();return;
 }
 try{
  let result;
  if(mode==='worker')result=await processPending(store);
  else if(mode==='send')result=await sendDrafts(store);
  else if(mode==='refresh'){
   result=await refreshConnections(store);
   if(result.retry||result.reauthorizationRequired)process.exitCode=1;
  }else throw new Error('Unknown PostgreSQL command');
  console.log(JSON.stringify(result));
 }finally{await store.close();}
}
module.exports={execute};
