import { useEffect, useRef, type KeyboardEvent as ReactKeyboardEvent } from "react";
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

/** 호가를 못 받았을 때의 빈 판 — 열 단 틀과 이유 한 줄 */
function EmptyBook({ why }: { why: string }) {
  const blank = padBottom([]);
  return (
    <div className="ob ob-blank">
      <div className="ob-body">
        <div className="ob-book">
          {blank.map((l) => (
            <div className="ob-row ask empty" key={`a-${l.step}`}>
              <span className="ob-qty left" />
              <span className="ob-price">
                <b className="pt-n">-</b>
              </span>
              <span className="ob-qty right" />
            </div>
          ))}
          <div className="ob-mid" />
          {blank.map((l) => (
            <div className="ob-row bid empty" key={`b-${l.step}`}>
              <span className="ob-qty left" />
              <span className="ob-price">
                <b className="pt-n">-</b>
              </span>
              <span className="ob-qty right" />
            </div>
          ))}
          {/* 좁은 칸(폰의 주문 화면)에 들어가므로 짧게. 자세한 사연은 title 로 */}
          <div className="ob-closed" title={why}>
            호가 없음
            <i>장 밖이라 안 옵니다. 가격은 직접</i>
          </div>
        </div>
      </div>
    </div>
  );
}

/**
 * 열 단을 **항상** 채운다 (2026-09-04).
 *
 * 벤티지: "nxt·krx 시간 아니더라도 종목 검색하면 호가 나오게 해 줘."
 * 장이 닫히면 키움이 호가를 빈 배열로 준다. 그대로 그리면 호가창 자리가 통째로 사라져서
 * 「고장 났나」로 보인다. 값이 없는 단은 이미 「-」로 그릴 줄 아므로(`empty`) 빈 단을 채운다.
 *
 * **어느 쪽에 채우느냐가 중요하다.** 호가창은 가운데(현재가 근처)가 실한 값이어야 한다 —
 * 매도는 **위쪽**에, 매수는 **아래쪽**에 빈 단을 붙여야 진짜 호가가 가운데 선에 붙어 남는다.
 */
function padTop(levels: { step: number; price: number; qty: number }[]): { step: number; price: number; qty: number }[] {
  const out = [...levels];
  for (let i = out.length; i < 10; i += 1) out.unshift({ step: 100 + i, price: 0, qty: 0 });
  return out;
}

