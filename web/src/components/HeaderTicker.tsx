import { useEffect, useRef, useState } from "react";
import { api, signClass, type IndexCard, type MarketSignal } from "../api";
import { useSection } from "../useSection";

/**
 * 상단 띠 — 코스피·코스닥 지수 + 상승/하락 종목수 + 시장 신호등 (2026-09-02).
 *
 * 벤티지: "최상단에 종모양 옆에 자리가 비어 있지? 거기에 코스피/코스닥 지수랑
 * 등락률이랑 상승하락종목수 간략하게 넣을 수 있겠어? 실시간으로 볼 수 있게" /
 * "시장 신호등도 넣자 넣는 김에"
 *
 * **새 조회가 아니다.** 지수 카드는 시황의 `indices` 섹션(서버 캐시 10초)을 그대로
 * 집어 오고 — 상승·하락 종목수가 그 카드에 이미 실려 온다 — 시장 신호등도 있는
 * API 를 1분마다 물을 뿐이다. 어느 화면에 있든 같은 값이 보이게 하려는 것이라
 * 여기서 따로 계산하는 건 없다.
 *
 * ## 폰에서는 단추 하나 → 아래로 펼침 (2026-09-02)
 *
 * 벤티지: "상단 띠는 모바일에서는 안 보이네. 버튼 하나 넣고 누르면 밑에 팝업처럼
 * 나오게 할 수 있나? 알림처럼"
 *
 * 처음엔 좁으면 그냥 숨겼다 — 검색창 한 줄에 띠까지 넣으면 검색창이 사라져서.
 * 대신 **알림 종과 같은 모양**의 단추 하나만 남기고(신호등 색 점이 곧 단추다),
 * 누르면 종 패널처럼 아래로 편다. 패널 위치도 종과 같은 방법이다 — 폰에서는
 * 뷰포트에 `fixed` 로 붙이고 세로 자리(`--ht-top`)만 단추를 재서 넘긴다.
 * 어느 쪽(띠/단추)이 보일지는 CSS 폭 조건이 정한다. 둘 다 그려 두고 하나만 보인다.
 */

const IDX: { code: string; label: string }[] = [
  { code: "001", label: "코스피" },
  { code: "101", label: "코스닥" },
];

const SIG_LABEL: Record<string, string> = {
  green: "초록",
  yellow: "노랑",
  red: "빨강",
  unknown: "보류",
};

function fmtIdx(v: number): string {
  return v.toLocaleString("ko-KR", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function fmtPct(v: number): string {
  return `${v > 0 ? "+" : ""}${v.toFixed(2)}%`;
}

export function HeaderTicker({ onGo }: { onGo: () => void }) {
  const indices = useSection<IndexCard[]>("indices", 5_000);
  const [sig, setSig] = useState<MarketSignal | null>(null);
  const [open, setOpen] = useState(false);
  const boxRef = useRef<HTMLDivElement | null>(null);
  const btnRef = useRef<HTMLButtonElement | null>(null);
  const [btnBottom, setBtnBottom] = useState(0);

  /* 시장 신호등 — 서버가 판정을 들고 있으니 1분이면 충분하다. 안 보일 때는 쉰다 */
  useEffect(() => {
    let timer: ReturnType<typeof setInterval> | null = null;
    const load = () => api.marketSignal().then(setSig).catch(() => undefined);
    const start = () => {
      if (!timer) timer = setInterval(load, 60_000);
    };
    const stop = () => {
      if (timer) clearInterval(timer);
      timer = null;
    };
    const onVisible = () => {
      if (document.visibilityState === "visible") {
        void load();
        start();
      } else stop();
    };
    onVisible();
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      stop();
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, []);

  /* 펼침 위치 — 폰에서는 뷰포트 기준이라 단추의 아래 y 를 재서 넘긴다 (종과 같은 방법) */
  useEffect(() => {
    if (!open) return;
    const measure = () => {
      const r = btnRef.current?.getBoundingClientRect();
      if (r) setBtnBottom(r.bottom);
    };
    measure();
    window.addEventListener("resize", measure);
    window.addEventListener("scroll", measure, true);
    return () => {
      window.removeEventListener("resize", measure);
      window.removeEventListener("scroll", measure, true);
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

  const cards = indices.data ?? [];
  const byCode = new Map(cards.map((c) => [c.code, c]));
  const go = () => {
    setOpen(false);
    onGo();
  };

  /** 지수 한 칸 — 띠에서는 가로 한 줄, 펼침에서는 세로 한 행. 같은 재료를 두 모양으로 */
  const idxCell = (code: string, label: string, wide: boolean) => {
    const c = byCode.get(code);
    return (
      <button
        key={code}
        className={wide ? "ht-row" : "ht-idx"}
        onClick={go}
        title={c ? `${label} ${fmtIdx(c.price)} · 상승 ${c.rising} · 보합 ${c.flat} · 하락 ${c.falling} — 시황으로` : `${label} — 받는 중`}
      >
        <span className="ht-name">{label}</span>
        {c ? (
          <>
            <span className={`ht-px num ${signClass(c.change)}`}>{fmtIdx(c.price)}</span>
            <span className={`ht-chg num ${signClass(c.change)}`}>{fmtPct(c.changeRate)}</span>
            <span className="ht-ad num">
              <span className={signClass(1)}>▲{c.rising}</span>
              <span className={signClass(-1)}>▼{c.falling}</span>
              {wide && <span className="ht-flat">─{c.flat}</span>}
            </span>
          </>
        ) : (
          <span className="ht-px num">—</span>
        )}
      </button>
    );
  };

  const sigCell = (wide: boolean) => (
    <button
      className={wide ? "ht-row" : "ht-sig"}
      onClick={go}
      title={sig ? `시장 신호등 ${SIG_LABEL[sig.level] ?? sig.level} ${sig.score}점 — ${sig.summary}` : "시장 신호등 — 받는 중"}
    >
      <span className={`sig-dot ${sig?.level ?? "loading"}`} />
      <span className="ht-name">시장</span>
      {sig ? (
        <>
          <b>{SIG_LABEL[sig.level] ?? sig.level}</b>
          {sig.level !== "unknown" && <span className="num">{sig.score}점</span>}
          {wide && <span className="ht-sum">{sig.summary}</span>}
        </>
      ) : (
        <span>—</span>
      )}
    </button>
  );

  return (
    <div className="hdr-tick" ref={boxRef} aria-label="지수·시장 신호등">
      {/* 넓은 화면 — 띠 */}
      <div className="hdr-tick-full">
        {IDX.map(({ code, label }) => idxCell(code, label, false))}
        {sigCell(false)}
      </div>

      {/* 좁은 화면 — 단추 하나. 신호등 색 점이 곧 단추다 */}
      <button
        ref={btnRef}
        className={`ht-btn${open ? " open" : ""}`}
        onClick={() => setOpen((v) => !v)}
        title="코스피·코스닥·시장 신호등"
        aria-label="지수·시장 신호등"
      >
        <span className={`sig-dot ${sig?.level ?? "loading"}`} />
        <span className="ht-btn-txt">지수</span>
      </button>

      {open && (
        <div className="ht-pop" style={{ "--ht-top": `${Math.round(btnBottom + 8)}px` } as React.CSSProperties}>
          {IDX.map(({ code, label }) => idxCell(code, label, true))}
          {sigCell(true)}
          <div className="ht-pop-note">누르면 시황으로 갑니다 · 지수 10초 · 신호등 1분</div>
        </div>
      )}
    </div>
  );
}
