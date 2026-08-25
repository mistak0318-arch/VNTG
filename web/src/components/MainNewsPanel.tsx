import { useEffect, useRef, useState } from "react";
import { api, type NaverNewsCat, type NaverNewsItem } from "../api";

/**
 * 네이버 증권 뉴스 — **썸네일 카드** (2026-08-25 주요뉴스 → 08-26 카테고리 전체로 확장).
 *
 * 검색 API 뉴스는 텍스트뿐이라 눈에 안 들어온다는 지적이 있었다. 네이버 증권의
 * 편집 목록(주요뉴스·속보·시황·기업·해외·부동산)은 썸네일이 같이 온다 — 그 목록을
 * 그대로 카드로 편다. 사진 한 장이 제목 열 자보다 빨리 읽힌다.
 *
 * 페이지 넘김: 서버가 한 쪽 20건 안팎 + hasMore 를 준다. 「더 불러와 이어 붙이기」가
 * 아니라 **쪽을 넘기는** 방식이다 — 신문 넘기듯 보고, 몇 쪽까지 봤는지 남는다.
 */

function ago(iso: string): string {
  const t = new Date(iso).getTime();
  if (!Number.isFinite(t)) return "";
  const m = Math.floor((Date.now() - t) / 60_000);
  if (m < 1) return "방금";
  if (m < 60) return `${m}분 전`;
  if (m < 24 * 60) return `${Math.floor(m / 60)}시간 전`;
  return `${Math.floor(m / 1440)}일 전`;
}

const NOTE: Record<NaverNewsCat, string> = {
  main: "네이버 증권 첫 화면의 주요뉴스(편집자 선별)입니다.",
  flash: "네이버 증권 속보 흐름입니다 — 최신이 맨 위입니다.",
  market: "네이버 금융뉴스 「시황·전망」 갈래입니다.",
  company: "네이버 금융뉴스 「기업·종목분석」 갈래입니다.",
  world: "네이버 금융뉴스 「해외증시」 갈래입니다.",
  estate: "네이버 뉴스 「부동산」 갈래입니다.",
};

export function MainNewsPanel({ cat = "main" }: { cat?: NaverNewsCat }) {
  const [items, setItems] = useState<NaverNewsItem[] | null>(null);
  const [hasMore, setHasMore] = useState(false);
  const [page, setPage] = useState(1);
  const [error, setError] = useState<string | null>(null);
  const topRef = useRef<HTMLDivElement>(null);

  // 탭을 바꾸면 1쪽부터 — 지난 탭의 쪽수를 들고 가면 빈 쪽이 나온다
  useEffect(() => setPage(1), [cat]);

  useEffect(() => {
    let alive = true;
    setItems(null);
    setError(null);
    api
      .newsNaver(cat, page)
      .then((r) => {
        if (!alive) return;
        setItems(r.items);
        setHasMore(r.hasMore);
      })
      .catch((e: Error) => alive && setError(e.message));
    return () => {
      alive = false;
    };
  }, [cat, page]);

  function flip(next: number) {
    setPage(next);
    // 쪽을 넘기면 맨 위부터 — 스크롤이 바닥에 남아 있으면 넘긴 티가 안 난다
    topRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
  }

  const pager =
    page > 1 || hasMore ? (
      <div className="mn-pager">
        <button className="filter-btn" disabled={page <= 1} onClick={() => flip(page - 1)}>
          ← 이전
        </button>
        <span className="mn-page num">{page}쪽</span>
        <button className="filter-btn" disabled={!hasMore} onClick={() => flip(page + 1)}>
          다음 →
        </button>
      </div>
    ) : null;

  if (error) return <div className="error-banner">{error}</div>;

  return (
    <>
      <div ref={topRef} />
      {items === null ? (
        <div className="empty">뉴스 불러오는 중…</div>
      ) : items.length === 0 ? (
        <div className="empty">{page > 1 ? "이 쪽에는 기사가 없습니다." : "기사가 비어 있습니다."}</div>
      ) : (
        <div className="mn-grid">
          {items.map((n) => (
            <a className="mn-card" href={n.link} target="_blank" rel="noreferrer" key={n.link}>
              {/* 썸네일이 없는 기사도 있다 — 그때는 글 카드로 */}
              {/* 네이버 CDN 이 리퍼러를 볼 때가 있어 안 보낸다 — 핫링크 차단 회피 */}
              {n.thumb && (
                <img className="mn-thumb" src={n.thumb} alt="" loading="lazy" referrerPolicy="no-referrer" />
              )}
              <div className="mn-body">
                <b className="mn-tit">{n.title}</b>
                <span className="mn-sum">{n.summary}</span>
                <span className="mn-meta">
                  {n.press} · {ago(n.at)}
                </span>
              </div>
            </a>
          ))}
        </div>
      )}
      {pager}
      <div className="table-note">
        {NOTE[cat]} 5분마다 갱신되고, 카드를 누르면 원문으로 갑니다.
      </div>
    </>
  );
}
