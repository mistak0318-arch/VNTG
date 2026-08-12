# VNTG HTS — 다음 작업 정리

마지막 갱신: 2026-08-12

---

## 0. 세션 시작할 때 먼저 할 일

```bash
cd "K:\0000 3740 프로젝트 (경제적자유)\00. 주식\2 AI 프롬프트\260810_클로드작업" && start-all.cmd
```

- 서버 `:4000` (tsx watch — 코드 고치면 자동 재시작), 웹 `:5173`
- 세션이 끊기면 서버도 같이 죽으므로 **매번 다시 띄워야 함**
- 접속: PC `http://localhost:5173` / 폰 `http://100.88.55.69:5173` (Tailscale)

---

## 1. 우선순위 A — 미니PC 이전 준비 ★가장 급함

미니PC를 실제로 옮기기 전에 해둬야 손이 덜 감.

- [ ] **pm2 등록** — 재부팅해도 서버/웹이 자동으로 뜨게 (`pm2 startup` + `pm2 save`)
- [ ] **헬스체크 확장** — `/api/health`에 키움 토큰 유효성·마지막 조회 성공 시각 포함
- [ ] **IP 변경 감지** — Tailscale IP나 LAN IP가 바뀌면 알 수 있게
- [ ] **README 설치 절차** — 새 PC에서 `npm i` → `.env` 채우기 → `pm2` 등록까지 순서대로
- [ ] **`.env.example`** 만들기 (키 이름만, 값은 비워서)
- [ ] **키움 앱키/시크릿 재발급** — 초기에 채팅창에 한 번 노출됐음. 미니PC 옮길 때 같이 교체할 것

> 참고: 현재 `.env`에 있는 키 — `KIWOOM_APP_KEY`, `KIWOOM_SECRET_KEY`, `DART_API_KEY`, `NAVER_CLIENT_ID`, `NAVER_CLIENT_SECRET`

---

## 2. 우선순위 B — 기능

- [ ] **텔레그램 파이프라인** — 조건 만족 종목을 텔레그램으로 푸시 (미니PC 세팅 후 하기로 했던 것)
- [ ] **차트 보조지표** — RSI / MACD / 볼린저밴드. lightweight-charts에 내장이 없어서 직접 계산해 서브 시리즈로 추가. `web/src/components/CandleChart.tsx`의 `sma()` 옆에 함수 추가하는 식
- [ ] **52주 베타 / 상대수익률 차트** — 키움 일봉 데이터만으로 계산 가능 (지수 대비)
- [ ] **로그인 TOTP** — 외부 노출 시 최소 방어
- [ ] **Claude API 분석 기능** — 선택사항

---

## 3. 우선순위 C — 알려진 문제 / 미해결

### 3-1. 차트 y축 음수 눈금 (미해결)
- 증상: 캔들차트 우측 축에 `-1,000,000` 같은 음수가 표시됨
- 원인: `CandleChart.tsx:56`의 `scaleMargins: { top: 0.05, bottom: 0.3 }` — 거래량 자리를 비우려고 준 하단 30% 여백만큼 축이 0 아래로 늘어남
- lightweight-charts **v4.2.0** 사용 중. v5의 `panes` 기능을 쓰면 거래량을 아예 별도 페인으로 분리 가능 → 근본 해결
- 데이터는 정확하고 순수 표시 문제

### 3-2. 업종 PER (task #28, 계속 보류)
**결론부터: 키움 REST API로는 못 가져옴.**

- 키움 **앱**의 업종PER은 FnGuide에서 사와서 앱에 심은 벤더 데이터. 그래서 앱엔 있고 API엔 없음
- `ka10026`은 고/저PER 종목만 주고 업종 평균은 안 줌
- DART에도 없음 (개별 기업 재무제표만, 업종 집계 없음)
- **FnGuide 크롤링 불가** — `comp.fnguide.com/robots.txt` = `Disallow: /`
- **네이버 금융도 불가** — `finance.naver.com`, `m.stock.naver.com` 모두 `Disallow: /`

