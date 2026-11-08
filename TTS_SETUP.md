# 클라우드 TTS(Google / Microsoft) 연결 가이드

이 문서는 `index.html`의 TTS 엔진 선택(Google / Microsoft)을 **실제 클라우드 음성**에 연결하는 절차입니다.
연결하지 않아도 게임은 동작하며, 이때 설정 화면에 "연결 안 됨 → ○○ 기기 음성 사용 중"으로 표시됩니다.

> **중요**: 이 작업은 인증 정보(API 키) 없이 진행되었기 때문에 Google·Microsoft 서버와의 실제 연결은 검증하지 못했습니다.
> 아래 절차 중 계정 생성, 결제 설정, 키 발급은 **직접** 하셔야 합니다. API 키는 절대 `index.html`이나 GitHub 저장소에 넣지 마세요.

## 전체 구조

```
브라우저(index.html) ──POST /tts──▶ Cloudflare Worker ──▶ Google Cloud TTS / Azure Speech
                    ◀── mp3 ──────  (키는 Worker Secret에만 저장, 응답은 30일 캐시)
```

- Worker 파일: `tts-worker.js` / 설정 파일: `wrangler.toml`
- 게임이 쓰는 주소: `index.html` 상단의 `const TTS_PROXY_URL=""` 한 줄

## 1. 사전 준비 (직접 해야 하는 일)

| 항목 | 필요한 것 |
|---|---|
| Cloudflare | 계정(무료 플랜으로 시작 가능) |
| Google Cloud | 프로젝트, **결제 계정 연결(무료 사용량 안에서도 필요)**, Cloud Text-to-Speech API 사용 설정, API 키 |
| Microsoft Azure | 구독, Speech 리소스(Azure AI Speech), 키와 지역(region) |
| PC | Node.js 18 이상 |

Google만 쓰거나 Microsoft만 쓰도록 둘 중 하나만 설정해도 됩니다. 설정하지 않은 쪽은 설정 화면에 "서버에 ○○ 인증 정보 미설정"으로 표시됩니다.

## 2. Google Cloud TTS 설정

