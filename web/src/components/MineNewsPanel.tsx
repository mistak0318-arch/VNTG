import { useEffect, useState } from "react";
import { api, type ScoredNews } from "../api";
import { NewsRow } from "./SectorNews";

/**
 * ⭐ 관심종목 뉴스 (2026-08-26) — **내 관심종목 리스트의 종목들로 검색한 기사만.**
 *
 * 서버 `/news/sectors` 의 「내 종목」 갈래를 그대로 쓴다 — 관심종목(AI_HTS)을 먼저,
 * 남는 자리를 키움 첫 그룹·내 테마로 채워 종목명 하나하나 검색한 결과다.
 * 분야별 뉴스 안에 묻혀 있던 걸 탭으로 꺼냈다.
 */
export function MineNewsPanel() {
  const [items, setItems] = useState<ScoredNews[] | null>(null);
  const [sources, setSources] = useState<string[]>([]);
  const [names, setNames] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    api
      .newsSectors("major", 40, "recent")
      .then((r) => {
        if (!alive) return;
        setItems(r.sectors.find((s) => s.key === "mine")?.items ?? []);
        setSources(r.mineSources ?? []);
        setNames(r.mineNames ?? []);
      })
      .catch((e: Error) => alive && setError(e.message));
    return () => {
      alive = false;
    };
  }, []);

  if (error) return <div className="error-banner">{error}</div>;
  if (items === null) return <div className="empty">관심종목 뉴스 불러오는 중…</div>;

  return (
    <>
      {names.length > 0 && (
        <div className="page-note">
          검색한 종목: {names.join(" · ")}
          {sources.length > 0 && ` (${sources.join(" · ")})`}
        </div>
      )}
      {items.length === 0 ? (
        <div className="empty">
          관심종목 기사가 없습니다. 관심종목을 먼저 담아 두면 여기로 모입니다.
        </div>
      ) : (
        <div className="report-lines">
          {items.map((n, i) => (
            <NewsRow key={`${n.link}-${i}`} item={n} />
          ))}
        </div>
      )}
      <div className="table-note">
        관심종목 → 키움 첫 그룹 → 내 테마 순으로 종목명을 하나씩 검색합니다 (최신순 · 5분 캐시).
      </div>
    </>
  );
}
