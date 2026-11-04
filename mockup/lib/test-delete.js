export async function deleteTestApplication({req,authorized,bridge}){
 const reply=(status,data)=>({status,data}),b=req.body||{};
 if(!authorized)return reply(403,{error:'운영자 인증이 필요합니다.'});
 if(req.method!=='POST')return reply(405,{error:'잘못된 요청입니다.'});
 if(!/^[a-f0-9-]{36}$/.test(b.id||'')||typeof b.eventId!=='string'||typeof b.confirmEmail!=='string'||b.testAcknowledged!==true)return reply(400,{error:'테스트 신청임을 확인하고 신청 이메일을 직접 입력해 주세요.'});
 const params={recordId:b.id,eventId:b.eventId,confirmEmail:b.confirmEmail.trim().toLowerCase(),testAcknowledged:true};
 const d=await bridge({action:'v2_test_delete',...params});
 if(d.status!=='ok')return reply(d.status==='missing'?404:409,{error:({invalid_confirmation:'선택한 이벤트와 신청 이메일을 확인해 주세요.',sync_busy:'이 신청의 동기화가 진행 중입니다. 잠시 후 삭제를 다시 확인해 주세요.',calendar_mismatch:'신청과 연결된 Calendar 일정을 확인하지 못했습니다. 다른 일정 보호를 위해 삭제를 중단했습니다.',calendar_unavailable:'연결된 캘린더를 읽지 못했습니다. 운영자가 연결을 확인한 뒤 다시 시도해 주세요.'})[d.status]||'테스트 삭제를 완료하지 못했습니다. 기존 신청을 확인한 뒤 다시 시도해 주세요.'});
 const r=d.record;if(r.bookingStatus==='test_deleted')return reply(200,{ok:true,alreadyDeleted:true});
 let notionCleanup='not_configured';
 if(process.env.NOTION_TOKEN){
  const headers={Authorization:'Bearer '+process.env.NOTION_TOKEN,'Notion-Version':'2022-06-28','Content-Type':'application/json'};
  try{
   for(let batch=0;batch<20;batch++){
    const q=await fetch('https://api.notion.com/v1/databases/'+process.env.NOTION_DATABASE_ID+'/query',{method:'POST',headers,body:JSON.stringify({filter:{property:'신청ID',rich_text:{equals:r.id}}},),signal:AbortSignal.timeout(15000)});const result=await q.json();if(!q.ok||!Array.isArray(result.results))throw Error('query');
    for(const page of result.results){const archived=await fetch('https://api.notion.com/v1/pages/'+page.id,{method:'PATCH',headers,body:JSON.stringify({archived:true}),signal:AbortSignal.timeout(15000)});if(!archived.ok)throw Error('archive');}
    if(!result.has_more){notionCleanup='archived';break;}
   }
   if(notionCleanup!=='archived')throw Error('remaining');
  }catch{return reply(503,{error:'예약 해제 후 Notion 정리가 아직 완료되지 않았습니다. 신청은 삭제 처리 중으로 보존됩니다. 잠시 후 같은 신청의 테스트 삭제를 다시 실행해 주세요.'});}
 }else if(['synced','review','failed','pending'].includes(r.notionStatus))return reply(503,{error:'Notion 연결을 확인하지 못했습니다. 신청은 삭제 처리 중으로 보존됩니다. 연결 복구 후 다시 확인해 주세요.'});
 const done=await bridge({action:'v2_test_delete_finish',...params,notionCleanup});
 return done.status==='ok'?reply(200,{ok:true}):reply(503,{error:'연동 정리는 처리했으나 삭제 완료 기록을 확인하지 못했습니다. 같은 신청의 테스트 삭제를 다시 실행해 주세요.'});
}
