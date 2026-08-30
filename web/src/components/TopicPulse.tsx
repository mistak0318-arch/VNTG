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
        <div className="pulse-terms">
          {p.items.slice(0, variant === "full" ? 8 : 5).map((i) => (
            <TermChip key={i.term} item={i} onSelectStock={onSelectStock} />
          ))}
        </div>
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
  onSelectStock,
}: {
  item: PulseItem;
  onSelectStock?: (code: string, name: string) => void;
}) {
  const cls = `pulse-term ${item.where}`;
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

  if (onSelectStock && item.codes.length === 1) {
    return (
      <button className={cls} title={title} onClick={() => onSelectStock(item.codes[0], item.term)}>
        {body}
      </button>
    );
  }
  return (
    <span className={cls} title={title}>
      {body}
    </span>
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
