import { useCallback, useEffect, useRef, useState } from "react";
import { useSheetBack } from "../useSheetBack";
import { api, type ChannelEntry, type MajorMsg, type MajorRoom } from "../api";
import { TgFontButtons, linkifyEscaped, useTgFont } from "./TelegramRoomsPanel";

/** 평문을 HTML 에 넣기 전에 — 태그로 해석될 글자를 막는다 */
function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/**
 * 주요 채널 (2026-08-27) — **골라 둔 채널의 글은 빠짐없이, 원문 그대로.**
 *
 * 받은 방과 똑같은 구조다(사용자 요청) — 주요 채널 하나가 방 하나. 방 목록에
 * 안읽음 말풍선이 뜨고, 누르면 그 채널의 대화방이 열린다(날짜 구분·여기까지 읽음·
 * 방 내 검색·별표). 재료는 서버가 5분마다 모아 두는 아카이브(majorFeed)다.
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

function ago(iso: string | null): string {
  if (!iso) return "";
  const m = Math.floor((Date.now() - new Date(iso).getTime()) / 60_000);
  if (m < 1) return "방금";
  if (m < 60) return `${m}분 전`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}시간 전`;
  return `${Math.floor(h / 24)}일 전`;
}

export function MajorChannelPanel() {
  const [rooms, setRooms] = useState<MajorRoom[] | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  /*
   * 뒤로가기로 **방을 나간다** (2026-08-28 요청). 방에 들어간 것도 「들어간 것」이라
   * 뒤로가기가 목록으로 돌아오는 길이어야 한다 — 전에는 페이지가 통째로 넘어갔다.
   * Esc·◀·목록 버튼으로 나가도 훅이 쌓아 둔 히스토리 칸을 스스로 회수한다.
   */
  useSheetBack(open !== null, () => setOpen(null));
  const [msgs, setMsgs] = useState<MajorMsg[]>([]);
  const [label, setLabel] = useState("");
  const [readAt, setReadAt] = useState("");
  const [query, setQuery] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [starred, setStarred] = useState<Set<string>>(new Set());
  const [channels, setChannels] = useState<ChannelEntry[]>([]);
  const [pickOpen, setPickOpen] = useState(false);
  const [pickFilter, setPickFilter] = useState("");
  const endRef = useRef<HTMLDivElement>(null);
  const unreadRef = useRef<HTMLDivElement>(null);
  /*
   * 방 순서 — **업데이트순 고정** (2026-08-29 요청).
   *
   * 끌어서 바꾸는 순서(useCardOrder)를 뒀었는데, 한 번 손대면 그 순서가 굳어서
   * **새 글이 온 방이 아래에 처박힌다.** 이 목록을 보는 이유가 「어디에 새 글이
   * 왔나」인데 그걸 가리면 목록이 제 일을 못 한다. 메신저들이 다 최신순으로
   * 고정해 두는 이유이기도 하다.
   * 정렬은 화면에서 한다 — 서버가 이미 최신순으로 주지만, 읽음 처리 뒤
   * 목록을 다시 안 받는 사이에도 자리가 맞아야 한다.
   */
  const font = useTgFont();

  const loadRooms = useCallback(() => {
    void api
      .majorRooms()
      .then((r) => setRooms(r.rooms))
      .catch((e: Error) => setError(e.message));
  }, []);

  useEffect(() => {
    loadRooms();
    void api
      .channels()
      .then((r) => setChannels(r.channels))
      .catch(() => undefined);
    /* 별표는 받은 방과 같은 보관함 — 「중요 메시지」 탭에 같이 모인다 */
    void api
      .tgStars()
      .then((r) => setStarred(new Set(r.stars.map((s) => `${s.channel}:${s.id}`))))
      .catch(() => undefined);
    /* 새 글 말풍선 — 서버 수집이 5분 주기라 1분 폴링이면 넉넉하다 */
    const t = setInterval(() => {
      if (document.visibilityState === "visible") loadRooms();
    }, 60_000);
    return () => clearInterval(t);
  }, [loadRooms]);

  /* Esc 로 방 목록 — 받은 방과 같은 규칙 */
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA")) return;
      if (e.key === "Escape") setOpen(null);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open]);

  /* 방 열기 — 「여기까지 읽음」 선에서 시작. 다 읽었거나 처음 여는 방은 최신부터 */
  async function openRoom(id: string) {
    setOpen(id);
    setMsgs([]);
    setQuery("");
    try {
      const r = await api.majorRoom(id);
      setMsgs(r.messages);
      setLabel(r.name);
      setReadAt(r.readAt); // 읽음 처리 전의 값 — 선은 이 시각에 긋는다
      await api.majorRoomRead(id).catch(() => undefined);
      setRooms((prev) => prev?.map((x) => (x.id === id ? { ...x, unread: 0 } : x)) ?? prev);
      setTimeout(() => {
        if (unreadRef.current) unreadRef.current.scrollIntoView({ block: "center" });
        else endRef.current?.scrollIntoView({ block: "end" });
      }, 50);
    } catch (e) {
      setError(e instanceof Error ? e.message : "불러오기 실패");
    }
  }

  async function toggleStar(m: MajorMsg) {
    /* 별표 키는 채널 표시 이름 — 「중요 메시지」에서 어느 방 글인지 그대로 보인다 */
    const key = `${m.channel}:${m.id}`;
    try {
      const r = await api.tgStar(m.channel, { id: m.id, at: m.at, text: m.text });
      setStarred((prev) => {
        const next = new Set(prev);
        if (r.starred) next.add(key);
        else next.delete(key);
        return next;
      });
    } catch {
      /* 다음 클릭에 다시 */
    }
  }

  async function toggleMajor(ch: ChannelEntry) {
    try {
      const r = await api.channelsSetMajor([{ id: ch.id, major: !ch.major }]);
      setChannels(r.channels);
      loadRooms(); // 방 목록에 바로 반영
    } catch {
      /* 다음 클릭에 다시 */
    }
  }

  if (error && rooms === null) return <div className="error-banner">{error}</div>;
  if (rooms === null) return <div className="empty">방 목록 불러오는 중…</div>;

  /*
   * 업데이트순 — 최근 글이 온 방이 위다. 글이 한 번도 없던 방(lastAt=null)은
   * 맨 아래로 보내고 이름순으로 둔다: 시각이 없는 것끼리 뒤섞이면 열 때마다
   * 자리가 달라져 어지럽다.
   */
  const sortedRooms = [...rooms].sort((a, b) => {
    if (!a.lastAt && !b.lastAt) return a.name.localeCompare(b.name);
    if (!a.lastAt) return 1;
    if (!b.lastAt) return -1;
    return b.lastAt.localeCompare(a.lastAt);
  });

  /* ── 대화방 뷰 — 받은 방과 같은 문법 ── */
  if (open) {
    let lastDay = "";
    const q = query.trim().toLowerCase();
    const shown = q ? msgs.filter((m) => m.text.toLowerCase().includes(q)) : msgs;
    const firstUnread = readAt && !q ? shown.findIndex((m) => m.at > readAt) : -1;
    return (
      <div className="tgr-room" style={font.style}>
        <div className="tgr-room-head">
          {/* 받은 방과 같은 자리·같은 크기 (2026-08-27) */}
          <button className="tgr-back" onClick={() => setOpen(null)} title="방 목록으로 (Esc)">
            ‹ 방 목록
          </button>
          <b>{label}</b>
          <TgFontButtons font={font} />
          <span className="pt-n tgr-head-note">최근 {msgs.length}건 · 5분마다 수집</span>
        </div>
        <div className="search-box tgr-search-row">
          <input
            className="search-input"
            type="text"
            inputMode="search"
            placeholder="이 방에서 검색 — 모아 둔 글 안에서 찾습니다"
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
            <div className="empty">아직 모인 글이 없습니다 — 다음 수집(5분 안)에 채워집니다.</div>
          )}
          {q && shown.length === 0 && msgs.length > 0 && (
            <div className="empty">「{query.trim()}」 — 모아 둔 글에는 없습니다.</div>
          )}
          {shown.map((m, i) => {
            const day = dayOf(m.at);
            const showDay = day !== lastDay;
            lastDay = day;
            const key = `${m.channel}:${m.id}`;
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
                    {/*
                      원문 그대로. 평문이라 **이스케이프한 뒤 주소만 링크로** 바꾼다
                      (2026-08-27) — 채널 글은 링크가 본론일 때가 많은데 텍스트로만
                      넣어서 눈에는 보이고 못 눌렀다. HTML 해석은 여전히 없다.
                    */}
                    <div
                      className="tgr-text tgr-plain"
                      dangerouslySetInnerHTML={{ __html: linkifyEscaped(escapeHtml(m.text)) }}
                    />
                    <span className="tgr-time">
                      {hm(m.at)}
                      {m.link && (
                        <a
                          className="tgr-src"
                          href={m.link}
                          target="_blank"
                          rel="noopener noreferrer"
                          title="텔레그램 원문으로"
                        >
                          ↗
                        </a>
                      )}
                    </span>
                  </div>
                  <button
                    className={`tgr-star${starred.has(key) ? " on" : ""}`}
                    onClick={() => void toggleStar(m)}
                    title={starred.has(key) ? "중요 해제" : "중요 표시 — 「중요 메시지」에 모입니다"}
                  >
                    {starred.has(key) ? "★" : "☆"}
                  </button>
                </div>
              </div>
            );
          })}
          <div ref={endRef} />
        </div>
        {/* 방 목록으로 — 오른쪽 아래 플로팅 (받은 방과 같은 이유) */}
        <button className="tgr-fab" onClick={() => setOpen(null)} title="방 목록으로">
          ‹ 방 목록
        </button>
      </div>
    );
  }

  /* ── 방 목록 — 받은 방과 같은 모양 + 위에 채널 고르기 ── */
  const majorCount = channels.filter((c) => c.major).length || rooms.length;
  return (
    <div className="tgr-list">
      <div className="tgr-room-head">
        <button className="filter-btn" onClick={() => setPickOpen((v) => !v)}>
          {pickOpen ? "채널 고르기 닫기" : `⭐ 채널 고르기 (${majorCount})`}
        </button>
        <span className="pt-n">별표한 채널마다 방이 하나씩 생깁니다 — 글은 5분마다 수집</span>
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
              .filter(
                (c) => !pickFilter.trim() || c.name.toLowerCase().includes(pickFilter.trim().toLowerCase()),
              )
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
              <div className="pt-n">
                구독 채널 목록이 없습니다 — 설정 &gt; 발행·알림에서 채널을 불러오세요.
              </div>
            )}
          </div>
          <div className="table-note">
            ★ 채널의 글은 서버가 <b>5분마다 원문 그대로</b> 모읍니다 (동향의 수집 대상 여부와
            무관). 등록 직후 첫 수집은 최근 12시간을 거슬러 채웁니다.
          </div>
        </div>
      )}

      {rooms.length === 0 && (
        <div className="empty">
          아직 등록된 채널이 없습니다 — 위 「⭐ 채널 고르기」에서 별표하면 방이 생깁니다.
        </div>
      )}
      {sortedRooms.map((r) => (
        <button
          key={r.id}
          className="tgr-room-row"
          onClick={() => void openRoom(r.id)}
          title="최근 글이 온 순서입니다"
        >
          <span className="tgr-avatar">{r.name.slice(0, 1)}</span>
          <span className="tgr-room-main">
            <b>{r.name}</b>
            <i className="tgr-preview">{r.preview || "메시지 없음"}</i>
          </span>
          <span className="tgr-room-side">
            <i className="tgr-ago">{ago(r.lastAt)}</i>
            {r.unread > 0 && <em className="tgr-badge">{r.unread > 99 ? "99+" : r.unread}</em>}
          </span>
        </button>
      ))}
    </div>
  );
}
