import type { KeyboardEvent as ReactKeyboardEvent } from "react";
import { api, fmtNum, signClass, type OrderBook } from "../api";
import { useLive } from "../useLive";
import { fid, useRealtime } from "../useRealtime";

/**
 * 호가창 — **지금 어느 쪽이 두터운가.**
 *
 * 종목 상세와 종목분석이 **같은 이 컴포넌트를 쓴다.** 두 화면이 각자 그리면
 * 언젠가 한쪽만 고쳐져서 같은 종목이 다르게 보인다.
 *
 * ## 배치가 곧 읽는 순서다
 *
 *   가운데   10단 호가 — 매도가 위, 매수가 아래 (HTS 와 같은 방향)
 *   오른쪽 위 KRX·NXT 고저, 250일 자리, 상·하한
 *   왼쪽 아래 잔량비·회전율·시간외 잔량
 *
 * ## 체결강도와 잔량비는 다른 값이다
 *
 * 체결강도는 **실제로 체결된 것**의 비율(`ka10003`), 잔량비는 **아직 대기 중인 물량**의
 * 비율(`ka10004`)이다. 둘 다 보여 준다 — 체결은 세게 붙는데 잔량은 얇은 날이 있고,
 * 그 차이가 뜻을 갖는다.
 *
 * ⚠️ 체결강도는 `ka10004`·`ka10001` 에는 **없다.** 한동안 못 찾아 잔량비로만 뒀는데,
 * `ka10003`(체결정보)에 있었다 — 한투를 뒤질 필요가 없었다.
 */

/** 막대 길이를 정할 기준 — 그 판에서 제일 두꺼운 호가 */
function maxQty(book: OrderBook): number {
  const all = [...book.asks, ...book.bids].map((l) => l.qty);
  return all.length > 0 ? Math.max(...all, 1) : 1;
}

/**
 * 실시간 호가(`0D`)를 REST 그림 위에 얹는다.
 *
 * ## 왜 얹기만 하나
 *
 * REST 를 걷어내면 **화면을 처음 열었을 때 빈 호가창**이 뜬다. 실시간은
 * 「지금부터의 변화」만 주기 때문이다. 밑그림은 REST, 갱신은 웹소켓이다.
 *
 * ## 왜 굳이 바꾸나 (이미 1초 폴링인데)
 *
 * 눈에 보이는 속도는 비슷하다. 이득은 두 가지다.
 *
 *   1. **키움 호출이 사라진다.** 종목당 초당 1건인데, 보드에 호가 칸을 여러 개 띄우거나
 *      창을 여럿 열면 **TR 당 초당 5건** 제한에 바로 걸린다
 *   2. **직전대비**(잔량 증감)가 생긴다 — REST 에는 없는 값이고, 지금 붙는 물량인지
 *      빠지는 물량인지는 그걸 봐야 안다
 *
 * FID: 매도호가 41~50 / 수량 61~70 / 직전대비 81~90,
 *      매수호가 51~60 / 수량 71~80 / 직전대비 91~100, 호가시간 21.
 */
function useLiveBook(code: string, base: OrderBook | null) {
  const rt = useRealtime(code ? [`0D:${code}`] : [], 1000);
  const v = rt.values[`0D:${code}`] ?? null;
  if (!base) return { book: base, live: false, delta: null as Record<string, number> | null };
  if (!rt.healthy || !v) return { book: base, live: false, delta: null };

  const asks: OrderBook["asks"] = [];
  const bids: OrderBook["bids"] = [];
  const delta: Record<string, number> = {};
  for (let i = 1; i <= 10; i++) {
    const ap = fid(v, String(40 + i));
    const aq = fid(v, String(60 + i));
    if (ap !== null && aq !== null) {
      asks.push({ step: i, price: Math.abs(ap), qty: aq });
      delta[`ask-${i}`] = fid(v, String(80 + i)) ?? 0;
    }
    const bp = fid(v, String(50 + i));
    const bq = fid(v, String(70 + i));
    if (bp !== null && bq !== null) {
      bids.push({ step: i, price: Math.abs(bp), qty: bq });
      delta[`bid-${i}`] = fid(v, String(90 + i)) ?? 0;
    }
  }
  if (asks.length === 0 || bids.length === 0) return { book: base, live: false, delta: null };

  const totalAsk = asks.reduce((a, b) => a + b.qty, 0);
  const totalBid = bids.reduce((a, b) => a + b.qty, 0);
  return {
    book: {
      ...base,
      asks,
      bids,
      totalAsk,
      totalBid,
      ratio: totalAsk > 0 ? totalBid / totalAsk : base.ratio,
    },
    live: true,
    delta,
  };
}

