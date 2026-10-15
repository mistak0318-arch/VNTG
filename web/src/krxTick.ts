/**
 * **호가 단위와 전일 대비** — KRX 2023-01 개편 기준.
 *
 * `OrderPage` 안에만 있던 `tickOf` 를 꺼내 왔다 (2026-10-15). 주문 말고도 쓸 데가
 * 생겼기 때문이다 — 시세분석 표에서 **등락률 밑에 「얼마 빠졌나」**를 적는 데 쓴다.
 */
export function tickOf(p: number): number {
  if (p < 2_000) return 1;
  if (p < 5_000) return 5;
  if (p < 20_000) return 10;
  if (p < 50_000) return 50;
  if (p < 200_000) return 100;
  if (p < 500_000) return 500;
  return 1_000;
}

/**
 * **전일 대비(원)** — 현재가와 등락률에서 되돌려 낸다.
 *
 * 벤티지: "등락률 밑에 얼마 빠진 건지 금액 좀 조그만 글씨로" (키움 관심종목 캡처).
 *
 * ## 왜 되돌려 내나
 *
 * 순위 조회 응답에는 **대비 칸이 없다**(`code·name·cur_prc·flu_rt·…`). 그 한 칸을
 * 받자고 종목마다 조회를 더 거는 것은 말이 안 되고, 현재가와 등락률만 있으면
 * 산수로 나온다 — `기준가 = 현재가 ÷ (1 + 등락률)`, 대비는 그 차이다.
 *
 * ## ⚠️ 반드시 호가 단위로 반올림한다
 *
 * 등락률이 **소수 둘째 자리까지만** 오므로 그냥 빼면 몇 원씩 어긋난다. 한화오션
 * 61,600 · −8.61% 는 산수로 **−5,803** 인데 실제 대비는 **−5,800** 이다(호가 100원).
 * 주가는 호가 단위 위에만 설 수 있으니 거기에 맞추면 그 오차가 사라진다.
 *
 * 캡처의 일곱 종목으로 검산했다 — 삼성중공업 1,010 · 한화오션 5,800 ·
 * HD현대중공업 21,500 · HD한국조선해양 17,500 · 한화엔진 3,700 · 대한조선 2,850 ·
 * NICE평가정보 250. **일곱 다 키움 화면과 같다.** 호가 반올림을 빼면 셋이 어긋난다.
 *
 * ⚠️ ETF·ETN 은 호가 체계가 달라(5원 단위 등) 한두 호가 어긋날 수 있다. 그래도
 * 등락률은 제 값이고 이 줄은 **곁에 적는 참고**라, 없는 것보다 낫다고 본다.
 */
export function diffFromRate(price: number | null | undefined, rate: number | null | undefined): number | null {
  if (price == null || rate == null) return null;
  const p = Math.abs(Number(price));
  const r = Number(rate);
  if (!Number.isFinite(p) || !Number.isFinite(r) || p <= 0) return null;
  /* −100% 는 기준가가 0 이라는 뜻이라 나눌 수 없다 */
  if (r <= -100) return null;
  const base = p / (1 + r / 100);
  const raw = p - base;
  const t = tickOf(p);
  return Math.round(raw / t) * t;
}
