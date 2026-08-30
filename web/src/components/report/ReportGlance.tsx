import { useEffect, useState } from "react";
import { api, type GlobalQuote, type IndexCard, type MarketFlow } from "../../api";

/**
 * 리포트 한눈 스트립 (2026-08-30 확장 — 「마켓브리핑에 나오는 거래대금이나 상승종목,
 * 야간선물, 미국 선물지수 VIX 유가도 브리프하게 · 기준날짜 꼭 적어주고」).
 *
 * ## 왜 두 덩어리로 나누나
 *
 * 예전엔 다섯 칩이 한 줄이었다. 거기에 야간선물·VIX·유가를 그냥 이어 붙이면
 * **기준 시점이 다른 값이 한 줄에 섞인다.** 코스피는 어제 3시 반에 굳은 값이고
 * 야간선물은 지금 이 순간 움직이는 값이다. 같은 줄에 두면 읽는 사람이 둘 다
 * 「오늘」로 읽는다 — 조간에 그건 판단을 틀리게 만든다.
 *
 * 그래서 **국내 마감**과 **밤사이**를 갈라 놓고, 각 덩어리에 제 기준을 적는다.
 * 「기준날짜 꼭 적어주고」가 바로 이 이야기다.
 *
 * ## 조회는 두 번만 는다
 *
 * 지수·환율·수급·야간선물·미국선물·VIX·유가는 **이미 받아 둔 값**이다(g·idx·f).
 * 상승/하락 종목 수도 지수 카드 안에 이미 들어 있다. 새로 받는 건 거래대금뿐이고,
 * 그것도 시황·브리핑이 쓰는 지수 일봉이라 서버 캐시를 같이 쓴다.
 */

function fmtNum(v: number | null | undefined): string {
  if (v == null || !Number.isFinite(v)) return "-";
  return v.toLocaleString("ko-KR", { maximumFractionDigits: 2 });
}

function pct(v: number | null | undefined): string {
  if (v == null || !Number.isFinite(v)) return "-";
  return `${v > 0 ? "+" : ""}${v.toFixed(2)}%`;
}

function sign(v: number | null | undefined): string {
  if (v == null || !Number.isFinite(v) || v === 0) return "";
  return v > 0 ? "positive" : "negative";
}

/** 억 단위를 조로 접는다 — 「8,412억」보다 「8.4조」가 한눈에 들어온다 */
function eok(v: number): string {
  if (v >= 10_000) return `${(v / 10_000).toFixed(1)}조`;
  return `${fmtNum(Math.round(v))}억`;
}

/** 20260828 → 8/28(금). 일봉이 주는 형식이 그것이다 */
function dayLabel(dt: string): string {
  const m = /^(\d{4})(\d{2})(\d{2})$/.exec(dt);
  if (!m) return dt;
  const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  const w = ["일", "월", "화", "수", "목", "금", "토"][d.getDay()];
  return `${Number(m[2])}/${Number(m[3])}(${w})`;
}

interface Chip {
  k: string;
  v: string;
  s?: number | null;
  /** 값 밑에 붙는 잔글씨 — 「20일 평균의 112%」처럼 뜻을 붙일 때 */
  sub?: string;
}

function ChipRow({ title, note, chips }: { title: string; note: string; chips: Chip[] }) {
  if (chips.length === 0) return null;
  return (
    <div className="rp-glance-band">
      <div className="rp-glance-head">
        <b>{title}</b>
        <span>{note}</span>
      </div>
      <div className="rp-glance">
        {chips.map((c) => (
          <span className="rp-glance-chip" key={c.k}>
            {/* 이름·값은 한 줄로 붙여 둔다 — 잔글씨가 그 사이를 벌리면 눈이 끊긴다 */}
            <span className="rp-glance-main">
              <em>{c.k}</em>
              <b className={sign(c.s)}>{c.v}</b>
            </span>
            {c.sub && <i className="rp-glance-sub">{c.sub}</i>}
          </span>
        ))}
      </div>
    </div>
  );
}

