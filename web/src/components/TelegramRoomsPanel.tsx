import { useCallback, useEffect, useRef, useState, type CSSProperties } from "react";
import { useSheetBack } from "../useSheetBack";
import { api, type TgMsg, type TgRoom, type TgStar } from "../api";
import { useCardOrder } from "../useCardOrder";

/**
 * 방 본문 글씨 크기 (2026-08-27 — "본문 글씨 키우고 줄이게 옵션 좀").
 * 기기별(localStorage)이다 — 27인치와 폰의 답이 다르다. 받은 방·주요 채널이 같이 쓴다.
 */
const FONT_KEY = "vntg.tgr.font";

export function useTgFont() {
  const [scale, setScale] = useState<number>(() => {
    const v = Number(localStorage.getItem(FONT_KEY));
    return Number.isFinite(v) && v >= 80 && v <= 160 ? v : 100;
  });
  /* 함수형 갱신 — 연속으로 빠르게 누르면 클로저의 옛 값 때문에 한 번만 먹는다 */
  const nudge = (d: number) =>
    setScale((prev) => {
      const v = Math.min(160, Math.max(80, prev + d));
      try {
        localStorage.setItem(FONT_KEY, String(v));
      } catch {
        /* 못 적어도 이번 화면에는 적용된다 */
      }
      return v;
    });
  return {
    scale,
    dec: () => nudge(-10),
    inc: () => nudge(10),
    /* .tgr-text 가 이 변수를 읽는다 — 방 컨테이너에 스프레드 */
    style: { "--tgr-fs": `${(0.84 * scale) / 100}rem` } as CSSProperties,
  };
}

/** 헤더의 [가− 가+] — 두 방 화면이 같은 모양으로 쓴다 */
export function TgFontButtons({ font }: { font: ReturnType<typeof useTgFont> }) {
  return (
    <span className="tgr-font-ctl">
      <button className="filter-btn" onClick={font.dec} disabled={font.scale <= 80} title="본문 글씨 줄이기">
        가−
      </button>
      <button className="filter-btn" onClick={font.inc} disabled={font.scale >= 160} title="본문 글씨 키우기">
        가+
      </button>
    </span>
  );
}

/**
 * VNTG 방 뷰어 (2026-08-27) — **봇이 보낸 방들을 브라우저에서 텔레그램처럼.**
 *
 * "6개 방을 폰으로 일일이 들어가 보기 쉽지 않다" — 방 목록에 안읽음 말풍선,
 * 누르면 대화방처럼 메시지가 흐르고, 중요한 건 별표로 집어 「중요 메시지」에서
 * 모아 본다. 재료는 서버의 **발신 아카이브**다(보낼 때 같이 저장 — 스캔 비용 0).
 * 방을 열면 읽음 처리되고, 미니PC(MTProto 세션)에선 **폰 텔레그램도 읽음**이 된다.
 */

/**
 * 평문 속 URL 을 링크로 (2026-08-27 — "URL 주소에 하이퍼링크가 안 먹네").
 *
 * 텔레그램은 주소를 그냥 적어도 앱이 눌리게 만들어 준다. 우리 화면은 텍스트로만
 * 넣고 있어서 눈에는 보이는데 못 눌렀다 — 채널 글은 링크가 본론일 때가 많다.
 *
 * ⚠️ **이미 이스케이프된 문자열**에 적용한다(태그가 살아 있는 채로 정규식을 돌리면
 * 속성 안의 주소까지 건드린다). http/https 만, 끝에 붙은 문장부호는 링크에서 뺀다.
 */
export function linkifyEscaped(escaped: string): string {
  return escaped.replace(/https?:\/\/[^\s<>"']+/g, (url) => {
    const m = url.match(/[),.;!?]+$/); // 「(주소)」·「주소.」의 꼬리는 링크가 아니다
    const tail = m ? m[0] : "";
    const href = tail ? url.slice(0, -tail.length) : url;
    if (!href) return url;
    return `<a href="${href}" target="_blank" rel="noopener noreferrer">${href}</a>${tail}`;
  });
}

