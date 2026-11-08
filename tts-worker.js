// Cloudflare Worker: Google Cloud TTS + Microsoft Azure Speech 중계 서버
// - API 키는 코드/HTML에 넣지 않고 Worker Secret으로만 보관합니다 (아래 TTS_SETUP.md 참고).
// - 라우트: GET /health (공급자별 인증 설정 여부만 반환, 키 값은 절대 반환하지 않음) / POST /tts
// - 보호 장치: 허용 출처(ALLOWED_ORIGINS), 음성 허용 목록, 글자 수 제한, 호출 제한(RATE_LIMITER, 선택), 일일 글자 수 상한(TTS_KV+DAILY_CHAR_LIMIT, 선택), 응답 캐시(30일)
// 주의: Origin 검사는 브라우저만 막습니다(curl 등은 Origin을 위조 가능). 실제 비용 방어선은 호출 제한 + 일일 상한 + 클라우드 쪽 예산 알림입니다.
const MAX_CHARS=200;
// 허용 음성 목록 (index.html의 CLOUD 카탈로그와 동일). 목록에 없는 음성 이름은 거부합니다.
const CATALOG={
 google:{"ko-KR":["ko-KR-Neural2-A","ko-KR-Neural2-B","ko-KR-Neural2-C","ko-KR-Wavenet-D"],"en-US":["en-US-Neural2-C","en-US-Neural2-E","en-US-Neural2-F","en-US-Neural2-H","en-US-Neural2-D","en-US-Neural2-A","en-US-Neural2-I","en-US-Neural2-J"]},
 microsoft:{"ko-KR":["ko-KR-SunHiNeural","ko-KR-JiMinNeural","ko-KR-SeoHyeonNeural","ko-KR-YuJinNeural","ko-KR-InJoonNeural","ko-KR-BongJinNeural","ko-KR-GookMinNeural","ko-KR-HyunsuNeural"],"en-US":["en-US-JennyNeural","en-US-AriaNeural","en-US-SaraNeural","en-US-NancyNeural","en-US-GuyNeural","en-US-DavisNeural","en-US-JasonNeural","en-US-TonyNeural"]}};
