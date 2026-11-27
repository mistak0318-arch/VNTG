import { useEffect, useState } from "react";
import { api, signClass, type ShortLoanMarket, type ShortLoanMover } from "../../api";
import { BalanceChart } from "./DepositTrendPanel";

/**
 * **공매도 · 대차잔고** (2026-11-27).
 *
 * 벤티지: "시황 대시보드 마지막에 그 카드도 넣을 수 있나? 전체 시장의 대차잔고 수량이나
 * 공매도 수량, 왜냐면 그게 또 외국인의 포지션을 결정하는 거라고 하더라고."
 *
 * 두 칸이 보는 것이 다르다:
 *   · **대차잔고** — 빌려 간 채 **안 갚은** 주식. 쌓여 있는 양이라 **포지션**이다.
 *     늘면 팔 준비가 쌓이는 것이고, 주가가 오르는데 줄면 **갚느라 사는 것**(숏커버링)이다.
 *   · **공매도** — 그날 실제로 판 양. 쌓인 게 아니라 **하루치 행동**이다.
 *
 * 증시자금동향이 「살 돈이 얼마나 들어와 있나」라면 이 카드는 **「팔 준비가 얼마나 쌓여
 * 있나」**다. 그래서 바로 뒤에 붙는다.
 *
 * ## 숫자가 어디서 오나 — 조회 0회
 *
 * 시장 합계를 주는 TR 은 없다. 대신 마감 뒤 정리가 **전종목** 공매도·대차를 원장에 쌓고
 * 있어서, 서버가 그걸 더해 준다(자세한 사정은 `server/src/shortLoanMarket.ts` 머리말).
 * **보통주만**이고 ETF·ETN 은 안 들어간다 — 전종목 수집이 보통주 목록으로 돌기 때문이다.
 * 그래서 신문에 나오는 KRX 공표치와 숫자가 똑같지는 않다. 결을 보는 카드다.
 *
 * ⚠️ **비중(%)은 일부러 없다.** 공매도는 통합(KRX+NXT)으로 받는데 거래대금은 KRX 단독이라
 * 나누면 비중이 부푼다. 틀린 숫자 대신 20일 평균선으로 「요즘 센가」를 말한다.
 */

const 조 = 1_000_000_000_000; // 원 → 조
const 억주 = 100_000_000; // 주 → 억주

function jo(v: number): string {
  return `${(v / 조).toFixed(1)}조`;
}
function eokju(v: number): string {
  return `${(v / 억주).toFixed(2)}억주`;
}
/** 조 단위로 적되, 1조에 못 미치면 억으로 — 공매도 하루치는 1조 안팎이라 둘 다 쓴다 */
function money(v: number): string {
  if (Math.abs(v) >= 조) return `${(v / 조).toFixed(2)}조`;
  return `${Math.round(v / 100_000_000).toLocaleString("ko-KR")}억`;
}
function pct(v: number): string {
  return `${v > 0 ? "+" : ""}${v.toFixed(1)}%`;
}

type PickStock = (code: string, name: string) => void;

function MoverRow({ m, onSelectStock }: { m: ShortLoanMover; onSelectStock?: PickStock }) {
  return (
    <li>
      <button type="button" className="sl-name" onClick={() => onSelectStock?.(m.code, m.name)} disabled={!onSelectStock}>
        {m.name}
      </button>
      <span className={`num sl-diff ${signClass(m.diffAmt)}`}>
        {m.diffAmt > 0 ? "+" : "−"}
        {money(Math.abs(m.diffAmt))}
      </span>
      <span className="num sl-pct">{pct(m.diffPct)}</span>
    </li>
  );
}

/**
 * 고른 구간은 **이 기기에 적어 둔다** (2026-11-27). 20일로 보는 사람은 매번 20일로 본다 —
 * 카드를 열 때마다 다시 누르게 할 이유가 없다. 서버에 둘 것은 아니다(기기마다 보는 눈이 다르다).
 */
const SPAN_KEY = "vntg.shortLoan.span";
/** 서버가 세는 구간과 같아야 한다 — `server/src/shortLoanMarket.ts` 의 `SPANS` */
const SPANS = [1, 5, 10, 20];
function loadSpan(): number {
  const v = Number(localStorage.getItem(SPAN_KEY));
  return SPANS.includes(v) ? v : 5;
}
const SPAN_LABEL: Record<number, string> = { 1: "당일", 5: "5일", 10: "10일", 20: "20일" };

