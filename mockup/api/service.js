import {paymentFirst,validateV2Event,syncV2} from '../lib/payment-first.js';
import {confirmPayment} from '../lib/confirmation.js';
import {createHmac,randomUUID,randomInt,timingSafeEqual} from 'node:crypto';
import {initialEvents,render} from '../lib/model.ts';
import {notionPayload} from '../lib/notion.ts';
const owner='operator@example.com';
const mac=s=>createHmac('sha256',process.env.MAIL_WEBHOOK_SECRET).update(s).digest('hex');
async function bridge(data){const payload=JSON.stringify({id:randomUUID(),timestamp:Date.now(),...data}).replace(/[\u0080-\uffff]/g,c=>'\\u'+c.charCodeAt(0).toString(16).padStart(4,'0'));const r=await fetch(process.env.GOOGLE_MAIL_WEBHOOK_URL,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({payload,signature:mac(payload)}),signal:AbortSignal.timeout(25000)});return r.json();}
function auth(req){try{const token=(req.headers.cookie||'').split('; ').find(x=>x.startsWith('nk_session='))?.slice(11);const [exp,sig]=token.split('.');return Number(exp)>Date.now()&&sig.length===64&&timingSafeEqual(Buffer.from(sig),Buffer.from(mac('session:'+exp)));}catch{return false;}}
async function events(){const d=await bridge({action:'events'});if(d.status!=='ok')throw Error('store');return d.events.length?d.events:initialEvents;}
export default async function handler(req,res){res.setHeader('Cache-Control','no-store');const route=req.query.route;
 try{
 if(req.method==='POST'&&req.headers.origin!==`https://${req.headers.host}`)return res.status(403).json({error:'잘못된 요청입니다.'});
 if(!process.env.MAIL_WEBHOOK_SECRET||!process.env.GOOGLE_MAIL_WEBHOOK_URL){if(route==='events'&&req.method==='GET')return res.json({events:initialEvents.map(({body,subject,attachmentId,approved,...e})=>e),calendar:false,uat:true});throw Error('setup');}
 const a=auth(req),b=req.body||{};
 if(['delete-test-application','retry-notifications','policy','apply','booking','booking-availability','book-session','confirm-payment'].includes(route)){const result=await paymentFirst({route,req,authorized:a,bridge,events,render,notionPayload});if(result)return res.status(result.status).json(result.data);}
 if(route==='confirm-payment'&&req.method==='POST'){const outcome=await confirmPayment({body:b,authorized:a,bridge,owner});return res.status(outcome.status).json(outcome.data);}
 if(route==='login'&&req.method==='POST'){
  const code=String(b.code||'');
  if(!code){const c=String(randomInt(100000,1000000));const d=await bridge({action:'otp_send',code:c,hash:mac('otp:'+c)});return res.status(d.status==='ok'?200:429).json({ok:d.status==='ok',error:d.status==='ok'?undefined:'1분 후 다시 요청해 주세요.'});}
  if(!/^\d{6}$/.test(code))return res.status(400).json({error:'6자리 인증번호를 입력해 주세요.'});
  const d=await bridge({action:'otp_verify',hash:mac('otp:'+code)});if(d.status!=='ok')return res.status(401).json({error:'인증번호가 틀렸거나 만료되었습니다.'});
  const exp=String(Date.now()+8*3600000);res.setHeader('Set-Cookie',`nk_session=${exp}.${mac('session:'+exp)}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=28800`);return res.json({ok:true});
 }
 if(route==='events'&&req.method==='GET'){const list=await events();return res.json({events:list.filter(e=>!e.id.startsWith('uat-')).map(({body,subject,attachmentId,approved,...e})=>({...e,status:process.env.GO_LIVE==='true'||a?e.status:'draft'})),calendar:true,uat:process.env.GO_LIVE!=='true'});}
 if(route==='admin'){
  if(!a)return res.status(403).json({error:'운영자 이메일 인증이 필요합니다.'});
  if(req.method==='GET'){const d=await bridge({action:'v2_admin'});if(d.status!=='ok')throw Error('store');for(const r of d.applications.filter(x=>x.flowVersion===2&&!['test_deleting','test_deleted'].includes(x.bookingStatus)&&(x.notionStatus!=='synced'||x.notionBookingStatus!==x.bookingStatus||x.notionMailStatus!==x.mailStatus)).slice(0,2)){const e=d.events.find(e=>e.id===r.eventId);if(e)r.notionStatus=await syncV2(bridge,r,e,notionPayload);}return res.json({policy:d.policy,events:d.events.length?d.events:initialEvents,applications:d.applications,ready:{mail:true,notion:!!process.env.NOTION_TOKEN,calendar:true},uat:process.env.GO_LIVE!=='true'});}
  if(req.method==='POST'){
   if(!/^[a-z0-9-]{3,70}$/.test(b.id)||typeof b.title!=='string'||!Array.isArray(b.courses)||!b.courses.length||!Array.isArray(b.questions)||b.questions.length>10||!['draft','open','closed'].includes(b.status)||!['slots','consult'].includes(b.mode)||JSON.stringify(b).length>35000)return res.status(400).json({error:'이벤트 입력값을 확인해 주세요.'});
   if(b.courses.some(c=>!/^[a-z0-9-]{1,70}$/.test(c.id)||!/^https:\/\//.test(c.paymentUrl)))return res.status(400).json({error:'과정 ID는 영문·숫자·하이픈으로 입력하고 결제 링크는 https 주소여야 합니다.'});
   if(b.status==='open'&&(!b.approved||!b.attachmentId))return res.status(409).json({error:'안내문 검토와 첨부파일 등록을 완료해 주세요.'});
   if(b.flowVersion===2){const settings=await bridge({action:'v2_admin'});if(settings.status!=='ok')throw Error('settings');const error=validateV2Event(b,settings.policy);if(error)return res.status(400).json({error});b.courses=b.courses.map(c=>({...c,detail:(c.sessions||[{teacherId:'lee',durationMinutes:80}]).map(s=>`${settings.policy.teachers.find(t=>t.id===s.teacherId)?.name||s.teacherId} · ${s.durationMinutes}분`).join(' + ')+` · ${(c.sessions||[1]).length}회`}));}
   const d=await bridge({action:'save_event',event:b});if(d.status!=='ok')throw Error('save');return res.json({ok:true});
  }
 }
 if(route==='apply'&&req.method==='POST'){
  if(process.env.GO_LIVE!=='true'&&(!a||b.email?.toLowerCase()!==owner))return res.status(403).json({error:'UAT 중입니다. 운영자 로그인 후 운영자 이메일로만 테스트할 수 있습니다.'});
  const e=(await events()).find(e=>e.id===b.eventId),c=e?.courses.find(c=>c.id===b.course);
  if(!e||e.status!=='open'||!c)return res.status(409).json({error:'접수 준비 중입니다.'});
  if(!b.consent||b.website||typeof b.name!=='string'||b.name.length<2||b.name.length>80||!/^\S+@\S+\.\S+$/.test(b.email)||!/^[0-9+() -]{8,25}$/.test(b.phone)||!Array.isArray(b.answers)||b.answers.length!==e.questions.length||b.answers.some(x=>typeof x!=='string'||!x.trim()||x.length>3000))return res.status(400).json({error:'필수 항목을 확인해 주세요.'});
  const id=randomUUID(),record={id,eventId:e.id,email:b.email.toLowerCase(),name:b.name,slot:e.mode==='slots'?b.slot:null,data:JSON.stringify(b),created:new Date().toISOString(),mailStatus:'pending',notionStatus:'pending',bookingStatus:'pending'};
  const inserted=await bridge({action:'insert_application',record});if(inserted.status!=='ok')return res.status(409).json({error:'이미 접수했거나 저장하지 못했습니다. 운영자에게 확인해 주세요.'});
  const patch=async p=>{const d=await bridge({action:'update_application',recordId:id,patch:p});if(d.status!=='ok')throw Error('update');};
  if(e.mode==='slots'){
   let booking;try{booking=await bridge({action:'reserve',bookingId:id,course:b.course,slot:b.slot});}catch{await patch({bookingStatus:'review'});return res.status(202).json({id,mailStatus:'review',bookingStatus:'review'});}
   if(booking.status!=='reserved'){await patch({bookingStatus:booking.status==='conflict'?'conflict':'review'});return res.status(409).json({error:booking.status==='conflict'?'방금 예약된 시간입니다. 다른 시간을 선택해 주세요.':'예약 상태를 운영자가 확인해야 합니다. 다시 신청하지 마세요.'});}
   await patch({bookingStatus:'reserved',calendarEventId:booking.eventId});
  }
  const vars={'신청자명':b.name,'이벤트명':e.title.replace(/\n/g,' '),'신청과정':c.name,'결제링크':c.paymentUrl,'예약일시':record.slot?new Date(record.slot).toLocaleString('ko-KR',{timeZone:'Asia/Seoul'}):'별도 협의'};
  await patch({mailStatus:'sending'});let mailStatus='review';try{const d=await bridge({id,to:record.email,name:b.name,subject:render(e.subject,vars),body:render(e.body,vars),attachmentId:e.attachmentId});if(d.status==='sent')mailStatus='sent';}catch{}await patch({mailStatus});
  let notionStatus='unconfigured';if(process.env.NOTION_TOKEN){try{const r=await fetch('https://api.notion.com/v1/pages',{method:'POST',headers:{Authorization:`Bearer ${process.env.NOTION_TOKEN}`,'Notion-Version':'2022-06-28','Content-Type':'application/json'},body:JSON.stringify(notionPayload({...record,mailStatus},e,process.env.NOTION_DATABASE_ID)),signal:AbortSignal.timeout(15000)});notionStatus=r.ok?'synced':'failed';}catch{notionStatus='review';}}await patch({notionStatus});return res.json({id,mailStatus,bookingStatus:e.mode==='slots'?'reserved':'consult'});
 }
 return res.status(404).json({error:'Not found'});
 }catch{return res.status(503).json({error:'연결을 확인하지 못했습니다. 접수 후 오류라면 재신청 전에 운영자에게 확인해 주세요.'});}
}
