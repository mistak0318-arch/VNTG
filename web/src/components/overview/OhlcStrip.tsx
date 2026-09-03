import { fmtNum } from "../../api";

/**
 * **당일 시·고·저·현재가 한 줄** (2026-09-03 — 벤티지: "지수 누르거나 선물 누르면 차트랑 상세
 * 나오잖아. 당일 고점, 저점, 현재가 이렇게는 표시가 안 되네. 야간선물도 그렇고").
 *
 * 세 시트(코스피·코스닥 / 주간 선물 / 야간선물)가 머리에 등락률만 적고 있었다. 오늘 봉은
 * 이미 받고 있으니(일봉의 마지막 봉이 오늘) 그걸 그대로 편다. 고가·저가 옆의 작은 %는
 * **전일 종가 대비** — 「오늘 얼마나 위아래로 흔들렸나」가 숫자 하나로 읽힌다.
 * 야간선물은 세션이 날짜를 넘어가므로 「어느 세션인가」를 라벨로 밝힌다.
 */
export function OhlcStrip({
  label,
  open,
  high,
  low,
  close,
  prevClose,
  digits = 2,
  closeLabel = "현재가",
}: {
  /** 「오늘」 · 「9/2 야간 세션」 */
  label: string;
  open: number;
  high: number;
  low: number;
  close: number;
  prevClose: number | null;
  digits?: number;
  closeLabel?: string;
}) {
  const f = (v: number) => (digits === 0 ? fmtNum(Math.round(v)) : v.toLocaleString("ko-KR", { minimumFractionDigits: digits, maximumFractionDigits: digits }));
  const pct = (v: number) => (prevClose && prevClose > 0 ? `${v - prevClose > 0 ? "+" : ""}${(((v - prevClose) / prevClose) * 100).toFixed(2)}%` : null);
  const cls = (v: number) => (prevClose ? (v > prevClose ? "positive" : v < prevClose ? "negative" : "") : "");
  const Cell = ({ k, v, tone }: { k: string; v: number; tone?: string }) => (
    <span className="ohlc-cell">
      <i>{k}</i>
      <b className={tone ?? cls(v)}>{f(v)}</b>
      {pct(v) && <small className={cls(v)}>{pct(v)}</small>}
    </span>
  );
  return (
    <div className="ohlc-strip num" title="일봉의 오늘 봉 — 시가·고가·저가는 장중에 계속 바뀐다. %는 전일 종가 대비">
      <span className="ohlc-label">{label}</span>
      <Cell k="시가" v={open} />
      <Cell k="고가" v={high} tone="positive" />
      <Cell k="저가" v={low} tone="negative" />
      <Cell k={closeLabel} v={close} />
      {prevClose !== null && (
        <span className="ohlc-cell">
          <i>전일 종가</i>
          <b>{f(prevClose)}</b>
        </span>
      )}
      <span className="ohlc-cell ohlc-range" title="고가 − 저가, 전일 종가 대비">
        <i>진폭</i>
        <b>{prevClose && prevClose > 0 ? `${(((high - low) / prevClose) * 100).toFixed(2)}%` : f(high - low)}</b>
      </span>
    </div>
  );
}