export function ShortLoanPanel({ onSelectStock }: { onSelectStock?: PickStock }) {
  const [data, setData] = useState<ShortLoanMarket | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [span, setSpan] = useState<number>(loadSpan);

  const pickSpan = (n: number) => {
    setSpan(n);
    try {
      localStorage.setItem(SPAN_KEY, String(n));
    } catch {
      /* 사생활 보호 창에서는 못 적는다 — 이번 판만 바뀌고 만다 */
    }
  };

  useEffect(() => {
    let alive = true;
    api
      .shortLoan()
      .then((r) => alive && setData(r))
      .catch((e: Error) => alive && setError(e.message));
    return () => {
      alive = false;
    };
  }, []);

  if (error) return <div className="ov-card-b empty">못 받음 — {error}</div>;
  if (!data) return <div className="ov-card-b empty">불러오는 중…</div>;
  if (data.days.length < 2)
    return (
      <div className="ov-card-b empty">
        아직 셀 거리가 없습니다 — 마감 뒤 정리(20:10)가 공매도·대차 확정값을 받으면 채워집니다.
      </div>
    );

  const days = data.days;
  const last = days[days.length - 1];

  /*
   * **전체 추이 — 네 구간을 한꺼번에** (2026-11-27 — 벤티지: "이거 전체적으로 증가하고 있는지
   * 오늘은 줄었는지 전체적으로 1일간 5일간 10일간 20일간 추이 좀 보여줘라").
   *
   * 구간 칩은 **종목별 목록만** 움직인다 — 「전체」는 네 구간이 한 줄에 다 있어야
   * 「늘다가 오늘 꺾였나」가 보인다. 하나씩 눌러 가며 비교하게 하면 그게 안 보인다.
   *
   * ⚠️ **가격을 고정한 금액(`*Fx`)으로 잰다.** 그날 종가로 친 `loanAmt` 로 추이를 내면
   * 주가 변동이 포지션 변동으로 둔갑한다 — 실측 2026-11-27 에 **10일 추이의 부호가
   * 뒤집혔다**(그날 종가 −0.8% ↔ 가격 고정 +3.8%). 그날 코스피가 +4.34% 올라 대차 금액이
   * 하루 +5.2% 로 보였는데 빌려 간 수량은 +0.1% 였다. 종목별 증감에서 이미 피한 함정인데
   * 합계에는 남아 있었다.
   *   · 대차잔고는 **잔고**라 「그때와 견주면 얼마나 쌓였나」
   *   · 공매도는 **하루치**라 「그 구간 평균보다 센가」 (당일은 전 거래일 대비)
   */
  const mean = (xs: number[]) => (xs.length > 0 ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);
  const trendOf = (n: number) => {
    const ago = days[days.length - 1 - n];
    if (!ago) return { loan: null as number | null, short: null as number | null };
    const base = n === 1 ? [ago.shortAmtFx] : days.slice(-1 - n, -1).map((d) => d.shortAmtFx);
    const avg = mean(base);
    return {
      loan: ago.loanAmtFx > 0 ? ((last.loanAmtFx - ago.loanAmtFx) / ago.loanAmtFx) * 100 : null,
      short: avg > 0 ? ((last.shortAmtFx - avg) / avg) * 100 : null,
    };
  };
  const trends = SPANS.filter((n) => days.length > n).map((n) => ({ n, ...trendOf(n) }));

  /*
   * 그래프도 **가격 고정**이다. 그날 종가로 그리면 90일 폭이 123~168조(주가가 만든 출렁임)인데
   * 가격을 고정하면 112~135조 — 뒤쪽이 「빌려 간 양」의 진짜 모양이다. 마지막 점은 두 방식이
   * 같은 값이라(그날이 기준날) 위의 큰 숫자와 어긋나지 않는다.
   */
  const loanRows = days.filter((d) => d.loanAmtFx > 0).map((d) => ({ date: d.date, v: d.loanAmtFx }));
  const shortRows = days.filter((d) => d.shortAmtFx > 0).map((d) => ({ date: d.date, v: d.shortAmtFx }));
  const split = last.loanAmtKospi > 0 || last.loanAmtKosdaq > 0;
  const sp = data.spans.find((s) => s.days === span) ?? null;

  /*
   * 「왜 두 숫자가 다른가」를 **그날 값으로** 말한다. 예전엔 주석을 쓰던 날의 숫자(+5.2% ↔ +0.1%)를
   * 글에 박아 뒀는데, 그건 다음 날이면 거짓말이다. 차이가 1%p 넘게 날 때만 적는다 —
   * 지수가 거의 안 움직인 날엔 둘이 같아서 굳이 할 말이 없다.
   */
  const prevDay = days[days.length - 2];
  const gap = (() => {
    if (!prevDay || prevDay.loanAmt <= 0 || prevDay.loanAmtFx <= 0) return null;
    const real = ((last.loanAmt - prevDay.loanAmt) / prevDay.loanAmt) * 100;
    const fx = ((last.loanAmtFx - prevDay.loanAmtFx) / prevDay.loanAmtFx) * 100;
    return Math.abs(real - fx) >= 1 ? { real, fx } : null;
  })();

  return (
    <div className="ov-card-b dep sl">
      <div className="dep-row">
        <div className="dep-cell">
          <span className="dep-k">대차잔고</span>
          <b className="num">{jo(last.loanAmt)}</b>
          <span className="num dep-d">{eokju(last.loanQty)}</span>
          <BalanceChart rows={loanRows.slice(-60)} color="var(--red)" fmt={jo} />
        </div>
        <div className="dep-cell">
          <span className="dep-k">공매도 (하루)</span>
          <b className="num">{money(last.shortAmt)}</b>
          <span className="num dep-d">{eokju(last.shortQty)}</span>
          {/* 눈금도 머릿수와 같은 `money` 로 — 머리는 「8,218억」인데 눈금만 「0.58조」면 같은 칸에서 단위가 갈린다 */}
          <BalanceChart rows={shortRows.slice(-60)} color="var(--blue)" fmt={money} />
        </div>
      </div>

      {/* 전체 추이 — 네 구간을 한 줄에. 위 주석 참고 (왜 가격 고정인지) */}
      {trends.length > 0 && (
        <div className="sl-trend">
          <div className="sl-tr-row sl-tr-head">
            <span className="sl-tr-k">전체 추이</span>
            {trends.map((t) => (
              <span key={t.n} className="num">
                {SPAN_LABEL[t.n]}
              </span>
            ))}
          </div>
          {/*
            재는 방식은 **풍선말로** 보낸다. 라벨 옆에 작게 달아 봤더니 3단 배치(카드 350px)에서
            「대차잔고 그때…」로 잘렸다 — 잘린 설명은 설명이 아니다. 아래 꼬리말이 이미 말한다.
          */}
          <div className="sl-tr-row">
            <span className="sl-tr-k" title="그 거래일의 잔고와 지금을 견준 값입니다 — 잔고라 「그때보다 얼마나 쌓였나」로 읽습니다">
              대차잔고
            </span>
            {trends.map((t) => (
              <span key={t.n} className={`num ${t.loan === null ? "" : signClass(t.loan)}`}>
                {t.loan === null ? "-" : pct(t.loan)}
              </span>
            ))}
          </div>
          <div className="sl-tr-row">
            <span className="sl-tr-k" title="그 구간의 하루 평균과 오늘을 견준 값입니다 (당일은 전 거래일 대비) — 공매도는 하루치라 「요즘보다 센가」로 읽습니다">
              공매도
            </span>
            {trends.map((t) => (
              <span key={t.n} className={`num ${t.short === null ? "" : signClass(t.short)}`}>
                {t.short === null ? "-" : pct(t.short)}
              </span>
            ))}
          </div>
        </div>
      )}

      {split && (
        <div className="dep-funds">
          대차잔고 — 코스피 {jo(last.loanAmtKospi)} · 코스닥 {jo(last.loanAmtKosdaq)} · 공매도 — 코스피{" "}
          {money(last.shortAmtKospi)} · 코스닥 {money(last.shortAmtKosdaq)}
        </div>
      )}

      {/*
        **종목별 — 구간을 고른다** (2026-11-27 — 벤티지: "당일 5일 10일 20일 선택해서 볼 수 있게
        하자 … 아니 종목별로 말이야. 지금은 5일간만 있잖아").

        칩은 `filter-row`·`filter-btn` 을 그대로 쓴다 — 이 앱의 다른 화면과 같은 손맛이라야 한다.
      */}
      <div className="sl-head">
        <span className="sl-mv-k">종목별 대차잔고 증감</span>
        <div className="filter-row sl-spans">
          {[1, 5, 10, 20].map((n) => (
            <button
              key={n}
              type="button"
              className={`filter-btn${span === n ? " active" : ""}`}
              onClick={() => pickSpan(n)}
              disabled={!data.spans.some((s) => s.days === n)}
              title={
                data.spans.some((s) => s.days === n)
                  ? `${n === 1 ? "전 거래일" : `${n}거래일 전`}과 견준다`
                  : "원장이 아직 그만큼 안 쌓였습니다"
              }
            >
              {SPAN_LABEL[n]}
            </button>
          ))}
        </div>
      </div>

      {sp === null || (sp.up.length === 0 && sp.down.length === 0) ? (
        <div className="sl-none">이 구간에 눈에 띄는 변화가 없습니다.</div>
      ) : (
        <div className="sl-movers">
          {sp.up.length > 0 && (
            <div className="sl-mv">
              <span className="sl-mv-k">증가 (빌려 가는 중)</span>
              <ul>
                {sp.up.map((m) => (
                  <MoverRow key={m.code} m={m} onSelectStock={onSelectStock} />
                ))}
              </ul>
            </div>
          )}
          {sp.down.length > 0 && (
            <div className="sl-mv">
              <span className="sl-mv-k">감소 (갚는 중)</span>
              <ul>
                {sp.down.map((m) => (
                  <MoverRow key={m.code} m={m} onSelectStock={onSelectStock} />
                ))}
              </ul>
            </div>
          )}
        </div>
      )}

      <div className="table-note">
        <b>대차잔고</b>는 빌려 간 채 안 갚은 주식입니다 — 쌓여 있는 양이라 <b>포지션</b>이고, 대부분
        외국인·기관이 빌립니다. 늘면 팔 준비가 쌓이는 것이고, <b>주가가 오르는데 줄면 갚느라 사는
        것</b>(숏커버링)입니다. <b>공매도</b>는 그날 실제로 판 하루치라 뜻이 다릅니다. 붉은 점선은{" "}
        <b>20일 평균</b>, 눈금은 그 구간의 최저·최고라 <b>바닥이 0 이 아닙니다.</b>
      </div>
      <div className="table-note">
        추이와 그래프는 <b>모든 날을 지금 종가로 쳐서</b> 주가 변동을 걷어낸 값입니다 — 그래야{" "}
        <b>빌려 간 양</b>의 흐름만 남습니다. 큰 숫자({jo(last.loanAmt)})는 그날 종가 기준의 실제
        규모라 조금 다를 수 있습니다.
        {gap !== null && (
          <>
            {" "}
            걷어내지 않으면 지수가 오른 날 포지션이 는 것처럼 보입니다 — <b>{last.date}</b> 은 대차
            금액이 하루 <b>{pct(gap.real)}</b> 인데 걷어내면 <b>{pct(gap.fx)}</b> 입니다.
          </>
        )}
      </div>
      <div className="table-note">
        종목별 증감은 <b>{sp ? (sp.days === 1 ? "전 거래일" : `${sp.days}거래일 전`) : "-"}</b>
        {sp ? `(${sp.from})` : ""} 과 견준 것이고, 금액은 <b>지금 종가 하나로</b> 양쪽을 쳤습니다 — 그래야
        주가가 올라 금액이 는 것이 섞이지 않고 <b>빌려 간 수량이 는 것만</b> 남습니다. 잔고 100억 미만
        종목은 뺐습니다.
      </div>
      <div className="table-note">
        {last.date} 기준 · 우리 원장 <b>{data.codes.toLocaleString("ko-KR")}종목</b>을 더한 값(조회 0회)
        {data.dropped.length > 0 ? ` · 덜 받은 ${data.dropped.length}일은 뺌` : ""} ·{" "}
        <b>보통주만</b>이라 ETF·ETN 이 빠져 KRX 공표치와는 다릅니다 · 공매도·대차는 공표가 저녁이라{" "}
        <b>하루 한 번(20:10)</b> 갱신됩니다.
      </div>
    </div>
  );
}
