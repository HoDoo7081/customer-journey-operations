import {createHmac,randomUUID} from 'node:crypto';
export default async function handler(req,res){
 res.setHeader('Cache-Control','no-store');
 if(req.method!=='GET')return res.status(405).json({error:'Method not allowed'});
 const course=req.query.course;if(!['kodit','personal','one','two'].includes(course))return res.status(400).json({error:'과정을 선택해 주세요.'});
 const secret=process.env.MAIL_WEBHOOK_SECRET,url=process.env.GOOGLE_MAIL_WEBHOOK_URL;
 if(!secret||!url)return res.status(503).json({error:'Calendar 연결 준비 중입니다.'});
 const payload=JSON.stringify({id:randomUUID(),action:'availability',course,timestamp:Date.now()});
 try{const r=await fetch(url,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({payload,signature:createHmac('sha256',secret).update(payload).digest('hex')}),signal:AbortSignal.timeout(20000)});const d=await r.json();if(d.status==='invalid'||d.status==='calendar_unconfigured')return res.status(503).json({error:'이 과정의 예약 시간 설정을 확인 중입니다. 접수가 열리면 시간을 선택할 수 있습니다.'});if(d.status!=='ok')throw Error('bridge');return res.json({slots:d.slots,source:'google-calendar'});}catch{return res.status(503).json({error:'캘린더를 확인하지 못했습니다. 잠시 후 다시 시도해 주세요.'});}
}
