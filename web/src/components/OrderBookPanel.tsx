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
 * ## 「체결강도」가 아니라 「잔량비」다
 *
 * 체결강도는 `ka10004`·`ka10001` 어디에도 없다. 순위 TR 에는 있지만 종목 단건으로
 * 부르는 길을 확인 못 했다. **없는 값을 있는 척 부르지 않는다.**
 * 잔량비(매수잔량÷매도잔량)는 다른 값이지만 같은 물음에 답한다 — 이름 그대로 적는다.
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
        <div className="ob-kv" title="매수잔량 ÷ 매도잔량. 1보다 크면 사려는 쪽이 두텁다">
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
        <b>잔량비는 체결강도가 아닙니다.</b> 체결된 것이 아니라 <b>대기 중인 물량</b>의
        비율입니다 — 두꺼운 쪽이 반드시 이기는 것도 아닙니다(허수 주문이 섞입니다).
        <b> 회전율</b>은 오늘 상장주식의 몇 %가 손바뀜했나입니다.
      </div>
    </div>
  );
}
