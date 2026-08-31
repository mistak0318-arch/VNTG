import { useCallback, useEffect, useRef, useState } from "react";
import { api, type Notice, type NoticeKind } from "../api";

/**
 * 알림 종 (2026-08-31 벤티지 요청).
 *
 * "시스템 최우상단에 종 모양 같은 거 하나 둘 수 있겠어? 각 종목들 알람, 중요한 알람,
 * 시스템 알람 … 종 모양의 알람 표시 딱 생겨가지고 내가 누르면 종목 검색하면 밑에
 * 나오는 창처럼 알람 리스트 확인하고 누르면은 **그 알람이 가리키는 방향으로** 갈 수
 * 있게".
 *
 * ## 왜 「가리키는 방향」이 핵심인가
 *
 * 지금까지 알림은 텔레그램으로만 갔다. 「삼성전자 VI 발동」을 읽어도 **거기서 그
 * 종목으로 갈 수가 없어서** 코드를 눈으로 읽고 다시 검색해야 했다. 알림마다
 * `link`(앱 안의 해시 경로)를 들려 보내는 이유가 그것이다 — 누르면 바로 그 자리다.
 *
 * ## 자리
 *
 * 종목 검색창과 **같은 줄**에 둔다. 벤티지가 「검색하면 밑에 나오는 창처럼」이라고
 * 한 그 모양을 그대로 쓰려는 것이다 — 두 드롭다운이 같은 문법이면 새로 배울 게 없다.
 */

const KIND_META: Record<NoticeKind, { icon: string; label: string }> = {
  stock: { icon: "📈", label: "종목" },
  market: { icon: "🌊", label: "시장" },
  system: { icon: "⚙️", label: "시스템" },
};

/** 30초 — 알림은 「지금 당장」이 아니라 「놓치지 않게」가 목적이다 */
const POLL_MS = 30_000;

