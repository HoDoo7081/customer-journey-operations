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
