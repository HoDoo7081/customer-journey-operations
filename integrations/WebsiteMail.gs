/** Google Apps Script Web App receiver. Deploy as operator@example.com.
 * Script Properties: MAIL_WEBHOOK_SECRET (same secret as Site)
 * Deploy execute-as owner. The shared HMAC authenticates POST payloads.
 * Never expose the secret in client code. */
function doPost(e) {
  const props = PropertiesService.getScriptProperties();
  const secret = props.getProperty('MAIL_WEBHOOK_SECRET');
  if (!secret) return json_({status:'unconfigured'});
  try {
    const request = JSON.parse(e.postData.contents);
    const expected = Utilities.computeHmacSha256Signature(request.payload, secret)
      .map(x => ('0' + ((x + 256) % 256).toString(16)).slice(-2)).join('');
    let diff = expected.length ^ String(request.signature).length;
    for (let i=0;i<expected.length;i++) diff |= expected.charCodeAt(i) ^ String(request.signature).charCodeAt(i);
    if(diff) return json_({status:'unauthorized'});
    const data = JSON.parse(request.payload);
    if (Math.abs(Date.now()-data.timestamp)>300000 || !/^[a-f0-9-]{36}$/.test(data.id)) return json_({status:'invalid'});
    if (Session.getEffectiveUser().getEmail().toLowerCase() !== 'operator@example.com') return json_({status:'wrong_sender'});
    if(typeof data.action==='string'&&data.action.indexOf('v2_')===0)return json_(bookingV2_(data));
    if(['otp_send','otp_verify','events','admin_data','save_event','insert_application','update_application'].indexOf(data.action)!==-1)return json_(bookingStore_(data));
    if(data.action==='availability'||data.action==='reserve') return json_(calendarRequest_(data));
    const key='sent_'+data.id,lock=LockService.getScriptLock();if(!lock.tryLock(10000))return json_({status:'busy'});
    try {
      const previous=props.getProperty(key);if(previous)return json_({status:previous});
      props.setProperty(key,'review'); // Durable claim before sending. Never resend ambiguous outcomes.
    } finally {lock.releaseLock();}
    let attachments;
    try {
      if(MailApp.getRemainingDailyQuota()<1){props.deleteProperty(key);return json_({status:'quota'});}
      attachments=data.attachmentId?[DriveApp.getFileById(data.attachmentId).getBlob()]:[];
    } catch(preflightError){props.deleteProperty(key);return json_({status:'preflight_failed'});}
    // Drive/Mail can be slow; never hold the shared booking lock across network services.
    MailApp.sendEmail({to:data.to,subject:data.subject,body:data.body,name:'코칭 운영 운영팀',replyTo:'operator@example.com',attachments});
    props.setProperty(key,'sent');return json_({status:'sent'});
  } catch(err) { return json_({status:'review'}); }
}
function json_(data){return ContentService.createTextOutput(JSON.stringify(data)).setMimeType(ContentService.MimeType.JSON);}


/** Add beside WebsiteMail.gs; requires Calendar authorization before use.
 * Called ONLY after WebsiteMail.doPost verifies the HMAC, timestamp and sender.
 * Script Properties CALENDAR_POLICY is a reviewed JSON policy; no client-supplied IDs.
 */
