import { useEffect, useMemo, useRef, useState } from "react";
import { api, type ChannelEntry, type MajorMsg } from "../api";

/**
 * 주요 채널 (2026-08-27) — **골라 둔 채널의 글은 빠짐없이, 원문 그대로.**
 *
 * 동향은 AI 가 고르고 줄인 요약이다. 회사에서 텔레그램이 막혀 있는 사용자에게는
 * 「읽어볼 만한 채널 몇 곳은 한 글자도 안 빼고 다 본다」는 자리가 따로 필요하다.
 * 서버가 5분마다 주요 채널만 통째로 아카이브하고, 여기서 VNTG 방 뷰어와 같은
 * 문법(말풍선·여기까지 읽음·검색)으로 읽는다.
 *
 * ⚠️ 사이드바 N 배지에는 일부러 안 넣는다 — 모든 글을 긁어오는 방이라 늘 새 글이
 * 있고, 그러면 배지가 항상 켜져 신호가 죽는다 (사용자 요청).
 */

function hm(iso: string): string {
  const d = new Date(iso);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

function dayOf(iso: string): string {
  const d = new Date(iso);
  return `${d.getMonth() + 1}/${d.getDate()} (${"일월화수목금토"[d.getDay()]})`;
}

export function MajorChannelPanel() {
  const [msgs, setMsgs] = useState<MajorMsg[] | null>(null);
  const [readAt, setReadAt] = useState("");
  const [channels, setChannels] = useState<ChannelEntry[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [pickOpen, setPickOpen] = useState(false);
  const [pickFilter, setPickFilter] = useState("");
  const endRef = useRef<HTMLDivElement>(null);
  const unreadRef = useRef<HTMLDivElement>(null);

  /* 처음 열 때 한 번 — 피드 받고 읽음 처리. 「여기까지 읽음」 선은 그 전 값으로 긋는다 */
  useEffect(() => {
    let alive = true;
    void api
      .majorFeed()
      .then(async (r) => {
        if (!alive) return;
        setMsgs(r.messages);
        setReadAt(r.readAt);
        await api.majorFeedRead().catch(() => undefined);
        setTimeout(() => {
          if (unreadRef.current) unreadRef.current.scrollIntoView({ block: "center" });
          else endRef.current?.scrollIntoView({ block: "end" });
        }, 50);
      })
      .catch((e: Error) => alive && setError(e.message));
    void api
      .channels()
      .then((r) => alive && setChannels(r.channels))
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, []);

  async function reload() {
    try {
      const r = await api.majorFeed();
      setMsgs(r.messages);
      setReadAt(r.readAt); // 마지막 읽음 이후 새로 온 것 앞에 선이 다시 그어진다
      await api.majorFeedRead().catch(() => undefined);
    } catch (e) {
      setError(e instanceof Error ? e.message : "불러오기 실패");
    }
  }

  async function toggleMajor(ch: ChannelEntry) {
    try {
      const r = await api.channelsSetMajor([{ id: ch.id, major: !ch.major }]);
      setChannels(r.channels);
    } catch {
      /* 다음 클릭에 다시 */
    }
  }

  const majors = channels.filter((c) => c.major);
  const q = query.trim().toLowerCase();
  const shown = useMemo(
    () => (q && msgs ? msgs.filter((m) => `${m.channel}\n${m.text}`.toLowerCase().includes(q)) : (msgs ?? [])),
    [msgs, q],
  );
  const firstUnread = readAt && !q ? shown.findIndex((m) => m.at > readAt) : -1;

  if (error && msgs === null) return <div className="error-banner">{error}</div>;
  if (msgs === null) return <div className="empty">불러오는 중…</div>;

  let lastDay = "";
  return (
    <div className="tgr-room">
      <div className="tgr-room-head">
        <b>주요 채널</b>
        <span className="pt-n">
          {majors.length > 0
            ? `${majors.length}곳 · ${msgs.length}건 (5분마다 수집)`
            : "아직 등록된 채널이 없습니다"}
        </span>
        <button className="filter-btn" onClick={() => void reload()} title="새 글 다시 읽기">
          ↻ 새로고침
        </button>
        <button className="filter-btn" onClick={() => setPickOpen((v) => !v)}>
          {pickOpen ? "채널 고르기 닫기" : `⭐ 채널 고르기 (${majors.length})`}
        </button>
      </div>

      {pickOpen && (
        <div className="mjr-pick">
          <input
            className="search-input"
            placeholder="채널 이름으로 거르기"
            value={pickFilter}
            onChange={(e) => setPickFilter(e.target.value)}
          />
          <div className="mjr-pick-list">
            {channels
              .filter((c) => !pickFilter.trim() || c.name.toLowerCase().includes(pickFilter.trim().toLowerCase()))
              .map((c) => (
                <button
                  key={c.id}
                  className={`mjr-pick-row${c.major ? " on" : ""}`}
                  onClick={() => void toggleMajor(c)}
                  title={c.major ? "주요 채널에서 빼기" : "주요 채널로 — 글을 빠짐없이 모읍니다"}
                >
                  <i>{c.major ? "★" : "☆"}</i>
                  <span>{c.name}</span>
                </button>
              ))}
            {channels.length === 0 && (
              <div className="pt-n">구독 채널 목록이 없습니다 — 설정 &gt; 발행·알림에서 채널을 불러오세요.</div>
            )}
          </div>
          <div className="table-note">
            ★ 채널의 글은 서버가 <b>5분마다 원문 그대로</b> 모읍니다 (동향의 수집 대상 여부와
            무관). 등록 직후 첫 수집은 최근 12시간을 거슬러 채웁니다.
          </div>
        </div>
      )}

      <div className="search-box tgr-search-row">
        <input
          className="search-input"
          type="text"
          inputMode="search"
          placeholder="이 방에서 검색 — 채널 이름·본문"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
        {q && (
          <>
            <span className="pt-n tgr-search-n">{shown.length}건</span>
            <button className="qss-close" onClick={() => setQuery("")} title="검색 지우기">
              ✕
            </button>
          </>
        )}
      </div>

      <div className="tgr-msgs">
        {msgs.length === 0 && (
          <div className="empty">
            아직 글이 없습니다 — 위 「⭐ 채널 고르기」에서 채널을 등록하면 미니PC가 5분 안에
            모아 옵니다.
          </div>
        )}
        {q && shown.length === 0 && msgs.length > 0 && (
          <div className="empty">「{query.trim()}」 — 모아 둔 글에는 없습니다.</div>
        )}
        {shown.map((m, i) => {
          const day = dayOf(m.at);
          const showDay = day !== lastDay;
          lastDay = day;
          return (
            <div key={m.id}>
              {i === firstUnread && (
                <div className="tgr-unread" ref={unreadRef}>
                  여기까지 읽음 — 아래부터 새 글
                </div>
              )}
              {showDay && <div className="tgr-day">{day}</div>}
              <div className="tgr-bubble-row">
                <div className="tgr-bubble">
                  <div className="tgr-chname">
                    {m.channel}
                    {m.link && (
                      <a href={m.link} target="_blank" rel="noopener noreferrer" title="텔레그램 원문으로">
                        ↗
                      </a>
                    )}
                  </div>
                  {/* 원문 그대로 — 채널 글은 평문이라 텍스트 노드로 넣는다 (HTML 해석 없음) */}
                  <div className="tgr-text tgr-plain">{m.text}</div>
                  <span className="tgr-time">{hm(m.at)}</span>
                </div>
              </div>
            </div>
          );
        })}
        <div ref={endRef} />
      </div>
    </div>
  );
}