export function OrderBookPanel({
  code,
  onPickPrice,
}: {
  code: string;
  /**
   * 호가를 누르면 그 값을 받아 갈 사람 (2026-09-04, 벤티지: "호가를 클릭하면 가격은
   * 자동으로 입력되어야 하는 구조로 가야지").
   *
   * **넘겨줄 때만** 줄이 눌리는 줄이 된다 — 종목상세·종목분석에서는 이 컴포넌트가
   * 읽기 전용이라 커서도 안 바뀌고 눌러도 아무 일이 없어야 한다. 주문 화면만 넘긴다.
   */
  onPickPrice?: (price: number) => void;
}) {
  /*
   * 밑그림. 실시간이 붙으면 아래에서 갈아끼우므로 **주기를 늦춰도 된다** —
   * 실시간이 죽었을 때 되돌아갈 자리로만 남겨 둔다.
   */
  const { data: base, loading, error } = useLive<OrderBook>(() => api.orderBook(code), [code], 3000);
  const { book, live, delta } = useLiveBook(code, base ?? null);
  /*
   * 프로그램 순매수 — HTS 호가 화면 오른쪽 아래에 붙어 있는 그 값.
   * `0w` FID 212 가 **백만원 단위 누적**이라 억으로 줄여 적는다.
   * 서버가 물고 있는 종목만 나온다(안 물면 「-」).
   */
  const prog = useRealtime(code ? [`0w:${code}`] : [], 3000);
  const progMil = fid(prog.values[`0w:${code}`] ?? null, "212");
  const program = progMil === null ? null : Math.round(progMil / 100);

  if (loading && !base) return <div className="empty">호가 불러오는 중…</div>;
  if (error && !base) return <div className="error-banner">{error}</div>;
  if (!book) return null;
  if (book.error) return <div className="error-banner">{book.error}</div>;

  const mx = maxQty(book);
  const pos250 =
    book.high250 > book.low250
      ? ((book.price - book.low250) / (book.high250 - book.low250)) * 100
      : null;

  /**
   * 호가 한 줄 — **가격 옆에 등락률.**
   *
   * HTS 가 호가마다 등락률을 적어 두는 이유는, 「이 호가에 걸면 오늘 몇 %인가」가
   * 가격 숫자만으로는 안 읽히기 때문이다. 상한가·하한가에서 몇 호가 떨어졌는지도
   * 이걸로 본다. 기준가(전일 종가) 대비다.
   */
  /*
   * ⚠️ **가격이 0 이면 등락률을 내지 않는다.**
   *
   * 장전 동시호가(08:30~09:00)에는 KRX 가 상위 세 단만 주고 나머지 일곱 단을 0 으로
   * 채워 보낸다. 그걸 그대로 계산하면 **「0원 −100.00%」가 일곱 줄** 늘어선다 —
   * 하한가로 곤두박질친 것처럼 보이는데 실제로는 **호가가 없는 것**이다.
   * 시·고·저도 첫 체결 전에는 0 으로 오므로 같은 문제가 난다.
   *
   * 0 은 「값이 0 이다」가 아니라 **「아직 없다」**다. 그 둘을 같은 0 으로 그리면 안 된다.
   */
  const rate = (price: number): number | null =>
    book.basePrice > 0 && price > 0 ? ((price - book.basePrice) / book.basePrice) * 100 : null;

  const row = (l: { step: number; price: number; qty: number }, side: "ask" | "bid") => {
    const r = rate(l.price);
    // 가격이 없으면 「이 단은 비었다」로 그린다. 현재가와 같다고 착각해 「종」이 붙지도 않게
    const empty = l.price <= 0;
    const now = !empty && book.price === l.price;
    /* 값이 없는 단은 누를 것이 없다 — 0 원이 폼에 들어가면 그게 더 나쁘다 */
    const pick = onPickPrice && !empty ? () => onPickPrice(l.price) : undefined;
    return (
      <div
        className={`ob-row ${side}${now ? " now" : ""}${empty ? " empty" : ""}${pick ? " pickable" : ""}`}
        key={`${side}-${l.step}`}
        {...(pick
          ? {
              role: "button" as const,
              tabIndex: 0,
              title: `${fmtNum(l.price)}원을 주문 가격으로`,
              onClick: pick,
              /* 키보드로도 — 호가창은 값을 고르는 자리지 장식이 아니다 */
              onKeyDown: (e: ReactKeyboardEvent) => {
                if (e.key === "Enter" || e.key === " ") {
                  e.preventDefault();
                  pick();
                }
              },
            }
          : {})}
      >
        {/* 매도는 왼쪽에 막대, 매수는 오른쪽에 — 가운데 가격을 기준으로 갈라진다 */}
        <span className="ob-qty left">
          {side === "ask" && !empty && (
            <>
              <span className="ob-bar ask" style={{ width: `${(l.qty / mx) * 100}%` }} />
              <b>{fmtNum(l.qty)}</b>
              {/* 직전대비 — 붙는 물량인지 빠지는 물량인지는 이걸 봐야 안다 */}
              {delta?.[`ask-${l.step}`] ? (
                <i className={`ob-d ${delta[`ask-${l.step}`] > 0 ? "up" : "down"}`}>
                  {delta[`ask-${l.step}`] > 0 ? "+" : ""}
                  {fmtNum(delta[`ask-${l.step}`])}
                </i>
              ) : null}
            </>
          )}
        </span>
        <span className="ob-price">
          {/* 지금 체결되는 호가에 표시 — HTS 의 그 노란 줄이다 */}
          {now && <i className="ob-here">종</i>}
          {empty ? (
            <b className="pt-n" title="이 단에는 아직 호가가 없습니다 (장전 동시호가에는 세 단만 옵니다)">
              -
            </b>
          ) : (
            <b className={signClass(r)}>{fmtNum(l.price)}</b>
          )}
          {r !== null && (
            <i className={`ob-rt ${signClass(r)}`}>
              {r > 0 ? "+" : ""}
              {r.toFixed(2)}%
            </i>
          )}
        </span>
        <span className="ob-qty right">
          {side === "bid" && !empty && (
            <>
              <span className="ob-bar bid" style={{ width: `${(l.qty / mx) * 100}%` }} />
              <b>{fmtNum(l.qty)}</b>
              {delta?.[`bid-${l.step}`] ? (
                <i className={`ob-d ${delta[`bid-${l.step}`] > 0 ? "up" : "down"}`}>
                  {delta[`bid-${l.step}`] > 0 ? "+" : ""}
                  {fmtNum(delta[`bid-${l.step}`])}
                </i>
              ) : null}
            </>
          )}
        </span>
      </div>
    );
  };

  return (
    <div className="ob">
      <div className="ob-head">
        {/* 지금 값이 어디서 온 것인지 — 실시간이 죽으면 폴링으로 돌아간 것을 알아야 한다 */}
        <span className={`ob-live ${live ? "on" : ""}`} title={live ? "실시간 호가" : "3초 조회"}>
          {live ? "● 실시간" : "○ 조회"}
        </span>
        <b className={`ob-now ${signClass(book.changeRate)}`}>{fmtNum(book.price)}</b>
        <span className={signClass(book.changeRate)}>
          {book.changeRate > 0 ? "+" : ""}
          {book.changeRate.toFixed(2)}%
        </span>
        <span className="pt-n">
          {book.at ? `${book.at.slice(0, 2)}:${book.at.slice(2, 4)}:${book.at.slice(4, 6)}` : ""}
        </span>
        {/* KRX 가 비는 프리·애프터엔 NXT 호가로 폴백된다 — 어느 시장 호가인지 밝힌다 */}
        {(book as { venue?: string }).venue === "NXT" && (
          <em className="ph-ex nxt" title="지금 KRX 호가가 비어 NXT 호가를 보여주고 있습니다">
            NXT 호가
          </em>
        )}
      </div>

      {/*
        체결 흐름 — **표가 아니라 띠.**

        처음엔 시각·가격·수량을 표로 스무 줄 깔았다. 정확하긴 한데 자리를 크게 먹고,
        정작 알고 싶은 「지금 사자가 몰리나 팔자가 몰리나」는 숫자를 하나씩 읽어야 나왔다.

        방향은 **색**, 크기는 **높이**로 두면 한 줄이면 된다 — 빨간 막대가 길게 이어지면
        사자가 붙는 것이고, 파란 막대가 쏟아지면 던지는 것이다.
        수량 차이가 백 배씩 나므로 높이는 **제곱근**으로 눌러 그린다(한 건이 크면
        나머지가 전부 1px 이 되는 걸 막는다). 정확한 값은 짚으면 나온다.
      */}
      {book.ticks.length > 0 && (
        <div className="ob-flow">
          <span
            className={`ob-flow-str ${
              book.strength === null ? "" : book.strength >= 100 ? "positive" : "negative"
            }`}
            title="체결강도 — 100 을 넘으면 매수 체결이 우세"
          >
            {book.strength === null ? "-" : `${book.strength.toFixed(0)}%`}
          </span>
          <span className="ob-flow-bars">
            {/* 왼쪽이 과거 — 시간이 흐르는 방향을 다른 그래프와 맞춘다 */}
            {[...book.ticks].reverse().map((t, i) => {
              const mxq = Math.max(...book.ticks.map((x) => Math.abs(x.qty)), 1);
              const h = Math.sqrt(Math.abs(t.qty) / mxq) * 100;
              return (
                <i
                  key={`${t.t}-${i}`}
                  className={`ob-flow-bar ${t.qty >= 0 ? "buy" : "sell"}`}
                  style={{ height: `${Math.max(8, h)}%` }}
                  title={`${t.t.slice(0, 2)}:${t.t.slice(2, 4)}:${t.t.slice(4, 6)} · ${fmtNum(
                    t.price,
                  )} · ${t.qty > 0 ? "매수" : "매도"} ${fmtNum(Math.abs(t.qty))}주`}
                />
              );
            })}
          </span>
          <span className="ob-flow-last">
            <b className={signClass(rate(book.ticks[0].price))}>{fmtNum(book.ticks[0].price)}</b>
            <i className="pt-n">
              {book.ticks[0].t.slice(0, 2)}:{book.ticks[0].t.slice(2, 4)}
            </i>
          </span>
        </div>
      )}

      <div className="ob-body">
        <div className="ob-book">
          {/*
            ⚠️ **매도호가는 뒤집어 그린다.**

            키움은 매도 1호가(제일 싼 것)부터 10호가 순으로 준다. 그걸 그대로 위에서
            아래로 늘어놓으면 **위가 싸고 아래가 비싸진다** — 호가창이 거꾸로 선다.

            호가창은 **가격이 위로 갈수록 비싸야** 한다. 그래야 매도 1호가와 매수 1호가가
            가운데에서 만나고, 현재가를 중심으로 위아래로 갈라진다. 사람이 호가창을
            읽는 방식이 그것이다 — 「지금 값이 어디에 있고 위아래로 얼마나 두꺼운가」.

            매수는 1호가(제일 비싼 것)부터 오므로 그대로 두면 맞는다.
          */}
          {[...book.asks].reverse().map((l) => row(l, "ask"))}
          <div className="ob-mid" />
          {book.bids.map((l) => row(l, "bid"))}
        </div>

        {/*
         * 오른쪽 요약 — **HTS 호가 화면의 그 자리, 그 순서.**
         *
         * 시·고·저를 먼저 두고 각각에 등락률을 붙인다. 「고가가 143,500 이고 지금 125,400」
         * 보다 「고가에서 +3.16 이었는데 지금 −9.85」가 훨씬 빨리 읽힌다.
         */}
        <div className="ob-side">
          {(
            [
              ["시", book.open],
              ["고", book.krxHigh],
              ["저", book.krxLow],
            ] as [string, number][]
          ).map(([label, v]) => {
            const r = rate(v);
            // 첫 체결 전에는 0 으로 온다 — 「0원 −100.00」이 아니라 「-」다
            return (
              <div className="ob-kv ohl" key={label}>
                <span>{label}</span>
                {v > 0 ? (
                  <b className={signClass(r)}>{fmtNum(v)}</b>
                ) : (
                  <b className="pt-n" title="아직 체결이 없습니다">
                    -
                  </b>
                )}
                <i className={signClass(r)}>
                  {r === null ? "" : `${r > 0 ? "+" : ""}${r.toFixed(2)}`}
                </i>
              </div>
            );
          })}
          <div className="ob-kv" title="전일 종가. 호가 옆 등락률은 이 값 기준입니다">
            <span>기준가</span>
            <b>{fmtNum(book.basePrice)}</b>
          </div>
          <div className="ob-kv" title="오늘 누적 거래대금">
            <span>거래대금</span>
            <b>{book.tradeValue > 0 ? `${fmtNum(Math.round(book.tradeValue / 1e8))}억` : "-"}</b>
          </div>
          <div className="ob-kv" title="거래량 ÷ 상장주식수. 오늘 주식이 몇 바퀴 돌았나">
            <span>회전율</span>
            <b>{book.turnover === null ? "-" : `${book.turnover.toFixed(2)}%`}</b>
          </div>
          <div className="ob-kv" title="실제 체결 기준. 100 초과면 매수 체결이 우세하다">
            <span>체결강도</span>
            <b className={book.strength === null ? "" : book.strength >= 100 ? "positive" : "negative"}>
              {book.strength === null ? "-" : `${book.strength.toFixed(2)}%`}
            </b>
          </div>
          <div className="ob-kv" title="오늘 프로그램 순매수(실시간). 서버가 물고 있는 종목만 나옵니다">
            <span>프로그램</span>
            <b className={program === null ? "" : program >= 0 ? "positive" : "negative"}>
              {program === null ? "-" : `${program > 0 ? "+" : ""}${fmtNum(program)}`}
            </b>
          </div>
          <div className="ob-kv" title="250일 최저~최고 구간에서 지금 위치">
            <span>250일 자리</span>
            <b>{pos250 === null ? "-" : `${pos250.toFixed(0)}%`}</b>
          </div>
          <div className="ob-kv">
            <span>상/하한</span>
            <b className="pt-n">
              {fmtNum(book.upperLimit)} / {fmtNum(book.lowerLimit)}
            </b>
          </div>
          <div className="ob-kv">
            <span>NXT 고/저</span>
            <b className="pt-n">
              {book.nxtHigh ? fmtNum(book.nxtHigh) : "-"} /{" "}
              {book.nxtLow ? fmtNum(book.nxtLow) : "-"}
            </b>
          </div>
        </div>
      </div>

      {/* 총잔량 — HTS 는 호가창 맨 아래에 이 줄을 둔다 */}
      <div className="ob-total">
        <b className="negative">{fmtNum(book.totalAsk)}</b>
        <span>총잔량</span>
        <b className="positive">{fmtNum(book.totalBid)}</b>
      </div>


      {/* 왼쪽 아래 — 지금 어느 쪽이 두터운가 */}
      <div className="ob-foot">
        <div className="ob-kv" title="매수잔량 ÷ 매도잔량. 대기 물량이다 — 체결강도와 다르다">
          <span>잔량비</span>
          <b className={book.ratio === null ? "" : book.ratio >= 1 ? "positive" : "negative"}>
            {book.ratio === null ? "-" : book.ratio.toFixed(2)}
          </b>
        </div>
        <div className="ob-kv">
          <span>거래량</span>
          <b>{fmtNum(book.volume)}</b>
        </div>
        <div className="ob-kv">
          <span>250일 고/저</span>
          <b className="pt-n">
            {fmtNum(book.high250)} / {fmtNum(book.low250)}
          </b>
        </div>
        {(book.overtimeAsk > 0 || book.overtimeBid > 0) && (
          <div className="ob-kv">
            <span>시간외 매도/매수</span>
            <b className="pt-n">
              {fmtNum(book.overtimeAsk)} / {fmtNum(book.overtimeBid)}
            </b>
          </div>
        )}
      </div>

      <div className="table-note">
        <b>체결강도</b>는 실제로 체결된 것의 비율이고, <b>잔량비</b>는 아직 <b>대기 중인
        물량</b>의 비율입니다 — 다른 값입니다. 잔량은 두꺼운 쪽이 반드시 이기지 않습니다
        (허수 주문이 섞입니다).
        <b> 회전율</b>은 오늘 상장주식의 몇 %가 손바뀜했나입니다.
      </div>
    </div>
  );
}