/** 봇 메시지의 HTML — 우리가 만든 것이지만 외부 텍스트가 섞이므로 화이트리스트로 거른다 */
export function sanitizeTgHtml(html: string): string {
  const ALLOW = new Set(["B", "STRONG", "I", "EM", "U", "S", "CODE", "PRE", "BR", "A"]);
  const doc = new DOMParser().parseFromString(html, "text/html");
  const walk = (node: Node, inLink = false): string => {
    if (node.nodeType === Node.TEXT_NODE) {
      const d = document.createElement("div");
      d.textContent = node.textContent ?? "";
      // 평문으로 적힌 주소도 링크로 — 이미 <a> 안이면 그대로 둔다(링크 속 링크 방지)
      return inLink ? d.innerHTML : linkifyEscaped(d.innerHTML);
    }
    if (node.nodeType !== Node.ELEMENT_NODE) return "";
    const el = node as Element;
    const inner = [...el.childNodes].map((c) => walk(c, inLink || el.tagName === "A")).join("");
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
  // map 이 넘기는 index 가 inLink 자리에 들어가지 않게 한 겹 감싼다
  return [...doc.body.childNodes].map((n) => walk(n)).join("");
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
  /*
   * 뒤로가기로 **방을 나간다** (2026-08-28 요청). 방에 들어간 것도 「들어간 것」이라
   * 뒤로가기가 목록으로 돌아오는 길이어야 한다 — 전에는 페이지가 통째로 넘어갔다.
   * Esc·◀·목록 버튼으로 나가도 훅이 쌓아 둔 히스토리 칸을 스스로 회수한다.
   */
  useSheetBack(open !== null, () => setOpen(null));
  const [msgs, setMsgs] = useState<TgMsg[]>([]);
  const [label, setLabel] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [starred, setStarred] = useState<Set<string>>(new Set());
  const [phoneRead, setPhoneRead] = useState<boolean | null>(null);
  /** 방을 열기 전에 어디까지 읽었었나 — 「여기까지 읽음」 선의 기준 */
  const [readAt, setReadAt] = useState("");
  /** 이 방에서 찾기 — 불러온 메시지 안에서 거른다 */
  const [query, setQuery] = useState("");
  const endRef = useRef<HTMLDivElement>(null);
  /* 맨 위·맨 아래 단추 (2026-08-29 요청) — 지금 어디쯤인지에 따라 필요한 것만 띄운다 */
  const msgsRef = useRef<HTMLDivElement>(null);
  const [atBottom, setAtBottom] = useState(true);

  /*
   * 지금 위·아래 끝에 닿았나. 여유 24px 은 「거의 끝」도 끝으로 친다 —
   * 1px 남았다고 단추가 깜빡이면 그게 더 거슬린다.
   */
  const onMsgScroll = () => {
    const n = msgsRef.current;
    if (!n) return;
    setAtBottom(n.scrollHeight - n.scrollTop - n.clientHeight <= 24);
  };

  /* 방을 열거나 메시지가 바뀌면 다시 잰다 — 안 재면 단추가 옛 상태로 남는다 */
  useEffect(() => {
    const t = setTimeout(onMsgScroll, 120);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, msgs.length]);

  /**
   * 맨 위/맨 아래로.
   *
   * **거리에 따라 갈라진다.** 방 하나가 3만 픽셀을 넘기도 하는데 그걸 전부
   * 스르륵 굴리면 몇 초를 기다리게 된다 — 가까울 때(세 화면 안쪽)만 부드럽게
   * 가고, 멀면 즉시 뛴다. 어디로 갔는지는 어차피 단추가 말해 준다.
   */
  const jumpTo = (where: "top" | "bottom") => {
    const n = msgsRef.current;
    if (!n) return;
    const to = where === "top" ? 0 : n.scrollHeight;
    const far = Math.abs(to - n.scrollTop) > n.clientHeight * 3;
    n.scrollTo({ top: to, behavior: far ? "auto" : "smooth" });
    /* 즉시 뛰면 scroll 이벤트가 한 번만 오므로 단추 상태를 여기서도 맞춘다 */
    window.setTimeout(onMsgScroll, 60);
  };
  const unreadRef = useRef<HTMLDivElement>(null);
  /* 방 순서 (2026-08-27) — 끌어서 바꾼다. 서버(cardOrder) 저장이라 기기 공통 */
  const roomOrder = useCardOrder(
    "telegram.rooms",
    (rooms ?? []).map((r) => r.channel),
  );
  const font = useTgFont();

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

  /* Esc 로 방 목록 — PC 에서 제일 빠른 길. 입력칸에 있을 때는 그 칸이 먼저 쓴다 */
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

  /* 방 열기 — 메시지 받고, 읽음 처리(뷰어 + 가능하면 폰 텔레그램까지).
     시작 위치는 「여기까지 읽음」 선 — 다 읽은 방이거나 처음 여는 방은 맨 아래(최신)다. */
  async function openRoom(ch: string) {
    setOpen(ch);
    setMsgs([]);
    setPhoneRead(null);
    setQuery("");
    try {
      const r = await api.tgRoom(ch);
      setMsgs(r.messages);
      setLabel(r.label);
      setReadAt(r.readAt); // 읽음 처리 전의 값 — 선은 이 시각에 긋는다
      const read = await api.tgRoomRead(ch);
      setPhoneRead((read as { phoneRead?: boolean }).phoneRead ?? false);
      setRooms((prev) => prev?.map((x) => (x.channel === ch ? { ...x, unread: 0 } : x)) ?? prev);
      // 사이드바 「텔레그램 동향」의 N 배지가 바로 꺼지게 — App 이 이 이벤트로 다시 센다
      window.dispatchEvent(new Event("vntg:tg-read"));
      setTimeout(() => {
        // 안 읽은 첫 메시지 앞의 선으로 — 없으면(다 읽음·첫 방문) 맨 아래로
        if (unreadRef.current) unreadRef.current.scrollIntoView({ block: "center" });
        else endRef.current?.scrollIntoView({ block: "end" });
      }, 50);
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
    const q = query.trim().toLowerCase();
    const stripTags = (s: string) => s.replace(/<[^>]+>/g, "");
    /* 검색은 불러온 범위(최근 120건) 안에서 — 방 전체 검색은 「검색」 탭의 몫이다 */
    const shown = q ? msgs.filter((m) => stripTags(m.text).toLowerCase().includes(q)) : msgs;
    /* 「여기까지 읽음」 — 읽은 적 있는 방에서, 검색 중이 아닐 때만 긋는다.
       처음 여는 방(readAt 없음)은 전부가 새것이라 선이 뜻이 없다 — 최신부터 본다. */
    const firstUnread = readAt && !q ? shown.findIndex((m) => m.at > readAt) : -1;
    return (
      <div className="tgr-room" style={font.style}>
        {/* 대화는 아래 칸이 **안에서** 스크롤된다 — 이 머리줄은 늘 보인다 */}
        <div className="tgr-room-head">
          {/* 제일 자주 누르는 버튼 — 헤더 컴팩트 규칙에서 빼고 크게 (2026-08-27) */}
          <button className="tgr-back" onClick={() => setOpen(null)} title="방 목록으로 (Esc)">
            ‹ 방 목록
          </button>
          <b>{label}</b>
          <TgFontButtons font={font} />
          <span className="pt-n tgr-head-note">
            최근 {msgs.length}건
            {phoneRead === true && " · 폰 텔레그램도 읽음 처리됨"}
            {phoneRead === false && " · 읽음은 이 화면만 (폰 연동은 미니PC에서)"}
          </span>
        </div>
        <div className="search-box tgr-search-row">
          <input
            className="search-input"
            type="text"
            inputMode="search"
            placeholder="이 방에서 검색 — 불러온 최근 메시지 안에서 찾습니다"
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
        <div className="tgr-msgs" ref={msgsRef} onScroll={onMsgScroll}>
          {msgs.length === 0 && <div className="empty">아직 이 방으로 보낸 메시지가 없습니다.</div>}
          {q && shown.length === 0 && msgs.length > 0 && (
            <div className="empty">「{query.trim()}」 — 불러온 메시지에는 없습니다.</div>
          )}
          {shown.map((m, i) => {
            const day = dayOf(m.at);
            const showDay = day !== lastDay;
            lastDay = day;
            const key = `${open}:${m.id}`;
            return (
              <div key={m.id}>
                {i === firstUnread && (
                  <div className="tgr-unread" ref={unreadRef}>
                    여기까지 읽음 — 아래부터 새 메시지
                  </div>
                )}
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
        {/* 방 목록으로 — 오른쪽 아래 플로팅. 폰에서 왼쪽 위 버튼까지 손이 멀고,
            브라우저 뒤로가기는 페이지째 나가 버린다 (2026-08-27) */}
        <button className="tgr-fab" onClick={() => setOpen(null)} title="방 목록으로">
          ‹ 방 목록
        </button>
        {/*
          맨 아래로 (2026-08-29 요청) — 방에서는 **이것 하나면 된다.**
          위로 올라가는 건 옛 글을 읽으려고 손으로 훑는 것이고, 돌아올 곳은
          늘 최신이다. (페이지 전체의 「맨 위로」는 App 의 전역 단추가 맡는다)

          **글을 가리지 않는 자리**여야 한다 — 말풍선은 왼쪽부터 차고 오른쪽 끝은
          시각·★ 자리라 글자가 거의 안 온다. 그래서 오른쪽 가장자리에, 「방 목록」
          단추 위로 쌓는다. 그리고 **맨 아래에 있으면 안 뜬다** — 안 쓰는 단추가
          떠 있으면 그게 곧 가리는 것이다.
        */}
        {!atBottom && (
          <div className="tgr-jump">
            <button onClick={() => jumpTo("bottom")} title="맨 아래로 (최신)" aria-label="맨 아래로">
              ↓
            </button>
          </div>
        )}
      </div>
    );
  }

  /* ── 방 목록 — 순서는 끌어서 바꾼다(서버 저장, 기기 공통). CSS order 라 재마운트가 없다 ── */
  return (
    <div className="tgr-list">
      {rooms.map((r) => (
        <button
          key={r.channel}
          className={`tgr-room-row${roomOrder.drag.cls(r.channel)}`}
          style={{ order: roomOrder.orderOf(r.channel) }}
          {...roomOrder.drag.props(r.channel)}
          onClick={() => void openRoom(r.channel)}
          title="끌어서 순서를 바꿀 수 있습니다"
        >
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
