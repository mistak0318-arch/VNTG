import { api, fmtNum, signClass, type OrderBook } from "../api";
import { useLive } from "../useLive";

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

export function OrderBookPanel({ code }: { code: string }) {
  /*
   * 1초 갱신. 키움 제한은 **TR 하나당 초당 5건**이고 이 창은 한 번에 하나만 열린다 —
   * 한도의 20% 다. (`useLive` 가 장중·NXT 시간에만 돌린다)
   */
  const { data: book, loading, error } = useLive<OrderBook>(() => api.orderBook(code), [code], 1000);

  if (loading && !book) return <div className="empty">호가 불러오는 중…</div>;
  if (error && !book) return <div className="error-banner">{error}</div>;
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
          </>
        )}
      </span>
      <span className={`ob-price ${book.price === l.price ? "now" : ""}`}>{fmtNum(l.price)}</span>
      <span className="ob-qty right">
        {side === "bid" && (
          <>
            <span className="ob-bar bid" style={{ width: `${(l.qty / mx) * 100}%` }} />
            <b>{fmtNum(l.qty)}</b>
          </>
        )}
      </span>
    </div>
  );

  return (
    <div className="ob">
      <div className="ob-head">
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
