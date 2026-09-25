import { useEffect, useState } from "react";
import { api, type StockReport } from "../api";

/**
 * **증권사 리포트** (2026-09-25 — 벤티지: "리서치나 증권사 리포트 가져오는 api 나 소스는 없어?").
 *
 * 종목 상세 「목표주가·리포트」 탭. 위의 한투 목표주가 표가 **숫자**라면 이건 **글** — 증권사가 왜 그 숫자를 냈는지.
 * 한 건에 증권사·날짜·의견·목표주가(전→후, 작성일 주가 대비)·본문 요약(펼치기)·PDF. 네이버 공개 창구, 조회 0회.
 */
export function ReportsPanel({ code }: { code: string }) {
  const [rows, setRows] = useState<StockReport[] | null>(null);
  const [open, setOpen] = useState<number | null>(null);
  useEffect(() => {
    let alive = true;
    setRows(null);
    setOpen(null);
    api
      .stockReports(code, 10)
      .then((r) => alive && setRows(r.reports))
      .catch(() => alive && setRows([]));
    return () => {
      alive = false;
    };
  }, [code]);

  const won = (v: number | null) => (v === null ? "-" : v.toLocaleString("ko-KR"));
  const up = (r: StockReport) => (r.goal !== null && r.priceAt ? ((r.goal - r.priceAt) / r.priceAt) * 100 : null);
  const opCls = (o: string | null) => {
    const s = (o ?? "").toLowerCase();
    return /buy|매수|outperform|overweight/.test(s) ? "positive" : /sell|매도|underperform|reduce/.test(s) ? "negative" : "";
  };

  return (
    <section className="rp">
      <h3 className="section-heading">
        증권사 리포트 <i className="pt-n">네이버 리서치 · 본문은 요약, PDF 는 원문</i>
      </h3>
      {rows === null && <div className="page-note">리포트 찾는 중…</div>}
      {rows !== null && rows.length === 0 && <div className="empty">최근 리포트가 없습니다 — 커버하는 증권사가 없거나 네이버에 안 올라온 종목입니다.</div>}
      {rows !== null && rows.length > 0 && (
        <ul className="rp-list">
          {rows.map((r) => {
            const u = up(r);
            const isOpen = open === r.id;
            return (
              <li key={r.id} className={`rp-item${isOpen ? " open" : ""}`}>
                <button type="button" className="rp-head" onClick={() => setOpen(isOpen ? null : r.id)} title={isOpen ? "접기" : "본문 요약 펼치기"}>
                  <span className="rp-meta">
                    <b>{r.broker}</b> <i>{r.date.slice(5)}</i>
                    {r.opinion && <em className={`rp-op ${opCls(r.opinion)}`}>{r.opinion}</em>}
                  </span>
                  <span className="rp-title">{r.title}</span>
                  <span className="rp-goal num">
                    {r.goal !== null && (
                      <>
                        {/* `prevGoalPrice` 는 실측상 작성일 주가와 같은 값이라(이전 목표가 아님) 안 쓴다 */}
                        목표 <b>{won(r.goal)}</b>
                        {u !== null && <em className={u >= 0 ? "positive" : "negative"} title="작성일 주가 대비"> {u > 0 ? "+" : ""}{u.toFixed(0)}%</em>}
                      </>
                    )}
                    {r.reads !== null && <i className="pt-n"> · {r.reads.toLocaleString("ko-KR")}회</i>}
                  </span>
                </button>
                {isOpen && (
                  <div className="rp-body">
                    {r.body ? r.body.split("\n").map((line, i) => (line.trim() ? <p key={i}>{line}</p> : null)) : <p className="pt-n">본문 요약이 없습니다.</p>}
                    <div className="rp-foot">
                      {r.priceAt !== null && <span className="pt-n">작성일 주가 {won(r.priceAt)}</span>}
                      {r.pdf && (
                        <a href={r.pdf} target="_blank" rel="noreferrer" className="filter-btn">
                          📄 PDF 원문
                        </a>
                      )}
                      <a href={`https://m.stock.naver.com/research/company/${r.id}`} target="_blank" rel="noreferrer" className="filter-btn">
                        네이버에서 보기
                      </a>
                    </div>
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