남은 선택지:
1. **KRX 정보데이터시스템** — 업종별 PER/PBR/배당수익률을 매일 공표. robots.txt가 404(제한 선언 없음)라 가능성 있음.
   엔드포인트 후보: `POST http://data.krx.co.kr/comm/bldAttendant/getJsonData.cmd`
   `bld=dbms/MDC/STAT/standard/MDCSTAT03501`, `mktId=STK`, `trdDd=YYYYMMDD`
   **⚠ 미확인** — 이 PC에서 curl 시도 시 응답이 없었음. 네트워크 문제인지 차단인지 확인 안 됨. **다음에 이것부터 확인할 것**
2. 업종 구성종목(ka20002) 순회 + DART 순이익으로 직접 계산 — 업종당 수십 회 호출, 무거움.
   `server/src/sectorPer.ts`에 코드는 이미 있으나 **어느 라우트에도 연결 안 됨(dead code)**. 안 쓸 거면 삭제할 것

### 3-3. 키움 앱에는 있는데 우리가 못 만드는 것
- **실시간수급(파워맵)** — 키움 자체 추정치 상품. REST API에 없음
- **종목투자자잠정 시간대별 누적** — `ka10066`은 전 종목 스냅샷 1건만 줌. 시간대별 누적을 만들려면 우리가 직접 폴링해서 쌓아야 함
- **거래원 외국계합** — `ka10002`가 상위 5개 창구만 줌. 현재 "상위5 내 합계"로 표시하고 화면에 명시해둠

---

## 4. 이번 세션에서 완료한 것 (참고)

- 재무 시각화 (매출·영업이익·순이익 3년 + 배당) — DART `fnlttSinglAcnt`
- **개별종목분석 페이지 신설** — 차트/호가/거래원/투자자/프로그램/신용/체결강도/일별상세 8탭
- 종목 상세 → 개별종목분석 이동 버튼
- 시세 요약 바 (시가·고가·저가에 등락률 % 병기)
- 업종·테마 분위기 표시
- 뉴스 주요 언론사 필터 (60개 언론사 사전 + 광고성/중복 제거)
- 타입 에러 4건 수정 → `npm run build` 통과 상태

### 이번에 알아낸 키움 API 요령 (중요)
- **`ka90001` + `qry_tp=2` + `stk_cd`** → 그 종목이 편입된 **테마만** 반환. 테마 전체를 훑을 필요 없이 호출 1번
- **`ka10099`(전종목 리스트)에 `upName`(업종명), `upSizeName`(대/중/소형주)** 포함 → 업종 매칭에 추가 호출 불필요
- TR별 **초당 5회** 제한. 초과 시 HTTP 429 + `return_code: 5` → `kiwoomClient.ts`에 백오프 재시도 구현돼 있음
- 리소스 경로가 TR마다 다름. 틀리면 `1504: 해당 URI에서는 지원하는 API ID가 아닙니다`
  - `/api/dostk/stkinfo` — ka10001, ka10002, ka10013, ka10015, ka10059, ka10099
  - `/api/dostk/mrkcond` — ka10004, ka10007, ka10046, ka10047, ka10063, ka10066, ka90013
  - `/api/dostk/chart` — ka10060, ka10080~83
  - `/api/dostk/sect` — ka20002, ka20003 / `/api/dostk/thme` — ka90001, ka90002
  - `/api/dostk/frgnistt` — ka10008, ka10009 / `/api/dostk/shsa` — ka10014 / `/api/dostk/slb` — ka20068

### 디버깅 팁
- PowerShell은 HTTP 에러 본문을 못 읽음 → **`curl.exe` 쓸 것**
- 한글 쿼리는 셸에서 깨짐 → `node -e "encodeURIComponent(...)"`로 인코딩해서 넘길 것
- 새 TR 탐색할 땐 `server/src/_tmpTest.ts` 만들어서 `npx tsx src/_tmpTest.ts` (쓰고 나면 삭제)
