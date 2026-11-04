import {deleteTestApplication} from './test-delete.js';
import {createHmac,createHash,randomUUID,timingSafeEqual} from 'node:crypto';
const base=(process.env.APP_BASE_URL||'https://example.com').replace(/\/$/,'');

export function bookingToken(record){return createHmac('sha256',process.env.MAIL_WEBHOOK_SECRET).update('booking-v2:'+record.id+':'+record.created).digest('hex');}
export function validToken(record,token){return typeof token==='string'&&/^[a-f0-9]{64}$/.test(token)&&timingSafeEqual(Buffer.from(token),Buffer.from(bookingToken(record)));}
export function stableId(value){const h=createHash('sha256').update(value).digest('hex').slice(0,32);return `${h.slice(0,8)}-${h.slice(8,12)}-${h.slice(12,16)}-${h.slice(16,20)}-${h.slice(20)}`;}
export function courseSessions(c){return c.sessions||[{teacherId:'lee',durationMinutes:80}];}
export function validateV2Event(e,policy){
 if(e.flowVersion!==2)return '';
 if(!Number.isInteger(e.paymentDeadlineHours)||e.paymentDeadlineHours<1||e.paymentDeadlineHours>168)return '결제 기한은 1–168시간으로 설정해 주세요.';
 if(!e.calendarLabel?.trim()||e.calendarLabel.length>50)return '캘린더 표시명을 입력해 주세요.';
 if(e.id==='shinhan-2026'&&(e.courses.length!==1||courseSessions(e.courses[0]).length!==1))return '이번 신한은행 이벤트는 1회 코칭 한 가지만 운영합니다.';
 if(new Set(e.courses.map(c=>c.id)).size!==e.courses.length)return '과정 ID가 중복됩니다.';
 for(const c of e.courses){const sessions=courseSessions(c);if(!c.name?.trim()||sessions.length<1||sessions.length>2)return '코칭 옵션은 1회 또는 2회로 설정해 주세요.';
 for(const s of sessions){if(!Number.isInteger(s.durationMinutes)||s.durationMinutes<10||s.durationMinutes>240)return '회차 시간을 확인해 주세요.';if(e.status==='open'&&!policy.teachers.some(t=>t.id===s.teacherId&&t.calendarId))return '선택한 강사의 캘린더를 먼저 연결해 주세요.';}}
 return '';
}
async function patch(bridge,id,value){const d=await bridge({action:'update_application',recordId:id,patch:value});if(d.status!=='ok')throw Error('save');}
export async function syncV2(bridge,r,e,notionPayload){
 let status='unconfigured',leaseToken;
 if(process.env.NOTION_TOKEN){
  leaseToken=randomUUID();
  const claim=await bridge({action:'v2_sync_claim',recordId:r.id,leaseToken});
  if(claim.status==='busy')return 'pending';
  if(claim.status!=='ok')return 'review';
  r=claim.record;
  try{
   const headers={Authorization:`Bearer ${process.env.NOTION_TOKEN}`,'Notion-Version':'2022-06-28','Content-Type':'application/json'};
   const q=await fetch(`https://api.notion.com/v1/databases/${process.env.NOTION_DATABASE_ID}/query`,{method:'POST',headers,body:JSON.stringify({filter:{property:'신청ID',rich_text:{equals:r.id}}}),signal:AbortSignal.timeout(15000)});const found=await q.json();if(!q.ok||!Array.isArray(found.results)||found.results.length>1)throw Error('query');
   const data=notionPayload(r,e,process.env.NOTION_DATABASE_ID);data.properties['결제확인']={checkbox:r.paymentStatus==='verified'};data.properties['접수상태']={select:{name:r.bookingStatus==='confirmed'?'확인':r.bookingStatus==='expired'?'취소':'접수'}};
   const response=await fetch(found.results.length?'https://api.notion.com/v1/pages/'+found.results[0].id:'https://api.notion.com/v1/pages',{method:found.results.length?'PATCH':'POST',headers,body:JSON.stringify(found.results.length?{properties:data.properties}:data),signal:AbortSignal.timeout(15000)});status=response.ok?'synced':'failed';
   await patch(bridge,r.id,{notionStatus:status,notionBookingStatus:r.bookingStatus,notionMailStatus:r.mailStatus});
  }catch{status='review';await patch(bridge,r.id,{notionStatus:status});}
  finally{await bridge({action:'v2_sync_release',recordId:r.id,leaseToken});}
  return status;
 }
 await patch(bridge,r.id,{notionStatus:status});return status;
}
async function send(bridge,r,kind,subject,body,attachmentId){let status='review';try{const d=await bridge({id:stableId(kind+':'+r.id),to:r.email,subject,body,attachmentId});if(d.status==='sent')status='sent';}catch{}await patch(bridge,r.id,{[kind+'MailStatus']:status,...(kind==='application'?{mailStatus:status}:{})});return status;}


