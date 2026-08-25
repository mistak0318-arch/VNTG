import type { UsQuoteRow } from "../api";
import { sideQuote, usFeActive } from "../usSession";
import { useDragOrder } from "../useDragOrder";
import { fid, useRealtime } from "../useRealtime";
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
  /* 끌어서 옮기기 — 편집 + 내 순서에서만 (onReorder 가 그 조건으로만 온다) */
  const drag = useDragOrder(stocks.map((s) => s.symbol), (next) => onReorder?.(next));
  const canDrag = editing && Boolean(onReorder);

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
  const rt = useRealtime(
    feOn ? stocks.map((s) => `FE:${s.symbol.toUpperCase()}`) : [],
    2500,
  );
  const live = (symbol: string): { price: number; rate: number | null } | null => {
    if (!rt.healthy) return null;
    const v = rt.values[`FE:${symbol.toUpperCase()}`];
    if (!v || Date.now() - v.at > 90_000) return null;
    const price = fid(v, "10");
    if (price === null || price === 0) return null;
    return { price: Math.abs(price), rate: fid(v, "12") };
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

  return (
    <div className="data-table-wrap">
      <table className={`data-table uw-table${cw.customized ? " col-fixed" : ""}`}>
        <colgroup>
          <col style={cw.styleOf("name")} />
          <col style={cw.styleOf("price")} />
          <col style={cw.styleOf("rate")} />
          <col style={cw.styleOf("won")} />
          <col style={cw.styleOf("w52")} />
          <col style={cw.styleOf("vol")} />
          <col style={cw.styleOf("power")} />
          <col style={cw.styleOf("added")} />
          <col style={cw.styleOf("ret")} />
          {editing && <col />}
        </colgroup>
        <thead>
          <tr>
            <th className="sticky-col">
              종목
              <ColumnGrip cw={cw} k="name" />
            </th>
            {/*
              시간외를 **괄호로 바로 옆에** 붙인다. 뒤쪽에 열로 두니 폰에서 잘려 안 보였다 —
              이 값은 정규장과 **견줘야** 뜻이 생기므로 떨어뜨려 놓으면 쓸모가 없다.

              ⚠️ 머리에 「(주간)」이 박혀 있었다. 시간외는 시각에 따라 프리장·애프터장·
              주간거래 셋 중 하나인데 늘 주간이라 적으니, 저녁 아홉 시 프리장 값이
              한국 낮 세션인 줄로 읽혔다. 지금 도는 세션 이름을 그대로 쓴다.
            */}
            <th title={`괄호는 ${sideName} — 정규장 밖에서 도는 세션입니다`}>
              현재가 <span className="uw-day-h">({sideName})</span>
              <ColumnGrip cw={cw} k="price" />
            </th>
            <th title={`전일 종가 대비 등락률입니다. 괄호는 ${sideName} 변동(정규장 종가 대비)`}>
              등락률 <span className="uw-day-h">({sideName})</span>
              <ColumnGrip cw={cw} k="rate" />
            </th>
            <th title="원화 환산가 — 한국투자증권이 계산해 준다">
              원화
              <ColumnGrip cw={cw} k="won" />
            </th>
            <th title="52주 구간에서 지금 위치 (0=저가, 100=고가)">
              52주
              <ColumnGrip cw={cw} k="w52" />
            </th>
            <th title="오늘 거래량 ÷ 전일 거래량">
              거래량
              <ColumnGrip cw={cw} k="vol" />
            </th>
            <th title="체결강도 — 100보다 크면 사는 쪽이 세다">
              강도
              <ColumnGrip cw={cw} k="power" />
            </th>
            <th>
              편입가
              <ColumnGrip cw={cw} k="added" />
            </th>
            <th>
              편입 대비
              <ColumnGrip cw={cw} k="ret" />
            </th>
            {editing && <th></th>}
          </tr>
        </thead>
        <tbody>
          {stocks.map((s, i, arr) => {
            const side = sideQuote(s);
            /* FE 실시간 → spark 3초 → 본 시세(1분 캐시) 순 — 점(●)이 그 표시다 */
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
                  <span className="uw-flag">{s.flag ?? (s.symbol.includes(".") ? "🇪🇺" : "")}</span>
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
                {/*
                  현재가·등락률·원화·편입대비는 **같이 움직인다.** 하나만 반짝이면
                  나머지는 조용히 바뀌어서, 오히려 안 바뀐 것처럼 보인다.
                */}
                <td className="num" title={lv ? `${s.currency ?? ""} · 빠른 시세(3초)` : (s.currency ?? "")}>
                  {lv && <span className="uw-live-dot" title="빠른 시세 — 3초마다 갱신" />}
                  {price(shownPrice, s.currency)}
                  {/* 괄호는 그대로 둔다 — 실시간이 끊길 때마다 붙었다 떨어지면 화면이 덜컹인다 */}
                  {side && (
                    <span className="uw-day" title={side.label}>
                      {" "}
                      ({price(side.price, s.currency)})
                    </span>
                  )}
                </td>
                {/*
                  ⚠️ **가격 열과 같은 기준으로 적는다.**
                  여기에 「지금 살아 있는 세션」을 쓰면 왼쪽 가격은 정규장인데 등락률만
                  시간외가 되어 짝이 어긋난다. 괄호로 둘 다 보여주므로 나눌 필요가 없다.
                */}
                <td className={`num tickable ${cls(shownRate)} ${tick?.(s.symbol) ?? ""}`}>
                  {pct(shownRate)}
                  {side && (
                    <span className={`uw-day ${cls(side.changeRate)}`} title={side.label}>
                      {" "}
                      ({pct(side.changeRate)})
                    </span>
                  )}
                </td>
                <td className="num pt-n">
                  {s.wonPrice == null ? "-" : s.wonPrice.toLocaleString("ko-KR")}
                </td>
                {/* 52주 구간 위치를 막대로 — 신고가 근처인지 바닥인지가 숫자보다 빨리 읽힌다 */}
                <td className="num">
                  {s.pos52 == null ? (
                    "-"
                  ) : (
                    <span className="uw-52" title={`${s.low52} ~ ${s.high52}`}>
                      <i style={{ width: `${Math.min(100, Math.max(0, s.pos52))}%` }} />
                      <em>{s.pos52.toFixed(0)}</em>
                    </span>
                  )}
                </td>
                <td
                  className={`num ${s.volumeVsPrev != null && s.volumeVsPrev >= 150 ? "positive" : ""}`}
                >
                  {s.volumeVsPrev == null ? "-" : `${s.volumeVsPrev.toFixed(0)}%`}
                </td>
                <td className={`num ${s.power != null && s.power >= 100 ? "positive" : ""}`}>
                  {s.power == null ? "-" : s.power.toFixed(0)}
                </td>
                <td className="num">{price(s.addedPrice, s.currency)}</td>
                <td className={`num ${cls(s.returnRate)}`}>{pct(s.returnRate)}</td>
                {editing && (
                  <td className="uw-ord" onClick={(e) => e.stopPropagation()}>
                    {/* 순서 바꾸기는 내 순서로 볼 때만 뜻이 있다 — 정렬 중이면 onMove 를 안 준다 */}
                    {onMove && (
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
    </div>
  );
}