function calendarRequest_(data) {
 const raw=PropertiesService.getScriptProperties().getProperty('CALENDAR_POLICY');
 if(!raw)return {status:'calendar_unconfigured'};
 const p=JSON.parse(raw),course=p.courses[data.course];
 if(!course||p.timezone!=='Asia/Seoul')return {status:'invalid'};
 const calendar=CalendarApp.getCalendarById(p.calendarId);
 if(!calendar)return {status:'calendar_unavailable'};
 const duration=course.durationMinutes,buffer=p.bufferMinutes;
 const now=Date.now(),first=now+p.minimumNoticeHours*3600000,last=now+p.bookingHorizonDays*86400000;
 function permitted(start){
  const d=new Date(start),day=Number(Utilities.formatDate(d,p.timezone,'u'));
  const [h,m]=Utilities.formatDate(d,p.timezone,'HH:mm').split(':').map(Number);
  const [sh,sm]=p.businessStart.split(':').map(Number),[eh,em]=p.businessEnd.split(':').map(Number);
  return start>=first&&start<=last&&p.weekdays.indexOf(day)!==-1&&h*60+m>=sh*60+sm&&h*60+m+duration+buffer<=eh*60+em;
 }
 function free(start){return !calendar.getEvents(new Date(start-buffer*60000),new Date(start+(duration+buffer)*60000)).some(e=>e.getTransparency()!==CalendarApp.EventTransparency.TRANSPARENT);}
 if(data.action==='availability'){
  const slots=[],busy=calendar.getEvents(new Date(first-buffer*60000),new Date(last+(duration+buffer)*60000)).filter(e=>e.getTransparency()!==CalendarApp.EventTransparency.TRANSPARENT).map(e=>[e.getStartTime().getTime(),e.getEndTime().getTime()]);
  for(let t=Math.ceil(first/1800000)*1800000;t<=last;t+=1800000)if(permitted(t)&&!busy.some(b=>b[0]<t+(duration+buffer)*60000&&b[1]>t-buffer*60000))slots.push(new Date(t).toISOString());
  return {status:'ok',slots};
 }
 if(data.action!=='reserve'||!data.bookingId||!/^[a-f0-9-]{36}$/.test(data.bookingId))return {status:'invalid'};
 const start=Date.parse(data.slot);if(!Number.isFinite(start)||!permitted(start))return {status:'invalid_slot'};
 const lock=LockService.getScriptLock();if(!lock.tryLock(10000))return {status:'busy'};
 try {
  const props=PropertiesService.getScriptProperties(),key='booking_'+data.bookingId,existing=props.getProperty(key);
  if(existing)return {status:existing==='review'?'review':'reserved',eventId:existing==='review'?null:existing};
  if(!free(start))return {status:'conflict'};
  props.setProperty(key,'review');
  const event=calendar.createEvent('[코칭 운영] 코칭 예약',new Date(start),new Date(start+duration*60000),{description:'신청 ID: '+data.bookingId+'\n과정: '+data.course,sendInvites:false});
  props.setProperty(key,event.getId());return {status:'reserved',eventId:event.getId()};
 }finally{lock.releaseLock();}
}


/** Signed server-only actions. No browser access to spreadsheet or credentials. */
function setupBookingStore(){
 const p=PropertiesService.getScriptProperties();
 let id=p.getProperty('BOOKING_SHEET_ID');
 if(!id){const ss=SpreadsheetApp.create('코칭 운영 | 코칭 운영 원본');id=ss.getId();p.setProperty('BOOKING_SHEET_ID',id);}
 const ss=SpreadsheetApp.openById(id);
 ['Events','Applications'].forEach(name=>{let s=ss.getSheetByName(name);if(!s)s=ss.insertSheet(name);if(!s.getLastRow())s.appendRow(['ID','JSON','Updated']);s.setFrozenRows(1);});
 console.log('운영 원본 준비 완료: '+ss.getUrl());
}
function bookingStore_(d){
 const p=PropertiesService.getScriptProperties(),cache=CacheService.getScriptCache();
 const lock=LockService.getScriptLock();if(!lock.tryLock(15000))return {status:'busy'};
 try {
  if(d.action==='otp_send'){
   if(cache.get('otp_cooldown'))return {status:'rate_limited'};
   cache.put('otp_cooldown','1',60);cache.put('otp_hash',d.hash,600);cache.put('otp_attempts','0',600);
   MailApp.sendEmail({to:'operator@example.com',subject:'[코칭 운영] 운영자 로그인 인증번호',body:'인증번호: '+d.code+'\n10분 동안 유효합니다. 본인이 요청하지 않았다면 무시해 주세요.',name:'코칭 운영 운영팀'});return {status:'ok'};
  }
  if(d.action==='otp_verify'){
   const attempts=Number(cache.get('otp_attempts')||0)+1;cache.put('otp_attempts',String(attempts),600);
   if(attempts>5||!cache.get('otp_hash')||cache.get('otp_hash')!==d.hash)return {status:'invalid'};
   cache.remove('otp_hash');return {status:'ok'};
  }
  const id=p.getProperty('BOOKING_SHEET_ID');if(!id)return {status:'store_unconfigured'};
  const ss=SpreadsheetApp.openById(id);
  function rows(name){const s=ss.getSheetByName(name);return s.getLastRow()<2?[]:s.getRange(2,1,s.getLastRow()-1,3).getValues().map((r,i)=>({row:i+2,id:r[0],value:JSON.parse(r[1])}));}
  function put(name,id,value){const s=ss.getSheetByName(name),r=rows(name).find(r=>r.id===id);s.getRange(r?r.row:s.getLastRow()+1,1,1,3).setValues([[id,JSON.stringify(value),new Date().toISOString()]]);SpreadsheetApp.flush();}
  if(d.action==='events')return {status:'ok',events:rows('Events').map(r=>r.value)};
  if(d.action==='admin_data')return {status:'ok',events:rows('Events').map(r=>r.value),applications:rows('Applications').map(r=>r.value)};
  if(d.action==='save_event'){put('Events',d.event.id,d.event);return {status:'ok'};}
  if(d.action==='insert_application'){
   const all=rows('Applications').map(r=>r.value);
   const old=all.find(r=>r.id===d.record.id);if(old)return {status:'existing',record:old};
   if(all.some(r=>r.eventId===d.record.eventId&&r.email===d.record.email&&!['conflict','test_deleted'].includes(r.bookingStatus)))return {status:'duplicate'};
   put('Applications',d.record.id,d.record);return {status:'ok'};
  }
  if(d.action==='update_application'){
   const r=rows('Applications').find(r=>r.id===d.recordId);if(!r)return {status:'missing'};
   if(['test_deleting','test_deleted'].includes(r.value.bookingStatus))return {status:'deleted'};
   put('Applications',r.id,Object.assign(r.value,d.patch));return {status:'ok'};
  }
  return {status:'invalid'};
 }finally{lock.releaseLock();}
}


