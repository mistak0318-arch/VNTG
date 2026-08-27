import { useCallback, useEffect, useRef, useState } from "react";
import { api, type TgMsg, type TgRoom, type TgStar } from "../api";

/**
 * VNTG 방 뷰어 (2026-08-27) — **봇이 보낸 방들을 브라우저에서 텔레그램처럼.**
 *
 * "6개 방을 폰으로 일일이 들어가 보기 쉽지 않다" — 방 목록에 안읽음 말풍선,
 * 누르면 대화방처럼 메시지가 흐르고, 중요한 건 별표로 집어 「중요 메시지」에서
 * 모아 본다. 재료는 서버의 **발신 아카이브**다(보낼 때 같이 저장 — 스캔 비용 0).
 * 방을 열면 읽음 처리되고, 미니PC(MTProto 세션)에선 **폰 텔레그램도 읽음**이 된다.
 */

/** 봇 메시지의 HTML — 우리가 만든 것이지만 외부 텍스트가 섞이므로 화이트리스트로 거른다 */
export function sanitizeTgHtml(html: string): string {
  const ALLOW = new Set(["B", "STRONG", "I", "EM", "U", "S", "CODE", "PRE", "BR", "A"]);
  const doc = new DOMParser().parseFromString(html, "text/html");
  const walk = (node: Node): string => {
    if (node.nodeType === Node.TEXT_NODE) {
      const d = document.createElement("div");
      d.textContent = node.textContent ?? "";
      return d.innerHTML; // 이스케이프된 텍스트
    }
    if (node.nodeType !== Node.ELEMENT_NODE) return "";
    const el = node as Element;
    const inner = [...el.childNodes].map(walk).join("");
    if (!ALLOW.has(el.tagName)) return inner;
    if (el.tagName === "BR") return "<br/>";
    if (el.tagName === "A") {
      const href = el.getAttribute("href") ?? "";
      if (!/^https:\/\//i.test(href)) return inner;
      return `<a href="${href.replace(/"/g, "&quot;")}" target="_blank" rel="noopener noreferrer">${inner}</a>`;
    }
    const tag = el.tagName.toLowerCase();
    return `<${tag}>${inner}</${tag}>`;
  };
  return [...doc.body.childNodes].map(walk).join("");
}

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

export function TelegramRoomsPanel() {
  const [rooms, setRooms] = useState<TgRoom[] | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  const [msgs, setMsgs] = useState<TgMsg[]>([]);
  const [label, setLabel] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [starred, setStarred] = useState<Set<string>>(new Set());
  const [phoneRead, setPhoneRead] = useState<boolean | null>(null);
  const endRef = useRef<HTMLDivElement>(null);

  const loadRooms = useCallback(() => {
    void api
      .tgRooms()
      .then((r) => setRooms(r.rooms))
      .catch((e: Error) => setError(e.message));
  }, []);

  useEffect(() => {
    loadRooms();
    void api
      .tgStars()
      .then((r) => setStarred(new Set(r.stars.map((s) => `${s.channel}:${s.id}`))))
      .catch(() => undefined);
    /* 새 메시지 말풍선 — 1분이면 충분하다 (발신 즉시 쌓이니 지연은 폴링 주기뿐) */
    const t = setInterval(() => {
      if (document.visibilityState === "visible") loadRooms();
    }, 60_000);
    return () => clearInterval(t);
  }, [loadRooms]);

  /* 방 열기 — 메시지 받고, 읽음 처리(뷰어 + 가능하면 폰 텔레그램까지) */
  async function openRoom(ch: string) {
    setOpen(ch);
    setMsgs([]);
    setPhoneRead(null);
    try {
      const r = await api.tgRoom(ch);
      setMsgs(r.messages);
      setLabel(r.label);
      const read = await api.tgRoomRead(ch);
      setPhoneRead((read as { phoneRead?: boolean }).phoneRead ?? false);
      setRooms((prev) => prev?.map((x) => (x.channel === ch ? { ...x, unread: 0 } : x)) ?? prev);
      // 사이드바 「텔레그램 동향」의 N 배지가 바로 꺼지게 — App 이 이 이벤트로 다시 센다
      window.dispatchEvent(new Event("vntg:tg-read"));
      setTimeout(() => endRef.current?.scrollIntoView({ block: "end" }), 50);
    } catch (e) {
      setError(e instanceof Error ? e.message : "불러오기 실패");
    }
  }

  async function toggleStar(m: TgMsg) {
    if (!open) return;
    const key = `${open}:${m.id}`;
    try {
      const r = await api.tgStar(open, m);
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

  if (error && rooms === null) return <div className="error-banner">{error}</div>;
  if (rooms === null) return <div className="empty">방 목록 불러오는 중…</div>;

  /* ── 대화방 뷰 ── */
  if (open) {
    let lastDay = "";
    return (
      <div className="tgr-room">
        <div className="tgr-room-head">
          <button className="filter-btn" onClick={() => setOpen(null)}>
            ‹ 방 목록
          </button>
          <b>{label}</b>
          <span className="pt-n">
            최근 {msgs.length}건
            {phoneRead === true && " · 폰 텔레그램도 읽음 처리됨"}
            {phoneRead === false && " · 읽음은 이 화면만 (폰 연동은 미니PC에서)"}
          </span>
        </div>
        <div className="tgr-msgs">
          {msgs.length === 0 && <div className="empty">아직 이 방으로 보낸 메시지가 없습니다.</div>}
          {msgs.map((m) => {
            const day = dayOf(m.at);
            const showDay = day !== lastDay;
            lastDay = day;
            const key = `${open}:${m.id}`;
            return (
              <div key={m.id}>
                {showDay && <div className="tgr-day">{day}</div>}
                <div className="tgr-bubble-row">
                  <div className="tgr-bubble">
                    <div
                      className="tgr-text"
                      // 자체 발신 HTML — 화이트리스트(sanitizeTgHtml)로 거른 것만 넣는다
                      dangerouslySetInnerHTML={{ __html: sanitizeTgHtml(m.text) }}
                    />
                    <span className="tgr-time">{hm(m.at)}</span>
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
      </div>
    );
  }

  /* ── 방 목록 ── */
  return (
    <div className="tgr-list">
      {rooms.map((r) => (
        <button key={r.channel} className="tgr-room-row" onClick={() => void openRoom(r.channel)}>
          <span className="tgr-avatar">{r.label.slice(0, 1)}</span>
          <span className="tgr-room-main">
            <b>{r.label}</b>
            <i className="tgr-preview">{r.preview || "메시지 없음"}</i>
          </span>
          <span className="tgr-room-side">
            <i className="tgr-ago">{ago(r.lastAt)}</i>
            {r.unread > 0 && <em className="tgr-badge">{r.unread > 99 ? "99+" : r.unread}</em>}
          </span>
        </button>
      ))}
      <div className="table-note">
        서버가 <b>보내는 순간 같이 저장</b>한 것이라 스캔 비용이 없습니다. 방을 열면 읽음
        처리되고, 미니PC(텔레그램 세션이 있는 곳)에서는 <b>폰 텔레그램의 안읽음도 같이
        지워집니다</b>. 메시지 옆 ☆ 를 누르면 「중요 메시지」에 모입니다.
      </div>
    </div>
  );
}

/** 중요 메시지 — 별표로 집은 것들 */
export function TelegramStarsPanel() {
  const [stars, setStars] = useState<TgStar[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(() => {
    void api
      .tgStars()
      .then((r) => setStars(r.stars))
      .catch((e: Error) => setError(e.message));
  }, []);
  useEffect(() => load(), [load]);

  if (error) return <div className="error-banner">{error}</div>;
  if (stars === null) return <div className="empty">불러오는 중…</div>;
  if (stars.length === 0) {
    return (
      <div className="empty">
        아직 별표한 메시지가 없습니다 — 「받은 방」에서 메시지 옆 ☆ 를 누르면 여기 모입니다.
      </div>
    );
  }
  return (
    <div className="tgr-stars">
      {stars.map((s) => (
        <div className="tgr-star-row" key={`${s.channel}:${s.id}`}>
          <div className="tgr-star-head">
            <em className="tgr-star-room">{s.channel}</em>
            <span className="pt-n">
              {s.at.slice(5, 10)} {hm(s.at)}
            </span>
            <button
              className="row-del-btn"
              title="중요 해제"
              onClick={() =>
                void api
                  .tgStar(s.channel, { id: s.id, at: s.at, text: s.text })
                  .then(load)
                  .catch(() => undefined)
              }
            >
              ★ 해제
            </button>
          </div>
          <div className="tgr-text" dangerouslySetInnerHTML={{ __html: sanitizeTgHtml(s.text) }} />
        </div>
      ))}
    </div>
  );
}
