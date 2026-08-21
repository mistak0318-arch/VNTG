import { useEffect, useState } from "react";
import { api, fmtAbsNum, fmtNum, type ExchangeQuote, type RawRecord } from "../api";
import { PeriodReturns, type LastSession } from "./PeriodReturns";

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
  /*
   * 거래가 있었던 마지막 날의 값. 아래 「기간 상승률」이 받는 일봉에서 올려 준다.
   * ka10001 이 개장 전에 0 을 주는 자리를 이걸로 메운다 — 새벽에 "거래량 0" 이 뜨던 문제.
   */
  const [last, setLast] = useState<LastSession | null>(null);
  /** ka10001 값이 0 이면 일봉 값으로 대신한다 */
  const fill = (v: unknown, alt: number | null | undefined) => {
    const n = Math.abs(Number(v));
    return Number.isFinite(n) && n > 0 ? n : (alt ?? 0);
  };

  const [nxt, setNxt] = useState<ExchangeQuote | null>(null);
  /*
   * 체결강도. **가벼운 조회 하나**(`ka10003`)만 쓴다 — 호가 조회는 TR 을 셋 부르는데
   * 요약줄은 늘 떠 있으므로 그걸 쓰면 초당 제한에 금방 닿는다.
   */
  const [strength, setStrength] = useState<number | null>(null);

  useEffect(() => {
    if (!code) return;
    let cancelled = false;
    const load = () =>
      fetch(`/api/market/ticks/${encodeURIComponent(code)}`)
        .then((r) => r.json() as Promise<{ strength?: number | null }>)
        .then((j) => {
          if (!cancelled) setStrength(j.strength ?? null);
        })
        .catch(() => undefined);
    void load();
    // 장중에는 계속 바뀐다. 요약줄이라 자주 볼 값이다
    const t = setInterval(() => void load(), 10_000);
    return () => {
      cancelled = true;
      clearInterval(t);
    };
  }, [code]);

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
  /*
   * 등락률의 기준값.
   *
   * 개장 전에는 시가·고가·저가를 **마지막 거래일** 것으로 메우는데, 그때 기준값까지
   * 오늘 전일종가로 두면 엉뚱한 퍼센트가 나온다 — NAVER 08/18 시가 225,500 이
   * -1.10% 대신 +3.92% 로 찍혔다. 메운 값에는 **그날의** 전일종가를 쓴다.
   */
  const filled = Math.abs(Number(info.open_pric)) === 0 && last?.base != null;
  const base = filled ? last!.base! : Math.abs(Number(info.base_pric));
  const fluRt = Number(String(info.flu_rt ?? "").replace(/\+/g, ""));

  /*
   * 큰 숫자는 **언제나 정규장(KRX) 값**이다.
   *
   * 예전엔 정규장 안팎을 가리지 않고 KRX 와 NXT 를 나란히 늘어놓아서 어느 쪽을 보고
   * 있는지 헷갈렸다. 이제 국면으로 가른다 —
   *
   *   · 정규장 중        큰 숫자 = 지금 KRX 값. **NXT 는 아예 안 띄운다**
   *   · 개장 전(NXT 프리) 큰 숫자 = **전날 정규장 종가**. KRX 는 아직 거래가 없다
   *   · 마감 후(NXT 애프터) 큰 숫자 = **오늘 정규장 종가**
   *
   * 정규장 밖에서는 그 밑에 NXT 를 **작게** 붙인다. 그 시간에 실제로 움직이는 건 NXT 이지만
   * 기준이 되는 값은 정규장 종가이므로, 크기로 둘의 무게를 갈라 놓는다.
   */
  const preOpen = phase === "pre";
  // 개장 전에는 KRX 가 아직 안 움직였다. 「현재가」라고 부르면 거짓말이 된다
  const mainPrice = preOpen ? info.base_pric : info.cur_prc;
  const mainLabel = preOpen ? "전날 종가" : krxDone ? "종가" : "현재가";
  /** 정규장 중에는 NXT 를 숨긴다 — 헷갈리기만 한다 */
  const showNxtLine =
    phase !== "regular" && nxt?.price != null && nxt.price > 0 && Number.isFinite(nxt.changeRate);
  const nxtCls = !nxt ? "" : nxt.changeRate > 0 ? "positive" : nxt.changeRate < 0 ? "negative" : "";

  return (
    <div className="price-header">
      <div className="ph-main">
        <div className="ph-main-label">
          {mainLabel} · {PHASE_LABEL[phase]}
        </div>
        <div className={`ph-price ${preOpen ? "" : sign}`}>{fmtAbsNum(mainPrice)}</div>
        {/* 개장 전 KRX 등락은 늘 0 이라 적을 이유가 없다 */}
        {!preOpen && (
          <div className={`ph-change ${sign}`}>
            {Number(info.pred_pre) > 0 ? "▲" : Number(info.pred_pre) < 0 ? "▼" : ""}
            {fmtAbsNum(info.pred_pre)}
            <span className="ph-rate">
              {Number.isFinite(fluRt) && fluRt > 0 ? "+" : ""}
              {Number.isFinite(fluRt) ? fluRt.toFixed(2) : "-"}%
            </span>
          </div>
        )}
        {showNxtLine && nxt && (
          <div className={`ph-nxt ${nxtCls}`}>
            <em className="ph-ex nxt">NXT</em>
            <b>{fmtNum(nxt.price)}</b>
            <span className="ph-nxt-rate">
              {nxt.changeRate > 0 ? "+" : ""}
              {nxt.changeRate.toFixed(2)}%
            </span>
            <span className="ph-when">{phase === "closed" ? "20:00 마감" : "거래 중"}</span>
          </div>
        )}
      </div>
      <div className="ph-grid">
        {[
          // 개장 전에는 ka10001 이 0 을 주므로 마지막 거래일 값으로 메운다
          { label: "시가", value: fill(info.open_pric, last?.open), nxtValue: nxt?.open ?? null },
          { label: "고가", value: fill(info.high_pric, last?.high), nxtValue: nxt?.high ?? null },
          { label: "저가", value: fill(info.low_pric, last?.low), nxtValue: nxt?.low ?? null },
        ].map((it) => {
          const v = vsBase(it.value, base);
          const nv = vsBase(it.nxtValue, base);
          // KRX 와 같은 값이면 굳이 두 번 적지 않는다 — 다를 때만 눈에 띄어야 한다
          const showNxt =
            phase !== "regular" &&
            it.nxtValue !== null &&
            it.nxtValue > 0 &&
            it.nxtValue !== Math.abs(Number(it.value));
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
          {/* 위 큰 숫자와 같은 규칙 — 정규장 중에는 NXT 를 띄우지 않는다 */}
          {showNxtLine && nxt && (
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
            <span className="ph-value">{fmtNum(fill(info.trde_qty, last?.volume))}</span>
          </span>
          {/*
            거래량 바로 밑에 거래대금. 주식 수만 보면 감이 안 온다 —
            80만주가 1,800억인 종목과 8억인 종목이 화면에서 똑같이 생겼다.
          */}
          <span className="ph-row">
            <em className="ph-sublabel">거래대금</em>
            <span className="ph-value sub">
              {last?.value == null ? "-" : `${Math.round(last.value / 100).toLocaleString("ko-KR")}억`}
            </span>
          </span>
          {/*
            거래대금 밑에 체결강도. 거래대금은 「얼마나 붙었나」이고 체결강도는
            **「어느 쪽이 붙었나」**다 — 둘이 같이 있어야 뜻이 산다.
            돈은 몰리는데 강도가 100 아래면 그 돈은 파는 쪽이다.
          */}
          <span className="ph-row">
            <em className="ph-sublabel" title="매수 체결 ÷ 매도 체결 × 100. 100 이 균형">
              체결강도
            </em>
            <span
              className={`ph-value sub ${
                strength === null ? "" : strength >= 100 ? "positive" : "negative"
              }`}
            >
              {strength === null ? "-" : strength.toFixed(0)}
            </span>
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
      {code && <PeriodReturns code={code} onTradeValue={setLast} />}
    </div>
  );
}
