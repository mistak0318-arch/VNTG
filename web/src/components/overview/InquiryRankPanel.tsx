import { useEffect, useState } from "react";
import { api, type RankResult } from "../../api";

/**
 * 실시간 조회순위 — 시황 카드 (2026-09-10 저녁 — 벤티지: "차라리 주도주가 여기에 와야지. 실시간 조회순위나").
 *
 * 키움 고객이 **지금 어떤 종목을 들여다보는가** 스무 줄 중 위 열. 시세분석의 그 표(ka00198, 1분 기준)와
 * 같은 응답이라 조회가 늘지 않는다(서버 캐시). 「NEW」는 직전 집계에 없던 종목, 화살표는 순위 변동.
 * 눌러서 종목 상세. 전부는 시세분석 › 실시간 조회순위.
 */
type Row = RankResult["rows"][number];

export function InquiryRankPanel({ onSelectStock }: { onSelectStock: (code: string, name: string) => void }) {
  const [rows, setRows] = useState<Row[]>([]);
  const [note, setNote] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => {
    let alive = true;
    const load = () =>
      api
        .rank("inquiry-rank", "000", "3", 20, { qry_tp: "1" })
        .then((r) => {
          if (!alive) return;
          setRows(r.rows.slice(0, 10));
          setNote(r.note ?? null);
          setErr(null);
        })
        .catch((e: Error) => alive && setErr(e.message));
    void load();
    const t = setInterval(() => void load(), 60_000);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, []);
  if (err && rows.length === 0) return <div className="error-banner">{err}</div>;
  if (rows.length === 0) return <div className="empty">불러오는 중…</div>;
  const num = (v: unknown) => {
    const n = Number(v);
    return Number.isFinite(n) ? n : 0;
  };
  return (
    <div className="iq">
      <div className="iq-list">
        {rows.map((r, i) => {
          const rate = num(r.flu_rt);
          const chg = num(r.rank_chg);
          const rank = num(r.rank) || i + 1;
          return (
            <button type="button" className="iq-row" key={r.code} onClick={() => onSelectStock(r.code, r.name)} title={`${r.name} ${Math.abs(num(r.cur_prc)).toLocaleString("ko-KR")}`}>
              <span className="iq-rank num">{rank}</span>
              <span className="iq-name">
                {r.name}
                {r.enteredAt && <i className="scr-new">NEW</i>}
              </span>
              <span className={`iq-chg num ${chg > 0 ? "positive" : chg < 0 ? "negative" : "pt-n"}`}>{chg > 0 ? `▲${chg}` : chg < 0 ? `▼${-chg}` : "–"}</span>
              <span className={`iq-rate num ${rate > 0 ? "positive" : rate < 0 ? "negative" : ""}`}>
                {rate > 0 ? "+" : ""}
                {rate.toFixed(2)}%
              </span>
            </button>
          );
        })}
      </div>
      <div className="pulse-foot pt-n">
        키움 고객 조회순위 · 1분 기준 · ▲▼ 는 직전 집계 대비 · NEW 는 새로 들어온 종목 · 전부는 시세분석
        {note && <span className="negative"> · {note}</span>}
      </div>
    </div>
  );
}
