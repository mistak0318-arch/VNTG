import { useEffect, useState } from "react";
import { api, type BuzzTermDetail } from "../api";

/**
 * 버즈 원문 창 (2026-08-31 요청 —
 * 「원문보기 하면 미니창에 보여줄 수 있어? 텔레그램 막혀 있는 회사에서는 좋은 구조」).
 *
 * ## 왜 따로 창인가
 *
 * 낱말 상세 시트 안에서는 문장이 **곁다리**다 — 시각 막대·방 목록 아래에 몇 줄
 * 붙는 정도. 그런데 정작 읽고 싶은 것이 그 글일 때가 있고, 그때는 **글만 있는
 * 화면**이 필요하다. 본창을 떠나지 않고 옆에 띄워 두고 읽으라고 팝업으로 연다.
 *
 * ## 텔레그램이 막힌 곳에서
 *
 * 링크를 눌러 텔레그램으로 가는 길이 막혀 있어도, 우리가 받아 둔 글은 여기서
 * 그대로 읽힌다. 그래서 링크는 **보조**로 두고 본문을 크게 놓는다.
 *
 * ⚠️ 전문이 늘 있는 것은 아니다. 「주요 채널」로 고른 방의 글만 자른 데 없이
 * 보관된다(majorFeed). 그 밖의 방은 수집 때 잘린 조각이라 그 사실을 **줄마다
 * 표시**한다 — 잘린 것을 원문이라고 보여 주면 안 된다.
 */
export function BuzzSourcePage() {
  const term = decodeURIComponent(new URLSearchParams(window.location.hash.split("?")[1] ?? "").get("term") ?? "");
  const [d, setD] = useState<BuzzTermDetail | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [onlyFull, setOnlyFull] = useState(false);

  useEffect(() => {
    if (!term) return;
    document.title = `${term} — 원문`;
    api
      .buzzTerm(term)
      .then(setD)
      .catch((e) => setErr(e instanceof Error ? e.message : "못 받았습니다"));
  }, [term]);

  if (!term) return <div className="empty">낱말이 없습니다.</div>;
  if (err) return <div className="error-banner">{err}</div>;
  if (!d) return <div className="empty">불러오는 중…</div>;

  const rows = onlyFull ? d.samples.filter((s) => s.full) : d.samples;
  const fullCount = d.samples.filter((s) => s.full).length;

  return (
    <div className="bsrc">
      <header className="bsrc-head">
        <h2>{d.term}</h2>
        <div className="pt-n">
          글 {d.samples.length}건 · 방 {d.channels.length}곳
          {fullCount > 0 && <> · 전문 {fullCount}건</>}
        </div>
        {fullCount > 0 && fullCount < d.samples.length && (
          <button
            className={`filter-btn${onlyFull ? " active" : ""}`}
            onClick={() => setOnlyFull((v) => !v)}
          >
            {onlyFull ? "전부 보기" : "전문만 보기"}
          </button>
        )}
      </header>

      {rows.length === 0 ? (
        <div className="empty">남아 있는 글이 없습니다.</div>
      ) : (
        <div className="bsrc-list">
          {rows.map((s, i) => (
            <article className="bsrc-item" key={`${s.link}|${i}`}>
              <div className="bsrc-meta">
                <b>{s.channel}</b>
                <span className="pt-n">{s.at.replace("T", " ").slice(0, 16)}</span>
                {s.full ? (
                  <span className="bsrc-badge full">전문</span>
                ) : (
                  <span className="bsrc-badge cut" title="수집할 때 잘린 조각입니다">
                    일부
                  </span>
                )}
                {s.link && (
                  <a className="bsrc-link" href={s.link} target="_blank" rel="noopener noreferrer">
                    텔레그램 ↗
                  </a>
                )}
              </div>
              {/* 글이 주인공이다 — 메타는 위에 작게, 본문은 읽기 좋은 크기로 */}
              <p className="bsrc-text">{s.text}</p>
            </article>
          ))}
        </div>
      )}

      <div className="table-note">
        「주요 채널」로 고른 방의 글만 <b>자른 데 없이</b> 보관됩니다. 그 밖의 방은
        수집할 때 잘린 조각이라 <b>일부</b>로 표시했습니다. 보관 기간은
        설정 &gt; 비용·상태 &gt; 데이터 보관에서 정합니다.
      </div>
    </div>
  );
}
