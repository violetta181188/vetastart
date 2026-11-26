const {test}=require('node:test');
const assert=require('node:assert/strict');
const {summarizeSubscriptions}=require('../admin-status');
test('subscription diagnostics distinguish absent subscriptions from unrecognized records',()=>{
  assert.equal(summarizeSubscriptions([],'123').messagesSubscribed,false);
  for(const entry of [{subscribed_fields:['messages']},'messages',{unknown_shape:true}]){
    const summary=summarizeSubscriptions([entry],'123');
    assert.equal(summary.subscriptionCount,1);assert.equal(summary.messagesSubscribed,null);
    assert.equal(summary.subscriptions.length,1);
  }
});
test('subscription diagnostics recognize explicit identifiers without dropping opaque IDs',()=>{
  for(const entry of [{id:'123',subscribed_fields:['messages']},{app_id:'123',subscribed_fields:['messages']},
    {application:{id:'123'},fields:[{name:'messages'}]}]){
    assert.equal(summarizeSubscriptions([entry],'123').messagesSubscribed,true);
  }
  assert.deepEqual(summarizeSubscriptions([{id:'opaque:123',subscribed_fields:['messages']}],'123').subscriptions,
    [{appId:'opaque:123',fields:['messages']}]);
  assert.equal(summarizeSubscriptions([{id:'123'}],'123').messagesSubscribed,null);
});
