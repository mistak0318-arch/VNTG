import { useEffect, useState } from "react";
import { api } from "../api";

/**
 * 네이버 증권 주요뉴스 (2026-08-25) — **썸네일 카드**.
 *
 * 검색 API 뉴스는 텍스트뿐이라 눈에 안 들어온다는 지적이 있었다. 검색 API 는
 * 이미지를 안 주지만, 네이버 증권 첫 화면의 주요뉴스(편집자 선별)는 썸네일이
 * 같이 온다 — 그 목록을 그대로 카드로 편다. 사진 한 장이 제목 열 자보다 빨리 읽힌다.
 */

type Item = Awaited<ReturnType<typeof api.newsMain>>["items"][number];

function ago(iso: string): string {
  const t = new Date(iso).getTime();
  if (!Number.isFinite(t)) return "";
  const m = Math.floor((Date.now() - t) / 60_000);
  if (m < 1) return "방금";
  if (m < 60) return `${m}분 전`;
  if (m < 24 * 60) return `${Math.floor(m / 60)}시간 전`;
  return `${Math.floor(m / 1440)}일 전`;
}

export function MainNewsPanel() {
  const [items, setItems] = useState<Item[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    api
      .newsMain(24)
      .then((r) => alive && setItems(r.items))
      .catch((e: Error) => alive && setError(e.message));
    return () => {
      alive = false;
    };
  }, []);

  if (error) return <div className="error-banner">{error}</div>;
  if (items === null) return <div className="empty">주요뉴스 불러오는 중…</div>;
  if (items.length === 0) return <div className="empty">주요뉴스가 비어 있습니다.</div>;

  return (
    <>
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
      <div className="table-note">
        네이버 증권 첫 화면의 <b>주요뉴스</b>(편집자 선별)입니다 — 우리가 검색어로 긁는
        분야별 뉴스와 출처가 다릅니다. 5분마다 갱신되고, 카드를 누르면 원문으로 갑니다.
      </div>
    </>
  );
}
