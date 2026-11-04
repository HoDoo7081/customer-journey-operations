import assert from 'node:assert/strict';
import {paymentFirst} from '../mockup/lib/payment-first.js';
process.env.GO_LIVE='true';
const event={id:'test-errors',flowVersion:2,status:'open',title:'테스트',calendarLabel:'테스트',paymentDeadlineHours:12,courses:[{id:'lee',name:'코치 A 80분',sessions:[{teacherId:'lee',durationMinutes:80}]}],questions:[]};
const req={method:'POST',query:{},body:{eventId:event.id,requestId:'11111111-1111-4111-8111-111111111111',name:'오류테스트',email:'test@example.invalid',phone:'010-0000-0000',answers:[],consent:true,course:'lee'}};
for(const [bridgeStatus,httpStatus,code] of [['duplicate',409,'DUPLICATE_APPLICATION'],['conflict',409,'REQUEST_CONFLICT'],['busy',503,'STORE_BUSY'],['review',503,'STORE_UNAVAILABLE'],['invalid',503,'STORE_UNAVAILABLE']]){
 const calls=[];const result=await paymentFirst({route:'apply',req,authorized:false,events:async()=>[event],bridge:async d=>{calls.push(d);return {status:bridgeStatus};}});
 assert.equal(result.status,httpStatus);assert.equal(result.data.code,code);assert.ok(result.data.error);assert.equal(calls.length,1);assert.equal(calls[0].action,'v2_create');
}
console.log('PASS application errors: duplicate/conflict distinguished from busy/store failures; no mail/calendar/notion side effects');
