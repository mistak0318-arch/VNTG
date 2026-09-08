import type { UsQuoteRow } from "../api";
import { sideQuote, usFeActive, usSideSession } from "../usSession";
import { flagOfSymbol } from "../yahooFlag";
import { useDragOrder } from "../useDragOrder";
import { fid, useRealtime } from "../useRealtime";
import { SortableTh, useSortableTable } from "../useSortableTable";
import { useCardOrder } from "../useCardOrder";
import { ColumnGrip, useColumnWidths } from "./ColumnWidths";

/**
 * 해외 관심종목 표 — **관심종목(해외) 메뉴와 시황 전광판이 같은 것을 쓴다.**
 *
 * ## 왜 하나로 합쳤나
 *
 * 두 화면이 각자 그리고 있었다. 그러다 한쪽만 고쳐서 **같은 종목에 다른 값**이 떴다 —
 * 엔비디아가 관심종목에서 −0.07%, 시황에서 −0.98% 였다. 둘 다 맞는 계산이지만 기준이
 * 달랐다(하나는 시간외 변동, 하나는 전일 대비). 어느 쪽이 진짜인지 화면만 봐서는
 * 알 수가 없다. **같은 값을 두 번 그리면 언젠가 반드시 갈라진다.**
 *
 * 시황 쪽은 옆으로 늘어놓은 카드였는데, 그것도 여기로 합치면서 표가 됐다 —
 * 열이 줄을 맞춰 서야 종목끼리 견줄 수 있다.
 *
 * ## 값의 기준
 *
 *   현재가 · 등락률   **정규장** (등락률은 전일 종가 대비)
 *   괄호             지금 도는 시간외 — 프리장 / 애프터장 / 주간거래
 *
 * 둘의 기준을 맞추는 게 핵심이다. 가격은 정규장인데 등락률만 시간외로 적으면
 * 214.72 옆에 −0.07% 가 붙는다. 그 −0.07% 는 214.58 의 것이라 아무 데도 안 맞는다.
 */

function pct(v: number | null): string {
  if (v === null || !Number.isFinite(v)) return "-";
  return `${v > 0 ? "+" : ""}${v.toFixed(2)}%`;
}

function cls(v: number | null): string {
  if (v === null || !Number.isFinite(v)) return "";
  return v > 0 ? "positive" : v < 0 ? "negative" : "";
}

/** 엔·원처럼 소수점을 안 쓰는 통화는 반올림해서 */
function price(v: number | null, currency?: string | null): string {
  if (v === null) return "-";
  return currency === "JPY" || currency === "VND" || currency === "KRW"
    ? Math.round(v).toLocaleString("ko-KR")
    : v.toFixed(2);
}

/**
 * 괄호에 든 세션 이름 — **값이 실제로 붙은 종목에서** 가져온다.
 * 시각으로만 재면 값이 하나도 없는 날에도 이름이 뜬다.
 */
export function sideNameOf(stocks: UsQuoteRow[]): string {
  return stocks.map((s) => sideQuote(s)).find((q) => q)?.label ?? "시간외";
}

/**
 * 옮길 수 있는 열들 — 종목 칸은 sticky 첫 칸이라 못 옮기고, 편집 칸은 늘 끝이다.
 * 정렬 접근자는 **행에 실린 본 시세**만 본다. 3초 빠른 시세까지 기준으로 삼으면
 * 훅이 처음 등록한 접근자에 옛 값이 갇히고, 본 시세도 30초~1분마다 갱신되니 충분하다.
 */
type UsColKey = "price" | "rate" | "won" | "w52" | "vol" | "power" | "added" | "ret";
const US_COLS: { key: UsColKey; title?: string; accessor: (r: UsQuoteRow) => number }[] = [
  { key: "price", accessor: (r) => r.price ?? -999 },
  { key: "rate", accessor: (r) => r.changeRate ?? -999 },
  {
    key: "won",
    title: "원화 환산가 — 한국투자증권이 계산해 준다",
    accessor: (r) => r.wonPrice ?? -999,
  },
  {
    key: "w52",
    title: "52주 구간에서 지금 위치 (0=저가, 100=고가)",
    accessor: (r) => r.pos52 ?? -999,
  },
  { key: "vol", title: "오늘 거래량 ÷ 전일 거래량", accessor: (r) => r.volumeVsPrev ?? -999 },
  {
    key: "power",
    title: "체결강도 — 100보다 크면 사는 쪽이 세다",
    accessor: (r) => r.power ?? -999,
  },
  { key: "added", accessor: (r) => r.addedPrice ?? -999 },
  { key: "ret", accessor: (r) => r.returnRate ?? -999 },
];

