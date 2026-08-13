import { useState } from "react";

/**
 * 네이버 증권 뉴스 화면 그대로 보기.
 *
 * 네이버 금융은 robots.txt 가 `Disallow: /` 라 **긁어올 수 없다.**
 * 하지만 화면을 그대로 띄우는 건 다른 얘기다 — 내 브라우저가 네이버에 직접 접속하는 것이라
 * 링크를 클릭하는 것과 같고, 네이버의 광고·브랜딩도 그대로 유지된다.
 *
 * 다만 네이버가 임베드를 막을 수도 있어(X-Frame-Options / CSP) 화면이 빈 채로 뜰 수 있다.
 * 그래서 **새 창으로 여는 버튼을 항상 같이 둔다.**
 */

const PAGES = [
  { key: "main", label: "주요뉴스", url: "https://finance.naver.com/news/mainnews.naver" },
  { key: "market", label: "시황·전망", url: "https://finance.naver.com/news/news_list.naver?mode=LSS3D&section_id=101&section_id2=258&section_id3=401" },
  { key: "company", label: "기업·종목", url: "https://finance.naver.com/news/news_list.naver?mode=LSS3D&section_id=101&section_id2=258&section_id3=402" },
  { key: "world", label: "해외증시", url: "https://finance.naver.com/news/news_list.naver?mode=LSS3D&section_id=101&section_id2=258&section_id3=403" },
];

export function NaverFinanceFrame() {
  const [page, setPage] = useState(PAGES[0]);
  const [failed, setFailed] = useState(false);

  return (
    <div className="nvfin">
      <div className="filter-row">
        {PAGES.map((p) => (
          <button
            key={p.key}
            className={`filter-btn ${page.key === p.key ? "active" : ""}`}
            onClick={() => {
              setPage(p);
              setFailed(false);
            }}
          >
            {p.label}
          </button>
        ))}
        <a className="filter-btn" href={page.url} target="_blank" rel="noreferrer noopener">
          새 창으로 열기 ↗
        </a>
      </div>

      <iframe
        key={page.url}
        className="nvfin-frame"
        src={page.url}
        title={`네이버 증권 ${page.label}`}
        sandbox="allow-scripts allow-same-origin allow-popups"
        onError={() => setFailed(true)}
      />

      <div className="table-note">
        네이버 화면을 그대로 띄웁니다 — 내용을 저장하거나 가공하지 않습니다.
        {failed && " 네이버가 임베드를 막고 있습니다. 위 '새 창으로 열기'를 쓰세요."}
        {" "}화면이 비어 보이면 네이버 쪽 임베드 차단이니 새 창으로 여세요.
      </div>
    </div>
  );
}
