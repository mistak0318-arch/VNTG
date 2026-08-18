# 한국투자증권 OpenAPI — 키움이 못 주는 것만 가져온다

출처: `한국투자증권_오픈API_전체문서_20260818_030007.xlsx` (2026-08-18 내려받음, 339개 API)
2026-08-18 실계좌 키로 **실제 호출해 확인함**(아래 「확인된 것」 참조).

## 왜 두 증권사를 같이 쓰나

키움이 국내주식은 충분한데 **세 가지가 아예 없다.**

| 필요한 것 | 키움 | 한투 |
|---|---|---|
| 증권사 목표주가·투자의견 | ✗ | ✓ `FHKST663300C0` |
| 해외주식 시세 | ✗ (야후로 대체 중) | ✓ `HHDFS00000300` 외 33종 |
| 국내 선물·옵션 | ✗ | ✓ `FHMIF10000000` 외 29종 |

**국내주식은 계속 키움을 쓴다.** 한투에도 같은 API가 있지만 이미 검증해 둔 걸 갈아엎을 이유가 없고,
두 곳에서 같은 값을 받아 오면 어긋날 때 어느 쪽이 맞는지 판단할 근거가 없다.

## 인증 — 토큰을 반드시 파일에 캐시할 것

```
POST https://openapi.koreainvestment.com:9443/oauth2/tokenP
{ "grant_type":"client_credentials", "appkey":"…", "appsecret":"…" }
→ { access_token, token_type:"Bearer", expires_in:86400, access_token_token_expired:"2026-08-19 23:41:30" }
```

- 유효기간 **24시간**, 갱신주기 **6시간** — 6시간 안에 다시 부르면 **직전 토큰을 그대로 돌려준다**
- 문서에 「1일 1회 발급 원칙」이라고 적혀 있다. 서버가 재시작될 때마다 발급하면 안 된다
- **`server/data/` 에 만료시각과 함께 저장하고, 만료 1시간 전에만 갱신한다**
- 헤더는 매 호출마다 `authorization: Bearer <token>` + `appkey` + `appsecret` + `tr_id` + `custtype: P`

유량 제한은 이 엑셀에 없다. KIS 포털 FAQ 기준 실전 초당 20건으로 알려져 있으나 **확인 전까지는 키움과 같은
초당 5건으로 다룬다** — 모자라서 문제가 된 적은 없다.

## ① 증권사 목표주가 — 이게 제일 급하다

### 종목투자의견 `FHKST663300C0`
`GET /uapi/domestic-stock/v1/quotations/invest-opinion`

한 종목에 대해 **여러 증권사가 낸 의견을 시간순으로** 준다. HTS [0605] 화면.

| 파라미터 | 값 |
|---|---|
| `FID_COND_MRKT_DIV_CODE` | `J` |
| `FID_COND_SCR_DIV_CODE` | `16633` (고정) |
| `FID_INPUT_ISCD` | 종목코드 |
| `FID_INPUT_DATE_1` / `_2` | 시작·종료일 `YYYYMMDD` |

응답 `output[]`:

| 필드 | 뜻 | 비고 |
|---|---|---|
| `stck_bsop_date` | 발표일 | |
| `mbcr_name` | 증권사 | "키움" "삼성" "한국투자" |
| `invt_opnn` | 투자의견 | **"BUY" 와 "매수" 가 섞여 나온다** — 정규화 필요 |
| `invt_opnn_cls_code` | 의견코드 | 2=매수 (직전과 비교해 상향/하향 판단) |
| `rgbf_invt_opnn` | 직전 의견 | 이게 있어서 **의견 변경**을 잡을 수 있다 |
| `hts_goal_prc` | **목표주가** | |
| `stck_prdy_clpr` | 발표 시점 전일종가 | |
| `dprt` | 괴리율 % | 현재가가 목표가보다 얼마나 아래인지 |

**한 번에 100건.** 더 필요하면 날짜를 쪼개야 한다(`tr_cont` 연속조회 안 됨).

### 증권사별 투자의견 `FHKST663400C0`
`GET /uapi/domestic-stock/v1/quotations/invest-opbysec` · SCR `16634` · **한 번에 20건**

`FID_INPUT_ISCD` 에 **종목코드가 아니라 회원사코드**를 넣는다(포털 FAQ 의 종목정보 다운로드 참조).
`FID_DIV_CLS_CODE`: 전체0 매수1 중립2 매도3. "이 증권사가 요즘 뭘 밀고 있나"를 볼 때 쓴다.

> **둘 다 모의투자 미지원.** 실전 도메인에서만 된다.

## ② 해외주식

`GET /uapi/overseas-price/v1/quotations/…` · 인증 파라미터 `AUTH` 는 **빈 문자열**을 넣는다.