export interface UsWatchTableProps {
  stocks: UsQuoteRow[];
  /** 빠른 시세(야후 spark, 3초) — 있으면 현재가·등락률을 덧씌운다 */
  fast?: Record<string, { price: number; changeRate: number | null; at: number }>;
  /** 종목을 누르면 — 상세 열기 */
  onOpen: (symbol: string, name: string) => void;
  /** 편집 중이면 순서·삭제 칸이 붙는다 */
  editing?: boolean;
  /** 순서 바꾸기. 없으면 버튼을 안 그린다 (정렬을 걸었을 때는 뜻이 없다) */
  onMove?: (symbol: string, dir: -1 | 1) => void;
  /** 끌어서 옮긴 새 순서 전체 — onMove 와 같은 조건(내 순서 + 편집)에서만 준다 */
  onReorder?: (nextSymbols: string[]) => void;
  onRemove?: (symbol: string) => void;
  /** 값이 바뀐 종목에 붙일 반짝임 클래스 */
  tick?: (symbol: string) => string;
}

export function UsWatchTable({
  stocks,
  fast,
  onOpen,
  editing = false,
  onMove,
  onReorder,
  onRemove,
  tick,
}: UsWatchTableProps) {
  const sideName = sideNameOf(stocks);
  /* 칸 너비 조절 — 시세분석과 같은 공통 모듈. 머리 칸 오른쪽 가장자리를 끈다 */
  const cw = useColumnWidths("usWatch");
  /*
   * 머리 클릭 정렬 (2026-08-26) — 국내 표들과 같은 3단계(내림→오름→원래).
   * 정렬 값은 **행에 실린 본 시세**다. 3초 빠른 시세까지 기준으로 삼으면 훅이
   * 처음 등록한 접근자에 옛 값이 갇히고, 본 시세도 30초~1분마다 갱신되니 충분하다.
   */
  const sort = useSortableTable(stocks);
  const rows = sort.sorted;
  const sorting = sort.sortKey !== null && sort.sortDir !== null;
  /*
   * 열 순서 — 시세분석과 같은 훅(서버 저장, 기기 공유). 머리를 끌면 언제든 옮고,
   * 편집 모드에서는 ◀▶ 화살표도 붙는다(폰은 끌기가 스크롤과 싸운다).
   */
  const colOrder = useCardOrder(
    "usWatch.cols",
    US_COLS.map((c) => c.key),
  );
  const orderedCols = [...US_COLS].sort(
    (a, b) => colOrder.orderOf(a.key) - colOrder.orderOf(b.key),
  );
  /* 끌어서 옮기기 — 편집 + 내 순서 + **정렬 안 걸었을 때만.**
     정렬로 줄 세운 화면에서 옮기면 보이는 자리와 저장되는 자리가 어긋난다 */
  const drag = useDragOrder(stocks.map((s) => s.symbol), (next) => onReorder?.(next));
  const canDrag = editing && Boolean(onReorder) && !sorting;

  /*
   * 키움 실시간(FE) — **밤(미국장)에만 묻는다.**
   *
   * 서버가 관심(해외)을 밤에 FE 로 걸어 두므로(realtimeHub 국면 배분) 화면은 최신값만
   * 집어 오면 된다. 미국 마감 시간에 물으면 답 없는 구독이 화면 몫(10자리)을 채워
   * 국내 화면 실시간을 밀어내니 그때는 아예 안 묻는다.
   *
   * 값은 국내 0B 와 같은 문법이다 — FID 10 현재가(부호=방향), 12 등락률.
   * ⚠️ 프레임 실측 전(등록만 통과)이라, 안 오면 표는 그냥 한투 폴링 값 그대로다 —
   * 실시간은 얹는 것이지 대체하는 게 아니다.
   */
  const feOn = usFeActive();
  /*
   * **읽기 전용으로 받는다** (2026-09-08 — 해외 실시간을 한투 웹소켓으로 받으면서).
   *
   * 두 가지가 같이 좋아진다:
   *   · 읽기 전용은 **SSE** 로 온다 — 값의 나이가 폴링 2.5초에서 0.2초로 준다.
   *     한투 소켓은 종목당 초당 네 틱쯤 보내는데, 2.5초로 물으면 그 대부분을 버리는 셈이다.
   *   · 키움 쪽에 **임시구독을 안 건다.** 여기 열쇠는 `FE:` 인데 키움 FE 는 프레임을 안
   *     준다(같은 날 실측) — 그동안 값도 없는 구독이 키움 정원(200)을 갉아먹고 있었다.
   *     해외 값은 이제 한투 소켓이 저장소에 넣어 주므로 키움에 걸 이유가 없다.
   */
  const rt = useRealtime(
    feOn ? stocks.map((s) => `FE:${s.symbol.toUpperCase()}`) : [],
    2500,
    { readOnly: true },
  );
  /*
   * ⚠️ **묵은 실시간 값이 신선한 3초 값을 막으면 안 된다** (2026-09-08 — 벤티지 "그래도
   * 갱신이 느리다" / "차라리 키움으로 해놨었을 때가 더 빠른 듯").
   *
   * 예전 창은 **90초**였다. 실시간이 최상위라 그 안이면 무조건 이겼는데, 소켓이 잠깐이라도
   * 끊기거나 그 종목 체결이 뜸하면 **60초 된 값이 3초짜리 spark 을 밀어냈다.** 실시간을
   * 붙이고 오히려 느려지는 길이 여기였다.
   *
   * 15초로 좁힌다 — 초당 몇 틱씩 오는 창구라 15초를 넘겼으면 그건 이미 실시간이 아니다.
   * 그 뒤로는 spark(3초)가 받는다.
   *
   * ## ⚠️ 다만 **프리·애프터장은 예외** (2026-09-09 — 벤티지 "해외주식 왜 일부만 실시간
   * 연결이 되지?", 애프터장 06:50 KST 화면에서 절반만 초록 점)
   *
   * 그 시간대에는 거래가 뜸해서 **15초 안에 체결이 없는 종목이 수두룩하다.** 애프터에
   * AMAT·TSM 이 조용한 것은 고장이 아니라 원래 그렇다. 그런데 창을 좁게 잡으면 그런 종목이
   * 「실시간 아님」으로 꺼져 버린다.
   *
   * 좁게 잡은 이유는 **묵은 값이 3초 spark 을 막는 것**이었는데, 프리·애프터에는 그 spark 이
   * 애초에 값을 안 준다(야후가 그 시간대 봉을 안 준다 — 실측). 막을 것이 없으니 좁힐 이유도
   * 없다. 그 시간대만 2분으로 연다.
   */
  const LIVE_FRESH_MS = usSideSession() ? 120_000 : 15_000;
  /** 지금이 실시간이 흐를 수 있는 시간대인가 — 점이 꺼진 이유를 가르는 데 쓴다 */
  const rtOn = feOn;
  const live = (symbol: string): { price: number; rate: number | null; at: number } | null => {
    const v = rt.values[`FE:${symbol.toUpperCase()}`];
    if (!v || Date.now() - v.at > LIVE_FRESH_MS) return null;
    const price = fid(v, "10");
    if (price === null || price === 0) return null;
    return { price: Math.abs(price), rate: fid(v, "12"), at: v.at };
  };

  /*
   * 값의 우선순위: FE 실시간(안 오는 게 실측이지만 오면 최상) → **spark 3초** → 본 시세.
   * spark 값이 5분 넘게 낡았으면 버린다 — 장이 닫힌 뒤엔 본 시세(정규장 종가)가 기준이다.
   */
  const fastOf = (symbol: string): { price: number; rate: number | null } | null => {
    const q = fast?.[symbol.toUpperCase()];
    if (!q || Date.now() - q.at > 5 * 60_000) return null;
    return { price: q.price, rate: q.changeRate };
  };

  /* 머리 라벨·설명 — 세션 이름(프리장/애프터장/주간거래)이 시각 따라 바뀌어 여기서 만든다 */
  const headLabel: Record<UsColKey, React.ReactNode> = {
    price: (
      <>
        현재가 <span className="uw-day-h">({sideName})</span>
      </>
    ),
    rate: (
      <>
        등락률 <span className="uw-day-h">({sideName})</span>
      </>
    ),
    won: "원화",
    w52: "52주",
    vol: "거래량",
    power: "강도",
    added: "편입가",
    ret: "편입 대비",
  };
  const headTitle: Partial<Record<UsColKey, string>> = {
    price: `괄호는 ${sideName} — 정규장 밖에서 도는 세션입니다`,
    rate: `전일 종가 대비 등락률입니다. 괄호는 ${sideName} 변동(정규장 종가 대비)`,
  };

  return (
    <div className="data-table-wrap">
      <table className={`data-table uw-table${cw.customized ? " col-fixed" : ""}`}>
        <colgroup>
          <col style={cw.styleOf("name")} />
          {orderedCols.map((c) => (
            <col key={c.key} style={cw.styleOf(c.key)} />
          ))}
          {editing && <col />}
        </colgroup>
        <thead>
          <tr>
            <SortableTh
              columnKey="name"
              label="종목"
              accessor={(r: UsQuoteRow) => r.symbol}
              sort={sort}
              className="sticky-col"
              extra={<ColumnGrip cw={cw} k="name" />}
            />
            {/*
              시간외를 **괄호로 바로 옆에** 붙인다. 뒤쪽에 열로 두니 폰에서 잘려 안 보였다 —
              이 값은 정규장과 **견줘야** 뜻이 생기므로 떨어뜨려 놓으면 쓸모가 없다.

              ⚠️ 머리에 「(주간)」이 박혀 있었다. 시간외는 시각에 따라 프리장·애프터장·
              주간거래 셋 중 하나인데 늘 주간이라 적으니, 저녁 아홉 시 프리장 값이
              한국 낮 세션인 줄로 읽혔다. 지금 도는 세션 이름을 그대로 쓴다.
            */}
            {orderedCols.map((c) => (
              <SortableTh
                key={c.key}
                columnKey={c.key}
                label={headLabel[c.key]}
                accessor={c.accessor}
                sort={sort}
                className={colOrder.drag.cls(c.key)}
                /* 끌어서 열 자리 옮기기 — 화살표(편집 모드)와 같은 저장으로 떨어진다 */
                thProps={{ ...colOrder.drag.props(c.key), title: headTitle[c.key] ?? c.title }}
                extra={
                  <>
                    {/* 열 순서 화살표 — 정렬 클릭과 섞이면 안 되므로 전파를 막는다 */}
                    {editing && (
                      <>
                        <span
                          className="dt-move"
                          role="button"
                          title="왼쪽으로"
                          onClick={(e) => {
                            e.stopPropagation();
                            colOrder.move(c.key, -1);
                          }}
                        >
                          ◀
                        </span>
                        <span
                          className="dt-move"
                          role="button"
                          title="오른쪽으로"
                          onClick={(e) => {
                            e.stopPropagation();
                            colOrder.move(c.key, 1);
                          }}
                        >
                          ▶
                        </span>
                      </>
                    )}
                    <ColumnGrip cw={cw} k={c.key} />
                  </>
                }
              />
            ))}
            {editing && <th></th>}
          </tr>
        </thead>
        <tbody>
          {rows.map((s, i, arr) => {
            const side = sideQuote(s);
            /* FE 실시간 → spark 3초 → 본 시세(1분 캐시) 순 — 점(●)이 그 표시다 */
            /*
             * 실시간이 살아 있으면 그것, 아니면 3초 겹. **둘 중 새 것**이 아니라 이 순서다 —
             * spark 의 `at` 은 1분봉의 시각이라 갓 받아도 최대 1분 뒤처져 보여서, 시각으로
             * 견주면 늘 소켓이 이긴다. 대신 위에서 소켓 값의 나이를 15초로 조였다.
             */
            const lv = live(s.symbol) ?? fastOf(s.symbol);
            const shownPrice = lv ? lv.price : s.price;
            const shownRate = lv && lv.rate !== null ? lv.rate : s.changeRate;
            return (
              /*
                줄 아무 데나 눌러도 상세가 열린다 (2026-08-25) — 종목명만 버튼이라
                숫자 칸을 누르면 아무 일도 없었다. 국내 표들과 같은 규칙으로 맞춘다.
                편집 칸(▲▼✕)은 stopPropagation 으로 제 일만 한다.
              */
              <tr
                key={s.symbol}
                className={`clickable-row${canDrag ? drag.cls(s.symbol) : ""}`}
                onClick={() => onOpen(s.symbol, s.name || s.symbol)}
                {...(canDrag ? drag.props(s.symbol) : {})}
              >
                {/* 이름이 길면 잘린다(CSS) — 티커는 안 잘리고, 전체 이름은 마우스로 본다 */}
                <td className="sticky-col" title={`${s.symbol} ${s.name}`}>
                  {/* 나라가 섞이니 국기를 앞에 — 78.89 가 달러인지 엔인지 알아야 한다 */}
                  {/* 한투가 준 깃발이 먼저, 없으면 야후 꼬리로 (2026-09-08 — 키옥시아가 EU 였다) */}
                  <span className="uw-flag">{s.flag ?? flagOfSymbol(s.symbol)}</span>
                  <button
                    type="button"
                    className="usb-open"
                    onClick={(e) => {
                      e.stopPropagation();
                      onOpen(s.symbol, s.name || s.symbol);
                    }}
                    title="눌러서 상세 보기"
                  >
                    {/*
                      **티커 아래 이름** — 두 줄로 나눈다.

                      한 줄에 국기·티커·이름을 다 넣으니 이름이 긴 ETF 에서 통째로 잘려
                      「us…」만 남았다. 이름을 줄여 봐야 무슨 종목인지 모르는 건 마찬가지다.
                      세로로 나누면 **쓸 수 있는 가로가 두 배**가 되어 이름이 온전히 들어간다.
                      섹터 MAP 타일도 같은 모양이라 눈이 헤매지 않는다.
                    */}
                    <b>{s.symbol.split(".")[0]}</b>
                    <span className="uw-sub">{s.name}</span>
                  </button>
                  {s.error && <span className="uw-err"> {s.error}</span>}
                </td>
                {/* 몸통도 머리와 같은 열 순서로 — 표는 CSS order 로는 못 세운다 */}
                {orderedCols.map((c) => {
                  switch (c.key) {
                    /*
                      현재가·등락률·원화·편입대비는 **같이 움직인다.** 하나만 반짝이면
                      나머지는 조용히 바뀌어서, 오히려 안 바뀐 것처럼 보인다.
                    */
                    case "price":
                      return (
                        <td
                          key={c.key}
                          className="num"
                          /* 어디서 온 값인지 그대로 적는다 — 문구가 실제와 다른 것이 제일 위험하다 */
                          title={
                            live(s.symbol)
                              ? `${s.currency ?? ""} · 실시간 체결(한투 소켓)`
                              : lv
                                ? `${s.currency ?? ""} · 빠른 시세(3초)`
                                : (s.currency ?? "")
                          }
                        >
                          {/*
                            점이 **왜** 켜졌는지·꺼졌는지를 말한다 (2026-09-09). 「일부만 초록」이
                            고장으로 보였는데, 애프터장에 그 종목 체결이 없었을 뿐인 경우가 많다.
                          */}
                          {lv && (
                            <span
                              className={`uw-live-dot${live(s.symbol) ? " rt" : ""}`}
                              title={live(s.symbol) ? "실시간 체결 — 한투 소켓으로 방금 들어왔습니다" : "빠른 시세 — 3초마다 갱신"}
                            />
                          )}
                          {!lv && (
                            <span
                              className="uw-live-dot off"
                              title={
                                rtOn
                                  ? "실시간은 붙어 있는데 이 종목은 최근 체결이 없습니다 — 값은 조회로 채웁니다"
                                  : "실시간 시간대가 아닙니다 (프리 04:00 ~ 애프터 20:00 ET) — 값은 조회로 채웁니다"
                              }
                            />
                          )}
                          {price(shownPrice, s.currency)}
                          {/* 괄호는 그대로 둔다 — 실시간이 끊길 때마다 붙었다 떨어지면 화면이 덜컹인다 */}
                          {side && (
                            <span className="uw-day" title={side.label}>
                              {" "}
                              ({price(side.price, s.currency)})
                            </span>
                          )}
                        </td>
                      );
                    /*
                      ⚠️ **가격 열과 같은 기준으로 적는다.**
                      여기에 「지금 살아 있는 세션」을 쓰면 왼쪽 가격은 정규장인데 등락률만
                      시간외가 되어 짝이 어긋난다. 괄호로 둘 다 보여주므로 나눌 필요가 없다.
                    */
                    case "rate":
                      return (
                        <td
                          key={c.key}
                          className={`num tickable ${cls(shownRate)} ${tick?.(s.symbol) ?? ""}`}
                        >
                          {pct(shownRate)}
                          {side && (
                            <span
                              className={`uw-day ${cls(side.changeRate)}`}
                              title={`${side.label}에서만 움직인 폭 — 정규장 종가 대비`}
                            >
                              {" "}
                              ({pct(side.changeRate)})
                            </span>
                          )}
                        </td>
                      );
                    case "won":
                      return (
                        <td key={c.key} className="num pt-n">
                          {s.wonPrice == null ? "-" : s.wonPrice.toLocaleString("ko-KR")}
                        </td>
                      );
                    /* 52주 구간 위치를 막대로 — 신고가 근처인지 바닥인지가 숫자보다 빨리 읽힌다 */
                    case "w52":
                      return (
                        <td key={c.key} className="num">
                          {s.pos52 == null ? (
                            "-"
                          ) : (
                            <span className="uw-52" title={`${s.low52} ~ ${s.high52}`}>
                              <i style={{ width: `${Math.min(100, Math.max(0, s.pos52))}%` }} />
                              <em>{s.pos52.toFixed(0)}</em>
                            </span>
                          )}
                        </td>
                      );
                    case "vol":
                      return (
                        <td
                          key={c.key}
                          className={`num ${s.volumeVsPrev != null && s.volumeVsPrev >= 150 ? "positive" : ""}`}
                        >
                          {s.volumeVsPrev == null ? "-" : `${s.volumeVsPrev.toFixed(0)}%`}
                        </td>
                      );
                    case "power":
                      return (
                        <td
                          key={c.key}
                          className={`num ${s.power != null && s.power >= 100 ? "positive" : ""}`}
                        >
                          {s.power == null ? "-" : s.power.toFixed(0)}
                        </td>
                      );
                    case "added":
                      return (
                        <td key={c.key} className="num">
                          {price(s.addedPrice, s.currency)}
                        </td>
                      );
                    case "ret":
                      return (
                        <td key={c.key} className={`num ${cls(s.returnRate)}`}>
                          {pct(s.returnRate)}
                        </td>
                      );
                  }
                })}
                {editing && (
                  <td className="uw-ord" onClick={(e) => e.stopPropagation()}>
                    {/* 순서 바꾸기는 내 순서로 볼 때만 뜻이 있다 — 페이지 정렬이면 onMove 가
                        안 오고, 머리 클릭 정렬이면 여기서 숨긴다 */}
                    {onMove && !sorting && (
                      <>
                        <button
                          className="row-del-btn"
                          disabled={i === 0}
                          onClick={() => onMove(s.symbol, -1)}
                          title="위로"
                        >
                          ▲
                        </button>
                        <button
                          className="row-del-btn"
                          disabled={i === arr.length - 1}
                          onClick={() => onMove(s.symbol, 1)}
                          title="아래로"
                        >
                          ▼
                        </button>
                      </>
                    )}
                    {onRemove && (
                      <button
                        className="row-del-btn"
                        onClick={() => onRemove(s.symbol)}
                        title="빼기"
                      >
                        ✕
                      </button>
                    )}
                  </td>
                )}
              </tr>
            );
          })}
        </tbody>
      </table>
      {editing && (
        <div className="table-note">
          머리 칸을 끌거나 <b>◀ ▶</b> 로 열 자리를 옮깁니다 — 서버에 저장되어 다른
          기기에서도 같은 순서입니다. 종목 칸은 고정 첫 칸이라 못 옮깁니다.
          {colOrder.customized && (
            <button className="filter-btn dt-reset" onClick={colOrder.reset}>
              열 순서 원래대로
            </button>
          )}
        </div>
      )}
    </div>
  );
}
