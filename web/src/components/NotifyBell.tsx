import { useCallback, useEffect, useRef, useState } from "react";
import { api, type Notice, type NoticeKind } from "../api";
import { VALID_TABS } from "../App";

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
  /* 갈 데가 없는 알림 — 그 줄에만 한 줄 적는다 */
  const [badLink, setBadLink] = useState<string | null>(null);
  const [items, setItems] = useState<Notice[]>([]);
  const [unread, setUnread] = useState(0);
  const [unreadBy, setUnreadBy] = useState<Record<NoticeKind, number>>({
    stock: 0,
    market: 0,
    system: 0,
  });
  /**
   * 탭 — **묶음**으로 거른다 (2026-09-02).
   *
   * 벤티지: "지금 알림 대분류가 4개인데 이걸 6개 정도로 만들면 효율적으로
   * 배치할 수 있지 않을까"
   *
   * 예전 넷(전체·종목·시장·시스템)은 `NoticeKind` 를 그대로 쓴 것이라
   * **「시스템」 하나에 마감 뒤 정리·표본·원장·신호등 분석이 다 들어갔다** —
   * 매일 도는 배치 소식에 신호등 편입이 묻힌다.
   *
   * 목록은 서버가 준다(설정 묶음과 **같은 것**을 쓴다) — 탭과 설정이 다르면
   * 「이 탭을 끄려면 어디를 눌러야 하나」가 안 보인다.
   */
  const [filter, setFilter] = useState<string>("all");
  const [groups, setGroups] = useState<{ key: string; label: string }[]>([]);
  const [unreadByGroup, setUnreadByGroup] = useState<Record<string, number>>({});
  /**
   * 알림 설정 — **출처 목록은 서버가 준다.**
   *
   * 화면이 목록을 들고 있으면 서버가 출처를 늘렸을 때 화면만 모르는 상태가 된다
   * (자동 그룹 목록에서 겪은 것과 같은 이유).
   */
  const [showCfg, setShowCfg] = useState(false);
  const [cfgSrc, setCfgSrc] = useState<
    { key: string; group: string; label: string; hint: string; def: boolean }[]
  >([]);
  const [cfgGroups, setCfgGroups] = useState<{ key: string; label: string }[]>([]);
  const [cfg, setCfg] = useState<Record<string, boolean>>({});

  /* 탭 목록 — 알림함을 열면 바로 필요하다(설정을 안 열어도) */
  useEffect(() => {
    if (!open || groups.length > 0) return;
    void api
      .noticeConfig()
      .then((r) => setGroups(r.groups))
      .catch(() => undefined);
  }, [open, groups.length]);

  useEffect(() => {
    if (!showCfg || cfgSrc.length > 0) return;
    void api
      .noticeConfig()
      .then((r) => {
        setCfgSrc(r.sources);
        setCfgGroups(r.groups);
        setCfg(r.config);
      })
      .catch(() => undefined);
  }, [showCfg, cfgSrc.length]);
  const boxRef = useRef<HTMLDivElement | null>(null);

  const load = useCallback(() => {
    api
      .notices({ limit: 60, group: filter })
      .then((r) => {
        setItems(r.items);
        setUnread(r.unread);
        setUnreadBy(r.unreadBy);
        setUnreadByGroup(r.unreadByGroup ?? {});
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

    /*
     * **모르는 탭이면 안 간다** (2026-09-04 — 벤티지: "바로가기 누르면 이상한 데로 가네").
     *
     * 라우터는 없는 탭을 만나면 말없이 시황 대시보드로 떨어진다. 그래서 옛 알림에
     * 박힌 `#/watchlist`·`#/dailyReport` 를 누르면 매번 엉뚱한 화면이 떴고, 누르는
     * 사람은 그게 **링크가 틀린 것**인 줄 알 수 없었다.
     *
     * 서버가 이미 걸러 주지만(`fixLink`) 여기서 한 번 더 본다 — 목록이 두 곳에 있으면
     * 언젠가 한쪽이 뒤처지고, 그때 조용히 틀리는 쪽이 다시 생긴다. 못 가면 창을 안 닫고
     * 그대로 둔다. 「눌렀는데 아무 일도 안 났다」가 「엉뚱한 데로 갔다」보다 낫다.
     */
    const hash = n.link.startsWith("#") ? n.link : `#${n.link}`;
    const tabKey = hash.replace(/^#\/?/, "").split("?")[0];
    if (!VALID_TABS.has(tabKey)) {
      setBadLink(n.id);
      return;
    }
    window.location.hash = hash;
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
              {[{ key: "all", label: "전체" }, ...groups].map((g) => (
                <button
                  key={g.key}
                  className={`nb-tab${filter === g.key ? " active" : ""}`}
                  onClick={() => setFilter(g.key)}
                >
                  {g.label}
                  {g.key !== "all" && (unreadByGroup[g.key] ?? 0) > 0 && (
                    <i className="nb-dot">{unreadByGroup[g.key]}</i>
                  )}
                </button>
              ))}
            </div>
            <div className="nb-acts">
              {unread > 0 && (
                <button className="nb-act" onClick={readAll}>
                  모두 읽음
                </button>
              )}
              {/*
                **설정** (2026-09-02) — 벤티지: "알림센터에서 받을만한 것들 좀
                추리고 on off 할수있는 구조로 가자"

                알림함 안에 둔다. 설정 화면으로 보내면 「시끄럽다」고 느낀 그
                자리에서 손이 닿지 않는다 — 끄고 싶은 순간이 곧 보고 있는 순간이다.
              */}
              <button
                className={`nb-act${showCfg ? " active" : ""}`}
                onClick={() => setShowCfg((v) => !v)}
                title="어떤 알림을 받을지 고릅니다"
              >
                ⚙ 설정
              </button>
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

          {showCfg && (
            <div className="nb-cfg">
              <p className="nb-cfg-head">
                <b>어떤 알림을 받을까</b>
                <span className="pt-n">
                  {" "}
                  — 끄면 알림함에 <b>담지 않습니다</b>(읽지 않음에도 안 셉니다).
                  텔레그램은 따로 켜고 끕니다.
                </span>
              </p>
              {cfgGroups.map((g) => {
                const rows = cfgSrc.filter((x) => x.group === g.key);
                if (rows.length === 0) return null;
                const on = rows.filter((x) => cfg[x.key] ?? x.def).length;
                return (
                  <div key={g.key} className="nb-cfg-group">
                    {/*
                      묶음 머리 — **한 번에 켜고 끈다.** 열넷을 하나씩 누르게 하면
                      「시스템 알림 다 끄기」 같은 흔한 일이 열 번의 클릭이 된다.
                    */}
                    <button
                      className="nb-cfg-gh"
                      onClick={() => {
                        const next = on < rows.length;
                        const patch: Record<string, boolean> = {};
                        for (const x of rows) patch[x.key] = next;
                        setCfg((c) => ({ ...c, ...patch }));
                        void api.noticeConfigSave(patch).catch(() => undefined);
                      }}
                      title={on < rows.length ? "이 묶음을 모두 켭니다" : "이 묶음을 모두 끕니다"}
                    >
                      <b>{g.label}</b>
                      <span className="pt-n">
                        {" "}
                        {on}/{rows.length}
                      </span>
                    </button>
                    {rows.map((s2) => (
                      <label key={s2.key} className="nb-cfg-row">
                  <input
                    type="checkbox"
                    checked={cfg[s2.key] ?? s2.def}
                    onChange={(e) => {
                      const next = { ...cfg, [s2.key]: e.target.checked };
                      setCfg(next);
                      void api.noticeConfigSave({ [s2.key]: e.target.checked }).catch(() => undefined);
                    }}
                  />
                        <span className="nb-cfg-label">{s2.label}</span>
                        <span className="nb-cfg-hint">{s2.hint}</span>
                      </label>
                    ))}
                  </div>
                );
              })}
            </div>
          )}

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
                    {/* 갈 데가 없을 때 — 조용히 엉뚱한 화면에 데려다 놓지 않는다 */}
                    {badLink === n.id && (
                      <span className="nb-badlink">
                        이 알림의 바로가기가 가리키는 화면이 지금은 없습니다 ({n.link}) — 옮겨 가지
                        않았습니다.
                      </span>
                    )}
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