/** Payment-first workflow. All actions enter through the signed Google bridge. */
function bookingV2_(d) {
 const lock=LockService.getScriptLock();if(!lock.tryLock(15000))return {status:'busy'};
 try {
  const props=PropertiesService.getScriptProperties(),ss=SpreadsheetApp.openById(props.getProperty('BOOKING_SHEET_ID'));
  function rows(name){const s=ss.getSheetByName(name);return s.getLastRow()<2?[]:s.getRange(2,1,s.getLastRow()-1,3).getValues().map((r,i)=>({row:i+2,value:JSON.parse(r[1])}));}
  function put(name,value){const s=ss.getSheetByName(name),old=rows(name).find(r=>r.value.id===value.id);s.getRange(old?old.row:s.getLastRow()+1,1,1,3).setValues([[value.id,JSON.stringify(value),new Date().toISOString()]]);SpreadsheetApp.flush();}
  const applications=rows('Applications').map(r=>r.value);
  applications.forEach(r=>{if(r.flowVersion===2&&r.bookingStatus==='awaiting_payment'&&r.paymentStatus!=='verified'&&Date.parse(r.paymentDueAt)<=Date.now()){r.bookingStatus='expired';r.paymentStatus='expired';r.notionStatus='pending';put('Applications',r);}});
  const raw=props.getProperty('BOOKING_V2_POLICY');
  const legacy=JSON.parse(props.getProperty('CALENDAR_POLICY')||'{}');
  const policy=raw?JSON.parse(raw):{timezone:'Asia/Seoul',minimumNoticeHours:24,bookingHorizonDays:30,bufferMinutes:10,teachers:[{id:'lee',name:'코치 A',calendarId:legacy.calendarId||'operator@example.com',weekdays:legacy.weekdays||[1,2,3,4,5],start:legacy.businessStart||'09:00',end:legacy.businessEnd||'18:00',blocks:[]},{id:'min',name:'코치 B',calendarId:'',weekdays:[1,2,3,4,5],start:'09:00',end:'18:00',blocks:[]}]};
  if(['v2_test_delete','v2_test_delete_finish'].includes(d.action)){
   const r=applications.find(x=>x.id===d.recordId);
   if(!r)return {status:'missing'};
   if(d.eventId!==r.eventId||d.testAcknowledged!==true||typeof d.confirmEmail!=='string'||d.confirmEmail.trim().toLowerCase()!==r.email.toLowerCase())return {status:'invalid_confirmation'};
   if(r.bookingStatus==='test_deleted')return {status:'ok',record:r};
   if(d.action==='v2_test_delete_finish'){
    if(r.bookingStatus!=='test_deleting'||!r.testDeletion?.calendarComplete||!['archived','not_configured'].includes(d.notionCleanup))return {status:'invalid'};
    r.bookingStatus='test_deleted';r.testDeletion.notionCleanup=d.notionCleanup;r.testDeletion.completedAt=new Date().toISOString();r.testDeletion.deletedBy='operator@example.com';put('Applications',r);return {status:'ok',record:r};
   }
   const lease=JSON.parse(props.getProperty('notion_sync_'+r.id)||'null');if(lease&&lease.until>Date.now())return {status:'sync_busy'};
   if(r.bookingStatus!=='test_deleting'){
    const refs=r.flowVersion===2?(r.sessions||[]).map(s=>({calendarId:s.calendarId||policy.teachers.find(t=>t.id===s.teacherId)?.calendarId,eventId:s.calendarEventId})):r.calendarEventId?[{calendarId:legacy.calendarId,eventId:r.calendarEventId}]:[];
    const backups=[];
    for(const ref of refs){if(!ref.calendarId||!ref.eventId)return {status:'calendar_mismatch'};const cal=CalendarApp.getCalendarById(ref.calendarId);if(!cal)return {status:'calendar_unavailable'};const event=cal.getEventById(ref.eventId);if(event){if(event.getDescription().indexOf(r.id)===-1)return {status:'calendar_mismatch'};backups.push({...ref,title:event.getTitle(),description:event.getDescription(),start:event.getStartTime().toISOString(),end:event.getEndTime().toISOString()});}else backups.push({...ref,alreadyMissing:true});}
    r.testDeletion={previousBookingStatus:r.bookingStatus,startedAt:new Date().toISOString(),calendarBackups:backups,calendarComplete:false};r.bookingStatus='test_deleting';put('Applications',r);
   }
   if(!r.testDeletion.calendarComplete){for(const ref of r.testDeletion.calendarBackups){const cal=CalendarApp.getCalendarById(ref.calendarId);if(!cal)return {status:'calendar_unavailable',record:r};const event=cal.getEventById(ref.eventId);if(event){if(event.getDescription().indexOf(r.id)===-1)return {status:'calendar_mismatch',record:r};event.deleteEvent();}}r.testDeletion.calendarComplete=true;put('Applications',r);}
   return {status:'ok',record:r};
  }
  if(d.action==='v2_admin')return {status:'ok',version:2,events:rows('Events').map(r=>r.value),applications,policy};
  if(d.action==='v2_expire')return {status:'ok'};
  if(d.action==='v2_policy') {
   const p=d.policy;
   if(!p||p.timezone!=='Asia/Seoul'||!Array.isArray(p.teachers)||!p.teachers.length||p.teachers.some(t=>!t||typeof t.id!=='string'||typeof t.name!=='string'||typeof t.calendarId!=='string')||new Set(p.teachers.map(t=>t.id)).size!==p.teachers.length||!Number.isInteger(p.minimumNoticeHours)||!Number.isInteger(p.bookingHorizonDays)||!Number.isInteger(p.bufferMinutes)||p.minimumNoticeHours<0||p.minimumNoticeHours>720||p.bookingHorizonDays<1||p.bookingHorizonDays>90||p.bufferMinutes<0||p.bufferMinutes>120)return {status:'invalid'};
   for(const event of rows('Events').map(x=>x.value)){if(event.flowVersion!==2||event.status!=='open')continue;for(const course of event.courses)for(const session of course.sessions||[{teacherId:'lee'}]){const t=p.teachers.find(t=>t.id===session.teacherId);if(!t||!t.calendarId)return {status:'calendar_unavailable'};}}
   for(const oldTeacher of policy.teachers){if(!p.teachers.some(t=>t.id===oldTeacher.id)&&applications.some(r=>!['test_deleting','test_deleted'].includes(r.bookingStatus)&&((r.sessions||[]).some(s=>s.teacherId===oldTeacher.id&&Date.parse(s.end)>Date.now()))))return {status:'calendar_in_use'};}
   for(const t of p.teachers){if(!t.id||!t.name||!Array.isArray(t.weekdays)||!t.weekdays.length||t.weekdays.some(n=>!Number.isInteger(n)||n<1||n>7)||!/^([01]\d|2[0-3]):[0-5]\d$/.test(t.start)||!/^([01]\d|2[0-3]):[0-5]\d$/.test(t.end)||t.start>=t.end||!Array.isArray(t.blocks)||t.blocks.some(b=>!b||!Number.isFinite(Date.parse(b.start))||!Number.isFinite(Date.parse(b.end))||Date.parse(b.end)<=Date.parse(b.start)))return {status:'invalid'};
    if(t.calendarId&&!CalendarApp.getCalendarById(t.calendarId))return {status:'calendar_unavailable'};
    const previous=policy.teachers.find(x=>x.id===t.id);if(previous&&previous.calendarId!==t.calendarId&&applications.some(r=>!['test_deleting','test_deleted'].includes(r.bookingStatus)&&((r.sessions||[]).some(s=>s.teacherId===t.id&&Date.parse(s.end)>Date.now())||(r.flowVersion!==2&&r.calendarEventId&&previous.calendarId===legacy.calendarId&&Date.parse(r.slot)>Date.now()))))return {status:'calendar_in_use'};
    for(const r of applications){if(['test_deleting','test_deleted'].includes(r.bookingStatus))continue;if(r.flowVersion!==2&&r.calendarEventId&&Date.parse(r.slot)>Date.now()&&t.calendarId===legacy.calendarId){const old=CalendarApp.getCalendarById(t.calendarId).getEventById(r.calendarEventId);if(old&&t.blocks.some(b=>Date.parse(b.start)<old.getEndTime().getTime()&&Date.parse(b.end)>old.getStartTime().getTime()))return {status:'existing_booking_conflict'};}}
    for(const r of applications.filter(r=>!['test_deleting','test_deleted'].includes(r.bookingStatus)))for(const s of r.sessions||[]){if(s.teacherId===t.id&&t.blocks.some(b=>Date.parse(b.start)<Date.parse(s.end)&&Date.parse(b.end)>Date.parse(s.slot)))return {status:'existing_booking_conflict'};}
   }
   props.setProperty('BOOKING_V2_POLICY',JSON.stringify(p));return {status:'ok'};
  }
  if(d.action==='v2_create'){
   const r=d.record,old=applications.find(x=>x.id===r.id);
   if(old)return old.flowVersion===2&&old.eventId===r.eventId&&old.email===r.email&&old.data===r.data?{status:'ok',record:old}:{status:'conflict'};
   if(applications.some(x=>x.eventId===r.eventId&&x.email===r.email&&!['expired','conflict','cancelled','test_deleted'].includes(x.bookingStatus)))return {status:'duplicate'};
   if(r.flowVersion!==2||r.bookingStatus!=='awaiting_payment'||!Number.isFinite(Date.parse(r.paymentDueAt)))return {status:'invalid'};
   put('Applications',r);return {status:'ok',record:r};
  }
  const r=applications.find(x=>x.id===d.recordId);if(!r||r.flowVersion!==2)return {status:'missing'};
  if(['test_deleting','test_deleted'].includes(r.bookingStatus))return {status:'deleted'};
  if(d.action==='v2_sync_claim'){
   const key='notion_sync_'+r.id,lease=JSON.parse(props.getProperty(key)||'null');
   if(lease&&lease.until>Date.now())return {status:'busy'};
   props.setProperty(key,JSON.stringify({token:d.leaseToken,until:Date.now()+60000}));return {status:'ok',record:r};
  }
  if(d.action==='v2_sync_release'){
   const key='notion_sync_'+r.id,lease=JSON.parse(props.getProperty(key)||'null');
   if(lease&&lease.token===d.leaseToken)props.deleteProperty(key);return {status:'ok'};
  }
  if(d.action==='v2_record')return {status:'ok',record:r};
  if(d.action==='v2_paid'){
   if(r.paymentStatus==='verified')return {status:'ok',record:r};
   if(!['awaiting_payment','expired'].includes(r.bookingStatus)||!d.reference||d.paymentChecked!==true)return {status:'invalid'};
   r.paymentStatus='verified';r.bookingStatus='awaiting_schedule';r.paymentReference=d.reference;r.confirmedBy='operator@example.com';r.paymentVerifiedAt=new Date().toISOString();put('Applications',r);return {status:'ok',record:r};
  }
  if(!['v2_availability','v2_reserve'].includes(d.action))return {status:'invalid'};
  if(r.paymentStatus!=='verified')return {status:'payment_required'};
  const index=Number(d.sessionIndex),session=r.courseSnapshot.sessions[index];if(!Number.isInteger(index)||!session)return {status:'invalid'};
  const booked=(r.sessions||[]).find(s=>s.index===index);if(booked)return {status:'reserved',record:r,session:booked};
  const teacher=policy.teachers.find(t=>t.id===session.teacherId),calendar=teacher&&teacher.calendarId&&CalendarApp.getCalendarById(teacher.calendarId);
  if(!calendar)return {status:'calendar_unconfigured'};
  const duration=session.durationMinutes,buffer=policy.bufferMinutes,first=Date.now()+policy.minimumNoticeHours*3600000,last=Date.now()+policy.bookingHorizonDays*86400000;
  function minutes(s){const a=s.split(':').map(Number);return a[0]*60+a[1];}
  function permitted(start){const date=new Date(start),day=Number(Utilities.formatDate(date,'Asia/Seoul','u')),time=minutes(Utilities.formatDate(date,'Asia/Seoul','HH:mm'));
   return start>=first&&start<=last&&start%1800000===0&&teacher.weekdays.indexOf(day)!==-1&&time>=minutes(teacher.start)&&time+duration<=minutes(teacher.end)&&!teacher.blocks.some(b=>Date.parse(b.start)<start+(duration+buffer)*60000&&Date.parse(b.end)>start-buffer*60000)&&!(r.sessions||[]).some(s=>Date.parse(s.slot)<start+duration*60000&&Date.parse(s.end)>start);
  }
  const busy=calendar.getEvents(new Date(first-buffer*60000),new Date(last+(duration+buffer)*60000)).filter(e=>e.getTransparency()!==CalendarApp.EventTransparency.TRANSPARENT).map(e=>[e.getStartTime().getTime(),e.getEndTime().getTime()]);
  function free(t){return !busy.some(b=>b[0]<t+(duration+buffer)*60000&&b[1]>t-buffer*60000);}
  if(d.action==='v2_availability'){const slots=[];for(let t=Math.ceil(first/1800000)*1800000;t<=last;t+=1800000)if(permitted(t)&&free(t))slots.push(new Date(t).toISOString());return {status:'ok',slots};}
  const start=Date.parse(d.slot);
  // Persist an intent before Calendar mutation. Ambiguous failures are never blindly repeated.
  const key='booking_v2_'+r.id+'_'+index,prior=props.getProperty(key);if(prior==='review')return {status:'review'};
  let event=prior?calendar.getEventById(prior):null;
  if(!prior&&(!Number.isFinite(start)||!permitted(start)||!free(start)))return {status:'conflict'};
  if(!event){if(prior)return {status:'review'};props.setProperty(key,'review');event=calendar.createEvent('['+r.eventLabel+'] '+r.name+' · '+(index+1)+'회차',new Date(start),new Date(start+duration*60000),{description:'과정: '+r.courseSnapshot.name+'\n강사: '+teacher.name+'\n신청 ID: '+r.id,sendInvites:false});props.setProperty(key,event.getId());}
  r.sessions=r.sessions||[];r.sessions.push({index,teacherId:teacher.id,teacherName:teacher.name,slot:event.getStartTime().toISOString(),end:event.getEndTime().toISOString(),calendarEventId:event.getId()});
  r.slot=r.sessions[0].slot;r.bookingStatus=r.sessions.length===r.courseSnapshot.sessions.length?'confirmed':'partially_scheduled';if(r.bookingStatus==='confirmed')r.confirmedAt=new Date().toISOString();put('Applications',r);return {status:'reserved',record:r};
 }finally{lock.releaseLock();}
}
function expireUnpaidApplications(){bookingV2_({action:'v2_expire'});}
function installPaymentExpiryTrigger(){if(!ScriptApp.getProjectTriggers().some(t=>t.getHandlerFunction()==='expireUnpaidApplications'))ScriptApp.newTrigger('expireUnpaidApplications').timeBased().everyHours(1).create();console.log('미결제 만료 처리: 매시간 및 신청 조회 시 실행');}


