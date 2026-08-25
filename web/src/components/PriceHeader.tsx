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

/**
 * 억원을 조·억으로 — 시가총액은 자릿수가 커서 숫자를 그대로 적으면 못 읽는다.
 * `15024936` 은 1502조다.
 */
function eok(v: unknown): string {
  const n = Number(String(v ?? "").replace(/[+,\s]/g, ""));
  if (!Number.isFinite(n) || n === 0) return "-";
  if (Math.abs(n) >= 10000) return `${(n / 10000).toLocaleString("ko-KR", { maximumFractionDigits: 0 })}조`;
  return `${Math.round(n).toLocaleString("ko-KR")}억`;
}

/**
 * PER·PBR — **없으면 없다고 적는다.**
 * 적자면 PER 이 음수거나 빈 값으로 온다. 거기에 0 을 적으면 「값이 싸다」로 읽힌다.
 */
function ratio(v: unknown): string {
  const n = Number(String(v ?? "").replace(/[+,\s]/g, ""));
  if (!Number.isFinite(n) || n <= 0) return "-";
  return n.toFixed(2);
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

  /** KRX 몫 거래대금 — 조회에서 직접 받는다(일봉은 개장 전에 어제 값을 준다) */
  const [krxValue, setKrxValue] = useState<number | null>(null);
  /** 상장주식수(주) — 회전율의 분모. `ka10007` 이 천주로 준다 */
  const [shares, setShares] = useState<number | null>(null);

  useEffect(() => {
    if (!code) return;
    let cancelled = false;
    /*
     * ⚠️ **한 번만 받고 끝냈었다.** 그래서 08~09시 NXT 프리마켓에 값이 움직이는데도
     * 화면의 NXT 등락률은 처음 받은 값에 멈춰 있었다 — 「거래 중」이라 적어 놓고
     * 안 바뀌니 고장으로 보인다. 체결강도가 이미 10초마다 도는 것과 같은 주기로 맞춘다.
     *
     * 조회 셋(KRX·NXT·통합)이 나가지만 요약줄은 종목 하나에만 떠 있고,
     * 이 줄의 값이 안 맞으면 그 아래 화면 전체를 못 믿는다.
     */
    const load = () =>
      api
        .exchangeQuotes(code)
        .then((r) => {
          if (cancelled) return;
          setNxt(r.exchanges.find((x) => x.key === "nxt") ?? null);
          const krx = r.exchanges.find((x) => x.key === "krx");
          setKrxValue(krx?.tradeValue ?? null);
          // 천주로 온다 — 주 단위로 바꿔 둔다
          setShares(krx?.shares ? krx.shares * 1000 : null);
        })
        .catch(() => undefined);
    void load();
    const t = setInterval(() => void load(), 10_000);
    return () => {
      cancelled = true;
      clearInterval(t);
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
   *   · 정규장 중        큰 숫자 = 지금 KRX 값. NXT 는 **값이 다를 때만** 작게
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
  /**
   * NXT 를 언제 보여줄까.
   *
   * ⚠️ 예전엔 **정규장 중엔 숨겼다**(「헷갈리기만 한다」). 그런데 NXT 는 정규장에도
   * **병행 거래**된다 — 2026-08-24 실측으로 삼성전자 하루 거래대금 137,023억 중
   * **52,462억(38%)이 NXT** 였고 종가도 KRX 257,000 · NXT 256,000 으로 달랐다.
   * 그만한 거래를 화면에서 지워 두면 「NXT 가격이 왜 안 보이냐」가 나온다.
   *
   * ## ⚠️ 「값이 같으면 숨긴다」를 그만뒀다 (2026-08-25)
   *
   * 정규장 중엔 값이 같을 때 줄을 지웠다. 그런데 이 값은 **10초마다 다시 받는다** —
   * KRX 와 NXT 가 붙었다 떨어졌다 하면서 **줄이 생겼다 없어졌다** 하고, 그때마다
   * 그 아래 화면 전체가 위아래로 밀렸다. 호가를 보고 있는데 창이 움직인다.
   *
   * **자리는 늘 잡아 둔다.** 값이 같으면 가격 대신 「= KRX」라고 적는다 — 같은 숫자를
   * 두 번 쓰는 것도 피하면서 높이는 안 변한다. 화면이 안 흔들리는 게 우선이다.
   */
  const nxtDiffers =
    nxt?.price != null && Math.abs(nxt.price - Math.abs(Number(info.cur_prc))) > 1e-9;
  const showNxtLine = nxt?.price != null && nxt.price > 0 && Number.isFinite(nxt.changeRate);
  /** 값이 KRX 와 같은가 — 같으면 숫자 대신 그렇게 적는다(줄은 그대로 둔다) */
  const nxtSame = showNxtLine && phase === "regular" && !nxtDiffers;

  /*
   * 회전율 — **통합 거래량**으로 낸다(KRX + NXT). 하루 거래는 둘의 합이라
   * KRX 만 세면 「얼마나 돌았나」가 절반으로 적힌다.
   */
  const totalVol = fill(info.trde_qty, last?.volume) + (nxt?.volume ?? 0);
  const turnover = shares && shares > 0 && totalVol > 0 ? (totalVol / shares) * 100 : null;
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
          <div className={`ph-nxt ${nxtSame ? "same" : nxtCls}`}>
            <em className="ph-ex nxt">NXT</em>
            {nxtSame ? (
              <b className="pt-n">= KRX</b>
            ) : (
              <>
                <b>{fmtNum(nxt.price)}</b>
                <span className="ph-nxt-rate">
                  {nxt.changeRate > 0 ? "+" : ""}
                  {nxt.changeRate.toFixed(2)}%
                </span>
              </>
            )}
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
          /*
           * ⚠️ **자리는 늘 잡아 둔다.**
           *
           * 「KRX 와 같으면 안 적는다」로 두었더니, 10초마다 값을 다시 받으면서
           * 두 값이 붙었다 떨어졌다 할 때마다 **줄이 생겼다 없어졌다** 했다.
           * 세 칸(시·고·저)이 제각각 그러니 화면이 계속 덜컹거린다.
           *
           * NXT 값이 아예 없을 때만 안 그린다(그건 안 바뀐다). 값이 있는데 KRX 와
           * 같으면 숫자 대신 「= KRX」다 — 같은 숫자를 두 번 안 쓰면서 높이는 고정된다.
           */
          const hasNxt = it.nxtValue !== null && it.nxtValue > 0;
          const sameAsKrx = hasNxt && it.nxtValue === Math.abs(Number(it.value));
          return (
            <div className="ph-cell" key={it.label}>
              <span className="ph-label">{it.label}</span>
              <span className="ph-row">
                <em className="ph-ex">KRX</em>
                <b className={`ph-value ${v.cls}`}>{fmtAbsNum(it.value)}</b>
                {v.rate && <em className={`ph-pct ${v.cls}`}>{v.rate}</em>}
              </span>
              {hasNxt && (
                <span className="ph-row">
                  <em className="ph-ex nxt">NXT</em>
                  {sameAsKrx ? (
                    <b className="ph-value pt-n">= KRX</b>
                  ) : (
                    <>
                      <b className={`ph-value ${nv.cls}`}>{fmtNum(it.nxtValue)}</b>
                      {nv.rate && <em className={`ph-pct ${nv.cls}`}>{nv.rate}</em>}
                    </>
                  )}
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
        {/*
          **회전율** — 그 종목 치고 얼마나 돌았나.

          거래대금만 보면 큰 종목이 늘 위에 있다. 삼성전자 2조와 소형주 500억은
          견줄 수가 없는데, 회전율로 보면 **주인이 하루에 몇 번 바뀌었나**가 나온다.
          시세분석 표에는 이미 있는데 정작 종목을 열면 없었다.

          `ka10007` 이 상장주식수를 주므로 조회가 안 는다.
        */}
        <div className="ph-cell">
          <span className="ph-label" title="오늘 거래량 ÷ 상장주식수. 5% 면 활발한 편입니다">
            회전율
          </span>
          <span className="ph-row">
            <span className={`ph-value ${turnover !== null && turnover >= 5 ? "positive" : ""}`}>
              {turnover === null ? "-" : `${turnover.toFixed(turnover >= 10 ? 0 : 2)}%`}
            </span>
          </span>
          <span className="ph-row">
            <em className="ph-sublabel">상장주식</em>
            <span className="ph-value sub">
              {shares === null ? "-" : `${fmtNum(Math.round(shares / 10000))}만주`}
            </span>
          </span>
        </div>
        <div className="ph-cell">
          <span className="ph-label">거래량</span>
          <span className="ph-row">
            <span className="ph-value">{fmtNum(fill(info.trde_qty, last?.volume))}</span>
          </span>
          {/*
            ⚠️ **NXT 몫을 따로 적는다.**

            거래량·거래대금이 `ka10001` **KRX 조회 하나**에서만 왔다. 그래서 08~09시
            NXT 프리마켓에는 KRX 가 장전 시간외 몇 백 주뿐이라 화면에 **「거래량 190 ·
            거래대금 0억」**이 떴다 — 정작 그 시간에 실제로 도는 건 NXT 쪽이다.
            시·고·저는 이미 KRX/NXT 를 갈라 적고 있었는데 여기만 안 갈라져 있었다.

            ⚠️ **거래량은 줄어들지 않으므로** 한 번 뜨면 계속 뜬다 — 여기서는
            나타났다 사라지는 일이 안 생긴다. 가격과 달리 누적값이라서다.
          */}
          {nxt?.volume != null && nxt.volume > 0 && (
            <span className="ph-row">
              <em className="ph-sublabel nxt">NXT</em>
              <span className="ph-value sub">{fmtNum(nxt.volume)}</span>
            </span>
          )}
          {/*
            거래량 바로 밑에 거래대금. 주식 수만 보면 감이 안 온다 —
            80만주가 1,800억인 종목과 8억인 종목이 화면에서 똑같이 생겼다.
          */}
          <span className="ph-row">
            <em className="ph-sublabel">거래대금</em>
            <span className="ph-value sub">
              {krxValue === null ? "-" : `${Math.round(krxValue / 100).toLocaleString("ko-KR")}억`}
            </span>
          </span>
          {nxt?.tradeValue != null && nxt.tradeValue > 0 && (
            <span className="ph-row">
              <em className="ph-sublabel nxt">NXT</em>
              <span className="ph-value sub">
                {Math.round(nxt.tradeValue / 100).toLocaleString("ko-KR")}억
              </span>
            </span>
          )}
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
        {/*
          **몸집과 값** — 키움이 `ka10001` 에서 같이 주는데 여태 안 쓰고 있었다.
          재무 탭에 있긴 했지만, 종목을 처음 열었을 때 「이게 얼마짜리 회사인가」는
          시가·고가와 같은 층의 질문이다. 탭을 옮겨서 볼 값이 아니다.

          PER 은 **적자면 안 나온다**(음수거나 빈 값). 그때 0 을 적으면 「값이 싸다」로
          읽히므로 아예 안 적는다 — 없는 걸 있는 척하는 게 제일 나쁘다.
        */}
        <div className="ph-cell">
          <span className="ph-label">시가총액</span>
          <span className="ph-row">
            <span className="ph-value">{eok(info.mac)}</span>
          </span>
          <span className="ph-row">
            <em className="ph-sublabel" title="주가 ÷ 주당순이익. 적자면 안 나옵니다">
              PER
            </em>
            <span className="ph-value sub">{ratio(info.per)}</span>
          </span>
          <span className="ph-row">
            <em className="ph-sublabel" title="주가 ÷ 주당순자산. 1 보다 낮으면 장부가 아래">
              PBR
            </em>
            <span className="ph-value sub">{ratio(info.pbr)}</span>
          </span>
        </div>
      </div>
      {/* 오늘 하루만 보면 흐름을 못 읽는다 — 아래에 기간별 상승률을 붙인다 */}
      {code && <PeriodReturns code={code} onTradeValue={setLast} />}
    </div>
  );
}
