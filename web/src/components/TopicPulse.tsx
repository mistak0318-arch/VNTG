import { useEffect, useState } from "react";
import { api, type PulseItem, type PulseWindow, type TopicPulse } from "../api";

/**
 * 지금 시장의 화제 — **네 브리핑 화면이 같은 말을 하게** (2026-08-30 요청).
 *
 * 문장은 서버가 만든다([topicPulse](../../server/src/topicPulse.ts)). 화면마다
 * 따로 지으면 **같은 시각에 네 화면이 다른 말을 한다** — 「관세로 시끄럽다」와
 * 「조용하다」가 나란히 떠 있으면 어느 쪽도 못 믿는다.
 *
 * 여기서는 **얼마나 펼칠지**만 정한다:
 *
 *   line — 한 줄. 시황 대시보드 카드처럼 자리가 없는 곳
 *   card — 문장 + 근거 + 낱말 몇 개. 장전 브리핑룸·마켓 브리핑
 *   full — 낱말마다 근거를 붙인 것. 데일리 리포트처럼 읽는 글
 */

export function TopicPulseBlock({
  window: win,
  variant = "card",
  onSelectStock,
}: {
  window: PulseWindow;
  variant?: "line" | "card" | "full";
  onSelectStock?: (code: string, name: string) => void;
}) {
  const [p, setP] = useState<TopicPulse | null>(null);
  /** 펴 놓은 낱말 — 한 번에 하나만. 여럿 펴면 카드가 화면을 다 먹는다 */
  const [open, setOpen] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    const load = () =>
      api
        .topicPulse(win)
        .then((r) => alive && setP(r))
        .catch((e: Error) => alive && setErr(e.message));
    load();
    /* 수집이 3~5분 주기라 그보다 자주 물어도 새 값이 없다 */
    const t = setInterval(load, 5 * 60_000);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, [win]);

  if (err) return <div className="pulse-line quiet">화제를 못 불러왔습니다 — {err}</div>;
  if (!p) return <div className="pulse-line quiet">화제를 살피는 중…</div>;

  if (variant === "line") {
    return (
      <div className={`pulse-line${p.hot ? " hot" : " quiet"}`} title={p.detail}>
        {p.hot && <b className="pulse-dot" aria-hidden="true" />}
        {p.headline}
      </div>
    );
  }

  return (
    <div className={`pulse${p.hot ? " hot" : ""}`}>
      <div className="pulse-head">{p.headline}</div>
      <div className="pulse-detail">{renderDetail(p.detail)}</div>

      {p.items.length > 0 && (
        <>
          <div className="pulse-terms">
            {p.items.slice(0, variant === "full" ? 8 : 5).map((i) => (
              <TermChip
                key={i.term}
                item={i}
                active={open === i.term}
                onToggle={() => setOpen((v) => (v === i.term ? null : i.term))}
              />
            ))}
          </div>
          {/*
            **누르면 근거가 펴진다** (2026-08-31 — "누르면 뉴스 리스트나 관련된거
            내용이라도 나와야 되지 않아?").
            예전엔 종목이 **정확히 하나**일 때만 눌렸고 그마저 바로 그 종목으로
            떠났다. 낱말이 왜 떴는지는 못 본 채 화면만 바뀐 셈이다.
          */}
          {open &&
            (() => {
              const it = p.items.find((x) => x.term === open);
              return it ? (
                <TermEvidence item={it} onSelectStock={onSelectStock} />
              ) : null;
            })()}
        </>
      )}

      {variant === "full" && <FullEvidence pulse={p} />}

      {!p.hot && p.health.baselineDays >= 2 && (
        <div className="pulse-foot">
          채널 {p.health.channelTotal}건 · 기사 {p.health.newsArticles}건을 살폈습니다.
        </div>
      )}
    </div>
  );
}

/** `**굵게**` 만 처리한다 — 서버 문장에 강조가 한두 군데 들어간다 */
function renderDetail(s: string) {
  return s.split(/(\*\*[^*]+\*\*)/g).map((part, i) =>
    part.startsWith("**") && part.endsWith("**") ? (
      <b key={i}>{part.slice(2, -2)}</b>
    ) : (
      <span key={i}>{part}</span>
    ),
  );
}

/**
 * 낱말 하나.
 *
 * **어디서 떴는지를 색으로 나눈다** — 양쪽(금색)·채널만·뉴스만. 이 구분이 이
 * 시스템의 요점이라 한눈에 보여야 한다.
 */
