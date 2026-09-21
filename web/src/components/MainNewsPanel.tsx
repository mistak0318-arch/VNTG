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

export function MainNewsPanel({ cat = "main", onSelectStock }: { cat?: NaverNewsCat; onSelectStock?: (code: string, name: string) => void }) {
  const [items, setItems] = useState<NaverNewsItem[] | null>(null);
  /*
   * 카드 채우기 (2026-09-08) — 벤티지: "안에 내용이 좀 덜 채워져 있네?"
   * 목록 요약은 120자가 전부라 줄을 늘려도 비었다. 목록이 오면 본문 앞 400자와 관련 종목을 따로 받아
   * 요약 자리에 넣는다. 늦게 와도 되고 못 와도 된다 — 그동안은 목록 요약이 있다.
   */
  const [leads, setLeads] = useState<Record<string, { lead: string; stocks: { code: string; name: string }[] }>>({});
  /*
   * 관련 종목의 **지금 값** (2026-09-19 — 벤티지가 증시플러스 뉴스속보를 보여 주며). 칩이 이름뿐이라
   * 「이 뉴스에 시장이 반응했나」를 누르기 전엔 몰랐다. 등락률과 **내 보유·관심 여부**를 같이 받는다.
   * 조회는 목록 한 쪽에 1~2회(ka10095 가 여러 종목을 한 번에 준다) · 서버 60초 캐시.
   */
  const [quotes, setQuotes] = useState<Record<string, { price: number; changeRate: number; mine: "hold" | "watch" | null }>>({});
  const [hasMore, setHasMore] = useState(false);
  const [page, setPage] = useState(1);
  const [error, setError] = useState<string | null>(null);
  const topRef = useRef<HTMLDivElement>(null);

  // 탭을 바꾸면 1쪽부터 — 지난 탭의 쪽수를 들고 가면 빈 쪽이 나온다
  useEffect(() => setPage(1), [cat]);
  useEffect(() => setQuotes({}), [cat, page]); // 앞 목록의 값이 새 목록 칩에 남지 않게

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
        api
          .newsLeads(r.items.map((x) => ({ link: x.link, title: x.title, summary: x.summary })))
          .then((l) => {
            if (!alive) return;
            const m: Record<string, { lead: string; stocks: { code: string; name: string }[] }> = {};
            for (const x of l.leads) m[x.link] = { lead: x.lead, stocks: x.stocks };
            setLeads(m);
          })
          .catch(() => undefined);
      })
      .catch((e: Error) => alive && setError(e.message));
    return () => {
      alive = false;
    };
  }, [cat, page]);

  /*
   * 종목 칩 시세 — `leads` 가 채워진 뒤 한 번. 목록이 바뀌면(카테고리·쪽) 다시 받는다.
   * 코드가 하나도 없으면 아무것도 안 부른다.
   */
  useEffect(() => {
    /* 서버가 80개에서 자른다 — 여기서 안 맞추면 넘친 칩은 등락률이 영영 안 붙는다(조용히). 나눠 받는다 (2026-09-21) */
    const all = [...new Set(Object.values(leads).flatMap((l) => l.stocks.map((x) => x.code)))].filter((c) => /^\d{6}$/.test(c));
    if (all.length === 0) return;
    const chunks: string[][] = [];
    for (let i = 0; i < all.length; i += 80) chunks.push(all.slice(i, i + 80));
    let alive = true;
    for (const part of chunks) {
      api
        .marketQuotes(part)
        .then((r) => alive && setQuotes((prev) => ({ ...prev, ...r.quotes })))
        .catch(() => undefined);
    }
    return () => {
      alive = false;
    };
  }, [leads]);

  /*
   * **나에게 중요한 기사**를 가른다 (2026-09-19, 벤티지 선택: 내 종목 + 급등락 ±5%).
   *
   * 남의 앱은 편집자가 「중요」를 고르지만 우리는 **내 포트폴리오 기준**으로 고를 수 있다 —
   * 관련 종목에 내 보유·관심이 있으면 `mine`, 크게 움직인 종목이 있으면 `move`.
   * 둘 다면 `mine` 이 이긴다(내 것이 먼저다).
   */
  const hotOf = (link: string): "mine" | "move" | null => {
    const ss = leads[link]?.stocks ?? [];
    if (ss.length === 0) return null;
    let move = false;
    for (const s of ss) {
      const q = quotes[s.code];
      if (!q) continue;
      if (q.mine) return "mine";
      if (Math.abs(q.changeRate) >= 5) move = true;
    }
    return move ? "move" : null;
  };

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
            <a className={`mn-card${hotOf(n.link) ? ` mn-hot ${hotOf(n.link)}` : ""}`} href={n.link} target="_blank" rel="noreferrer" key={n.link}>
              {/* 썸네일이 없는 기사도 있다 — 그때는 글 카드로 */}
              {/* 네이버 CDN 이 리퍼러를 볼 때가 있어 안 보낸다 — 핫링크 차단 회피 */}
              {n.thumb && (
                <img className="mn-thumb" src={n.thumb} alt="" loading="lazy" referrerPolicy="no-referrer" />
              )}
              <div className="mn-body">
                <b className="mn-tit">{n.title}</b>
                <span className={`mn-sum ${leads[n.link]?.lead ? "lead" : ""}`}>{leads[n.link]?.lead || n.summary}</span>
                {leads[n.link]?.stocks && leads[n.link].stocks.length > 0 && (
                  <span className="mn-stocks">
                    {leads[n.link].stocks.map((s) => {
                      const q = quotes[s.code];
                      const cls = q ? (q.changeRate > 0 ? "up" : q.changeRate < 0 ? "down" : "flat") : "";
                      return (
                        <button
                          key={s.code}
                          className={`mn-stock ${cls} ${q?.mine ? `mine-${q.mine}` : ""}`}
                          title={
                            q
                              ? `${s.name} ${q.price.toLocaleString()}원 ${q.changeRate > 0 ? "+" : ""}${q.changeRate.toFixed(2)}%${q.mine === "hold" ? " · 보유 중" : q.mine === "watch" ? " · 관심종목" : ""} — 상세 열기`
                              : `${s.name} 종목 상세 열기`
                          }
                          onClick={(e) => {
                            e.preventDefault();
                            e.stopPropagation();
                            onSelectStock?.(s.code, s.name);
                          }}
                        >
                          {q?.mine && <i className="mn-mine">{q.mine === "hold" ? "◆" : "★"}</i>}
                          {s.name}
                          {q && (
                            <em className="mn-rate">
                              {q.changeRate > 0 ? "+" : ""}
                              {q.changeRate.toFixed(2)}%
                            </em>
                          )}
                        </button>
                      );
                    })}
                  </span>
                )}
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
