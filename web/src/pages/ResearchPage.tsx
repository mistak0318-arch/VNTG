import { useEffect, useState } from "react";
import { api, normalizeStockCode, type ResearchBoard, type ResearchItem } from "../api";

/**
 * **리서치** — 증권사 보고서를 「어디를 보고 있나」로 읽는 자리 (2026-09-16).
 *
 * 벤티지가 네이버 증권 개편판을 훑어 보라고 해서 넣은 넷 중 하나. 보고서 자체는 우리가 읽어 줄 수 없지만
 * (본문은 PDF고, 우리는 긁지 않는다) **목록만으로도 답이 나오는 물음**이 셋 있다:
 *
 *   ① **목표주가가 바뀐 곳** — 애널리스트가 생각을 고친 종목. 올린 쪽·내린 쪽을 같이 본다.
 *   ② **보고서가 몰린 산업** — 일주일 치를 세면 시장이 지금 어디를 들여다보는지가 나온다.
 *   ③ **많이 읽힌 보고서** — 남들이 무엇을 읽고 있나. 화제 레이더의 「기사」와는 다른 눈이다.
 *
 * ⚠️ 목표주가는 **애널리스트 의견**이다. 신호등 점수에는 안 들어간다(문턱·무게 12월까지 동결).
 * 오른 목표주가를 근거로 사는 게 아니라, **왜 고쳤는지 찾아보라는 실마리**로 쓴다.
 */

const TYPE_LABEL: Record<string, string> = {
  company: "종목",
  industry: "산업",
  market: "시황",
  invest: "투자정보",
  economy: "경제",
  debenture: "채권",
};

function fmtDate(s: string): string {
  return s.length >= 10 ? s.slice(5, 10).replace("-", "/") : s;
}
function fmtNum(v: number | null): string {
  return v === null ? "-" : Math.round(v).toLocaleString("ko-KR");
}