function padBottom(levels: { step: number; price: number; qty: number }[]): { step: number; price: number; qty: number }[] {
  const out = [...levels];
  for (let i = out.length; i < 10; i += 1) out.push({ step: 100 + i, price: 0, qty: 0 });
  return out;
}

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

  /*
   * ⚠️ **서버가 주는 것과 같은 차례로 맞춘다** (2026-09-04 고침).
   *
   * 벤티지: "주문 메뉴 호가창이 이상한데 종목 상세는 안 그래."
   * 둘은 **같은 컴포넌트**다. 다른 건 그때 실시간이 붙어 있었느냐였다 —
   * 실시간에서 만든 매도호가는 `41→50`(1호가=제일 싼 것)이라 **오름차순**인데,
   * 서버(REST)는 이미 **내림차순**으로 정렬해 준다(`orderBook.ts`). 화면은 하나의 차례만
   * 알고 그리므로, 실시간이 붙은 쪽만 위아래가 뒤집혀 보였다.
   *
   * 그리는 쪽을 고치면 반대쪽이 깨진다. **들어오는 값을 한 모양으로 맞추는 것**이 맞다 —
   * 매도는 비싼 것이 위, 매수는 비싼 것이 위.
   */
  asks.sort((x, y) => y.step - x.step);
  bids.sort((x, y) => x.step - y.step);
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
  onQuote,
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
  /**
   * 지금 값을 위로 올려 준다 (2026-09-04) — 벤티지: "매수·매도 버튼 위 종목명, 거기에
   * 현재가 등락률 좀 표시해 줘."
   *
   * 호가창이 이미 3초마다(+실시간) 받고 있는 값이라 **부르는 쪽이 따로 조회할 이유가 없다.**
   * 시세를 두 곳에서 받으면 두 값이 갈리고, 그때 어느 쪽이 맞는지 사람이 판정해야 한다.
   */
  onQuote?: (q: {
    price: number;
    changeRate: number | null;
    /** 당일 고·저 — **KRX 와 NXT 를 갈라서** 준다. 두 시장은 고저가 다르다 */
    krxHigh: number;
    krxLow: number;
    nxtHigh: number | null;
    nxtLow: number | null;
  }) => void;
}) {
  /*
   * 밑그림. 실시간이 붙으면 아래에서 갈아끼우므로 **주기를 늦춰도 된다** —
   * 실시간이 죽었을 때 되돌아갈 자리로만 남겨 둔다.
   */
  const { data: base, loading, error } = useLive<OrderBook>(() => api.orderBook(code), [code], 3000);
  const { book, live, delta } = useLiveBook(code, base ?? null);
  /* 값이 **바뀔 때만** 올린다 — 매 렌더마다 부르면 부모가 계속 다시 그린다 */
  const price = book?.price ?? 0;
  const nowRate = book && book.basePrice > 0 && book.price > 0 ? ((book.price - book.basePrice) / book.basePrice) * 100 : null;
  const quoteRef = useRef<string>("");
  useEffect(() => {
    if (!onQuote || price <= 0) return;
    const hi = book?.krxHigh ?? 0;
    const lo = book?.krxLow ?? 0;
    const nhi = book?.nxtHigh ?? null;
    const nlo = book?.nxtLow ?? null;
    const key = `${price}|${nowRate ?? ""}|${hi}|${lo}|${nhi}|${nlo}`;
    if (key === quoteRef.current) return;
    quoteRef.current = key;
    onQuote({ price, changeRate: nowRate, krxHigh: hi, krxLow: lo, nxtHigh: nhi, nxtLow: nlo });
  }, [price, nowRate, book?.krxHigh, book?.krxLow, book?.nxtHigh, book?.nxtLow, onQuote]);
  /*
   * 프로그램 순매수 — HTS 호가 화면 오른쪽 아래에 붙어 있는 그 값.
   * `0w` FID 212 가 **백만원 단위 누적**이라 억으로 줄여 적는다.
   * 서버가 물고 있는 종목만 나온다(안 물면 「-」).
   */
  const prog = useRealtime(code ? [`0w:${code}`] : [], 3000);
  const progMil = fid(prog.values[`0w:${code}`] ?? null, "212");
  const program = progMil === null ? null : Math.round(progMil / 100);

  if (loading && !base) return <div className="empty">호가 불러오는 중…</div>;
  /*
   * **호가를 못 받아도 틀은 세운다** (2026-09-04).
   *
   * 벤티지: "시간 아니더라도 종목 검색하면 호가 나오게 해 줘."
   * 장 밖에서는 키움이 빈 배열이 아니라 **에러**를 준다(「서비스를 처리하는 중에 오류가
   * 발생했습니다[1631]」). 그때 빨간 띠만 남기면 호가창 자리가 통째로 사라져서 고장으로
   * 보인다 — 키움 앱도 장 밖에서는 빈 호가판을 보여 준다.
   *
   * 그래서 열 단짜리 빈 틀과 **왜 비었는지 한 줄**을 그린다. 값이 없다는 사실은 「-」로
   * 이미 드러나므로 없는 값을 지어내는 것이 아니다.
   */
  if ((error && !base) || (book && book.error)) {
    const why = (book?.error || error) ?? "";
    return <EmptyBook why={why} />;
  }
  if (!book) return null;

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
          {/*
            지금 값이 있는 줄 — HTS 의 그 노란 줄이다.

            글자가 「종」이었다. 뜻은 「지금 체결되는」이었는데 **종가로 읽힌다** —
            벤티지: "종가에 노란색 포커싱이 들어가 있어, 저 포커싱은 현재가에 들어가야 되는 거잖아."
            장 밖에는 현재가와 전일 종가가 같은 값이라 더 헷갈렸다. 「현」으로 바꾼다.
          */}
          {now && (
            <i className="ob-here" title="현재가 — 지금 값이 이 호가에 있습니다">
              현
            </i>
          )}
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
        체결강도 — **저울과 눈금으로** (2026-09-04 다시 그림).

        벤티지: "체결강도 적어놓고 막대그래프로 표현해 놨는데 이게 이해가 잘 안 되거든?
        알기 쉽게 좀 표현해 줄래? 너무 키워서 호가창 가리지는 말고. 차라리 호가창 밑에 표현해도 되고."

        옛 그림은 최근 스무 건을 **낱개 막대**로 세웠다. 방향은 색, 크기는 높이였는데 —
        낱개는 「지금 어느 쪽이 이기고 있나」를 **사람이 눈으로 합산**해야 답이 나온다.
        그게 어려웠던 것이다. 합은 기계가 해야 한다.

        그래서 둘로 바꿨다. 자리는 오히려 줄었고 **머리줄 바로 아래** — 호가창 위에 둔다
        (2026-09-04 벤티지: "한눈에 보기 좋다. 호가창 위에 배치하는 게 좋겠어").
        값을 먼저 읽고 호가를 보는 순서라 위가 맞다:
          ① 눈금  체결강도 한 값을 50~150 자 위에 점으로. 100 이 가운데 선이다
          ② 저울  최근 체결 스무 건의 **매수량 : 매도량**을 한 줄로 갈라 칠한다
        ①은 하루 전체의 누적이고 ②는 방금이다 — 둘이 어긋나면 그게 바뀌는 순간이다.
      */}
      {(book.strength !== null || book.ticks.length > 0) && (
        <div className="ob-str">
          {book.strength !== null && (
            <div className="ob-str-row">
              <span className="ob-str-label">체결강도</span>
              <span className={`ob-str-val ${book.strength >= 100 ? "positive" : "negative"}`}>
                {book.strength.toFixed(0)}%
              </span>
              {/* 눈금 — 100 이 가운데. 값이 오른쪽이면 사자, 왼쪽이면 팔자가 셌다 */}
              <span className="ob-str-gauge" title="체결강도 — 100 을 넘으면 사자가 우세. 오늘 누적입니다">
                <i className="ob-str-mid" />
                <i
                  className={`ob-str-pin ${book.strength >= 100 ? "buy" : "sell"}`}
                  style={{ left: `${Math.min(100, Math.max(0, ((book.strength - 50) / 100) * 100))}%` }}
                />
              </span>
              <span className="ob-str-say">
                {book.strength >= 120
                  ? "사자가 세다"
                  : book.strength >= 100
                    ? "사자가 조금 우세"
                    : book.strength >= 80
                      ? "팔자가 조금 우세"
                      : "팔자가 세다"}
              </span>
            </div>
          )}

          {book.ticks.length > 0 &&
            (() => {
              /* 방금 스무 건의 무게를 잰다 — 부호가 방향, 절대값이 양이다 */
              const buy = book.ticks.reduce((a, t) => a + (t.qty > 0 ? t.qty : 0), 0);
              const sell = book.ticks.reduce((a, t) => a + (t.qty < 0 ? -t.qty : 0), 0);
              const sum = buy + sell;
              const bp = sum > 0 ? (buy / sum) * 100 : 50;
              return (
                <div className="ob-str-row">
                  <span className="ob-str-label" title="지금 화면에 든 최근 체결 스무 건의 수량 비율입니다">
                    최근 {book.ticks.length}건
                  </span>
                  <span className="ob-str-scale">
                    <i className="buy" style={{ width: `${bp}%` }} />
                    <i className="sell" style={{ width: `${100 - bp}%` }} />
                  </span>
                  <span className="ob-str-say">
                    사자 <b className="positive">{bp.toFixed(0)}%</b> · 팔자{" "}
                    <b className="negative">{(100 - bp).toFixed(0)}%</b>
                  </span>
                </div>
              );
            })()}
        </div>
      )}

      <div className="ob-body">
        <div className="ob-book">
          {/*
            ⚠️ **여기서 뒤집지 않는다** (2026-09-04 고침 — 벤티지: "호가창 배열이 이상해,
            밑에서 위로 갈 때 높아지는 구조로 가야 되는데 반대로 되어 있어").

            예전 주석은 「키움이 매도 1호가(제일 싼 것)부터 준다」였는데, **우리 서버가 이미
            높은 값부터 내려오게 정렬해서 준다**(`orderBook.ts` 의 `y.step - x.step`).
            그걸 화면에서 또 뒤집으니 위가 싸고 아래가 비싼 거꾸로 선 호가창이 됐다.
            실측: 서버가 asks 를 120,800 → 120,500 차례로, bids 를 119,700 → 119,400 차례로 준다.
            둘 다 **위에서 아래로 그대로** 그리면 가격이 위로 갈수록 비싸진다.
          */}
          {padTop(book.asks).map((l) => row(l, "ask"))}
          <div className="ob-mid" />
          {padBottom(book.bids).map((l) => row(l, "bid"))}
          {/*
            한 단도 없으면 **왜 비었는지** 적는다 — 빈 틀만 있으면 고장 난 것으로 보인다.
            값이 한 줄이라도 있으면 안 뜬다(장중에 한쪽만 비는 경우가 있다).
          */}
          {book.asks.length === 0 && book.bids.length === 0 && (
            <div className="ob-closed">
              호가 없음
              <i>장 밖이라 안 옵니다. 가격은 직접</i>
            </div>
          )}
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
