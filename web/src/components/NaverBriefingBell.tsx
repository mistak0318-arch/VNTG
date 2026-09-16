import { useEffect, useRef, useState } from "react";
import { api, type NaverBriefing } from "../api";

/**
 * **머리글 🤖 — 네이버 AI 시황 한 번에** (2026-09-17, 벤티지: "아이콘으로 해서 코스피·코스닥 카드 옆에 비춰 줘.
 * 그것만 눌러도 네이버 요약을 볼 수 있게. 장 끝났을 때도").
 *
 * 시황 대시보드의 접힌 카드(NaverBriefingBlock)는 그 화면에 가야 보인다. 이건 **어느 화면에서든** 한 번 누르면
 * 최근 여섯 개가 펼쳐진다 — 지수 단추(HeaderTicker)와 같은 자리 규칙(같은 팝업 CSS `ht-pop`, 바깥 누르면 닫힘,
 * 폰은 뷰포트 기준). 새 글이 오면 NEW 점 — 읽은 표시는 카드와 **같은 localStorage 키**라 한쪽에서 읽으면 둘 다 꺼진다.
 * 장 마감 뒤에도 네이버가 [마감]·[야간] 꼬리표로 계속 내니 시간 제한 없이 늘 뜬다. 못 받으면 단추를 숨기지 않고 흐리게.
 */
const SEEN_KEY = "naverBriefing.seenId";
function readSeen(): number {
  try {
    return Number(localStorage.getItem(SEEN_KEY) ?? "0") || 0;
  } catch {
    return 0;
  }
}
function writeSeen(id: number): void {
  try {
    localStorage.setItem(SEEN_KEY, String(id));
  } catch {
    /* 저장이 막혀 있어도 화면은 그대로 돈다 */
  }
}

export function NaverBriefingBell() {
  const [data, setData] = useState<{ latest: NaverBriefing | null; recent: NaverBriefing[] } | null>(null);
  const [open, setOpen] = useState(false);
  const [expand, setExpand] = useState<number | null>(null);
  const [seen, setSeen] = useState(readSeen);
  const boxRef = useRef<HTMLDivElement | null>(null);
  const btnRef = useRef<HTMLButtonElement | null>(null);
  const [btnBottom, setBtnBottom] = useState(0);

  useEffect(() => {
    let alive = true;
    const pull = () =>
      api
        .naverBriefing()
        .then((r) => alive && setData(r))
        .catch(() => undefined);
    void pull();
    const t = window.setInterval(pull, 10 * 60_000);
    return () => {
      alive = false;
      window.clearInterval(t);
    };
  }, []);

  /* 펼침 위치 · 바깥 누르면 닫힘 — HeaderTicker 와 같은 방법 */
  useEffect(() => {
    if (!open) return;
    const measure = () => {
      const r = btnRef.current?.getBoundingClientRect();
      if (r) setBtnBottom(r.bottom);
    };
    measure();
    const onDown = (e: MouseEvent) => {
      if (boxRef.current && !boxRef.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    window.addEventListener("resize", measure);
    window.addEventListener("scroll", measure, true);
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("resize", measure);
      window.removeEventListener("scroll", measure, true);
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const latest = data?.latest ?? null;
  const isNew = latest !== null && latest.id > seen;
  const toggle = () => {
    const next = !open;
    setOpen(next);
    if (next && latest) {
      writeSeen(latest.id);
      setSeen(latest.id);
      setExpand(latest.id);
    }
  };

  return (
    <div className="hdr-tick nvbb" ref={boxRef} aria-label="네이버 AI 시황">
      <button
        ref={btnRef}
        className={`ht-btn${open ? " open" : ""}${latest ? "" : " dim"}`}
        onClick={toggle}
        title={latest ? `네이버 AI 시황 ${latest.when.slice(11, 16)} · ${latest.title}` : "네이버 AI 시황 — 아직 못 받았습니다"}
        aria-label="네이버 AI 시황"
        aria-expanded={open}
      >
        <span className="nvbb-ico">🤖</span>
        {isNew && <b className="nvbb-new">NEW</b>}
      </button>
      {open && (
        <div className="ht-pop nvbb-pop" style={{ "--ht-top": `${Math.round(btnBottom + 8)}px` } as React.CSSProperties}>
          <div className="nvbb-h">🤖 다른 눈 — 네이버 AI 시황 <i>한 시간마다 · 줄을 누르면 본문</i></div>
          {!latest && <div className="empty">아직 못 받았습니다.</div>}
          {(data?.recent ?? []).slice(0, 6).map((b) => (
            <div className={`nvb-item${expand === b.id ? " open" : ""}`} key={b.id}>
              <button type="button" className="nvb-h" onClick={() => setExpand(expand === b.id ? null : b.id)}>
                <i>{b.when.slice(5, 16).replace("T", " ")}</i>
                {b.title}
              </button>
              {expand === b.id && <p className="nvb-sum">{b.summary}</p>}
            </div>
          ))}
          <div className="ht-pop-note">우리 요약과 견주라고 둔 것이지 근거가 아닙니다 — 같은 장을 다르게 읽었다면 그 차이가 볼 거리.</div>
        </div>
      )}
    </div>
  );
}