/** Run only AFTER v2 bridge + Vercel release pass UAT. Keeps existing applications unchanged. */
function configurePaymentFirstRelease(){
 const current=bookingV2_({action:'v2_admin'});if(current.status!=='ok')throw Error('store');
 const policy=current.policy;policy.minimumNoticeHours=24;policy.bookingHorizonDays=30;policy.bufferMinutes=10;policy.teachers.forEach(t=>{t.weekdays=[1,2,3,4,5,6,7];t.start='09:00';t.end='23:00';});
 const saved=bookingV2_({action:'v2_policy',policy});if(saved.status!=='ok')throw Error(saved.status);
 const labels={'kodit-2026':'신용보증기금','personal-coaching':'상시코칭','shinhan-2026':'신한은행'};
 for(const e of current.events){if(!labels[e.id])continue;if(e.flowVersion===2)continue;
  e.flowVersion=2;e.mode='slots';e.paymentDeadlineHours=12;e.calendarLabel=labels[e.id];
  e.courses=[{...e.courses[0],name:'코치 A · 1회 코칭',detail:'코치 A 선생님 · 80분 · 1회',sessions:[{teacherId:'lee',durationMinutes:80}]}];
  e.description=e.description.replace(/신청 및 상담을 완료한 후 결제해 주세요\./g,'신청 후 결제하고, 결제 확인 메일에서 날짜를 선택해 주세요.');
  e.subject='[코칭 운영] {{이벤트명}} 신청 접수 · 12시간 내 결제 안내';
  e.body='{{신청자명}}님, 안녕하세요. 코칭 운영입니다.\n\n{{이벤트명}} 신청이 접수되었습니다.\n선택한 코칭: {{신청과정}}\n\n■ 12시간 내 결제\n결제 기한: {{결제기한}} (한국시간)\n결제 링크: {{결제링크}}\n기한 내 미결제 시 신청이 취소됩니다. 이미 결제하셨다면 중복 결제하지 마세요.\n결제를 완료했으나 아직 확인되지 않아 신청이 만료된 경우 이 메일에 주문번호를 회신해 주세요. 운영자가 확인 후 복구합니다.\n\n■ 날짜 선택 방법\n운영자가 실제 결제 내역을 확인하면 본인 전용 날짜 선택 링크를 별도 이메일로 보내드립니다.\n전용 링크에서 날짜와 시간을 선택해야 예약이 확정됩니다. 결제 전에는 시간을 확보하지 않습니다.\n경험정리 양식 작성과 이력서·자기소개서 준비에 필요한 시간을 충분히 확보한 뒤 코칭 날짜를 선택해 주세요. 준비자료는 코칭일 최소 하루 전까지 제출해 주세요.\n예약은 최소 24시간 전에 가능합니다.\n\n■ 코칭 준비자료\n첨부된 경험정리 양식을 작성하고, 이력서·자기소개서를 PDF로 준비해 주세요.\n코칭일 최소 하루 전까지 이 메일에 답장해 제출하고 코치 B 대표님(operator@example.com)을 참조해 주세요.\n\n■ 개인정보 보관\n예약 신청 정보는 코칭 종료 후 3개월까지 보관합니다.\n\n문의: operator@example.com / 카카오톡 example-operations / 010-0000-0000\n감사합니다. 코칭 운영 운영팀';
  const result=bookingStore_({action:'save_event',event:e});if(result.status!=='ok')throw Error('save');
 }
 installPaymentExpiryTrigger();
 console.log('결제 우선 접수: 12시간 · 매일 09–23시 · 코치 A 80분 1회 · 기존 예약 보존');
}

