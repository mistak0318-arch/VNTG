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
 * ## 단추 하나 → 아래로 펼침 — PC 도 폰도 (2026-09-02)
 *
 * 벤티지: "상단 띠는 모바일에서는 안 보이네. 버튼 하나 넣고 누르면 밑에 팝업처럼
 * 나오게 할 수 있나? 알림처럼" → 폰만 단추로 바꿨다. 그러자 같은 날 저녁:
 * "데스크탑 모드에서 코스피 코스닥 지수랑 시장 글자까지 들어가니깐 위에가 다 깨진다."
 *
 * 재 보니 PC 띠가 **565px** 였다 — 검색 줄(845px)의 3분의 2. 검색창을 열거나
 * 탭이 쌓여 「탭 모두 닫기」가 붙으면 밀려 나간다. 지수 값·상승하락수·「시장 빨강
 * 0점」까지 한 줄에 다 적은 게 문제였다.
 *
 * 그래서 **PC 도 폰과 같은 단추 하나**다. 다른 건 단추에 적힌 글자뿐이다:
 *
 *   PC   `● 코스피 -3.99% · 코스닥 -2.10%`   — 실시간으로 보고 싶던 건 결국 이 셋(색·두 등락률)이다
 *   폰   `●`                                 — 글자는 CSS 가 숨긴다(720px 이하)
 *
 * 지수 값·상승/하락/보합 수·신호등 점수와 요약은 누르면 아래로 펼친다 — **알림 종과
 * 같은 모양**의 단추, 같은 방식의 패널이다. 폰에서는 뷰포트에 `fixed` 로 붙이고
 * 세로 자리(`--ht-top`)만 단추를 재서 넘긴다.
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

  /** 펼침의 지수 한 행 — 이름 · 지수 · 등락률 · 상승/하락/보합 수 */
  const idxRow = (code: string, label: string) => {
    const c = byCode.get(code);
    return (
      <button
        key={code}
        className="ht-row"
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
              <span className="ht-flat">─{c.flat}</span>
            </span>
          </>
        ) : (
          <span className="ht-px num">—</span>
        )}
      </button>
    );
  };

  const sigRow = (
    <button
      className="ht-row"
      onClick={go}
      title={sig ? `시장 신호등 ${SIG_LABEL[sig.level] ?? sig.level} ${sig.score}점 — ${sig.summary}` : "시장 신호등 — 받는 중"}
    >
      <span className={`sig-dot ${sig?.level ?? "loading"}`} />
      <span className="ht-name">시장</span>
      {sig ? (
        <>
          <b>{SIG_LABEL[sig.level] ?? sig.level}</b>
          {sig.level !== "unknown" && <span className="num">{sig.score}점</span>}
          <span className="ht-sum">{sig.summary}</span>
        </>
      ) : (
        <span>—</span>
      )}
    </button>
  );

  /** 단추에 적는 글자 — PC 에서만 보인다. 등락률 둘이면 충분하다; 나머지는 펼침에 */
  const btnTxt = IDX.map(({ code, label }, i) => {
    const c = byCode.get(code);
    return (
      <span key={code} className="ht-btn-idx">
        {i > 0 && <span className="ht-btn-sep">·</span>}
        <span className="ht-name">{label}</span>
        <span className={`num ${c ? signClass(c.change) : ""}`}>{c ? fmtPct(c.changeRate) : "—"}</span>
      </span>
    );
  });

  const btnTitle = [
    sig ? `시장 신호등 ${SIG_LABEL[sig.level] ?? sig.level}${sig.level !== "unknown" ? ` ${sig.score}점` : ""}` : "시장 신호등 — 받는 중",
    ...IDX.map(({ code, label }) => {
      const c = byCode.get(code);
      return c ? `${label} ${fmtIdx(c.price)} (${fmtPct(c.changeRate)}) ▲${c.rising} ▼${c.falling}` : `${label} — 받는 중`;
    }),
    "누르면 펼칩니다",
  ].join("\n");

  return (
    <div className="hdr-tick" ref={boxRef} aria-label="지수·시장 신호등">
      {/* 단추 하나 — 신호등 색 점이 곧 단추다. PC 는 옆에 등락률 둘, 폰은 점만 */}
      <button
        ref={btnRef}
        className={`ht-btn${open ? " open" : ""}`}
        onClick={() => setOpen((v) => !v)}
        title={btnTitle}
        aria-label="지수·시장 신호등"
        aria-expanded={open}
      >
        <span className={`sig-dot ${sig?.level ?? "loading"}`} />
        <span className="ht-btn-txt">{btnTxt}</span>
      </button>

      {open && (
        <div className="ht-pop" style={{ "--ht-top": `${Math.round(btnBottom + 8)}px` } as React.CSSProperties}>
          {IDX.map(({ code, label }) => idxRow(code, label))}
          {sigRow}
          <div className="ht-pop-note">누르면 시황으로 갑니다 · 지수 10초 · 신호등 1분</div>
        </div>
      )}
    </div>
  );
}
