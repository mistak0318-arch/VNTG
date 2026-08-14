import { useEffect, useState } from "react";
import { api, fmtAbsNum, fmtNum, type ExchangeQuote, type RawRecord } from "../api";

/**
 * 종목 상세 맨 위에 항상 붙는 시세 요약.
 * 어떤 탭(차트·수급·재무)을 보고 있어도 "오늘 몇 % 움직였는지"가 눈에 들어와야 한다.
 * ka10001(주식기본정보)이 주는 값은 **KRX 기준**이다. 그런데 그렇게 적어 두질 않아서
 * 화면에 뜬 시가·고가·저가·종가가 어느 거래소 것인지 알 수가 없었다 — NXT 에서
 * 고가가 따로 나는 날에는 두 값이 다르다.
 * 그래서 라벨에 KRX 를 박고, NXT 값을 아래에 나란히 붙인다.
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

export function PriceHeader({ info, code }: { info: RawRecord | null; code?: string }) {
  const [nxt, setNxt] = useState<ExchangeQuote | null>(null);

  useEffect(() => {
    if (!code) return;
    let cancelled = false;
    api
      .exchangeQuotes(code)
      .then((r) => {
        if (!cancelled) setNxt(r.exchanges.find((x) => x.key === "nxt") ?? null);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [code]);

  if (!info) return null;

  // 마감(15:40) 이후면 지금 값이 그날 종가다. 주말·휴장도 마감으로 본다
  const kst = new Date(Date.now() + 9 * 3600_000);
  const mins = kst.getUTCHours() * 60 + kst.getUTCMinutes();
  const weekday = kst.getUTCDay() !== 0 && kst.getUTCDay() !== 6;
  const closed = !weekday || mins >= 15 * 60 + 40 || mins < 9 * 60;

  const sig = String(info.pre_sig ?? "");
  const sign = sigClass(sig);
  const base = Math.abs(Number(info.base_pric));
  const fluRt = Number(String(info.flu_rt ?? "").replace(/\+/g, ""));

  return (
    <div className="price-header">
      <div className="ph-main">
        <div className="ph-main-label">
          {/*
            장중엔 종가가 없다 — 지금 값은 현재가다. 마감 뒤에는 같은 숫자가 그날 종가다.
            둘을 같은 말로 부르면 "이게 확정값인가"를 알 수 없어서 시각으로 갈라 적는다.
          */}
          {closed ? "종가" : "현재가"} <em className="ph-ex">KRX</em>
        </div>
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
          { label: "시가", value: info.open_pric, nxtValue: nxt?.open ?? null },
          { label: "고가", value: info.high_pric, nxtValue: nxt?.high ?? null },
          { label: "저가", value: info.low_pric, nxtValue: nxt?.low ?? null },
        ].map((it) => {
          const v = vsBase(it.value, base);
          const nv = vsBase(it.nxtValue, base);
          // KRX 와 같은 값이면 굳이 두 번 적지 않는다 — 다를 때만 눈에 띄어야 한다
          const showNxt =
            it.nxtValue !== null && it.nxtValue > 0 && it.nxtValue !== Math.abs(Number(it.value));
          return (
            <div className="ph-cell" key={it.label}>
              <span className="ph-label">{it.label}</span>
              <span className="ph-row">
                <em className="ph-ex">KRX</em>
                <b className={`ph-value ${v.cls}`}>{fmtAbsNum(it.value)}</b>
                {v.rate && <em className={`ph-pct ${v.cls}`}>{v.rate}</em>}
              </span>
              {showNxt && (
                <span className="ph-row">
                  <em className="ph-ex nxt">NXT</em>
                  <b className={`ph-value ${nv.cls}`}>{fmtNum(it.nxtValue)}</b>
                  {nv.rate && <em className={`ph-pct ${nv.cls}`}>{nv.rate}</em>}
                </span>
              )}
            </div>
          );
        })}
        <div className="ph-cell">
          {/* 전일종가는 두 거래소가 같다 — 정규장 종가를 기준값으로 쓰기 때문 */}
          <span className="ph-label">전일종가</span>
          <span className="ph-row">
            <span className="ph-value">{fmtAbsNum(info.base_pric)}</span>
          </span>
        </div>
        <div className="ph-cell">
          <span className="ph-label">거래량</span>
          <span className="ph-row">
            <span className="ph-value">{fmtNum(info.trde_qty)}</span>
          </span>
        </div>
        <div className="ph-cell">
          <span className="ph-label">전일比 거래량</span>
          <span className="ph-row">
            <span className="ph-value">{String(info.trde_pre ?? "-")}%</span>
          </span>
        </div>
      </div>
    </div>
  );
}
