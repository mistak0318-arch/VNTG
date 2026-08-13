import { useEffect, useState } from "react";
import { api, type DisclosureItem, type NewsItem } from "../api";

/**
 * 뉴스 + 공시 패널.
 * 뉴스 탭과 종목 상세가 이 컴포넌트를 공유해서 같은 조회 로직·같은 서버 캐시를 쓴다.
 */

function fmtDateTime(iso: string): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const now = Date.now();
  const diffMin = Math.floor((now - d.getTime()) / 60000);
  if (diffMin < 60) return `${Math.max(diffMin, 0)}분 전`;
  if (diffMin < 60 * 24) return `${Math.floor(diffMin / 60)}시간 전`;
  return `${String(d.getMonth() + 1).padStart(2, "0")}/${String(d.getDate()).padStart(2, "0")}`;
}

function fmtYmd(ymd: string): string {
  if (!/^\d{8}$/.test(ymd)) return ymd;
  return `${ymd.slice(4, 6)}/${ymd.slice(6, 8)}`;
}

export function NewsList({ query }: { query: string }) {
  const [items, setItems] = useState<NewsItem[]>([]);
  const [counts, setCounts] = useState<{ major: number; all: number } | null>(null);
  const [scope, setScope] = useState<"major" | "all">("major");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!query) {
      setItems([]);
      setLoading(false);
      return;
    }
    let cancelled = false;
    setLoading(true);
    setError(null);
    api
      .news(query, { scope })
      .then((res) => {
        if (cancelled) return;
        setItems(res.items);
        setCounts(res.counts);
      })
      .catch((err: Error) => {
        if (!cancelled) setError(err.message);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [query, scope]);

  // 필터 토글은 로딩 중에도 계속 보여야 화면이 덜컹거리지 않는다
  const filterRow = (
    <div className="filter-row news-filter">
      <button
        className={`filter-btn ${scope === "major" ? "active" : ""}`}
        onClick={() => setScope("major")}
      >
        주요 언론사{counts ? ` (${counts.major})` : ""}
      </button>
      <button className={`filter-btn ${scope === "all" ? "active" : ""}`} onClick={() => setScope("all")}>
        전체{counts ? ` (${counts.all})` : ""}
      </button>
    </div>
  );

  return (
    <div>
      {filterRow}
      {loading && <div className="empty">뉴스 불러오는 중...</div>}
      {error && <div className="error-banner">{error}</div>}
      {!loading && !error && items.length === 0 && (
        <div className="empty">
          {scope === "major" ? "주요 언론사 기사가 없습니다. '전체'로 바꿔보세요." : "관련 뉴스가 없습니다."}
        </div>
      )}
      {!loading && !error && items.length > 0 && (
        <div className="feed-list">
          {items.map((n, i) => (
            <a
              key={`${n.link}-${i}`}
              className="feed-item"
              href={n.link}
              target="_blank"
              rel="noreferrer noopener"
            >
              <div className="feed-title">{n.title}</div>
              {n.summary && <div className="news-summary">{n.summary}</div>}
              <div className="feed-meta">
                {n.press && <span className={n.major ? "press-major" : ""}>{n.press}</span>}
                <span>{fmtDateTime(n.publishedAt)}</span>
              </div>
            </a>
          ))}
        </div>
      )}
    </div>
  );
}

export function DisclosureList({ code }: { code: string }) {
  const [items, setItems] = useState<DisclosureItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!code) {
      setItems([]);
      setLoading(false);
      return;
    }
    let cancelled = false;
    setLoading(true);
    setError(null);
    api
      .disclosures(code)
      .then((res) => {
        if (!cancelled) setItems(res.items);
      })
      .catch((err: Error) => {
        if (!cancelled) setError(err.message);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [code]);

  if (loading) return <div className="empty">공시 불러오는 중...</div>;
  if (error) return <div className="error-banner">{error}</div>;
  if (items.length === 0)
    return <div className="empty">최근 공시가 없습니다. (ETF·ETN 등은 DART 대상이 아닙니다)</div>;

  return (
    <div className="feed-list">
      {items.map((d) => (
        <a key={d.receiptNo} className="feed-item" href={d.url} target="_blank" rel="noreferrer noopener">
          <div className="feed-title">{d.reportName}</div>
          <div className="feed-meta">
            <span>{d.filerName}</span>
            <span>{fmtYmd(d.receiptDate)}</span>
          </div>
        </a>
      ))}
    </div>
  );
}

/** 종목 상세용 — 뉴스/공시를 좌우(PC) 또는 서브탭(모바일)으로 */
export function NewsDisclosurePanel({ code, name }: { code: string; name: string }) {
  const [sub, setSub] = useState<"news" | "disclosure">("news");
  const [wide, setWide] = useState(() => window.matchMedia("(min-width:900px)").matches);

  useEffect(() => {
    const mq = window.matchMedia("(min-width:900px)");
    const handler = (e: MediaQueryListEvent) => setWide(e.matches);
    mq.addEventListener("change", handler);
    return () => mq.removeEventListener("change", handler);
  }, []);

  if (wide) {
    return (
      <div className="feed-two-col">
        <section>
          <h3 className="feed-heading">뉴스</h3>
          <NewsList query={name} />
        </section>
        <section>
          <h3 className="feed-heading">공시 (DART)</h3>
          <DisclosureList code={code} />
        </section>
      </div>
    );
  }

  return (
    <div>
      <div className="filter-row">
        <button className={`filter-btn ${sub === "news" ? "active" : ""}`} onClick={() => setSub("news")}>
          뉴스
        </button>
        <button
          className={`filter-btn ${sub === "disclosure" ? "active" : ""}`}
          onClick={() => setSub("disclosure")}
        >
          공시
        </button>
      </div>
      {sub === "news" ? <NewsList query={name} /> : <DisclosureList code={code} />}
    </div>
  );
}
