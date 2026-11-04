import {createHash} from 'node:crypto';
export async function confirmPayment({body,authorized,bridge,owner}) {
 if(!authorized)return {status:403,data:{error:'운영자 인증이 필요합니다.'}};
 if(!/^[a-f0-9-]{36}$/.test(body.id||'')||body.paymentChecked!==true||typeof body.reference!=='string'||body.reference.trim().length<3||body.reference.length>200)return {status:400,data:{error:'실제 결제 내역을 확인하고 주문번호 또는 결제 확인 근거를 입력해 주세요.'}};
 const all=await bridge({action:'admin_data'});if(all.status!=='ok')throw Error('store');
 const record=all.applications.find(r=>r.id===body.id);
 if(!record)return {status:404,data:{error:'신청 내역을 찾을 수 없습니다.'}};
 if(!['reserved','confirmed'].includes(record.bookingStatus)||!record.calendarEventId)return {status:409,data:{error:'캘린더 예약이 확보된 신청만 확정할 수 있습니다.'}};
 if(record.bookingStatus==='confirmed'&&record.confirmationMailStatus==='sent'&&['synced','unconfigured'].includes(record.confirmationNotionStatus))return {status:200,data:{ok:true,alreadyConfirmed:true,confirmationMailStatus:record.confirmationMailStatus||'review'}};
 const event=all.events.find(e=>e.id===record.eventId);if(!event)throw Error('event');
 const patch=async value=>{const d=await bridge({action:'update_application',recordId:record.id,patch:value});if(d.status!=='ok')throw Error('save');};
 // Persist payment verification before sending; retries reuse the same mail ID.
 if(record.bookingStatus!=='confirmed')await patch({bookingStatus:'confirmed',paymentStatus:'verified',paymentReference:body.reference.trim(),confirmedBy:owner,confirmedAt:new Date().toISOString(),confirmationMailStatus:'pending'});
 const hex=createHash('sha256').update('confirmation:'+record.id).digest('hex').slice(0,32);
 const mailId=hex.slice(0,8)+'-'+hex.slice(8,12)+'-'+hex.slice(12,16)+'-'+hex.slice(16,20)+'-'+hex.slice(20);
 let mail='review';try{const d=await bridge({id:mailId,to:record.email,subject:'[코칭 운영] 코칭 예약 최종 확정',body:record.name+'님, 결제 내역 확인이 완료되어 예약이 최종 확정되었습니다.\n\n'+event.title.replace(/\n/g,' ')+'\n일정: '+new Date(record.slot).toLocaleString('ko-KR',{timeZone:'Asia/Seoul'})+'\n\n변경 문의는 이 메일에 답장해 주세요.'});if(d.status==='sent')mail='sent';}catch{}
 await patch({confirmationMailStatus:mail});
 let notion='unconfigured';
 if(process.env.NOTION_TOKEN){try{
 const headers={Authorization:'Bearer '+process.env.NOTION_TOKEN,'Notion-Version':'2022-06-28','Content-Type':'application/json'};
 const q=await fetch('https://api.notion.com/v1/databases/'+process.env.NOTION_DATABASE_ID+'/query',{method:'POST',headers,body:JSON.stringify({filter:{property:'신청ID',rich_text:{equals:record.id}}}),signal:AbortSignal.timeout(15000)});
 const result=await q.json();if(!q.ok||result.results?.length!==1)throw Error('record');
 const r=await fetch('https://api.notion.com/v1/pages/'+result.results[0].id,{method:'PATCH',headers,body:JSON.stringify({properties:{'결제확인':{checkbox:true},'접수상태':{select:{name:'확인'}}}}),signal:AbortSignal.timeout(15000)});notion=r.ok?'synced':'failed';
 }catch{notion='review';}}
 await patch({confirmationNotionStatus:notion});
 return {status:200,data:{ok:true,confirmationMailStatus:mail,confirmationNotionStatus:notion}};
}
