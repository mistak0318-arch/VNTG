import { useEffect, useState } from "react";
import { api, fmtAbsNum, fmtNum, type ExchangeQuote, type RawRecord } from "../api";
import { PeriodReturns } from "./PeriodReturns";

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

  /*
   * 지금이 어느 국면인가.
   *
   * KRX 는 15:30 에 끝나지만 NXT 는 20:00 까지 돈다. 그 사이에 KRX 값을 "종가"라고
   * 부르는 건 맞지만, **큰 숫자까지 종가라고 하면 안 된다** — 그 시간대에 실제로
   * 움직이는 값은 NXT 쪽이기 때문이다.
   * 그래서 큰 숫자는 언제나 "지금 값"으로 두고, 어디가 만든 값인지를 옆에 적는다.
   * (정규장 09:00~15:30 · NXT 프리 08:00~ · NXT 애프터 ~20:00 — 당일 흐름 차트와 같은 기준)
   */
  const kst = new Date(Date.now() + 9 * 3600_000);
  const mins = kst.getUTCHours() * 60 + kst.getUTCMinutes();
  const weekday = kst.getUTCDay() !== 0 && kst.getUTCDay() !== 6;
  const phase: "pre" | "regular" | "after" | "closed" = !weekday
    ? "closed"
    : mins < 8 * 60
      ? "closed"
      : mins < 9 * 60
        ? "pre"
        : mins <= 15 * 60 + 30
          ? "regular"
          : mins < 20 * 60
            ? "after"
            : "closed";
  const closed = phase === "closed";
  const PHASE_LABEL: Record<typeof phase, string> = {
    pre: "NXT 프리마켓",
    regular: "정규장",
    after: "NXT 애프터마켓",
    closed: "장 마감",
  };
  /** KRX 는 정규장 끝나면 그 값이 종가다 */
  const krxDone = phase === "after" || phase === "closed";

  const sig = String(info.pre_sig ?? "");
  const sign = sigClass(sig);
  const base = Math.abs(Number(info.base_pric));
  const fluRt = Number(String(info.flu_rt ?? "").replace(/\+/g, ""));

  return (
    <div className="price-header">
      <div className="ph-main">
        <div className="ph-main-label">
          {closed ? "종가" : "현재가"} · {PHASE_LABEL[phase]}
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
        {/*
          거래소별 지금 값. KRX 는 15:30 이후면 그게 종가이고, NXT 는 20:00 까지 움직인다.
          같은 칸에 나란히 둬야 "어느 쪽 숫자를 보고 있는지"가 헷갈리지 않는다.
        */}
        <div className="ph-cell">
          <span className="ph-label">{krxDone ? "종가" : "현재가"} · 거래소별</span>
          <span className="ph-row">
            <em className="ph-ex">KRX</em>
            <b className={`ph-value ${sign}`}>{fmtAbsNum(info.cur_prc)}</b>
            <em className="ph-when">{krxDone ? "15:30 마감" : "거래 중"}</em>
          </span>
          {nxt?.price != null && nxt.price > 0 && (
            <span className="ph-row">
              <em className="ph-ex nxt">NXT</em>
              <b
                className={`ph-value ${nxt.changeRate > 0 ? "positive" : nxt.changeRate < 0 ? "negative" : ""}`}
              >
                {fmtNum(nxt.price)}
              </b>
              <em className={`ph-pct ${nxt.changeRate > 0 ? "positive" : nxt.changeRate < 0 ? "negative" : ""}`}>
                {nxt.changeRate > 0 ? "+" : ""}
                {nxt.changeRate.toFixed(2)}%
              </em>
              <em className="ph-when">{phase === "closed" ? "20:00 마감" : "거래 중"}</em>
            </span>
          )}
        </div>
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
      {/* 오늘 하루만 보면 흐름을 못 읽는다 — 아래에 기간별 상승률을 붙인다 */}
      {code && <PeriodReturns code={code} />}
    </div>
  );
}