const clamp=(n,a,b)=>Math.min(b,Math.max(a,n));
const json=(o,status,h)=>new Response(JSON.stringify(o),{status,headers:{...h,"Content-Type":"application/json"}});
const pct=n=>(n>=0?"+":"")+n.toFixed(0)+"%";
const xml=s=>s.replace(/[<>&"']/g,c=>({"<":"&lt;",">":"&gt;","&":"&amp;",'"':"&quot;","'":"&apos;"}[c]));
async function sha256(s){const d=await crypto.subtle.digest("SHA-256",new TextEncoder().encode(s));return[...new Uint8Array(d)].map(b=>b.toString(16).padStart(2,"0")).join("")}
async function googleTTS(env,{text,voice,rate,pitch}){
 const body=withPitch=>JSON.stringify({input:{text},voice:{languageCode:voice.slice(0,5),name:voice},audioConfig:{audioEncoding:"MP3",speakingRate:rate,...(withPitch?{pitch}:{})}});
 const call=b=>fetch("https://texttospeech.googleapis.com/v1/text:synthesize",{method:"POST",headers:{"Content-Type":"application/json","X-Goog-Api-Key":env.GOOGLE_TTS_KEY},body:b});
 let r=await call(body(true));if(r.status===400)r=await call(body(false));// 일부 음성은 pitch 미지원 → pitch 없이 재시도
 if(!r.ok)throw new Error("google "+r.status);
 const j=await r.json();return Uint8Array.from(atob(j.audioContent),c=>c.charCodeAt(0));
}
async function azureTTS(env,{text,voice,rate,pitch}){
 const lang=voice.slice(0,5);
 const ssml=`<speak version="1.0" xmlns="http://www.w3.org/2001/10/synthesis" xml:lang="${lang}"><voice name="${voice}"><prosody rate="${pct((rate-1)*100)}" pitch="${pct(pitch*6)}">${xml(text)}</prosody></voice></speak>`;
 const r=await fetch(`https://${env.AZURE_SPEECH_REGION}.tts.speech.microsoft.com/cognitiveservices/v1`,{method:"POST",headers:{"Ocp-Apim-Subscription-Key":env.AZURE_SPEECH_KEY,"Content-Type":"application/ssml+xml","X-Microsoft-OutputFormat":"audio-24khz-48kbitrate-mono-mp3","User-Agent":"npwd-tts"},body:ssml});
 if(!r.ok)throw new Error("azure "+r.status);return new Uint8Array(await r.arrayBuffer());
}
export default{async fetch(req,env,ctx){
 const url=new URL(req.url),origin=req.headers.get("Origin")||"";
 const allowed=(env.ALLOWED_ORIGINS||"").split(",").map(s=>s.trim()).filter(Boolean),okOrigin=allowed.includes(origin);
 const cors=okOrigin?{"Access-Control-Allow-Origin":origin,"Vary":"Origin","Access-Control-Allow-Methods":"GET,POST,OPTIONS","Access-Control-Allow-Headers":"Content-Type","Access-Control-Max-Age":"86400"}:{"Vary":"Origin"};
 if(req.method==="OPTIONS")return new Response(null,{status:okOrigin?204:403,headers:cors});
 if(!okOrigin)return json({error:"origin not allowed"},403,cors);
 const have={google:!!env.GOOGLE_TTS_KEY,microsoft:!!(env.AZURE_SPEECH_KEY&&/^[a-z0-9-]+$/.test(env.AZURE_SPEECH_REGION||""))};
 if(url.pathname==="/health"&&req.method==="GET")return json({ok:true,providers:have},200,cors);
 if(url.pathname!=="/tts"||req.method!=="POST")return json({error:"not found"},404,cors);
 let b;try{b=await req.json()}catch(e){return json({error:"bad json"},400,cors)}
 const provider=b.provider,text=String(b.text||"").trim(),voice=String(b.voice||"");
 if(!CATALOG[provider])return json({error:"unknown provider"},400,cors);
 if(!text||text.length>MAX_CHARS)return json({error:"bad text length"},400,cors);
 if(!(CATALOG[provider][voice.slice(0,5)]||[]).includes(voice))return json({error:"voice not allowed"},400,cors);
 if(!have[provider])return json({error:"provider not configured"},503,cors);
 const rate=clamp(+b.rate||1,.5,1.5),pitch=clamp(+b.pitch||0,-6,6);
 if(env.RATE_LIMITER){const{success}=await env.RATE_LIMITER.limit({key:req.headers.get("CF-Connecting-IP")||"unknown"});if(!success)return json({error:"rate limited"},429,cors)}
 // 캐시: 같은 (공급자·음성·속도·음높이·문장)은 외부 API를 다시 호출하지 않음 → 카드 문장은 거의 다 캐시 적중
 const cacheKey="https://tts-cache.internal/"+await sha256([provider,voice,rate.toFixed(2),pitch.toFixed(1),text].join("|")),cache=caches.default;
 const hit=await cache.match(cacheKey);
 if(hit)return new Response(hit.body,{status:200,headers:{...cors,"Content-Type":"audio/mpeg","Cache-Control":"public, max-age=2592000","X-TTS-Cache":"HIT","X-TTS-Provider":provider}});
 // 일일 글자 수 상한 (캐시 미적중=실제 과금 발생 시에만 계산). KV는 원자적이지 않아 근사치입니다.
 if(env.TTS_KV&&env.DAILY_CHAR_LIMIT){const k="chars:"+new Date().toISOString().slice(0,10),used=+(await env.TTS_KV.get(k)||0);
  if(used+text.length>+env.DAILY_CHAR_LIMIT)return json({error:"daily limit reached"},429,cors);
  ctx.waitUntil(env.TTS_KV.put(k,String(used+text.length),{expirationTtl:172800}));}
 let audio;try{audio=provider==="google"?await googleTTS(env,{text,voice,rate,pitch}):await azureTTS(env,{text,voice,rate,pitch})}catch(e){return json({error:"upstream failed"},502,cors)}
 ctx.waitUntil(cache.put(cacheKey,new Response(audio,{headers:{"Content-Type":"audio/mpeg","Cache-Control":"public, max-age=2592000"}})));
 return new Response(audio,{status:200,headers:{...cors,"Content-Type":"audio/mpeg","Cache-Control":"public, max-age=2592000","X-TTS-Cache":"MISS","X-TTS-Provider":provider}});
}};
