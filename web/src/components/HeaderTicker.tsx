import { useEffect, useState } from "react";
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
 * 폰에서는 숨긴다(CSS) — 검색창 한 줄에 이 띠까지 넣으면 검색창이 사라진다.
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

  const cards = indices.data ?? [];
  const byCode = new Map(cards.map((c) => [c.code, c]));

  return (
    <div className="hdr-tick" aria-label="지수·시장 신호등">
      {IDX.map(({ code, label }) => {
        const c = byCode.get(code);
        return (
          <button
            key={code}
            className="ht-idx"
            onClick={onGo}
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
                </span>
              </>
            ) : (
              <span className="ht-px num">—</span>
            )}
          </button>
        );
      })}
      <button
        className="ht-sig"
        onClick={onGo}
        title={sig ? `시장 신호등 ${SIG_LABEL[sig.level] ?? sig.level} ${sig.score}점 — ${sig.summary}` : "시장 신호등 — 받는 중"}
      >
        <span className={`sig-dot ${sig?.level ?? "loading"}`} />
        <span className="ht-name">시장</span>
        {sig ? (
          <>
            <b>{SIG_LABEL[sig.level] ?? sig.level}</b>
            {sig.level !== "unknown" && <span className="num">{sig.score}</span>}
          </>
        ) : (
          <span>—</span>
        )}
      </button>
    </div>
  );
}