export function ResearchPage({ onSelectStock }: { onSelectStock: (code: string, name: string) => void }) {
  const [board, setBoard] = useState<ResearchBoard | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [dir, setDir] = useState<"up" | "down">("up");
  const [type, setType] = useState<string>("company");
  const [open, setOpen] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    api
      .naverResearch()
      .then((r) => alive && setBoard(r))
      .catch((e: Error) => alive && setError(e.message));
    return () => {
      alive = false;
    };
  }, []);

  if (error) return <div className="page-note">네이버 리서치를 못 받았습니다 — {error}</div>;
  if (!board) return <div className="page-note">불러오는 중…</div>;

  const goals = dir === "up" ? board.goalUp : board.goalDown;
  const today = new Date(Date.now() + 9 * 3600_000).toISOString().slice(0, 10);
  const goalDay = goals[0]?.date.slice(0, 10) ?? "";
  /* 「기타」는 빼고 센다 — 늘 1위인데 「애널리스트가 기타를 봤다」는 아무 말도 아니다 */
  const industries = board.industries.filter((i) => i.name !== "기타" && i.name !== "");
  const maxCount = Math.max(1, ...industries.map((i) => i.count));
  const item = (r: ResearchItem) => (
    <div className={`rsc-item${open === r.nid ? " open" : ""}`} key={r.nid}>
      <button type="button" className="rsc-item-h" onClick={() => setOpen(open === r.nid ? null : r.nid)}>
        <span className="rsc-t">{r.title}</span>
        <span className="rsc-m">
          {r.name && <b>{r.name}</b>}
          {r.industry && <i>{r.industry}</i>}
          {r.broker} · {fmtDate(r.date)}
          {r.reads !== null && <em>👁 {r.reads.toLocaleString("ko-KR")}</em>}
        </span>
      </button>
      {open === r.nid && (
        <div className="rsc-body">
          {r.body ? <p>{r.body}</p> : <p className="quiet">요약이 없는 보고서입니다.</p>}
          {r.code && (
            <button type="button" className="link-btn" onClick={() => onSelectStock(normalizeStockCode(r.code!), r.name ?? r.code!)}>
              {r.name ?? r.code} 종목 분석 →
            </button>
          )}
        </div>
      )}
    </div>
  );

  return (
    <div className="page rsc">
      <p className="page-note">
        증권사 보고서를 <b>목록으로</b> 읽습니다 — 목표주가를 고친 곳, 보고서가 몰린 산업, 많이 읽힌 것.
        본문은 증권사 PDF 라 여기서는 요약까지만 봅니다. <b>애널리스트 의견</b>이지 매매 근거가 아닙니다
        {board.stale && " · 지금은 새로 못 받아 옛 값입니다"}.
      </p>

      <section className="card">
        {/*
          날짜를 꼭 적는다 — 네이버는 **오늘치만** 주고, 보고서가 나오기 전(아침 8시대)에는 빈 응답이
          온다. 그때 서버가 마지막으로 채워졌던 날 것을 그대로 돌려주므로(naverMarket 주석), 날짜가
          없으면 어제 것을 오늘 것으로 읽게 된다.
        */}
        <h3>
          목표주가를 고친 곳
          {goalDay && <span className="rsc-when">{goalDay === today ? "오늘" : `${goalDay.slice(5).replace("-", "/")} 발표분`}</span>}
        </h3>
        <div className="ov-seg">
          <button type="button" className={dir === "up" ? "on" : ""} onClick={() => setDir("up")}>
            올림 {board.goalUp.length}
          </button>
          <button type="button" className={dir === "down" ? "on" : ""} onClick={() => setDir("down")}>
            내림 {board.goalDown.length}
          </button>
        </div>
        <div className="data-table-wrap">
          <table className="data-table">
            <thead>
              <tr>
                <th className="sticky-col">종목</th>
                <th>이전</th>
                <th>목표</th>
                <th>변화</th>
                <th>증권사</th>
                <th>보고서</th>
              </tr>
            </thead>
            <tbody>
              {goals.map((g, i) => (
                <tr key={`${g.code}-${i}`} className="clickable-row" onClick={() => onSelectStock(normalizeStockCode(g.code), g.name)}>
                  <td className="sticky-col">{g.name}</td>
                  <td className="num pt-n">{fmtNum(g.prevGoal)}</td>
                  <td className="num">{fmtNum(g.goal)}</td>
                  <td className={`num ${dir === "up" ? "up" : "down"}`}>
                    {g.diffRate === null ? "-" : `${g.diffRate > 0 ? "+" : ""}${g.diffRate.toFixed(1)}%`}
                  </td>
                  <td>{g.broker}</td>
                  <td className="rsc-title-cell">{g.title}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <div className="table-note">
          목표주가를 <b>왜</b> 고쳤는지가 본론입니다 — 실적 전망이 바뀐 것인지, 주가가 이미 올라 따라 올린 것인지.
          같은 종목이 여러 증권사에서 동시에 올라오면 그건 업황이 바뀐 자리입니다.
        </div>
      </section>

      {industries.length > 0 && (
        <section className="card">
          <h3>보고서가 몰린 산업 <span className="rsc-when">최근 7일</span></h3>
          <div className="rsc-inds">
            {industries.map((n) => (
              <div className="rsc-ind" key={n.name}>
                <span className="rsc-ind-n">{n.name}</span>
                <span className="rsc-ind-bar">
                  <i style={{ width: `${(n.count / maxCount) * 100}%` }} />
                </span>
                <b className="num">{n.count}</b>
              </div>
            ))}
          </div>
          <div className="table-note">
            애널리스트가 일주일 동안 어디에 글을 썼나입니다. <b>테마 흐름</b>(오늘 도는 판)과 겹치면 돈과 시선이 같은
            곳을 보는 것이고, 어긋나면 한쪽이 먼저 움직인 것입니다.
          </div>
        </section>
      )}

      {board.hot.length > 0 && (
        <section className="card">
          <h3>많이 읽힌 보고서 <span className="rsc-when">최근 7일</span></h3>
          <div className="rsc-list">{board.hot.map(item)}</div>
        </section>
      )}

      {Object.keys(board.latest).length > 0 && (
        <section className="card">
          <h3>최신 보고서</h3>
          <div className="ov-seg wrap">
            {Object.keys(board.latest).map((t) => (
              <button key={t} type="button" className={type === t ? "on" : ""} onClick={() => setType(t)}>
                {TYPE_LABEL[t] ?? t}
              </button>
            ))}
          </div>
          <div className="rsc-list">{(board.latest[type] ?? []).map(item)}</div>
        </section>
      )}
    </div>
  );
}