async function sendApplication(bridge,r,e,render){
 const c=r.courseSnapshot;
  const vars={'신청자명':r.name,'이벤트명':e.title.replace(/\n/g,' '),'신청과정':c.name,'결제링크':c.paymentUrl,'결제기한':new Date(r.paymentDueAt).toLocaleString('ko-KR',{timeZone:'Asia/Seoul'}),'예약일시':'결제 확인 후 전용 링크에서 선택'};
  return r.mailStatus==='sent'?'sent':await send(bridge,r,'application',render(e.subject,vars),render(e.body,vars),e.attachmentId);
}
async function sendFinal(bridge,r){return r.confirmationMailStatus==='sent'?'sent':await send(bridge,r,'confirmation','[코칭 운영] 코칭 예약 최종 확정',r.name+'님, 코칭 예약이 확정되었습니다.\n\n'+r.eventTitle.replace(/\n/g,' ')+'\n'+r.courseSnapshot.name+'\n'+r.sessions.map(s=>`${s.index+1}회차 · ${s.teacherName} · ${new Date(s.slot).toLocaleString('ko-KR',{timeZone:'Asia/Seoul'})}`).join('\n')+'\n\n코칭일 최소 하루 전까지 경험정리 양식을 작성하여 회신해 주세요. 코치 B 대표님(operator@example.com)을 참조해 주세요.');}
export async function paymentFirst({route,req,authorized,bridge,events,render,notionPayload}){
 if(route==='delete-test-application')return deleteTestApplication({req,authorized,bridge});
 const b=req.body||{},q=req.query||{};const reply=(status,data)=>({status,data});
 if(route==='policy'){
  if(!authorized)return reply(403,{error:'운영자 인증이 필요합니다.'});
  if(req.method!=='POST')return reply(405,{error:'잘못된 요청입니다.'});
  const d=await bridge({action:'v2_policy',policy:b});return reply(d.status==='ok'?200:409,d.status==='ok'?{ok:true}:{error:({existing_booking_conflict:'기존 예약과 겹칩니다. 예약을 먼저 조정해 주세요.',calendar_in_use:'향후 예약이 있는 강사의 캘린더는 변경할 수 없습니다.',calendar_unavailable:'캘린더를 읽을 수 없습니다. 운영 계정에 캘린더를 공유해 주세요.'})[d.status]||'운영시간과 예약 불가 기간을 확인해 주세요.'});
 }
 if(route==='apply'){
  const e=(await events()).find(x=>x.id===b.eventId);if(e?.flowVersion!==2)return null;
  if(req.method!=='POST')return reply(405,{error:'잘못된 요청입니다.'});
  if(process.env.GO_LIVE!=='true'&&(!authorized||b.email?.toLowerCase()!=='operator@example.com'))return reply(403,{error:'운영자 테스트만 가능합니다.'});
  const c=e.courses.find(c=>c.id===b.course);if(e.status!=='open'||!c)return reply(409,{error:'접수 준비 중입니다.'});
  if(b.consent!==true||b.website||typeof b.name!=='string'||b.name.trim().length<2||b.name.length>80||typeof b.email!=='string'||b.email.length>254||!/^\S+@\S+\.\S+$/.test(b.email)||typeof b.phone!=='string'||!/^[0-9+() -]{8,25}$/.test(b.phone)||!Array.isArray(b.answers)||b.answers.length!==e.questions.length||b.answers.some(x=>typeof x!=='string'||!x.trim()||x.length>3000))return reply(400,{error:'필수 항목을 확인해 주세요.'});
  if(!/^[a-f0-9-]{36}$/.test(b.requestId||''))return reply(400,{error:'새로고침 후 신청해 주세요.'});
  const record={id:b.requestId,flowVersion:2,eventId:e.id,eventLabel:e.calendarLabel||e.title.replace(/\n/g,' '),eventTitle:e.title,email:b.email.toLowerCase(),name:b.name.trim(),courseSnapshot:{...c,sessions:courseSessions(c)},slot:null,sessions:[],data:JSON.stringify({name:b.name,email:b.email,phone:b.phone,course:b.course,answers:b.answers,consent:true}),created:new Date().toISOString(),paymentDueAt:new Date(Date.now()+e.paymentDeadlineHours*3600000).toISOString(),mailStatus:'pending',notionStatus:'pending',bookingStatus:'awaiting_payment',paymentStatus:'pending'};
  if(JSON.stringify(record).length>45000)return reply(400,{error:'신청 답변이 너무 깁니다. 답변을 줄인 뒤 다시 제출해 주세요.'});
  const saved=await bridge({action:'v2_create',record});
  if(saved.status==='duplicate')return reply(409,{code:'DUPLICATE_APPLICATION',error:'같은 이메일로 이 이벤트에 이미 신청한 내역이 있습니다. 기존 신청 안내 메일을 확인해 주세요. 추가 신청이나 테스트가 필요하면 운영자에게 문의해 주세요.'});
  if(saved.status==='conflict')return reply(409,{code:'REQUEST_CONFLICT',error:'이 접수 요청은 이미 처리된 내역과 입력 내용이 다릅니다. 기존 신청 안내 메일을 먼저 확인하고, 신청 내용을 수정하려면 운영자에게 문의해 주세요.'});
  if(saved.status!=='ok')return reply(503,{code:saved.status==='busy'?'STORE_BUSY':'STORE_UNAVAILABLE',error:saved.status==='busy'?'현재 다른 접수를 처리하고 있습니다. 잠시 후 다시 눌러 주세요.':'신청 저장을 확인하지 못했습니다. 중복 신청을 피하려면 안내 메일을 먼저 확인한 뒤 운영자에게 문의해 주세요.'});
  const r=saved.record;
  if(['test_deleting','test_deleted'].includes(r.bookingStatus))return reply(410,{code:'APPLICATION_REMOVED',error:'테스트 삭제 처리된 신청입니다. 새로고침한 뒤 새 신청을 접수해 주세요.'});
  if(r.bookingStatus==='expired')return reply(410,{code:'APPLICATION_EXPIRED',error:'기존 신청의 결제 기한이 만료되었습니다. 이미 결제했다면 운영자에게 확인을 요청해 주세요. 새 신청은 페이지를 새로고침한 후 진행해 주세요.'});
  const mailStatus=await sendApplication(bridge,r,e,render);
  if(r.notionStatus!=='synced')await syncV2(bridge,{...r,mailStatus},e,notionPayload);
  return reply(200,{id:r.id,mailStatus,bookingStatus:r.bookingStatus,paymentDueAt:r.paymentDueAt});
 }
 if(route==='retry-notifications'){
  if(!authorized)return reply(403,{error:'운영자 인증이 필요합니다.'});
  if(req.method!=='POST')return reply(405,{error:'잘못된 요청입니다.'});
  if(!/^[a-f0-9-]{36}$/.test(b.id||''))return reply(400,{error:'신청 ID를 확인해 주세요.'});
  const all=await bridge({action:'v2_admin'});if(all.status!=='ok')throw Error('store');
  const r=all.applications.find(x=>x.id===b.id),e=r&&all.events.find(x=>x.id===r.eventId);
  if(!r||r.flowVersion!==2||!e)return reply(404,{error:'신청 내역을 찾을 수 없습니다.'});
  if(r.bookingStatus!=='awaiting_payment'||r.paymentStatus==='verified')return reply(409,{error:'결제 대기 중인 신청의 접수 안내만 재확인할 수 있습니다. 만료된 신청에는 결제를 다시 안내하지 않습니다.'});
  const mailStatus=await sendApplication(bridge,r,e,render);await syncV2(bridge,r,e,notionPayload);return reply(200,{ok:true,mailStatus});
 }
 if(route==='confirm-payment'&&req.method==='POST'){
  if(!authorized)return reply(403,{error:'운영자 인증이 필요합니다.'});
  if(!/^[a-f0-9-]{36}$/.test(b.id||'')||b.paymentChecked!==true||typeof b.reference!=='string'||b.reference.trim().length<3||b.reference.length>200)return reply(400,{error:'실제 결제 내역을 확인하고 주문번호 또는 확인 근거를 입력해 주세요.'});
  const all=await bridge({action:'v2_admin'});if(all.status!=='ok')throw Error('bridge');const record=all.applications.find(r=>r.id===b.id);if(!record||record.flowVersion!==2)return null;
  const d=await bridge({action:'v2_paid',recordId:b.id,reference:b.reference.trim(),paymentChecked:true});if(d.status!=='ok')return reply(409,{error:'결제 확인이 가능한 신청이 아닙니다.'});
  const r=d.record;
  if(r.bookingStatus==='confirmed'){const confirmationMailStatus=await sendFinal(bridge,r);const e=all.events.find(e=>e.id===r.eventId);if(e)await syncV2(bridge,r,e,notionPayload);return reply(200,{ok:true,bookingStatus:r.bookingStatus,confirmationMailStatus});}
  const link=base+'/?booking='+r.id+'&token='+bookingToken(r);const status=r.scheduleMailStatus==='sent'?'sent':await send(bridge,r,'schedule','[코칭 운영] 결제 확인 완료 · 코칭 날짜를 선택해 주세요',r.name+'님, 결제 확인이 완료되었습니다.\n\n'+r.eventTitle.replace(/\n/g,' ')+'\n'+r.courseSnapshot.name+'\n\n아래 본인 전용 링크에서 각 회차의 날짜와 시간을 선택해 주세요.\n'+link+'\n\n날짜 선택을 완료해야 예약이 확정됩니다. 이 링크를 다른 사람에게 공유하지 마세요.\n\n경험정리 양식 작성과 이력서·자기소개서 준비에 필요한 시간을 충분히 확보한 뒤 코칭 날짜를 선택해 주세요. 준비자료는 코칭일 최소 하루 전까지 제출해 주세요.\n예약은 최소 24시간 전에 가능합니다.');
  const e=all.events.find(e=>e.id===r.eventId);if(e)await syncV2(bridge,r,e,notionPayload);return reply(200,{ok:true,bookingStatus:r.bookingStatus,scheduleMailStatus:status});
 }
 if(['booking','booking-availability','book-session'].includes(route)){
  if((route==='book-session'&&req.method!=='POST')||(route!=='book-session'&&req.method!=='GET'))return reply(405,{error:'잘못된 요청입니다.'});
  const params=req.method==='POST'?b:q;if(!/^[a-f0-9-]{36}$/.test(params.id||''))return reply(403,{error:'예약 링크를 확인해 주세요.'});
  const d=await bridge({action:'v2_record',recordId:params.id});if(d.status!=='ok'||!validToken(d.record,params.token))return reply(403,{error:'유효한 본인 전용 예약 링크가 필요합니다.'});
  const r=d.record;if(r.paymentStatus!=='verified')return reply(403,{error:'운영자 결제 확인 후 날짜를 신청할 수 있습니다.'});
  if(route==='booking')return reply(200,{id:r.id,name:r.name,title:r.eventTitle,course:r.courseSnapshot,sessions:r.sessions,bookingStatus:r.bookingStatus});
  const result=await bridge({action:route==='book-session'?'v2_reserve':'v2_availability',recordId:r.id,sessionIndex:Number(params.sessionIndex),slot:params.slot});
  if(route==='booking-availability')return result.status==='ok'?reply(200,{slots:result.slots}):reply(409,{error:result.status==='calendar_unconfigured'?'강사 캘린더 연결을 운영자가 확인 중입니다.':'이미 예약된 회차이거나 시간을 조회할 수 없습니다.'});
  if(result.status!=='reserved')return reply(409,{error:result.status==='conflict'?'선택한 시간이 더 이상 가능하지 않습니다. 다른 시간을 선택해 주세요.':'예약 결과를 확인 중입니다. 다시 신청하지 말고 운영자에게 문의해 주세요.'});
  const next=result.record;let confirmationMailStatus=next.confirmationMailStatus;
  if(next.bookingStatus==='confirmed')confirmationMailStatus=await sendFinal(bridge,next);
  const e=(await events()).find(e=>e.id===next.eventId);if(e)await syncV2(bridge,next,e,notionPayload);
  return reply(200,{ok:true,bookingStatus:next.bookingStatus,sessions:next.sessions,confirmationMailStatus});
 }
 return null;
}
