# 내 HTS (키움 REST API 웹 뷰어)

키움증권 신규 Open API(REST)로 계좌 요약 / 보유종목 / 시세 / 차트를 조회하는 모바일 친화 웹앱입니다.
지금 버전은 **조회 전용**입니다 (매수/매도 주문 기능 없음).

- `server/` : Node.js + Express + TypeScript. 키움 API 키를 보관하고, 토큰 발급·API 호출을 대신 처리하는 백엔드.
- `web/` : React + Vite + TypeScript. 휴대폰에서 보는 대시보드 화면.

키움 API 키를 브라우저(휴대폰)에 직접 노출하지 않기 위해, 반드시 이 백엔드 서버를 거쳐서 호출하도록 구성했습니다.

## 0. 사전 준비

1. **Node.js 설치**: https://nodejs.org 에서 LTS 버전 설치 (이 PC엔 아직 없습니다).
2. 키움 REST API 포털(openapi.kiwoom.com)에서 발급받은 **실전투자 앱키/시크릿키**를 준비합니다 (계좌번호는 앱키에 연결되어 있어 따로 필요 없습니다).

## 1. 서버 설정

```bash
cd server
npm install
copy .env.example .env
```

`server/.env` 파일을 열어 아래 값을 채웁니다.

```
KIWOOM_APP_KEY=발급받은_앱키
KIWOOM_APP_SECRET=발급받은_시크릿키
KIWOOM_IS_MOCK=false
PORT=4000
```

`.env`는 `.gitignore`에 포함되어 있어 git에는 올라가지 않습니다. **절대로 다른 사람과 공유하거나 커밋하지 마세요.**

서버 실행:

```bash
npm run dev
```

`http://localhost:4000/api/health` 접속 시 `{"ok":true}`가 뜨면 정상입니다.

## 2. 프론트엔드 설정

새 터미널을 열고:

```bash
cd web
npm install
npm run dev
```

터미널에 뜨는 주소(`http://localhost:5173`)로 PC 브라우저에서 먼저 확인해보세요.

## 3. 휴대폰(모바일)에서 접속하기

PC와 휴대폰이 **같은 Wi-Fi**에 연결되어 있어야 합니다.

1. PC의 로컬 IP 확인 (PowerShell):
   ```powershell
   ipconfig
   ```
   `무선 LAN 어댑터 Wi-Fi` 항목의 `IPv4 주소` (예: `192.168.0.12`)를 확인합니다.
2. 휴대폰 브라우저에서 `http://192.168.0.12:5173` 접속.
3. 접속이 안 되면 Windows 방화벽이 5173/4000 포트를 막고 있을 수 있습니다. "Windows Defender 방화벽" → "고급 설정" → 인바운드 규칙에서 Node.js 또는 해당 포트를 허용해주세요.

> 외부(다른 Wi-Fi, LTE 등)에서 접속하려면 별도의 터널링(Cloudflare Tunnel 등)이나 배포가 필요합니다. 지금은 로컬 개발 단계라 다루지 않았습니다.

## 4. 화면에 값이 이상하게 보이거나 "-"로 나올 때

키움 REST API의 상세 응답 필드명(항목명)은 로그인 없이는 공식 문서에 접근할 수 없어, 흔히 쓰이는 필드명 후보들을 코드에 미리 넣어뒀습니다 (`web/src/App.tsx`, `web/src/components/StockDetail.tsx` 상단의 `*_KEYS` 배열).

실제 실행해서 값이 안 맞으면:

1. 계좌 요약/보유종목 카드 아래 **"원본 JSON 보기"**를 눌러 실제 응답 필드명을 확인합니다.
2. 해당 필드명을 `App.tsx`의 관련 `*_KEYS` 배열 맨 앞에 추가합니다.
3. 저장하면 Vite가 자동으로 새로고침됩니다.

이 부분만 다시 알려주시면 제가 정확한 필드명으로 바로 고쳐드릴 수 있습니다.

## 5. 다음 단계 (원하시면)

- WebSocket(`wss://api.kiwoom.com:10000`)으로 실시간 시세 반영
- 관심종목 등록/검색
- PWA로 만들어 휴대폰 홈 화면에 아이콘 추가
- 외부에서도 접속 가능하도록 배포