export function ReportGlance({
  idx,
  g,
  f,
}: {
  idx: IndexCard[];
  g: GlobalQuote[];
  f: MarketFlow | null | undefined;
}) {
  /** 거래대금 — 시장별 오늘 값과 20일 평균 대비, 그리고 **기준 거래일** */
  const [turn, setTurn] = useState<
    { name: string; today: number; avg: number; dt: string; close: number; rate: number | null }[] | null
  >(null);

  useEffect(() => {
    let alive = true;
    (async () => {
      const out: { name: string; today: number; avg: number; dt: string; close: number; rate: number | null }[] = [];
      for (const m of [
        { code: "001", name: "코스피" },
        { code: "101", name: "코스닥" },
      ]) {
        try {
          const r = await api.indexDetail(m.code, "day");
          /*
           * ⚠️ **거래가 없는 봉은 버린다** (2026-08-31).
           *
           * 키움 일봉은 **장 전에도 오늘 봉을 준다.** 거래대금 0, 등락 0 인 껍데기다.
           * 그대로 마지막 봉으로 쓰면 기준일이 「8/31(월) 종가 기준」으로 찍히고
           * 거래대금이 0억, 20일 평균의 0% 로 나온다 — 값은 8/28 종가인데 날짜와
           * 등락만 오늘 것인 **앞뒤가 안 맞는 줄**이 조간마다 나갔다.
           *
           * 거래대금이 0인 날은 장이 안 섰거나 아직 안 끝난 날이다. 둘 다 「마감」이
           * 아니므로 마감 줄에 쓸 수 없다.
           */
          const cs = r.candles.filter((c) => c.tradeValue > 0);
          if (cs.length === 0) continue;
          const last = cs[cs.length - 1];
          const prev20 = cs.slice(-21, -1);
          const avg =
            prev20.length > 0 ? prev20.reduce((a, c) => a + c.tradeValue, 0) / prev20.length : 0;
          const prev = cs[cs.length - 2];
          out.push({
            name: m.name,
            today: last.tradeValue,
            avg,
            dt: last.dt,
            /*
             * 종가·등락률도 **같은 봉에서** 낸다 (2026-08-31).
             * 지수 카드(`idx`)는 장 전에 등락 0 으로 오는데, 값은 지난 종가라
             * 「6,788.88 (0.00%)」처럼 한 줄 안에서 앞뒤가 안 맞았다.
             */
            close: last.close,
            rate: prev && prev.close > 0 ? ((last.close - prev.close) / prev.close) * 100 : null,
          });
        } catch {
          /* 한 시장을 못 받아도 나머지는 보여 준다 */
        }
      }
      if (alive) setTurn(out);
    })();
    return () => {
      alive = false;
    };
  }, []);

  const kospi = idx.find((c) => /^KOSPI$|^코스피$/i.test(c.name));
  const kosdaq = idx.find((c) => /^KOSDAQ$|^코스닥$/i.test(c.name));
  const usd = g.find((q) => q.key === "usdkrw");

  /* ── 국내 마감 ── */
  const kr: Chip[] = [];
  /* 일봉에서 낸 값을 먼저 쓴다 — 없을 때만 지수 카드로 물러선다 */
  const byName = new Map((turn ?? []).map((t) => [t.name, t]));
  const idxChip = (label: string, card: IndexCard | undefined) => {
    const t = byName.get(label);
    const price = t ? t.close : card?.price;
    const rate = t && t.rate !== null ? t.rate : card?.changeRate;
    if (price == null) return;
    kr.push({ k: label, v: `${fmtNum(price)} (${pct(rate ?? null)})`, s: rate ?? null });
  };
  idxChip("코스피", kospi);
  idxChip("코스닥", kosdaq);

  if (turn && turn.length > 0) {
    const total = turn.reduce((a, t) => a + t.today, 0);
    /*
     * 20일 평균 대비를 잔글씨로 붙인다. 「26.6조」는 평소를 알아야 뜻이 생긴다 —
     * 같은 26조라도 평균의 70%면 식은 장이고 130%면 달아오른 장이다.
     *
     * ⚠️ 두 시장의 **퍼센트를 평균 내면 안 된다.** 코스피가 코스닥의 네 배라
     * 「코스피 78% · 코스닥 84%」의 평균 81% 는 코스피의 무게를 지운 숫자다.
     * 합계끼리 나눠야 「시장 전체에 돈이 평소만큼 도나」라는 물음의 답이 된다.
     */
    const avgTotal = turn.reduce((a, t) => a + t.avg, 0);
    const vsAvg = avgTotal > 0 ? Math.round((total / avgTotal) * 100) : null;
    kr.push({
      k: "거래대금",
      v: eok(total),
      sub: [
        turn.map((t) => `${t.name} ${eok(t.today)}`).join(" · "),
        vsAvg == null ? null : `20일 평균의 ${vsAvg}%`,
      ]
        .filter(Boolean)
        .join(" / "),
    });
  }

  /*
   * 상승·하락 종목 수 — 지수가 올라도 오른 종목이 적으면 「몇 개가 끌어올린 장」이다.
   * 두 시장을 합쳐서 본다. 상한가·하한가는 따로 세지 않는다(칩이 길어진다).
   */
  const rising = (kospi?.rising ?? 0) + (kosdaq?.rising ?? 0);
  const falling = (kospi?.falling ?? 0) + (kosdaq?.falling ?? 0);
  if (rising + falling > 0) {
    kr.push({
      k: "상승·하락",
      v: `${fmtNum(rising)} : ${fmtNum(falling)}`,
      s: rising - falling,
      sub: `상승 ${Math.round((rising / (rising + falling)) * 100)}%`,
    });
  }

  /*
   * ⚠️ **「0억」과 「아직 안 나옴」은 다르다** (2026-08-31).
   *
   * 장 전에는 수급이 전부 0 으로 온다. 그걸 그대로 「외국인 0억 · 기관 0억」이라
   * 적으면 **오늘 아무도 안 샀다**는 말이 된다 — 조간에 그건 거짓 정보다.
   * 열두 주체가 모두 정확히 0 이면 그것은 값이 아니라 빈칸이다.
   */
  const frg = f ? f.kospi.foreign + f.kosdaq.foreign : 0;
  const inst = f ? f.kospi.institution + f.kosdaq.institution : 0;
  const indiv = f ? f.kospi.individual + f.kosdaq.individual : 0;
  const flowEmpty = !f || (frg === 0 && inst === 0 && indiv === 0);
  if (!flowEmpty) {
    kr.push({ k: "외국인", v: `${frg > 0 ? "+" : ""}${fmtNum(Math.round(frg))}억`, s: frg });
    kr.push({ k: "기관", v: `${inst > 0 ? "+" : ""}${fmtNum(Math.round(inst))}억`, s: inst });
  }

  /* ── 밤사이 ── */
  const night: Chip[] = [];
  const add = (key: string, label: string, digits = 2) => {
    const q = g.find((x) => x.key === key);
    if (!q || q.price == null) return;
    night.push({
      k: label,
      v: `${q.price.toLocaleString("ko-KR", { maximumFractionDigits: digits })}${
        q.changeRate == null ? "" : ` (${pct(q.changeRate)})`
      }`,
      s: q.changeRate,
    });
  };
  add("krNightFut", "코스피 야간선물");
  add("esF", "S&P500 선물", 0);
  add("nqF", "나스닥 선물", 0);
  add("vix", "VIX");
  add("wti", "WTI 유가");
  if (usd?.price != null) {
    night.push({
      k: "달러/원",
      v: `${fmtNum(usd.price)}${usd.changeRate == null ? "" : ` (${pct(usd.changeRate)})`}`,
      s: usd.changeRate,
    });
  }

  if (kr.length === 0 && night.length === 0) return null;

  /*
   * 기준일. 거래대금을 받아 온 일봉의 **마지막 거래일**이 국내 값의 기준이다.
   * 못 받았으면 날짜를 지어내지 않고 「최근 거래일」이라고만 적는다 — 틀린 날짜가
   * 날짜 없는 것보다 나쁘다.
   */
  const base = turn && turn.length > 0 ? dayLabel(turn[0].dt) : null;

  return (
    <div className="rp-glance-wrap">
      <ChipRow
        title="국내 마감"
        note={
          (base ? `${base} 종가 기준` : "최근 거래일 종가 기준") +
          /* 빠진 것을 밝힌다 — 없는 줄을 조용히 지우면 왜 없는지 알 수 없다 */
          (flowEmpty ? " · 수급은 장 마감 뒤에 들어옵니다" : "") +
          (rising + falling === 0 ? " · 등락 종목 수 집계 전" : "")
        }
        chips={kr}
      />
      <ChipRow title="밤사이" note="지금 시각 기준 · 오늘 개장의 예고편" chips={night} />
    </div>
  );
}