function ago(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime();
  if (!Number.isFinite(ms) || ms < 0) return "";
  const m = Math.floor(ms / 60_000);
  if (m < 1) return "방금";
  if (m < 60) return `${m}분 전`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}시간 전`;
  return `${Math.floor(h / 24)}일 전`;
}

export function NotifyBell() {
  const [open, setOpen] = useState(false);
  const [items, setItems] = useState<Notice[]>([]);
  const [unread, setUnread] = useState(0);
  const [unreadBy, setUnreadBy] = useState<Record<NoticeKind, number>>({
    stock: 0,
    market: 0,
    system: 0,
  });
  const [filter, setFilter] = useState<NoticeKind | "all">("all");
  const boxRef = useRef<HTMLDivElement | null>(null);

  const load = useCallback(() => {
    api
      .notices({ limit: 60, kind: filter })
      .then((r) => {
        setItems(r.items);
        setUnread(r.unread);
        setUnreadBy(r.unreadBy);
      })
      .catch(() => {
        /* 못 받으면 종만 조용하다 — 화면은 그대로 뜬다 */
      });
  }, [filter]);

  useEffect(() => {
    load();
    const t = window.setInterval(load, POLL_MS);
    return () => window.clearInterval(t);
  }, [load]);

  /**
   * 어느 쪽으로 펼 것인가 — **자리를 재서 정한다** (2026-09-01).
   *
   * ## 왜 CSS 로 못 박으면 안 되나
   *
   * 붙는 쪽을 두 번 고쳤고 두 번 다 틀렸다. `right: 0` 이면 왼쪽으로 뻗다가
   * 「알림이 없습니다」가 「습니다」로 잘렸고, `left: 0` 으로 바꿨더니 이번엔
   * 오른쪽으로 뻗어 화면 밖으로 나갔다.
   *
   * 둘 다 맞을 때가 있다 — **종의 위치가 고정이 아니기 때문**이다. 종은 검색창과
   * 같은 줄에 있고 검색창이 `flex: 1` 이라, 창 폭·검색창 접힘·「탭 모두 닫기」의
   * 유무에 따라 종이 왼쪽에도 오른쪽에도 선다. 한쪽으로 못 박으면 반대 경우가
   * 반드시 깨진다.
   *
   * 그래서 **열 때 재서** 정한다. 왼쪽 기준으로 폈을 때 오른쪽이 넘치면 오른쪽에
   * 붙인다. 창 크기가 바뀌어도 다시 잰다.
   */
  /** 본문을 펼쳐 둔 알림 — 패널을 닫으면 잊는다(다시 열면 다시 요약부터) */
  const [openText, setOpenText] = useState<Set<string>>(new Set());
  const toggleText = useCallback((id: string) => {
    setOpenText((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  const [alignRight, setAlignRight] = useState(false);
  /**
   * 종의 아래끝 — **폰에서 패널을 뷰포트에 고정할 때** 쓴다.
   *
   * 폰(375)에서는 좌우 어느 쪽에 붙여도 안 들어간다. 실측: 종이 x=182 에 서는데
   * 패널 폭이 355 라, 오른쪽에 붙이면 **왼쪽으로 168px 삐져나갔다.**
   * 폭이 화면만 한데 기준점이 화면 한가운데면 어느 쪽으로 붙이든 넘치는 게 당연하다.
   *
   * 그래서 폰에서는 `position: fixed` 로 **화면 좌우에 직접** 맞춘다. 그러면 위치의
   * 기준이 종이 아니라 뷰포트가 되어 넘칠 수가 없다. 다만 세로 자리는 여전히 종
   * 아래여야 하므로 그 값만 여기서 재서 넘긴다.
   */
  const [bellBottom, setBellBottom] = useState(0);
  useEffect(() => {
    if (!open) return;
    const measure = () => {
      const el = boxRef.current;
      if (!el) return;
      const r = el.getBoundingClientRect();
      /* 패널 폭(420) + 가장자리 여백. 넘치면 오른쪽 기준 (데스크톱) */
      setAlignRight(r.left + 420 > window.innerWidth - 12);
      setBellBottom(r.bottom);
    };
    measure();
    window.addEventListener("resize", measure);
    /* 스크롤하면 종이 움직인다 — fixed 인 폰에서는 따라가야 한다 */
    window.addEventListener("scroll", measure, { passive: true });
    return () => {
      window.removeEventListener("resize", measure);
      window.removeEventListener("scroll", measure);
    };
  }, [open]);

  /* 바깥을 누르면 닫는다 — 드롭다운의 기본 예의다 */
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (boxRef.current && !boxRef.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  /**
   * 알림을 누르면 **읽음으로 적고 그 자리로 간다.**
   *
   * 링크가 없는 알림도 있다(그냥 알려 주기만 하는 것). 그때는 읽음 처리만 하고
   * 창을 닫지 않는다 — 닫아 버리면 「눌렀는데 아무 일도 안 났다」로 보인다.
   */
  const openNotice = (n: Notice) => {
    if (!n.read) {
      setItems((prev) => prev.map((x) => (x.id === n.id ? { ...x, read: true } : x)));
      setUnread((u) => Math.max(0, u - 1));
      void api.noticesRead([n.id]).catch(() => undefined);
    }
    if (!n.link) return;
    window.location.hash = n.link.startsWith("#") ? n.link : `#${n.link}`;
    setOpen(false);
  };

  const readAll = () => {
    setItems((prev) => prev.map((x) => ({ ...x, read: true })));
    setUnread(0);
    setUnreadBy({ stock: 0, market: 0, system: 0 });
    void api.noticesRead().catch(() => undefined);
  };

  return (
    <div className="nb" ref={boxRef}>
      <button
        className={`nb-bell${unread > 0 ? " has" : ""}`}
        onClick={() => setOpen((v) => !v)}
        title={unread > 0 ? `안 읽은 알림 ${unread}건` : "알림"}
        aria-label="알림"
      >
        🔔
        {unread > 0 && <span className="nb-badge">{unread > 99 ? "99+" : unread}</span>}
      </button>

      {open && (
        <div
          className={`nb-panel${alignRight ? " to-right" : ""}`}
          style={{ "--nb-top": `${Math.round(bellBottom + 8)}px` } as React.CSSProperties}
        >
          <div className="nb-head">
            <div className="nb-tabs">
              {(["all", "stock", "market", "system"] as const).map((k) => (
                <button
                  key={k}
                  className={`nb-tab${filter === k ? " active" : ""}`}
                  onClick={() => setFilter(k)}
                >
                  {k === "all" ? "전체" : KIND_META[k].label}
                  {k !== "all" && unreadBy[k] > 0 && <i className="nb-dot">{unreadBy[k]}</i>}
                </button>
              ))}
            </div>
            <div className="nb-acts">
              {unread > 0 && (
                <button className="nb-act" onClick={readAll}>
                  모두 읽음
                </button>
              )}
              <button
                className="nb-act"
                onClick={() => {
                  void api
                    .noticesClear()
                    .then(load)
                    .catch(() => undefined);
                }}
                title="읽은 것만 지웁니다 — 안 읽은 알림은 남습니다"
              >
                읽은 것 비우기
              </button>
            </div>
          </div>

          <div className="nb-list">
            {items.length === 0 ? (
              <div className="nb-empty">
                <b>알림이 없습니다.</b>
                <span>
                  종목 알림·장세 변화·표본 점검 결과가 여기에 쌓입니다. 어떤 것을 받을지는{" "}
                  <b>설정</b>에서 정합니다.
                </span>
              </div>
            ) : (
              items.map((n) => (
                <button
                  key={n.id}
                  className={`nb-item lv-${n.level}${n.read ? " read" : ""}${n.link ? " go" : ""}`}
                  onClick={() => openNotice(n)}
                >
                  <span className="nb-icon">{KIND_META[n.kind].icon}</span>
                  <span className="nb-body">
                    <span className="nb-title">
                      {n.title}
                      {/* 같은 사건이 이어지는 중이면 몇 번째인지 — 새 알림과 구분된다 */}
                      {n.hits > 1 && <i className="nb-hits">×{n.hits}</i>}
                    </span>
                    {/*
                      본문을 누르면 **펼친다** (2026-09-01).

                      세 줄에서 잘려 있었다. 그런데 「신호등 분석 완료」처럼
                      **정보가 본문에만 있는 알림**이 있다 — 어느 목록에서 몇 종목이
                      걸렸는지는 바로가기로 가도 그 화면에 없는 요약이다.
                      잘린 채 두면 알림이 「무슨 일이 있었다」까지만 말하고 만다.

                      항목 전체가 `<button>` 이라 안에 버튼을 못 넣는다(HTML 이
                      허락하지 않는다). 그래서 본문 자체를 누르게 하고, 그 클릭이
                      항목의 「바로가기」로 새지 않게 막는다.
                    */}
                    {n.body && (
                      <span
                        className={`nb-text${openText.has(n.id) ? " open" : ""}`}
                        onClick={(e) => {
                          e.stopPropagation();
                          toggleText(n.id);
                        }}
                        title={openText.has(n.id) ? "접기" : "눌러서 전체 보기"}
                      >
                        {n.body}
                      </span>
                    )}
                    {/* 접혀 있고 길면 잘렸다는 걸 알린다 — 모르면 안 누른다 */}
                    {n.body && n.body.length > 80 && !openText.has(n.id) && (
                      <span
                        className="nb-more-text"
                        onClick={(e) => {
                          e.stopPropagation();
                          toggleText(n.id);
                        }}
                      >
                        ⌄ 전체 보기
                      </span>
                    )}
                    <span className="nb-meta">
                      {n.name && <b>{n.name}</b>} {ago(n.lastAt)}
                      {n.link && <i className="nb-go">→ 바로가기</i>}
                    </span>
                  </span>
                  {!n.read && <span className="nb-new" />}
                </button>
              ))
            )}
          </div>
        </div>
      )}
    </div>
  );
}
