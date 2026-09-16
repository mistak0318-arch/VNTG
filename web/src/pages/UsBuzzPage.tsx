import { useEffect, useState } from "react";
import { api, type UsBuzz } from "../api";
import { YahooChartSheet, type ChartTarget } from "../components/overview/YahooChartSheet";

/**
 * **인기·화제(해외)** (2026-09-17 — 벤티지: "이슈나 종목토론 해외 부분도 있으면 좋겠다, 트렌드 읽을 수 있게").
 *
 * 세 눈을 나란히 — 미국판 「지금의 화제」:
 *   · 네이버 인기     한국 사람이 많이 본 미국 종목 (조회 수)
 *   · 야후 trending   미국 사람이 지금 보는 종목
 *   · 네이버 종목토론 개인 투자자가 떠드는 미국 종목 — 글 제목을 펼치면 **왜** 떠드는지가 보인다
 * 셋이 같은 종목을 가리키면 그날의 중심이고, 한쪽만 뜨거우면 쏠림이다. 신호등 점수에는 안 들어간다.
 */
function pct(v: number | null): string {
  return v === null ? "" : `${v > 0 ? "+" : ""}${v.toFixed(2)}%`;
}
function cls(v: number | null): string {
  return v === null || v === 0 ? "" : v > 0 ? "up" : "down";
}

export function UsBuzzPage() {
  const [data, setData] = useState<UsBuzz | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  const [chart, setChart] = useState<ChartTarget | null>(null);

  useEffect(() => {
    let alive = true;
    const pull = () =>
      api
        .usBuzz()
        .then((r) => alive && setData(r))
        .catch((e: Error) => alive && setError(e.message));
    void pull();
    const t = window.setInterval(pull, 3 * 60_000);
    return () => {
      alive = false;
      window.clearInterval(t);
    };
  }, []);

  if (error) return <div className="page-note">못 받았습니다 — {error}</div>;
  if (!data) return <div className="page-note">불러오는 중…</div>;

  const go = (symbol: string, name: string | null) => setChart({ kind: "usStock", symbol, label: `${name ?? symbol} (${symbol})`, digits: 2 });
  /* 세 눈이 겹치는 종목 — 그날의 중심 */
  const inPop = new Set((data.popular?.rows ?? []).map((r) => r.symbol));
  const inTr = new Set((data.trending ?? []).map((r) => r.symbol));
  const inDis = new Set((data.discussion?.items ?? []).map((r) => r.symbol));
  const overlap = [...inDis].filter((s) => inPop.has(s) || inTr.has(s));

  return (
    <div className="page ubz">
      <p className="page-note">
        세 눈이 <b>같은 종목</b>을 가리키면 그날의 중심, 한쪽만 뜨거우면 쏠림입니다.
        {overlap.length > 0 && (
          <>
            {" "}
            지금 겹치는 종목: <b>{overlap.slice(0, 8).join(" · ")}</b>
          </>
        )}
      </p>
      <div className="ubz-cols">
        <section className="card">
          <h3>
            🇰🇷 네이버 인기 <span className="usm-sub">한국 사람이 많이 본 미국 종목</span>
          </h3>
          {!data.popular && <div className="empty">못 받음</div>}
          <div className="ubz-list">
            {(data.popular?.rows ?? []).slice(0, 20).map((r) => (
              <button key={r.symbol} type="button" className={`ubz-row${inDis.has(r.symbol) || inTr.has(r.symbol) ? " hot" : ""}`} onClick={() => go(r.symbol, r.name)}>
                <b>{r.rank}</b>
                <span className="ubz-nm">
                  {r.name} <i>{r.symbol}</i>
                </span>
                <em className={`num ${cls(r.rate)}`}>{pct(r.rate)}</em>
              </button>
            ))}
          </div>
        </section>
        <section className="card">
          <h3>
            🇺🇸 야후 trending <span className="usm-sub">미국 사람이 지금 보는 종목</span>
          </h3>
          {!data.trending && <div className="empty">못 받음</div>}
          <div className="ubz-list">
            {(data.trending ?? []).map((r, i) => (
              <button key={r.symbol} type="button" className={`ubz-row${inDis.has(r.symbol) || inPop.has(r.symbol) ? " hot" : ""}`} onClick={() => go(r.symbol, r.name)}>
                <b>{i + 1}</b>
                <span className="ubz-nm">
                  {r.name ?? r.symbol} <i>{r.symbol}</i>
                </span>
                <em className={`num ${cls(r.rate)}`}>{pct(r.rate)}</em>
              </button>
            ))}
          </div>
        </section>
        <section className="card">
          <h3>
            🗣 네이버 종목토론 <span className="usm-sub">{data.discussion ? `${data.discussion.rankTime.slice(11, 16)} 기준` : ""} · 줄을 누르면 글 제목</span>
          </h3>
          {!data.discussion && <div className="empty">못 받음</div>}
          <div className="ubz-list">
            {(data.discussion?.items ?? []).slice(0, 25).map((r) => {
              const jump = r.prevRank === null ? "신규" : r.prevRank - r.rank > 0 ? `↑${r.prevRank - r.rank}` : r.prevRank - r.rank < 0 ? `↓${r.rank - r.prevRank}` : "–";
              const isOpen = open === r.reuters;
              return (
                <div key={r.reuters} className={`ubz-dis${isOpen ? " open" : ""}${inPop.has(r.symbol) || inTr.has(r.symbol) ? " hot" : ""}`}>
                  <button type="button" className="ubz-row" onClick={() => setOpen(isOpen ? null : r.reuters)}>
                    <b>{r.rank}</b>
                    <span className="ubz-nm">
                      {r.name ?? r.symbol} <i>{r.symbol}</i>
                    </span>
                    <em className={`num ${cls(r.rate)}`}>{pct(r.rate)}</em>
                    <i className={`ubz-jp${jump === "신규" || jump.startsWith("↑") ? " up" : ""}`}>{jump}</i>
                  </button>
                  {isOpen && (
                    <div className="ubz-posts">
                      {r.posts.length === 0 && <span className="pt-n">글 제목이 없습니다</span>}
                      {r.posts.slice(0, 6).map((p, i) => (
                        <div key={i}>· {p}</div>
                      ))}
                      <button type="button" className="link-btn" onClick={() => go(r.symbol, r.name)}>
                        {r.name ?? r.symbol} 상세 →
                      </button>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </section>
      </div>
      <div className="table-note">
        토론 글은 개인 투자자의 말이라 <b>과열의 재료</b>입니다 — 세 눈이 겹치는 종목이 무엇 때문에 떠드는지를 읽는 자리이지, 사라는 신호가 아닙니다.
      </div>
      {chart && <YahooChartSheet target={chart} onClose={() => setChart(null)} />}
    </div>
  );
}