function TermChip({
  item,
  active,
  onToggle,
}: {
  item: PulseItem;
  active: boolean;
  onToggle: () => void;
}) {
  const cls = `pulse-term ${item.where}${active ? " open" : ""}`;
  const label =
    item.where === "both" ? "채널+뉴스" : item.where === "channel" ? "채널" : "뉴스";
  const body = (
    <>
      {item.term}
      <i>{label}</i>
      {item.fresh && <em>NEW</em>}
    </>
  );
  const title = `${label} · 채널 ${item.buzzCount}건 · 뉴스 ${item.newsCount}건${
    item.sources > 0 ? ` · ${item.sources}곳` : ""
  }`;

  /*
   * **언제나 누를 수 있다.** 예전엔 종목이 정확히 하나일 때만 버튼이었는데,
   * 낱말은 대개 종목이 없거나 여럿이라 대부분이 못 누르는 글자였다.
   * 누르면 아래에 근거가 펴진다 — 종목으로 가는 것은 그 안에서 고른다.
   */
  return (
    <button className={cls} title={`${title} · 눌러서 근거 보기`} onClick={onToggle}>
      {body}
    </button>
  );
}

/**
 * 낱말 하나의 **근거** (2026-08-31).
 *
 * ## 무엇을 보여주나
 *
 *   ① 이 낱말이 어디서 몇 건 떴나 — 채널·뉴스·매체 수
 *   ② 원문 한 줄(`quote`) — 서버가 이미 뽑아 두고 있었는데 데일리 리포트에서만 썼다
 *   ③ 관련 종목 — 누르면 그 종목으로
 *   ④ 뉴스 목록 — 누를 때 **그때 받는다**
 *
 * ④를 미리 안 받는 이유: 칩이 다섯~여덟 개인데 전부 미리 받으면 브리핑 화면
 * 하나에 뉴스 조회가 여덟 번 나간다. 눌러야 보는 값이라 눌렀을 때 받는 것이 맞다.
 */
function TermEvidence({
  item,
  onSelectStock,
}: {
  item: PulseItem;
  onSelectStock?: (code: string, name: string) => void;
}) {
  const [news, setNews] = useState<{ title: string; press: string; link: string }[] | null>(null);
  const [err, setErr] = useState(false);

  useEffect(() => {
    let alive = true;
    setNews(null);
    setErr(false);
    api
      .news(item.term, { display: 8 })
      .then((r) => alive && setNews(r.items.slice(0, 8)))
      .catch(() => alive && setErr(true));
    return () => {
      alive = false;
    };
  }, [item.term]);

  return (
    <div className="pulse-ev-box">
      <div className="pulse-ev-head">
        <b>{item.term}</b>
        <span className="pt-n">
          채널 {item.buzzCount}건 · 뉴스 {item.newsCount}건
          {item.sources > 0 && ` · ${item.sources}곳`}
          {item.fresh && " · 오늘 처음"}
        </span>
      </div>

      {item.quote && (
        <div className="pulse-ev-q">
          「{item.quote}」{item.quoteFrom && <i> ({item.quoteFrom})</i>}
        </div>
      )}

      {item.codes.length > 0 && onSelectStock && (
        <div className="pulse-ev-codes">
          {item.codes.slice(0, 8).map((c) => (
            <button key={c} className="filter-btn" onClick={() => onSelectStock(c, item.term)}>
              {c}
            </button>
          ))}
          <span className="pt-n">눌러서 종목 화면으로</span>
        </div>
      )}

      {news === null && !err && <div className="pt-n">뉴스 찾는 중…</div>}
      {err && <div className="pt-n">뉴스를 못 받았습니다.</div>}
      {news !== null && news.length === 0 && (
        <div className="pt-n">
          이 낱말로 걸리는 기사가 없습니다 — 채널에서만 돌고 있는 얘기일 수 있습니다.
        </div>
      )}
      {news !== null && news.length > 0 && (
        <ul className="pulse-ev-news">
          {news.map((n) => (
            <li key={n.link}>
              <a href={n.link} target="_blank" rel="noreferrer">
                {n.title}
              </a>
              <span className="pt-n"> {n.press}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/** 데일리 리포트용 — 낱말마다 근거 한 줄. 읽는 글이라 인용을 붙인다 */
function FullEvidence({ pulse }: { pulse: TopicPulse }) {
  const withQuote = pulse.items.filter((i) => i.quote).slice(0, 4);
  if (withQuote.length === 0) return null;
  return (
    <ul className="pulse-ev">
      {withQuote.map((i) => (
        <li key={i.term}>
          <b>{i.term}</b>
          <span className="pulse-ev-q">
            「{i.quote}」{i.quoteFrom && <i> ({i.quoteFrom})</i>}
          </span>
        </li>
      ))}
    </ul>
  );
}
