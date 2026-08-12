import { fmtAbsNum, fmtNum, type RawRecord } from "../api";

/**
 * 종목 상세 맨 위에 항상 붙는 시세 요약.
 * 어떤 탭(차트·수급·재무)을 보고 있어도 "오늘 몇 % 움직였는지"가 눈에 들어와야 한다.
 * ka10001(주식기본정보) 응답만 쓰므로 추가 API 호출이 없다.
 */

function sigClass(sig: string): string {
  if (sig === "1" || sig === "2") return "positive";
  if (sig === "4" || sig === "5") return "negative";
  return "";
}

/** 시가/고가/저가를 전일종가 대비 등락률로. 가격만 보면 몇 % 움직였는지 감이 안 온다 */
function vsBase(value: unknown, base: number): { cls: string; rate: string } {
  const n = Math.abs(Number(value));
  if (!Number.isFinite(n) || !Number.isFinite(base) || base === 0 || n === 0) {
    return { cls: "", rate: "" };
  }
  const rate = ((n - base) / base) * 100;
  return {
    cls: rate > 0 ? "positive" : rate < 0 ? "negative" : "",
    rate: `${rate > 0 ? "+" : ""}${rate.toFixed(2)}%`,
  };
}

export function PriceHeader({ info }: { info: RawRecord | null }) {
  if (!info) return null;

  const sig = String(info.pre_sig ?? "");
  const sign = sigClass(sig);
  const base = Math.abs(Number(info.base_pric));
  const fluRt = Number(String(info.flu_rt ?? "").replace(/\+/g, ""));

  return (
    <div className="price-header">
      <div className="ph-main">
        <div className={`ph-price ${sign}`}>{fmtAbsNum(info.cur_prc)}</div>
        <div className={`ph-change ${sign}`}>
          {Number(info.pred_pre) > 0 ? "▲" : Number(info.pred_pre) < 0 ? "▼" : ""}
          {fmtAbsNum(info.pred_pre)}
          <span className="ph-rate">
            {Number.isFinite(fluRt) && fluRt > 0 ? "+" : ""}
            {Number.isFinite(fluRt) ? fluRt.toFixed(2) : "-"}%
          </span>
        </div>
      </div>
      <div className="ph-grid">
        {[
          { label: "시가", value: info.open_pric },
          { label: "고가", value: info.high_pric },
          { label: "저가", value: info.low_pric },
        ].map((it) => {
          const v = vsBase(it.value, base);
          return (
            <div className="ph-cell" key={it.label}>
              <span className="ph-label">{it.label}</span>
              <span className={`ph-value ${v.cls}`}>
                {fmtAbsNum(it.value)}
                {v.rate && <em className="ph-pct">{v.rate}</em>}
              </span>
            </div>
          );
        })}
        <div className="ph-cell">
          <span className="ph-label">전일종가</span>
          <span className="ph-value">{fmtAbsNum(info.base_pric)}</span>
        </div>
        <div className="ph-cell">
          <span className="ph-label">거래량</span>
          <span className="ph-value">{fmtNum(info.trde_qty)}</span>
        </div>
        <div className="ph-cell">
          <span className="ph-label">전일比 거래량</span>
          <span className="ph-value">{String(info.trde_pre ?? "-")}%</span>
        </div>
      </div>
    </div>
  );
}
