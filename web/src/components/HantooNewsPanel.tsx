import { useEffect, useState } from "react";
import { api, fmtKstHm, type HantooNewsItem } from "../api";

/**
 * 🏦 한투 속보 — 한국투자증권 HTS 뉴스창 그대로 (FHKST01011800, 2026-09-10).
 *
 * 네이버 속보와 다른 점: **종목코드가 달려 온다.** 제목에서 종목을 맞히는 게 아니라 한투가 붙인
 * 것이라 칩이 정확하다. 자동 생성 줄(「○○ 소폭 상승세 +3%」)이 절반쯤 섞여 기본은 뺀다 —
 * 켜면 그것도 흐름(어느 종목이 지금 움직이나)으로 읽을 수 있다. 원문 링크는 안 주므로
 * 제목을 누르면 네이버 뉴스 검색으로 간다.
 */
export function HantooNewsPanel({ onSelectStock }: { onSelectStock: (code: string, name: string) => void }) {
  const [items, setItems] = useState<HantooNewsItem[]>([]);
  const [next, setNext] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [hideAuto, setHideAuto] = useState(() => localStorage.getItem("vntg.hantooNews.hideAuto") !== "0");
  const [onlyStock, setOnlyStock] = useState(() => localStorage.getItem("vntg.hantooNews.onlyStock") === "1");

  const load = (srno?: string) => {
    setLoading(true);
    return api
      .hantooNews(srno)
      .then((r) => {
        if (!r.ready) {
          setError("한투 API 가 준비돼 있지 않습니다 (키·토큰).");
          return;
        }
        setError(null);
        setItems((prev) => {
          const seen = new Set(prev.map((x) => x.id));
          const add = r.items.filter((x) => !seen.has(x.id));
          /* 첫 장(srno 없음)은 최신이 앞이라 앞에 붙이고, 더 보기는 뒤에 */
          const merged = srno ? [...prev, ...add] : [...add, ...prev];
          return merged.sort((a, b) => b.at.localeCompare(a.at)).slice(0, 400);
        });
        if (srno || next === null) setNext(r.next);
      })
      .catch((e: Error) => setError(e.message))
      .finally(() => setLoading(false));
  };

  useEffect(() => {
    void load();
    const t = setInterval(() => void load(), 60_000);
    return () => clearInterval(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const shown = items.filter((x) => (!hideAuto || !x.auto) && (!onlyStock || x.stocks.length > 0));
  const searchUrl = (title: string) => `https://search.naver.com/search.naver?where=news&sm=tab_jum&query=${encodeURIComponent(title.replace(/\[.*?\]/g, "").slice(0, 60))}`;

  return (
    <div className="hn">
      <div className="filter-row">
        <button
          className={`filter-btn${hideAuto ? " active" : ""}`}
          onClick={() => {
            setHideAuto((v) => {
              localStorage.setItem("vntg.hantooNews.hideAuto", v ? "0" : "1");
              return !v;
            });
          }}
          title="「○○ 소폭 상승세 +3%」 같은 자동 생성 줄을 뺍니다"
        >
          자동 줄 빼기
        </button>
        <button
          className={`filter-btn${onlyStock ? " active" : ""}`}
          onClick={() => {
            setOnlyStock((v) => {
              localStorage.setItem("vntg.hantooNews.onlyStock", v ? "0" : "1");
              return !v;
            });
          }}
        >
          종목 언급만
        </button>
        <span className="pt-n">
          {shown.length}건{items.length !== shown.length ? ` / ${items.length}` : ""} · 1분마다
        </span>
        <button className="refresh-btn" onClick={() => void load()} disabled={loading}>
          {loading ? "…" : "↻"}
        </button>
      </div>
      {error && <div className="error-banner">{error}</div>}
      {shown.length === 0 && !loading && !error && <div className="empty">지금은 걸리는 줄이 없습니다.</div>}
      <ul className="hn-list">
        {shown.map((n) => (
          <li className={`hn-item${n.auto ? " auto" : ""}`} key={n.id}>
            <span className="hn-tm num">{fmtKstHm(n.at)}</span>
            <span className="hn-body">
              <a className="hn-title" href={searchUrl(n.title)} target="_blank" rel="noreferrer" title="네이버 뉴스에서 이 제목 찾기">
                {n.title}
              </a>
              {n.org && <i className="hn-org">{n.org}</i>}
              {n.stocks.length > 0 && (
                <span className="hn-stocks">
                  {n.stocks.slice(0, 6).map((s) => (
                    <button type="button" className="rp-nc-stock" key={s.code} onClick={() => onSelectStock(s.code, s.name)} title={`${s.name} 종목 상세`}>
                      {s.name}
                    </button>
                  ))}
                </span>
              )}
            </span>
          </li>
        ))}
      </ul>
      {next && (
        <button className="filter-btn hn-more" onClick={() => void load(next)} disabled={loading}>
          더 보기 (이전 40건)
        </button>
      )}
      <div className="table-note">
        한국투자증권 뉴스창(제목만) — 종목 칩은 한투가 붙인 것이라 정확합니다. 원문 링크는 안 주어서 제목을
        누르면 네이버 뉴스 검색으로 갑니다.
      </div>
    </div>
  );
}
