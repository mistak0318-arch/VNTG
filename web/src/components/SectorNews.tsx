import { useEffect, useState } from "react";
import { api, type ScoredNews } from "../api";

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

/**
 * 기사 한 줄.
 * compact=true면 요약을 감춰서 목록을 촘촘하게 (하위 티어용).
 */
export function NewsRow({ item, compact = false }: { item: ScoredNews; compact?: boolean }) {
  const hot = item.coverage >= 4;
  return (
    <a
      className={`news-item${compact ? " compact" : ""}`}
      href={item.link}
      target="_blank"
      rel="noreferrer noopener"
    >
      <div className="news-title">
        {item.mentions.length > 0 && <span className="news-tag watch">★ {item.mentions[0]}</span>}
        {hot && <span className="news-tag hot">주목</span>}
        {item.title}
      </div>
      {!compact && item.summary && <div className="news-summary">{item.summary}</div>}
      <div className="news-meta">
        <span className={item.major ? "press-major" : ""}>{item.press}</span>
        <span>{fmtNewsTime(item.publishedAt)}</span>
        {item.coverage > 1 && (
          <span className="news-coverage" title={item.alsoPress.join(", ")}>
            {item.coverage}개 매체
          </span>
        )}
      </div>
    </a>
  );
}

export function SectorNews({
  perSector = 20,
  defaultSort = "importance",
  onFetched,
}: {
  perSector?: number;
  /**
   * importance: 오늘 하루 중요했던 것 (데일리 리포트)
   * recent: 방금 나온 것 위주 (뉴스·공시 탭)
   */
  defaultSort?: "importance" | "recent";
  /** 상위 화면이 기준시각을 표시할 수 있게 알려준다 */
  onFetched?: (iso: string) => void;
}) {
  const [sectors, setSectors] = useState<{ key: string; label: string; items: ScoredNews[] }[]>([]);
  /*
   * 처음 보이는 건 **브리핑**이다.
   *
   * 예전엔 「증시」 탭이 먼저 열렸다. 그런데 뉴스를 열 때 하고 싶은 건 분야를 고르는 게
   * 아니라 **위에서 아래로 훑는 것**이다 — 오늘 시장이 크게 다룬 것 → 내 종목 → 전반 시황.
   * 탭은 그 다음에 파고들 때 쓴다.
   */
  const [tab, setTab] = useState("brief");
  const [scope, setScope] = useState<"major" | "all">("major");
  const [sort, setSort] = useState<"importance" | "recent">(defaultSort);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState(false);
  const [reloadKey, setReloadKey] = useState(0);
  const [fetchedAt, setFetchedAt] = useState("");
  const [mineSources, setMineSources] = useState<string[]>([]);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    api
      .newsSectors(scope, perSector, sort)
      .then((r) => {
        if (cancelled) return;
        setSectors(r.sectors);
        setMineSources(r.mineSources ?? []);
        setExpanded(false);
        setFetchedAt(r.fetchedAt);
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
  }, [scope, perSector, sort, reloadKey]);

  const current = sectors.find((s) => s.key === tab)?.items ?? [];
  const pick = (key: string) => sectors.find((s) => s.key === key)?.items ?? [];

  // 3단 계층: 헤드라인(요약 포함) / 주요(제목만) / 나머지(접기)
  // 예전엔 12건 뒤를 전부 접어놔서 목록이 실제보다 훨씬 빈약해 보였다.
  const headline = current.slice(0, 5);
  const major = current.slice(5, 30);
  const rest = current.slice(30);


  return (
    <div>
      <div className="filter-row news-sector-tabs">
        <button
          className={`filter-btn ${tab === "brief" ? "active" : ""}`}
          onClick={() => setTab("brief")}
        >
          브리핑
        </button>
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
          className={`filter-btn ${sort === "recent" ? "active" : ""}`}
          onClick={() => setSort("recent")}
          title="방금 나온 기사 위주 — 보도량이 많아도 오래된 기사는 뒤로 밀린다"
        >
          최신순
        </button>
        <button
          className={`filter-btn ${sort === "importance" ? "active" : ""}`}
          onClick={() => setSort("importance")}
          title="오늘 하루 시장이 크게 다룬 기사 위주"
        >
          중요도순
        </button>
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
        <span className="news-fetched">
          {fetchedAt ? `${fmtNewsTime(fetchedAt)} 수집` : ""}
        </span>
        <button
          className="filter-btn"
          onClick={() => setReloadKey((k) => k + 1)}
          disabled={loading}
          title="서버가 5분간 캐시하므로, 그 안에 다시 눌러도 같은 결과가 나옵니다"
        >
          {loading ? "…" : "↻ 새로고침"}
        </button>
      </div>

      {loading && <div className="empty">뉴스 불러오는 중...</div>}
      {error && <div className="error-banner">{error}</div>}

      {/*
        브리핑 — 위에서 아래로 한 번에 훑는 자리.
        「분야를 골라서 보라」고 하면 결국 아무것도 안 읽게 된다.
      */}
      {!loading && !error && tab === "brief" && (
        <div className="nb">
          <NewsBlock
            title="오늘 시장이 크게 다룬 것"
            /*
             * **여러 매체가 함께 다룬 것만** 올린다.
             * 조회수는 네이버 검색 API 가 주지 않는다. 대신 쓸 수 있는 가장 가까운 값이
             * 「같은 사건을 몇 개 매체가 썼나」다 — 한 곳만 쓴 기사는 아직 이슈가 아니다.
             */
            items={pick("top").filter((n) => n.coverage >= 2).slice(0, 6)}
            fallback={pick("top").slice(0, 6)}
            note="여러 매체가 함께 다룬 순입니다. 한 곳만 쓴 기사는 아직 이슈가 아닙니다."
            onMore={() => setTab("top")}
          />
          <NewsBlock
            title="내 관심종목"
            items={pick("mine").slice(0, 8)}
            note={
              mineSources.length > 0
                ? `${mineSources.join(" · ")} 종목을 하나씩 검색했습니다.`
                : "관심종목이 없어 검색할 종목이 없습니다."
            }
            onMore={() => setTab("mine")}
          />
          <NewsBlock
            title="전반 시황"
            items={[...pick("market"), ...pick("global")]
              .sort((a, b) => b.score - a.score)
              .slice(0, 8)}
            note="증시·글로벌을 합쳐 점수순으로 보여줍니다."
            onMore={() => setTab("market")}
          />
        </div>
      )}

      {!loading && !error && tab !== "brief" && current.length > 0 && (
        <>
          <div className="report-lines">
            {headline.map((n, i) => (
              <NewsRow key={`h-${n.link}-${i}`} item={n} />
            ))}
          </div>

          {major.length > 0 && (
            <div className="report-lines news-tier">
              {major.map((n, i) => (
                <NewsRow key={`m-${n.link}-${i}`} item={n} compact />
              ))}
            </div>
          )}

          {rest.length > 0 && (
            <>
              {expanded && (
                <div className="report-lines news-tier">
                  {rest.map((n, i) => (
                    <NewsRow key={`r-${n.link}-${i}`} item={n} compact />
                  ))}
                </div>
              )}
              <button className="news-more" onClick={() => setExpanded((v) => !v)}>
                {expanded ? "접기" : `기사 ${rest.length}건 더 보기`}
              </button>
            </>
          )}
        </>
      )}

      {!loading && !error && current.length === 0 && (
        <div className="empty">이 분야 기사가 없습니다.</div>
            )}
    </div>
  );
}


/**
 * 브리핑의 한 단.
 *
 * `fallback` 이 있는 이유: 「여러 매체가 함께 다룬 것」으로 거르면 장 초반이나
 * 한산한 날에는 한 건도 안 남을 수 있다. **빈 칸을 보여주느니** 거르기 전 것을 쓴다 —
 * 없는 것보다 덜 중요한 게 낫다.
 */
function NewsBlock({
  title,
  items,
  fallback,
  note,
  onMore,
}: {
  title: string;
  items: ScoredNews[];
  fallback?: ScoredNews[];
  note: string;
  onMore: () => void;
}) {
  const list = items.length > 0 ? items : (fallback ?? []);
  return (
    <section className="nb-block">
      <h3 className="nb-title">
        {title}
        <button className="nb-more" onClick={onMore}>
          더 보기 →
        </button>
      </h3>
      {list.length === 0 ? (
        <div className="page-note">해당하는 기사가 없습니다.</div>
      ) : (
        <div className="report-lines">
          {list.map((n, i) => (
            <NewsRow key={`${title}-${n.link}-${i}`} item={n} />
          ))}
        </div>
      )}
      <div className="table-note">{note}</div>
    </section>
  );
}
