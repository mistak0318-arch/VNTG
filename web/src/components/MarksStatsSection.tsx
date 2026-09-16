import { useEffect, useState } from "react";
import { api, type MarksStats } from "../api";

/**
 * **전종목 마크 집계** — 데일리 리포트 (2026-09-16, 벤티지가 업그레이드 방향에서 고름).
 *
 * 마감 뒤 정리 ⑧이 2,600종목에 마크를 붙이면서 「오늘 시장에 쌍끌이가 몇 종목인가」를 처음으로 셀 수 있게
 * 됐다. 시장 체온계가 **폭**(몇 종목이 올랐나)이라면 이건 **수급·추세의 폭**이다 — 쌍끌이 종목 수가 늘면
 * 외국인·주포가 넓게 사는 장이고, 탈락 경보(σ·진폭 과열) 수가 늘면 판이 뜨거운 것이다.
 * 어제 수를 나란히 둔다 — 절대 수보다 **늘었나 줄었나**가 뜻이다.
 */
const ROWS: { key: keyof MarksStats["counts"]; label: string; hint: string }[] = [
  { key: "twin", label: "🧲 쌍끌이", hint: "외국인·주포 5·10·20일 여섯 칸 전부 순매수" },
  { key: "fgn3", label: "외국인 3칸", hint: "외국인 5·10·20일 전부 순매수" },
  { key: "trend", label: "정배열", hint: "종가 > 5 > 20 > 60일선" },
  { key: "newHigh250", label: "250일 신고가", hint: "종가가 1년 최고 고가 이상" },
  { key: "hot", label: "🔥 쏠림 경보", hint: "회전율·진폭·거래량·갭·변동성 중 하나라도" },
  { key: "kill", label: "탈락 경보", hint: "σ20 7%↑ · 진폭 12%↑ · 약세장 RS60 · 저점 +50%" },
  { key: "super", label: "🌟 슈퍼신호등", hint: "활성 편입" },
];

export function MarksStatsSection() {
  const [s, setS] = useState<MarksStats | null>(null);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => {
    let alive = true;
    api
      .marksStats()
      .then((r) => alive && setS(r))
      .catch((e: Error) => alive && setErr(e.message));
    return () => {
      alive = false;
    };
  }, []);
  if (err) return <p className="pt-n">마크 집계를 못 받았습니다 — {err}</p>;
  if (!s) return <p className="pt-n">불러오는 중…</p>;
  if (!s.day) return <p className="pt-n">아직 마크가 없습니다 — 마감 뒤 정리 ⑧이 돌면 채워집니다.</p>;
  const prev = s.prev?.counts;
  const diff = (k: keyof MarksStats["counts"]) => {
    if (!prev) return null;
    const d = s.counts[k] - prev[k];
    return d === 0 ? "±0" : `${d > 0 ? "+" : ""}${d}`;
  };
  return (
    <div className="mks">
      <p className="pt-n">
        {s.day.replace(/(\d{4})(\d{2})(\d{2})/, "$1-$2-$3")} 마감 기준 · {s.total.toLocaleString("ko-KR")}종목
        {s.prev ? ` · 괄호는 전 거래일(${s.prev.day.slice(4, 6)}/${s.prev.day.slice(6, 8)}) 대비` : ""}
      </p>
      <div className="mks-grid">
        {ROWS.map((r) => (
          <div className="mks-cell" key={r.key} title={r.hint}>
            <span className="mks-k">{r.label}</span>
            <b className="num">{s.counts[r.key].toLocaleString("ko-KR")}</b>
            {diff(r.key) !== null && <i className={`num ${(s.counts[r.key] - (prev?.[r.key] ?? 0)) > 0 ? "up" : (s.counts[r.key] - (prev?.[r.key] ?? 0)) < 0 ? "down" : ""}`}>({diff(r.key)})</i>}
          </div>
        ))}
      </div>
      <p className="table-note">
        조회 0회로 전 종목을 세어 둔 것입니다. 쌍끌이 수가 늘면 외국인·주포가 <b>넓게</b> 사는 장, 탈락 경보 수가 늘면 판이
        뜨거운 것입니다. 신호등 점수에는 안 들어갑니다(12월까지 동결) — 조건 검색 「마크」 묶음으로 종목을 고를 수 있습니다.
      </p>
    </div>
  );
}
