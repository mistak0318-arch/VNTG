import { useEffect, useState } from "react";
import { api, type NewsItem } from "../api";

/**
 * 분야별 뉴스 (증시 / 글로벌 / 정책·금융 / 산업·기업 / 부동산).
 *
 * 예전에는 "증시" 한 단어로만 검색해서 비트코인·ETF 분배금 같은 기사가 섞였다.
 * 지금은 분야마다 다른 질의를 던지고 제목의 힌트 단어로 소속을 정리한다.
 * 데일리 리포트와 뉴스·공시 탭이 이 컴포넌트를 공유한다.
 */

export function fmtNewsTime(iso: string): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const diffMin = Math.floor((Date.now() - d.getTime()) / 60000);
  if (diffMin < 60) return `${Math.max(diffMin, 0)}분 전`;
  if (diffMin < 60 * 24) return `${Math.floor(diffMin / 60)}시간 전`;
  return d.toLocaleString("ko-KR", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
}

/** 기사 한 줄 — 제목 + 요약 2줄 + 언론사/시각 */
export function NewsRow({ item }: { item: NewsItem }) {
  return (
    <a className="news-item" href={item.link} target="_blank" rel="noreferrer noopener">
      <div className="news-title">{item.title}</div>
      {item.summary && <div className="news-summary">{item.summary}</div>}
      <div className="news-meta">
        <span className={item.major ? "press-major" : ""}>{item.press}</span>
        <span>{fmtNewsTime(item.publishedAt)}</span>
      </div>
    </a>
  );
}

export function SectorNews({
  perSector = 8,
  onFetched,
}: {
  perSector?: number;
  /** 상위 화면이 기준시각을 표시할 수 있게 알려준다 */
  onFetched?: (iso: string) => void;
}) {
  const [sectors, setSectors] = useState<{ key: string; label: string; items: NewsItem[] }[]>([]);
  const [tab, setTab] = useState("market");
  const [scope, setScope] = useState<"major" | "all">("major");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    api
      .newsSectors(scope, perSector)
      .then((r) => {
        if (cancelled) return;
        setSectors(r.sectors);
        onFetched?.(r.fetchedAt);
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
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scope, perSector]);

  const current = sectors.find((s) => s.key === tab)?.items ?? [];

  return (
    <div>
      <div className="filter-row news-sector-tabs">
        {sectors.map((s) => (
          <button
            key={s.key}
            className={`filter-btn ${tab === s.key ? "active" : ""}`}
            onClick={() => setTab(s.key)}
          >
            {s.label} ({s.items.length})
          </button>
        ))}
        <span className="news-scope-sep" />
        <button
          className={`filter-btn ${scope === "major" ? "active" : ""}`}
          onClick={() => setScope("major")}
          title="주요 언론사만"
        >
          주요
        </button>
        <button
          className={`filter-btn ${scope === "all" ? "active" : ""}`}
          onClick={() => setScope("all")}
        >
          전체
        </button>
      </div>

      {loading && <div className="empty">뉴스 불러오는 중...</div>}
      {error && <div className="error-banner">{error}</div>}

      {!loading && !error && (
        <div className="report-lines">
          {current.map((n, i) => (
            <NewsRow key={`${n.link}-${i}`} item={n} />
          ))}
          {current.length === 0 && <div className="empty">이 분야 기사가 없습니다.</div>}
        </div>
      )}
    </div>
  );
}
