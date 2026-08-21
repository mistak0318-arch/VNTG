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

export function OrderBookPanel({ code }: { code: string }) {
  /*
   * 밑그림. 실시간이 붙으면 아래에서 갈아끼우므로 **주기를 늦춰도 된다** —
   * 실시간이 죽었을 때 되돌아갈 자리로만 남겨 둔다.
   */
  const { data: base, loading, error } = useLive<OrderBook>(() => api.orderBook(code), [code], 3000);
  const { book, live, delta } = useLiveBook(code, base ?? null);

  if (loading && !base) return <div className="empty">호가 불러오는 중…</div>;
  if (error && !base) return <div className="error-banner">{error}</div>;
  if (!book) return null;
  if (book.error) return <div className="error-banner">{book.error}</div>;

  const mx = maxQty(book);
  const pos250 =
    book.high250 > book.low250
      ? ((book.price - book.low250) / (book.high250 - book.low250)) * 100
      : null;

  const row = (l: { step: number; price: number; qty: number }, side: "ask" | "bid") => (
    <div className={`ob-row ${side}`} key={`${side}-${l.step}`}>
      {/* 매도는 왼쪽에 막대, 매수는 오른쪽에 — 가운데 가격을 기준으로 갈라진다 */}
      <span className="ob-qty left">
        {side === "ask" && (
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
      <span className={`ob-price ${book.price === l.price ? "now" : ""}`}>{fmtNum(l.price)}</span>
      <span className="ob-qty right">
        {side === "bid" && (
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
      </div>

      <div className="ob-body">
        <div className="ob-book">
          {book.asks.map((l) => row(l, "ask"))}
          <div className="ob-mid" />
          {book.bids.map((l) => row(l, "bid"))}
        </div>

        {/* 오른쪽 위 — 오늘 어디까지 갔나, 지금이 어디쯤인가 */}
        <div className="ob-side">
          <div className="ob-kv">
            <span>KRX 고/저</span>
            <b>
              {fmtNum(book.krxHigh)} / {fmtNum(book.krxLow)}
            </b>
          </div>
          <div className="ob-kv">
            <span>NXT 고/저</span>
            <b>
              {book.nxtHigh ? fmtNum(book.nxtHigh) : "-"} /{" "}
              {book.nxtLow ? fmtNum(book.nxtLow) : "-"}
            </b>
          </div>
          <div className="ob-kv">
            <span>시가</span>
            <b>{fmtNum(book.open)}</b>
          </div>
          <div className="ob-kv" title="250일 최저~최고 구간에서 지금 위치">
            <span>250일 자리</span>
            <b>{pos250 === null ? "-" : `${pos250.toFixed(0)}%`}</b>
          </div>
          <div className="ob-kv">
            <span>250일 고/저</span>
            <b className="pt-n">
              {fmtNum(book.high250)} / {fmtNum(book.low250)}
            </b>
          </div>
          <div className="ob-kv">
            <span>상/하한</span>
            <b className="pt-n">
              {fmtNum(book.upperLimit)} / {fmtNum(book.lowerLimit)}
            </b>
          </div>
        </div>
      </div>

      {/* 왼쪽 아래 — 지금 어느 쪽이 두터운가 */}
      <div className="ob-foot">
        <div className="ob-kv" title="실제 체결 기준. 100 초과면 매수 체결이 우세하다">
          <span>체결강도</span>
          <b className={book.strength === null ? "" : book.strength >= 100 ? "positive" : "negative"}>
            {book.strength === null ? "-" : book.strength.toFixed(1)}
          </b>
        </div>
        <div className="ob-kv" title="매수잔량 ÷ 매도잔량. 대기 물량이다 — 체결강도와 다르다">
          <span>잔량비</span>
          <b className={book.ratio === null ? "" : book.ratio >= 1 ? "positive" : "negative"}>
            {book.ratio === null ? "-" : book.ratio.toFixed(2)}
          </b>
        </div>
        <div className="ob-kv" title="거래량 ÷ 상장주식수. 오늘 주식이 몇 바퀴 돌았나">
          <span>회전율</span>
          <b>{book.turnover === null ? "-" : `${book.turnover.toFixed(2)}%`}</b>
        </div>
        <div className="ob-kv">
          <span>거래량</span>
          <b>{fmtNum(book.volume)}</b>
        </div>
        <div className="ob-kv">
          <span>총잔량 매도/매수</span>
          <b className="pt-n">
            {fmtNum(book.totalAsk)} / {fmtNum(book.totalBid)}
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
