import { useEffect, useState } from "react";
import { api, type IndexDetailData } from "../api";
import { winStore } from "../boardStore";
import { CandleChart } from "./CandleChart";

/**
 * 지수 차트 **칸** — 보드에 놓는 코스피·코스닥 봉차트.
 *
 * ## 왜 칸으로 따로 두나
 *
 * 지수 상세는 시트(모달)로만 볼 수 있었다. 열면 화면을 덮으므로 **띄워 놓고 곁눈으로
 * 볼 수가 없다.** 그런데 지수는 종목을 보는 내내 옆에 있어야 하는 값이다 — 내 종목이
 * 빠지는 게 저 혼자 빠지는 것인지 판이 빠지는 것인지는 지수를 봐야 갈린다.
 *
 * ## 칸마다 다른 지수
 *
 * 어느 지수를 볼지는 **칸 이름으로 기억한다.** 그래서 왼쪽 칸은 코스피, 오른쪽 칸은
 * 코스닥으로 둘 수 있다. 차트 칸이 봉을 기억하는 것과 같은 방식이다.
 *
 * ## 종목과 무관하다
 *
 * 보드에서 종목을 바꿔도 이 칸은 안 바뀐다. 지수판·시장 신호등과 같은 층이다.
 */

const INDICES: { code: string; label: string }[] = [
  { code: "001", label: "코스피" },
  { code: "101", label: "코스닥" },
];

/** 어느 구간을 볼지 — 지수 상세 시트와 같은 눈금 */
const RANGES: { key: "day" | "week" | "month"; label: string; show: number }[] = [
  { key: "day", label: "일봉", show: 120 },
  { key: "week", label: "주봉", show: 104 },
  { key: "month", label: "월봉", show: 60 },
];

function sign(v: number): string {
  return v > 0 ? "positive" : v < 0 ? "negative" : "";
}

export function IndexChartCell({ viewId, height }: { viewId?: string; height?: number }) {
  /*
   * 무엇을 보고 있었나.
   *
   * **창별로 적는다**(`winStore`). 「이 창이 지금 뭘 띄우고 있나」는 그 창의 사정이라,
   * 전역에 두면 창을 두 개 띄워 하나는 코스피 하나는 코스닥으로 보려던 게 안 된다 —
   * 한쪽을 바꾸면 다른 쪽이 따라 바뀐다. 보드의 다른 상태들과 같은 규칙이다.
   *
   * 읽기는 **동기**여야 한다. 나중에 도착하면 코스피가 한 번 그려진 뒤에 코스닥으로
   * 바뀌어 깜빡인다.
   */
  const key = viewId ? `vntg.indexcell.${viewId}` : "";
  const saved = (): { code?: string; range?: string } => {
    if (!key) return {};
    try {
      return JSON.parse(winStore.get(key) ?? "{}") as Record<string, never>;
    } catch {
      return {};
    }
  };

  const [code, setCode] = useState<string>(() => {
    const c = saved().code;
    return INDICES.some((i) => i.code === c) ? (c as string) : "001";
  });
  const [range, setRange] = useState<"day" | "week" | "month">(() => {
    const r = saved().range;
    return RANGES.some((x) => x.key === r) ? (r as "day" | "week" | "month") : "day";
  });
  const [data, setData] = useState<IndexDetailData | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!key) return;
    winStore.set(key, JSON.stringify({ code, range }));
  }, [key, code, range]);

  useEffect(() => {
    let alive = true;
    setData(null);
    setError(null);
    api
      .indexDetail(code, range)
      .then((d) => alive && setData(d))
      .catch((e: Error) => alive && setError(e.message));
    return () => {
      alive = false;
    };
  }, [code, range]);

  const show = RANGES.find((r) => r.key === range)?.show ?? 120;
  const candles = (data?.candles ?? []).slice(-show);
  const last = candles[candles.length - 1];
  const prev = candles[candles.length - 2];
  const diff = last && prev ? last.close - prev.close : 0;
  const rate = last && prev && prev.close > 0 ? (diff / prev.close) * 100 : 0;

  return (
    <div className="idxc">
      <div className="filter-row idxc-bar">
        {INDICES.map((i) => (
          <button
            key={i.code}
            className={`filter-btn ${code === i.code ? "active" : ""}`}
            onClick={() => setCode(i.code)}
          >
            {i.label}
          </button>
        ))}
        <span className="idxc-sep" />
        {RANGES.map((r) => (
          <button
            key={r.key}
            className={`filter-btn ${range === r.key ? "active" : ""}`}
            onClick={() => setRange(r.key)}
          >
            {r.label}
          </button>
        ))}
        {last && (
          <b className={`idxc-now num ${sign(diff)}`}>
            {last.close.toFixed(2)}
            <span className="idxc-rate">
              {" "}
              {diff > 0 ? "+" : ""}
              {rate.toFixed(2)}%
            </span>
          </b>
        )}
      </div>

      {error && <div className="error-banner">{error}</div>}
      {!data && !error && <div className="empty">불러오는 중…</div>}

      {/*
        봉차트다. 종가만 이으면 흐름은 보여도 **꼬리가 안 보인다** — 아래로 길게
        찔렀다 올라온 날과 그냥 오른 날은 완전히 다른 뜻인데 선차트에서는 똑같이 생긴다.
        지수엔 거래량이 없어 0 을 넣는다 — 거래량 막대는 그려지지 않는다.
      */}
      {candles.length > 1 && (
        <CandleChart
          name={data?.name}
          showExtremes
          height={height}
          /* 지수나 구간을 바꾸면 시간축을 다시 맞춘다 — 안 그러면 예전 자리에 남는다 */
          fitKey={`${code}:${range}`}
          candles={candles.map((c) => ({
            time: {
              year: Number(c.dt.slice(0, 4)),
              month: Number(c.dt.slice(4, 6)),
              day: Number(c.dt.slice(6, 8)),
            },
            open: c.open,
            high: c.high,
            low: c.low,
            close: c.close,
            volume: 0,
          }))}
        />
      )}
    </div>
  );
}
