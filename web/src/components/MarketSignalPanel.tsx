import { useEffect, useState } from "react";
import { api, type MarketSignal } from "../api";

/**
 * 시장 전체 신호등.
 *
 * 종목 신호등은 "이 종목이 내 기준에 맞나"를 본다. 그런데 **아무리 좋은 종목도 시장이
 * 무너지는 날엔 같이 빠진다.** 종목을 고르기 전에 지금이 살 자리인지 쉴 자리인지를
 * 먼저 봐야 해서 이 화면을 맨 위에 둔다.
 *
 * 항목마다 "왜 이걸 보는가"를 접어 두었다. 숫자만 보여주면 며칠 지나 자기가 만든
 * 기준도 왜 그랬는지 잊는다.
 */

const LEVEL_TEXT: Record<string, { label: string; note: string }> = {
  green: { label: "초록", note: "추세·폭·수급이 함께 우호적입니다" },
  yellow: { label: "노랑", note: "엇갈립니다. 크게 걸 자리는 아닙니다" },
  red: { label: "빨강", note: "역풍입니다. 좋은 종목도 같이 밀립니다" },
  unknown: { label: "판단 보류", note: "판정할 데이터가 부족합니다" },
};

/**
 * 접힘 기억 — 기기마다 (2026-09-03). 벤티지: "시황대시보드에 신호등 나오는거 화면차지가 너무
 * 큰데 이거 접을 수 있게 좀 해줘. 기본설정이 접음이고 내가 펼칠수있게."
 */
const COLLAPSE_KEY = "vntg.msig.collapsed";
function readCollapsed(): boolean {
  try {
    const v = localStorage.getItem(COLLAPSE_KEY);
    return v === null ? true : v === "1";
  } catch {
    return true;
  }
}

export function MarketSignalPanel({ collapsible = false }: { collapsible?: boolean } = {}) {
  const [sig, setSig] = useState<MarketSignal | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [openWhy, setOpenWhy] = useState<string | null>(null);
  /* 접을 수 있는 자리(시황 대시보드)에서만 기본 접음. 보드·미니는 그대로 편다 */
  const [collapsed, setCollapsed] = useState<boolean>(() => (collapsible ? readCollapsed() : false));
  const toggle = () => {
    const next = !collapsed;
    setCollapsed(next);
    try {
      localStorage.setItem(COLLAPSE_KEY, next ? "1" : "0");
    } catch {
      /* 저장 못 해도 이번 화면은 동작한다 */
    }
  };

  async function load(force = false) {
    setLoading(true);
    setError(null);
    try {
      setSig(await api.marketSignal(force));
    } catch (e) {
      setError(e instanceof Error ? e.message : "불러오기 실패");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void load();
  }, []);

  if (loading && !sig) return <div className="page-note">시장 신호등 판정 중…</div>;
  if (error) return <div className="error-banner">{error}</div>;
  if (!sig) return null;

  const meta = LEVEL_TEXT[sig.level] ?? LEVEL_TEXT.unknown;

  /*
   * 컴팩트 (2026-08-27 — "전해주는 내용에 비해 박스가 너무 커").
   * 한 줄 헤더(등급·점수) + 체크는 **칩 한 줄**로 — 칩 색이 판정이고, 값은 칩에
   * 바로, 근거(왜)는 칩을 눌러 편다. 보드·시황·미니가 같은 컴포넌트라 전부 적용.
   */
  return (
    <section className={`msig msig-${sig.level} msig-slim${collapsible && collapsed ? " msig-collapsed" : ""}`}>
      <div className="msig-head">
        {collapsible && (
          <button className="msig-fold" onClick={toggle} title={collapsed ? "펼치기" : "접기"} aria-label={collapsed ? "펼치기" : "접기"}>
            {collapsed ? "▸" : "▾"}
          </button>
        )}
        <span className={`sig-dot big ${sig.level}`} />
        <div className="msig-title">
          <b>
            시장 신호등 {meta.label}
            {sig.level !== "unknown" && <span className="msig-score num"> {sig.score}점</span>}
          </b>
          <span className="msig-note">{meta.note}</span>
        </div>
        {/* 접혀 있으면 「통과 n/m」만 — 펴야 칩이 보인다 */}
        {collapsible && collapsed && (
          <span className="msig-fold-sum">
            통과 {sig.checks.filter((c) => c.pass === true).length}/{sig.checks.length}
          </span>
        )}
        <button className="filter-btn" onClick={() => void load(true)} disabled={loading} title="다시 판정">
          {loading ? "…" : "↻"}
        </button>
      </div>

      {!(collapsible && collapsed) && (
      <div className="msig-chips">
        {sig.checks.map((c) => (
          <button
            key={c.key}
            className={`msig-chip ${c.pass === true ? "ok" : c.pass === false ? "bad" : "mid"}${openWhy === c.key ? " open" : ""}`}
            onClick={() => setOpenWhy(openWhy === c.key ? null : c.key)}
            title={`${c.value}${c.why ? ` — 눌러서 근거 보기` : ""}`}
          >
            <i />
            {c.label}
            <em className="num">{c.value.length > 26 ? `${c.value.slice(0, 26)}…` : c.value}</em>
          </button>
        ))}
      </div>
      )}
      {!(collapsible && collapsed) && openWhy &&
        (() => {
          const c = sig.checks.find((x) => x.key === openWhy);
          if (!c) return null;
          return (
            <p className="msig-why">
              <b>{c.label}</b> — {c.value}
              <br />
              {c.why} <span className="pt-n">(가중치 {c.weight})</span>
            </p>
          );
        })()}
    </section>
  );
}
