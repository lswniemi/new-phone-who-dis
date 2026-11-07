// Google Cloud TTS 중계용 Cloudflare Worker (선택 사항)
// 배포: wrangler secret put GOOGLE_TTS_KEY  → API 키는 Worker 비밀값으로만 보관 (HTML에는 넣지 않음)
// 설정: 환경변수 ALLOW_ORIGIN = "https://내아이디.github.io" (허용할 사이트만 지정 권장)
// 그 뒤 index.html의 TTS_PROXY_URL에 Worker 주소를 넣으면 '엔진: Google'이 Cloud TTS를 사용합니다.
export default{async fetch(req,env){
 const cors={"Access-Control-Allow-Origin":env.ALLOW_ORIGIN||"*","Access-Control-Allow-Headers":"Content-Type","Access-Control-Allow-Methods":"POST,OPTIONS"};
 if(req.method==="OPTIONS")return new Response(null,{headers:cors});
 if(req.method!=="POST")return new Response("POST only",{status:405,headers:cors});
 const{text,voice,rate,pitch}=await req.json();
 if(!text||text.length>300)return new Response("bad text",{status:400,headers:cors});
 const r=await fetch("https://texttospeech.googleapis.com/v1/text:synthesize?key="+env.GOOGLE_TTS_KEY,{method:"POST",headers:{"Content-Type":"application/json"},
  body:JSON.stringify({input:{text},voice:{languageCode:"ko-KR",name:voice||"ko-KR-Neural2-A"},audioConfig:{audioEncoding:"MP3",speakingRate:Math.min(2,Math.max(.5,rate||1)),pitch:Math.min(10,Math.max(-10,pitch||0))}})});
 if(!r.ok)return new Response("tts error",{status:502,headers:cors});
 const{audioContent}=await r.json();
 return new Response(Uint8Array.from(atob(audioContent),c=>c.charCodeAt(0)),{headers:{...cors,"Content-Type":"audio/mpeg"}})}}
