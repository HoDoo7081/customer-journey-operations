import assert from 'node:assert/strict';
import {paymentFirst,bookingToken} from '../mockup/lib/payment-first.js';
process.env.MAIL_WEBHOOK_SECRET='test-only';process.env.GO_LIVE='true';delete process.env.NOTION_TOKEN;
const record={id:'11111111-1111-4111-8111-111111111111',flowVersion:2,eventId:'test',eventTitle:'테스트',created:'2026-11-04T00:00:00Z',email:'test@example.invalid',name:'테스트',paymentStatus:'pending',bookingStatus:'awaiting_payment',courseSnapshot:{name:'코치 A 1회',sessions:[{teacherId:'lee',durationMinutes:80}]},data:'{}',sessions:[]};
const calls=[];let mails=0;
async function bridge(d){calls.push(d);if(d.action==='v2_admin')return {status:'ok',applications:[record],events:[{id:'test'}]};if(d.action==='v2_record')return {status:'ok',record};if(d.action==='v2_paid'){record.paymentStatus='verified';record.bookingStatus='awaiting_schedule';return {status:'ok',record};}if(d.action==='update_application'){Object.assign(record,d.patch);return {status:'ok'};}if(d.to){mails++;return {status:'sent'};}if(d.action==='v2_reserve'){record.sessions=[{index:0,teacherName:'코치 A',slot:'2026-11-07T00:00:00Z'}];record.bookingStatus='confirmed';return {status:'reserved',record};}throw Error('Unexpected '+d.action);}
const invoke=(route,method,body,query={})=>paymentFirst({route,req:{method,body,query},authorized:true,bridge,events:async()=>[{id:'test'}]});
assert.equal((await invoke('booking','GET',null,{id:record.id,token:bookingToken(record)})).status,403,'valid link still cannot bypass unpaid status');
assert.equal((await invoke('confirm-payment','POST',{id:record.id,reference:'order',paymentChecked:false})).status,400);
let d=await invoke('confirm-payment','POST',{id:record.id,reference:'TEST-order',paymentChecked:true});assert.equal(d.data.scheduleMailStatus,'sent');assert.equal(mails,1);assert.match(calls.find(c=>c.to).body,/\?booking=/);assert.equal(calls.filter(c=>c.action==='v2_reserve').length,0,'payment verification must not reserve a random time');
await invoke('confirm-payment','POST',{id:record.id,reference:'TEST-order',paymentChecked:true});assert.equal(mails,1,'repeat payment verification must not resend');
assert.equal((await invoke('booking','GET',null,{id:record.id,token:bookingToken(record)})).status,200);
d=await invoke('book-session','POST',{id:record.id,token:bookingToken(record),sessionIndex:0,slot:'2026-11-07T00:00:00Z'});assert.equal(d.data.bookingStatus,'confirmed');assert.equal(d.data.confirmationMailStatus,'sent');assert.equal(mails,2);
await invoke('book-session','POST',{id:record.id,token:bookingToken(record),sessionIndex:0,slot:'2026-11-07T00:00:00Z'});assert.equal(mails,2);
console.log('PASS payment verification -> private booking link -> reservation -> final email, duplicate mail suppression, no payment bypass');
