import { useEffect, useState } from "react";
import { useBuzzDays } from "./BuzzBadge";
import { api, type BuzzDetail, type NewsItem } from "../api";
import { useSheetBack } from "../useSheetBack";

/**
 * 조회순위 「뉴스 N회 · 텔레그램 N회」를 누르면 뜨는 팝업 (2026-09-09).
 *
 * 벤티지: "누르면 우리 이미 긁고 있잖아. 그러니까 그거를 이제 미니 창으로 보여주는 게 …
 * 클릭하면 뉴스 볼 수 있게 해줘. 뉴스 클릭하는 것도 브라우저로 이동하는 옵션을 따로
 * 주고, 클릭하면 그 창 안에서 볼 수 있는 게 더 빠르게 확인할 수 있는 방법인 것 같아."
 *
 * 그래서 세 겹이다 — 목록(뉴스·텔레그램 탭) → 기사를 누르면 **같은 창 안에서 전문** →
 * 「원문 브라우저로」는 따로 단추. 텔레그램 글은 창고에 본문이 다 있으니 그 자리에서
 * 펼치고, 「텔레그램에서 열기」 링크만 단다.
 *
 * 종목 상세 시트와 같은 `overlay`/`sheet` 판이라 폰 뒤로가기로 닫힌다(`useSheetBack`).
 */