| 쓸 것 | TR_ID | 경로 |
|---|---|---|
| 현재체결가 | `HHDFS00000300` | `price` |
| **복수종목 시세(최대 10)** | `HHDFS76220000` | `multprice` |
| 현재가상세 | `HHDFS76200200` | `price-detail` |
| 기간별시세(일/주/월) | `HHDFS76240000` | `dailyprice` |
| 종목/지수/환율 기간별(일주월년) | `FHKST03030100` | `inquire-daily-chartprice` |
| 분봉 | `HHDFS76950200` | `inquire-time-itemchartprice` |
| 조건검색 | `HHDFS76410000` | `inquire-search` |
| 상품기본정보 | `CTPF1702R` | `search-info` |

거래소코드 `EXCD`: `NAS`나스닥 `NYS`뉴욕 `AMS`아멕스 `TSE`도쿄 `HKS`홍콩 `SHS`상해 `SZS`심천 `HSX`호치민 `HNX`하노이.
`BAQ`/`BAY`/`BAA` 는 **주간(한국시간 낮) 거래** — 미국 정규장이 아니다.

`multprice` 는 `EXCD_01~10` + `SYMB_01~10` + `NREC`(건수)로 **한 번에 10종목**을 받는다.
지금 미국 관심종목은 야후를 종목마다 부르고 있는데, 여기로 옮기면 호출이 1/10 이 된다.
다만 `t_xprc`(원화환산가), `tomv`(시가총액), `h52p`/`l52p`(52주)까지 주므로 화면이 더 두꺼워진다.

**야후를 완전히 버릴 수는 없다** — 지수선물(`ES=F` 등)과 미국 현물지수는 여기 없다.
「글로벌 시황」은 야후를, 「관심종목(미국)」은 한투를 쓰는 게 맞다.

## ③ 국내 선물·옵션

`GET /uapi/domestic-futureoption/v1/quotations/…`

| 쓸 것 | TR_ID | 경로 |
|---|---|---|
| 선물옵션 시세 | `FHMIF10000000` | `inquire-price` |
| 전광판(선물 월물 목록) | `FHPIF05030200` | `display-board-futures` |
| 전광판(콜풋) | `FHPIF05030100` | `display-board-callput` |
| 기초자산 시세 | `FHPIF05030000` | `display-board-top` |
| 기간별시세 | `FHKIF03020100` | `inquire-daily-fuopchartprice` |

`FID_COND_MRKT_DIV_CODE`: `F`지수선물 `O`지수옵션 `JF`주식선물 `JO`주식옵션 `CF`상품·금리·통화선물 `CM`야간선물 `EU`야간옵션.

**종목코드를 외워 쓰지 말 것.** 월물은 3개월마다 바뀐다.
`display-board-futures`(`FID_COND_MRKT_CLS_CODE` 공백=KOSPI200, `MKI`=미니, `KQI`=코스닥150)로
목록을 받아 `futs_shrn_iscd` 를 꺼내 쓴다.

시세 응답 `output1` 에서 볼 것: `futs_prpr`현재가 `futs_prdy_ctrt`등락률 `hts_thpr`이론가
**`hts_otst_stpl_qty`미결제약정** — 미결제는 지수 방향과 같이 봐야 뜻이 생긴다.

`CM`(야간선물)·`EU`(야간옵션)이 있다는 게 크다. **미국장이 열려 있는 동안 한국 지수가 어디로 가는지**를
현물 개장 전에 볼 수 있다 — 조간 리포트에 넣을 값이다.

## 확인된 것 (2026-08-18 실호출)

| 대상 | 결과 |
|---|---|
| 토큰 발급 | ✓ 만료 2026-08-19 23:41 |
| 목표주가 (삼성전자, 06/01~08/18) | ✓ 28건 — 키움 35만, 삼성 40만, 한국투자 65만, 신한 45만 |
| 해외 현재가 (NAS/NVDA) | ✓ 219.6950 / −2.36% / 19,235,507주 |
| 선물 전광판 → 시세 | ✓ KOSPI200 F202609(`A01609`) 1078.25 / −1.88% / 미결제 150,211 |

## 환경변수

```
HANTOO_APP_KEY=…      (36자)
HANTOO_APP_SECRET=…   (180자)
```

`server/.env` 에만 둔다. 미니PC·개발PC 각각 넣는다(git 에 올리지 않는다).

> **2026-08-18 발견:** 두 PC의 `HANTOO_APP_SECRET` 이 **181자**로 한 글자 더 길어서
> `EGW00105 유효하지 않은 AppSecret` 이 났다. 맨 뒤 한 글자를 지우니 통과했다.
> 앱시크릿은 **정확히 180자**다 — 붙여넣을 때 길이를 세 볼 것.

## 아직 안 본 것

- 계좌·주문 API 전부 — **이 프로젝트는 조회 전용이라 쓸 일이 없다**
- 해외선물옵션(20종) — 야후 선물로 충분한지 먼저 볼 것
- 장내채권(18종) — 금리를 볼 때 쓸 수 있으나 지금은 급하지 않다
- 웹소켓 실시간 — 세션이 한 대에서만 살 수 있는 텔레그램과 같은 제약이 있는지 확인 필요
