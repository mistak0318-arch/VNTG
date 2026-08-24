import { useEffect, useState } from "react";
import { api, type FlowIntradayDay, type FlowSample } from "../../api";

/**
 * 장중 수급 변화.
 *
 * 위의 막대는 "오늘 외국인 +801억" 하나만 말해 준다. 그런데 그 숫자만으론
 * **오전에 팔다 오후에 산 날**과 **하루 종일 판 날**을 구분할 수 없다.
 * 방향이 바뀐 지점이 보여야 "왜 올랐나"에 답할 수 있다.
 *
 * 선은 셋만 그린다 — 외국인·기관·개인. 열두 주체를 다 그리면 아무것도 안 읽힌다.
 * 0 선을 굵게 두는 게 중요하다. **부호가 바뀌는 순간**이 이 그림의 전부다.
 */

/* 순서는 **개인·외국인·기관** — 다른 수급 화면과 같아야 눈이 헤매지 않는다 */
const SERIES = [
  { key: "individual" as const, label: "개인", color: "#ff5c5c" },
  { key: "foreign" as const, label: "외국인", color: "#4c8dff" },
  { key: "institution" as const, label: "기관", color: "#f5c542" },
];

const W = 560;
const H = 132;
const PAD = { l: 4, r: 4, t: 8, b: 16 };

function path(rows: FlowSample[], key: (typeof SERIES)[number]["key"], min: number, max: number) {
  if (rows.length < 2) return "";
  const span = max - min || 1;
  const iw = W - PAD.l - PAD.r;
  const ih = H - PAD.t - PAD.b;
  return rows
    .map((r, i) => {
      const x = PAD.l + (i / (rows.length - 1)) * iw;
      const y = PAD.t + ih - ((r[key] - min) / span) * ih;
      return `${i === 0 ? "M" : "L"}${x.toFixed(1)},${y.toFixed(1)}`;
    })
    .join(" ");
}

export function FlowIntradayChart({ market }: { market: "kospi" | "kosdaq" }) {
  const [day, setDay] = useState<FlowIntradayDay | null>(null);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    let alive = true;
    api
      .flowIntraday()
      .then((r) => {
        if (!alive) return;
        setDay(r.day);
        setLoaded(true);
      })
      .catch(() => alive && setLoaded(true));
    // 수급 자체가 1분 주기라 그림도 그 정도면 충분하다
    const timer = setInterval(() => {
      api
        .flowIntraday()
        .then((r) => alive && setDay(r.day))
        .catch(() => undefined);
    }, 60_000);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, []);

  const rows = (day?.[market] ?? []).filter((r) => r && r.t);
  if (!loaded) return null;
  if (rows.length < 2) {
    return (
      <div className="table-note">
        장중 수급 변화는 <b>서버가 켜져 있는 동안</b> 1분마다 쌓입니다. 아직 표본이 모자랍니다
        — 장이 열리면 그려집니다.
      </div>
    );
  }

  const all = rows.flatMap((r) => SERIES.map((s) => r[s.key]));
  // 0 이 반드시 화면 안에 있어야 한다 — 부호가 바뀌는 순간을 보려는 그림이다
  const min = Math.min(0, ...all);
  const max = Math.max(0, ...all);
  const span = max - min || 1;
  const zeroY = PAD.t + (H - PAD.t - PAD.b) - ((0 - min) / span) * (H - PAD.t - PAD.b);

  return (
    <div className="fi-wrap">
      <svg viewBox={`0 0 ${W} ${H}`} className="fi-svg" preserveAspectRatio="none">
        <line x1={PAD.l} x2={W - PAD.r} y1={zeroY} y2={zeroY} className="fi-zero" />
        {SERIES.map((s) => (
          <path key={s.key} d={path(rows, s.key, min, max)} fill="none" stroke={s.color} strokeWidth={1.6} />
        ))}
      </svg>
      <div className="fi-legend">
        {SERIES.map((s) => {
          const last = rows[rows.length - 1][s.key];
          return (
            <span key={s.key}>
              <i style={{ background: s.color }} />
              {s.label}
              <b className={last > 0 ? "positive" : last < 0 ? "negative" : ""}>
                {last > 0 ? "+" : ""}
                {Math.round(last).toLocaleString("ko-KR")}
              </b>
            </span>
          );
        })}
        <span className="pt-n">
          {rows[0].t.slice(0, 2)}:{rows[0].t.slice(2)} ~ {rows[rows.length - 1].t.slice(0, 2)}:
          {rows[rows.length - 1].t.slice(2)} · 억원 누적
        </span>
      </div>
    </div>
  );
}