export function BuzzSheet({
  code,
  name,
  onClose,
  onSelectStock,
}: {
  code: string;
  name: string;
  onClose: () => void;
  onSelectStock?: (code: string, name: string) => void;
}) {
  const days = useBuzzDays();
  const [data, setData] = useState<BuzzDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [tab, setTab] = useState<"news" | "tg">("news");
  /** 창 안에서 읽는 중인 기사 */
  const [reading, setReading] = useState<NewsItem | null>(null);
  const [body, setBody] = useState<{ link: string; text: string; reason?: string } | null>(null);
  const [bodyLoading, setBodyLoading] = useState(false);
  /** 펼친 텔레그램 글 */
  const [openTg, setOpenTg] = useState<Set<string>>(new Set());

  /* 폰 뒤로가기 = 닫기 (읽던 기사도 함께). 「‹ 목록」 단추가 따로 있다 */
  useSheetBack(true, onClose);

  useEffect(() => {
    let alive = true;
    api
      .rankBuzzDetail(code, days)
      .then((d) => {
        if (!alive) return;
        setData(d);
        /* 뉴스가 하나도 없고 텔레그램만 있으면 그쪽을 먼저 편다 */
        if (d.news.length === 0 && d.tg.length > 0) setTab("tg");
      })
      .catch((e: Error) => alive && setError(e.message));
    return () => {
      alive = false;
    };
  }, [code, days]);

  useEffect(() => {
    if (!reading) return;
    let alive = true;
    setBodyLoading(true);
    setBody(null);
    api
      .newsBody(reading.link)
      .then((r) => alive && setBody({ link: reading.link, ...r }))
      .catch(() => alive && setBody({ link: reading.link, text: "", reason: "본문을 못 받았습니다" }))
      .finally(() => alive && setBodyLoading(false));
    return () => {
      alive = false;
    };
  }, [reading]);

  const stamp = (at: string): string => {
    const d = new Date(at);
    if (Number.isNaN(d.getTime())) return at;
    const mins = Math.round((Date.now() - d.getTime()) / 60_000);
    if (mins < 60) return `${Math.max(mins, 0)}분 전`;
    if (mins < 24 * 60) return `${Math.floor(mins / 60)}시간 전`;
    return d.toLocaleString("ko-KR", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" });
  };

  const openOutside = (url: string) => window.open(url, "_blank", "noopener");

  return (
    <div className="overlay" onClick={onClose}>
      <div className="sheet buzz-sheet" onClick={(e) => e.stopPropagation()}>
        <div className="sheet-header">
          <h2>
            {reading ? (
              <button className="buzz-back" onClick={() => setReading(null)} title="목록으로">
                ‹ 목록
              </button>
            ) : (
              <>
                <button
                  className="link-btn"
                  onClick={() => onSelectStock?.(code, name)}
                  title="종목 상세 열기"
                  disabled={!onSelectStock}
                >
                  {name}
                </button>
                <span className="pt-n"> ({code}) · {days === 1 ? "24시간" : `${days}일`}</span>
              </>
            )}
          </h2>
          <button className="close-btn" onClick={onClose}>
            ✕
          </button>
        </div>

        {error && <div className="error">{error}</div>}
        {!data && !error && <div className="pt-n buzz-empty">읽는 중…</div>}

        {/* ── 기사 전문 ─────────────────────────────────────────── */}
        {data && reading && (
          <div className="buzz-read">
            <h3 className="buzz-read-title">{reading.title}</h3>
            <div className="buzz-read-meta pt-n">
              {reading.press} · {stamp(reading.publishedAt)}
              <span className="news-scope-sep" />
              <button className="filter-btn" onClick={() => openOutside(reading.link)}>
                원문 브라우저로 ↗
              </button>
              {reading.originalLink && reading.originalLink !== reading.link && (
                <button className="filter-btn" onClick={() => openOutside(reading.originalLink)} title="언론사 원문">
                  언론사 ↗
                </button>
              )}
            </div>
            {bodyLoading && <div className="pt-n buzz-empty">본문 받는 중…</div>}
            {body && body.link === reading.link && !bodyLoading && (
              body.text ? (
                /* 문단은 서버가 줄바꿈으로 갈라 둔다 — 한 덩어리면 못 읽는다 */
                <div className="buzz-body">
                  {body.text.split("\n").map((p, i) => (
                    <p key={i}>{p}</p>
                  ))}
                </div>
              ) : (
                <div className="buzz-body">
                  <p className="pt-n">{body.reason ?? "이 기사는 창 안에서 못 읽습니다"} — 요약만 보입니다.</p>
                  <p>{reading.summary}</p>
                  <button className="filter-btn" onClick={() => openOutside(reading.link)}>
                    브라우저로 열기 ↗
                  </button>
                </div>
              )
            )}
          </div>
        )}

        {/* ── 목록 ─────────────────────────────────────────────── */}
        {data && !reading && (
          <>
            <div className="filter-row buzz-tabs">
              <button className={`filter-btn ${tab === "news" ? "active" : ""}`} onClick={() => setTab("news")}>
                📰 뉴스 {data.news.length}
              </button>
              <button className={`filter-btn ${tab === "tg" ? "active" : ""}`} onClick={() => setTab("tg")}>
                ✈ 텔레그램 {data.tg.length}
              </button>
              {tab === "tg" && (
                <span className="pt-n buzz-words" title="이 낱말이 들어간 글을 찾았습니다">
                  「{data.words.join("」「")}」
                </span>
              )}
            </div>

            {tab === "news" &&
              (data.news.length === 0 ? (
                <div className="pt-n buzz-empty">{days === 1 ? "24시간" : `${days}일`} 안에 나온 기사가 없습니다.</div>
              ) : (
                <ul className="buzz-list">
                  {data.news.map((n) => (
                    <li key={n.link} className="buzz-item" onClick={() => setReading(n)} title="창 안에서 읽기">
                      <div className="buzz-title">
                        {n.major && <i className="buzz-major" title="주요 언론사">●</i>}
                        {n.title}
                      </div>
                      <div className="buzz-meta pt-n">
                        {n.press} · {stamp(n.publishedAt)}
                        <button
                          className="buzz-ext"
                          onClick={(e) => {
                            e.stopPropagation();
                            openOutside(n.link);
                          }}
                          title="브라우저로 열기"
                        >
                          ↗
                        </button>
                      </div>
                    </li>
                  ))}
                </ul>
              ))}

            {tab === "tg" &&
              (data.tg.length === 0 ? (
                <div className="pt-n buzz-empty">{days === 1 ? "24시간" : `${days}일`} 안에 이 종목을 말한 채널 글이 없습니다.</div>
              ) : (
                <ul className="buzz-list">
                  {data.tg.map((h) => {
                    const k = `${h.channelId}:${h.messageId}`;
                    const open = openTg.has(k);
                    return (
                      <li
                        key={k}
                        className={`buzz-item${open ? " open" : ""}`}
                        onClick={() =>
                          setOpenTg((s) => {
                            const n = new Set(s);
                            if (n.has(k)) n.delete(k);
                            else n.add(k);
                            return n;
                          })
                        }
                        title={open ? "접기" : "펼치기"}
                      >
                        <div className="buzz-meta pt-n">
                          <b>{h.channelName}</b> · {stamp(h.at)}
                          {h.link && (
                            <button
                              className="buzz-ext"
                              onClick={(e) => {
                                e.stopPropagation();
                                openOutside(h.link);
                              }}
                              title="텔레그램에서 열기"
                            >
                              ↗
                            </button>
                          )}
                        </div>
                        {/* 접혀 있으면 앞 두 줄만 — 펼치면 전문 */}
                        <div className={`buzz-tg-text${open ? "" : " clamp"}`}>{h.text}</div>
                      </li>
                    );
                  })}
                </ul>
              ))}
          </>
        )}
      </div>
    </div>
  );
}
