import assert from 'node:assert/strict';
import{call,stores,props,events,record,context}from'./payment-first.mjs';
import{paymentFirst,syncV2}from'../mockup/lib/payment-first.js';
import{confirmPayment}from'../mockup/lib/confirmation.js';
const clone=x=>JSON.parse(JSON.stringify(x));
// Malformed JSON policy values must fail before property mutation.
const policy=call({action:'v2_admin'}).policy,before=props.get('BOOKING_V2_POLICY');
for(const patch of [{minimumNoticeHours:null},{bookingHorizonDays:'30'},{bufferMinutes:null},{teachers:[]},{teachers:[null]},{teachers:[policy.teachers[0],policy.teachers[0]]}]){assert.equal(call({action:'v2_policy',policy:{...clone(policy),...patch}}).status,'invalid');assert.equal(props.get('BOOKING_V2_POLICY'),before);}
const malformed=clone(policy);malformed.teachers[0].blocks=[{start:'2026-11-10T00:00:00Z',end:'invalid'}];assert.equal(call({action:'v2_policy',policy:malformed}).status,'invalid');
const removed=clone(policy);removed.teachers=removed.teachers.filter(t=>t.id!=='min');assert.equal(call({action:'v2_policy',policy:removed}).status,'calendar_in_use');
stores.Applications.push({id:'legacy-policy-check',eventId:'legacy',email:'legacy@example.invalid',calendarEventId:'legacy-event',slot:'2026-11-20T00:00:00Z',bookingStatus:'reserved'});
const rebound=clone(policy);rebound.teachers[0].calendarId='new-calendar';assert.equal(call({action:'v2_policy',policy:rebound}).status,'calendar_in_use');stores.Applications.pop();
stores.Events.push({id:'open-policy-test',flowVersion:2,status:'open',courses:[{sessions:[{teacherId:'lee'}]}]});const disconnected=clone(policy);disconnected.teachers[0].calendarId='';assert.equal(call({action:'v2_policy',policy:disconnected}).status,'calendar_unavailable');stores.Events.pop();
// Cross-event request reuse must never return another application's success.
assert.equal(call({action:'v2_create',record:{...record,eventId:'other-event'}}).status,'conflict');
assert.equal(call({action:'v2_sync_claim',recordId:record.id,leaseToken:'owner-A'}).status,'ok');assert.equal(call({action:'v2_sync_claim',recordId:record.id,leaseToken:'owner-B'}).status,'busy');
call({action:'v2_sync_release',recordId:record.id,leaseToken:'wrong-owner'});assert.equal(call({action:'v2_sync_claim',recordId:record.id,leaseToken:'owner-B'}).status,'busy');call({action:'v2_sync_release',recordId:record.id,leaseToken:'owner-A'});assert.equal(call({action:'v2_sync_claim',recordId:record.id,leaseToken:'owner-B'}).status,'ok');call({action:'v2_sync_release',recordId:record.id,leaseToken:'owner-B'});
// Failed global lock prevents any mutation, including competing reservations.
const snapshot=JSON.stringify(stores),calendarCount=events.length,lock=context.LockService.getScriptLock;context.LockService.getScriptLock=()=>({tryLock:()=>false});assert.equal(call({action:'v2_create',record:{...record,id:'busy'}}).status,'busy');assert.equal(JSON.stringify(stores),snapshot);assert.equal(events.length,calendarCount);context.LockService.getScriptLock=lock;
console.log('PASS policy validation, legacy reservation protection, cross-event replay, sync lease ownership, lock contention');
process.env.GO_LIVE='true';delete process.env.NOTION_TOKEN;
const event={id:'reliability-test',flowVersion:2,status:'open',title:'테스트',calendarLabel:'테스트',paymentDeadlineHours:12,courses:[{id:'lee',name:'코치 A80분',sessions:[{teacherId:'lee',durationMinutes:80}]}],questions:[]};
const req={method:'POST',query:{},body:{eventId:event.id,requestId:record.id,name:'테스트',email:'test@example.invalid',phone:'010-0000-0000',consent:true,answers:[],course:'lee'}};
let calls=[];let response=await paymentFirst({route:'apply',req,events:async()=>[event],bridge:async d=>{calls.push(d);return {status:'ok',record:{...record,bookingStatus:'expired'}}}});assert.equal(response.status,410);assert.equal(calls.length,1);
response=await paymentFirst({route:'apply',req:{...req,body:{...req.body,consent:'false'}},events:async()=>[event],bridge:async()=>{throw Error('must not call')}});assert.equal(response.status,400);
// Operator may recover final-mail failure without sending a scheduling mail or changing payment audit.
let row={...clone(record),bookingStatus:'confirmed',paymentStatus:'verified',confirmationMailStatus:'review',sessions:[{index:0,teacherName:'코치 A',slot:'2026-11-07T00:00:00Z'}]},mailCount=0;
async function b(d){if(d.action==='v2_admin')return {status:'ok',applications:[row],events:[{id:row.eventId}]};if(d.action==='v2_paid')return {status:'ok',record:row};if(d.action==='update_application'){Object.assign(row,d.patch);return {status:'ok'}}if(d.to){assert.match(d.subject,/최종 확정/);mailCount++;return {status:'sent'}}throw Error(d.action)}
const input={route:'confirm-payment',req:{method:'POST',body:{id:row.id,paymentChecked:true,reference:'review evidence'}},authorized:true,bridge:b};assert.equal((await paymentFirst(input)).data.confirmationMailStatus,'sent');await paymentFirst(input);assert.equal(mailCount,1);
row={...clone(record),bookingStatus:'confirmed',calendarEventId:'old-event',confirmationMailStatus:'pending',confirmedAt:'original-time'};mailCount=0;
async function legacy(d){if(d.action==='admin_data')return {status:'ok',applications:[row],events:[{id:row.eventId,title:'이전예약'}]};if(d.action==='update_application'){Object.assign(row,d.patch);return {status:'ok'}}mailCount++;return {status:'sent'}}
assert.equal((await confirmPayment({body:{id:row.id,paymentChecked:true,reference:'original-order'},authorized:true,bridge:legacy,owner:'operator@example.invalid'})).data.confirmationMailStatus,'sent');assert.equal(row.confirmedAt,'original-time');assert.equal(mailCount,1);
console.log('PASS expired retry denies payment, strict consent, v2 and legacy final-mail recovery without duplicate sends/audit loss');
// Parallel Notion requests share a durable lease. Only one may create the page.
process.env.NOTION_TOKEN='test-only';process.env.NOTION_DATABASE_ID='test-only';let held=false,created=0,releaseFirst;const gate=new Promise(r=>releaseFirst=r);const nativeFetch=globalThis.fetch;row={...clone(record),bookingStatus:'confirmed',paymentStatus:'verified',mailStatus:'sent'};
async function syncBridge(d){if(d.action==='v2_sync_claim'){if(held)return {status:'busy'};held=true;return {status:'ok',record:row}}if(d.action==='v2_sync_release'){held=false;return {status:'ok'}}if(d.action==='update_application'){Object.assign(row,d.patch);return {status:'ok'}}throw Error(d.action)}
globalThis.fetch=async(url,opts)=>{if(url.endsWith('/query')){await gate;return {ok:true,json:async()=>({results:[]})}}created++;return {ok:true}};
try{const first=syncV2(syncBridge,row,event,()=>({properties:{}}));await new Promise(r=>setTimeout(r,0));assert.equal(await syncV2(syncBridge,row,event,()=>({properties:{}})),'pending');releaseFirst();assert.equal(await first,'synced');assert.equal(created,1);assert.equal(held,false);
globalThis.fetch=async()=>{throw Error('simulated upstream outage')};assert.equal(await syncV2(syncBridge,row,event,()=>({properties:{}})),'review');assert.equal(held,false);}finally{globalThis.fetch=nativeFetch;delete process.env.NOTION_TOKEN;}
console.log('PASS concurrent Notion sync creates once; upstream failure releases lease and marks review');
// Recover a known pre-send failure, reuse the mail ID, and never turn it into payment verification.
row={...clone(record),eventId:event.id,bookingStatus:'awaiting_payment',paymentStatus:'pending',mailStatus:'review',paymentDueAt:new Date(Date.now()+3600000).toISOString()};mailCount=0;const mailIds=[];
async function appRetry(d){if(d.action==='v2_admin')return {status:'ok',applications:[row],events:[{...event,subject:'신청 안내',body:'결제 안내'}]};if(d.action==='update_application'){Object.assign(row,d.patch);return {status:'ok'}}if(d.to){mailCount++;mailIds.push(d.id);return {status:'sent'}}throw Error(d.action)}
const recovery={route:'retry-notifications',req:{method:'POST',body:{id:row.id}},authorized:true,bridge:appRetry,render:s=>s};
assert.equal((await paymentFirst({...recovery,authorized:false})).status,403);assert.equal((await paymentFirst(recovery)).data.mailStatus,'sent');await paymentFirst(recovery);assert.equal(mailCount,1);assert.equal(row.paymentStatus,'pending');row.bookingStatus='expired';assert.equal((await paymentFirst(recovery)).status,409);assert.equal(mailCount,1);
console.log('PASS operator-only initial-mail recovery; no duplicate sends, payment verification, or expired payment notice');