1. [Google Cloud 콘솔](https://console.cloud.google.com/)에서 프로젝트를 만들고 **결제 계정을 연결**합니다.
2. "API 및 서비스 → 라이브러리"에서 **Cloud Text-to-Speech API**를 사용 설정합니다.
3. "API 및 서비스 → 사용자 인증 정보 → 사용자 인증 정보 만들기 → API 키"로 키를 만듭니다.
4. 만든 키를 편집해서 **API 제한사항 → Cloud Text-to-Speech API만 허용**으로 제한합니다.
5. "결제 → 예산 및 알림"에서 월 예산 알림(예: 1달러, 5달러)을 설정합니다.
6. 키 값을 복사해 둡니다(3단계의 `GOOGLE_TTS_KEY`).

무료 한도와 요금은 변경될 수 있으니 [공식 가격 페이지](https://cloud.google.com/text-to-speech/pricing)에서 반드시 확인하세요. 작업 시점에 확인한 내용: Standard·WaveNet 음성은 월 400만 자, Neural2 음성은 월 100만 자까지 무료이고 그 이상은 종량 과금입니다. 이 게임은 Neural2 음성을 사용합니다.

## 3. Microsoft Azure Speech 설정

1. [Azure 포털](https://portal.azure.com/)에서 "리소스 만들기 → Speech"(Azure AI Speech)를 만듭니다.
2. 가격 책정 계층은 **Free(F0)** 또는 Standard(S0)를 고릅니다. 무료 계층의 한도는 [공식 가격 페이지](https://azure.microsoft.com/pricing/details/cognitive-services/speech-services/)에서 확인하세요(작업 시점에 확인한 자료상 신경망 음성 월 50만 자 수준이며, 정확한 수치와 상업적 사용 조건은 직접 확인이 필요합니다).
3. 지역은 한국과 가까운 `koreacentral` 등을 권장합니다.
4. 리소스의 "키 및 엔드포인트"에서 **키 1**과 **지역**을 복사해 둡니다(`AZURE_SPEECH_KEY`, `AZURE_SPEECH_REGION`).
5. 선택한 지역에서 아래 음성이 모두 제공되는지 [Azure 음성 갤러리](https://speech.microsoft.com/portal/voicegallery)에서 확인하세요. 제공되지 않는 음성은 `tts-worker.js`의 `CATALOG`와 `index.html`의 `CLOUD`에서 함께 빼야 합니다.
   - 한국어: SunHi, JiMin, SeoHyeon, YuJin, InJoon, BongJin, GookMin, Hyunsu
   - 영어(en-US): Jenny, Aria, Sara, Nancy, Guy, Davis, Jason, Tony

## 4. Cloudflare Worker 배포

작업 폴더에 `tts-worker.js`와 `wrangler.toml`을 두고 진행합니다.

```bash
npm install -g wrangler
wrangler login
```

1. `wrangler.toml`을 엽니다.
   - `ALLOWED_ORIGINS`: 게임을 올릴 사이트 주소(경로 없이). 예: `https://내아이디.github.io`
   - `AZURE_SPEECH_REGION`: 3단계에서 확인한 지역
   - `DAILY_CHAR_LIMIT`: 하루 최대 합성 글자 수(캐시에 없는 새 문장만 집계)
2. (권장) 일일 상한 집계용 KV를 만들고 `wrangler.toml`의 주석을 풀어 줍니다.
   ```bash
   wrangler kv namespace create TTS_KV
   ```
   출력된 `id`를 `[[kv_namespaces]]`의 `id`에 넣습니다. KV가 없으면 일일 상한은 동작하지 않습니다.
3. (권장) 호출 제한(`[[unsafe.bindings]]`의 `RATE_LIMITER`)은 Cloudflare의 현재 문서에서 문법과 지원 여부를 확인한 뒤 주석을 풉니다. 이 문법은 제가 실제 배포로 검증하지 못했습니다.
4. 비밀값을 등록합니다(입력 시 값이 화면에 표시되지 않습니다).
   ```bash
   wrangler secret put GOOGLE_TTS_KEY
   wrangler secret put AZURE_SPEECH_KEY
   ```
5. 배포합니다.
   ```bash
   wrangler deploy
   ```
   출력되는 주소(예: `https://npwd-tts.내계정.workers.dev`)를 복사합니다.

## 5. 게임에 연결

1. `index.html`에서 아래 줄을 찾아 Worker 주소를 넣습니다(끝에 `/`를 붙이지 않습니다).
   ```js
   const TTS_PROXY_URL="https://npwd-tts.내계정.workers.dev";
   ```
2. 수정한 `index.html`을 GitHub Pages에 올립니다.
3. 게임의 ⚙️ 설정 → TTS 엔진에서 Google 또는 Microsoft를 고르고 **연결 확인**을 누릅니다.
   - 첫 줄이 "○○ 클라우드 TTS: 연결됨 (서버 경유)"이고 둘째 줄이 "현재 재생 경로: ○○ 클라우드 음성"이면 성공입니다.
   - **🔈 미리듣기**를 눌러 실제 음성을 확인하고, 맨 아래 진단 줄의 `last:`에 `cloud/Google/…`처럼 표시되는지 봅니다.

`file://`로 연 로컬 파일은 Origin이 허용 목록과 맞지 않아 연결되지 않습니다. 로컬에서 시험하려면 `python3 -m http.server 8000`으로 띄우고 `ALLOWED_ORIGINS`에 `http://localhost:8000`을 추가하세요.

## 6. 문제 해결

| 설정 화면 표시 | 원인과 해결 |
|---|---|
| 서버 응답 없음 | `TTS_PROXY_URL` 오타, Worker 미배포, 또는 `ALLOWED_ORIGINS`가 게임 사이트와 다름(경로나 끝의 `/` 없이 `https://아이디.github.io`) |
| 서버에 ○○ 인증 정보 미설정 | `wrangler secret put`을 하지 않았거나 Azure 지역값이 잘못됨(Azure는 키와 지역이 모두 있어야 함) |
| 연결됨인데 소리가 나지 않음 | Worker 로그 확인: `wrangler tail`. 키 제한이 너무 엄격하거나 해당 지역에 없는 음성일 수 있음 |
| iOS에서 클라우드 음성이 나오지 않음 | 첫 화면 탭 이후에만 오디오가 허용됩니다. 무음 모드 스위치와 음량도 확인하세요. 실패하면 기기 음성으로 대체됩니다 |

## 7. 비용과 남용 방지

- **캐시**: 같은 (공급자·음성·속도·음높이·문장)은 30일간 Worker에 캐시되어 외부 API를 다시 호출하지 않습니다. 카드 문장은 고정이라 대부분 캐시에 적중합니다.
- **일일 글자 수 상한**: `DAILY_CHAR_LIMIT`을 넘기면 429를 반환하고 게임은 기기 음성으로 대체합니다(근사치 집계).
- **호출 제한**: 가능하면 `RATE_LIMITER`를 켜세요.
- **입력 검증**: 허용 음성 목록 밖의 음성, 200자 초과 문장은 거부합니다.
- **한계**: Origin 검사는 브라우저만 막을 수 있습니다. 실제 방어선은 호출 제한, 일일 상한, 클라우드 쪽 예산 알림입니다. 키가 유출됐다면 즉시 폐기하고 재발급하세요.
- **대략적인 사용량(제 추정치)**: 한 라운드에 문장 약 7개(문장당 약 60자)가 읽히므로 10라운드 게임이 약 4천 자입니다. 캐시 적중 전 기준으로 월 100만 자는 약 250게임 분량입니다.

## 8. 실제 기기에서 확인할 항목

이 항목들은 실기기에서 아직 확인되지 않았습니다. 확인한 뒤 결과를 알려 주세요.

**음성 목록 (iPhone, Galaxy 각각)**
- [ ] ⚙️ 설정 → "음성 목록 보기"를 열어 보이는 이름, voiceURI, 제공자, 유형이 실제 기기와 맞는지
- [ ] "목록 복사"로 복사한 내용을 저에게 전달(실제 voiceURI 형식 확인용)
- [ ] iOS: Bubbles, Zarvox, Bad News 등 효과음성이 기본 목록과 화자 배정에서 제외되는지, "부자연스러운 음성도 목록에 표시"를 켜면 보이는지
- [ ] iOS: 제공자가 Apple로 표시되는지, Google/Microsoft로 표시되는 음성이 없는지

**엔진 표시**
- [ ] 서버 미연결 상태에서 Google 선택 → "연결 안 됨 (TTS 서버 주소 미설정)" + "Apple(또는 Android 시스템) 기기 음성 사용 중"
- [ ] Microsoft 선택 시 같은 방식으로 표시되는지
- [ ] 서버 연결 후 Google·Microsoft 각각 "연결됨"이며 실제로 음색이 다른지

**재생**
- [ ] 첫 음절이 잘리지 않는지, "N번 답장"이 빠지지 않는지
- [ ] 답장 공개가 한 장씩, 음성이 끝난 뒤에 이어지는지
- [ ] iOS에서 발신자와 답장자 목소리가 구분되는지(기기에 자연스러운 음성이 1개뿐이면 같은 목소리로 읽히는 것이 정상)
- [ ] Android(Galaxy)에서 한국어와 영어 음성
- [ ] 클라우드 연결을 끊었을 때(비행기 모드 등) 게임이 멈추지 않고 기기 음성으로 이어지는지

**화면**
- [ ] 휴대폰 세로·가로에서 설정 화면과 음성 목록 표가 화면 안에 들어오는지
