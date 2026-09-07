import { useEffect, useState } from "react";
import { api, type MarketSignal, type SignalVerification } from "../api";

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
  /* 검증 표 (2026-09-07 밤) — 초록/노랑/빨강이었던 날의 5·20거래일 뒤 코스피 수익률 */
  const [verify, setVerify] = useState<SignalVerification | null | "loading">(null);
  const REGIME_KO: Record<string, string> = { up: "상승 추세", rebound: "반등 시도", range: "횡보", down: "하락 추세", fear: "공포", split: "한쪽만 도는 장" };
  async function openVerify() {
    if (verify !== null && verify !== "loading") {
      setVerify(null);
      return;
    }
    setVerify("loading");
    try {
      setVerify(await api.marketSignalVerify());
    } catch {
      setVerify(null);
    }
  }
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
  /** 접어 둔 상태 — 접을 수 있는 자리(시황 대시보드)에서만 성립한다 */
  const folded = collapsible && collapsed;

  /*
   * 컴팩트 (2026-08-27 — "전해주는 내용에 비해 박스가 너무 커").
   * 한 줄 헤더(등급·점수) + 체크는 **칩 한 줄**로 — 칩 색이 판정이고, 값은 칩에
   * 바로, 근거(왜)는 칩을 눌러 편다. 보드·시황·미니가 같은 컴포넌트라 전부 적용.
   */
  return (
    <section className={`msig msig-${sig.level} msig-slim${folded ? " msig-collapsed" : ""}`}>
      <div className="msig-head">
        {collapsible && (
          <button className="msig-fold" onClick={toggle} title={collapsed ? "펼치기" : "접기"} aria-label={collapsed ? "펼치기" : "접기"}>
            {collapsed ? "▸" : "▾"}
          </button>
        )}
        <span className={`sig-dot big ${sig.level}`} />
        <div className="msig-title">
          <b>
            {/*
              이름을 span 으로 뺀 이유 — 좁은 화면에서 제목만 말줄임하려고.
              한 덩어리로 두면 「한쪽만 / 도는 장 / (코스 / 피)」로 네 줄이 나면서
              접어 둔 카드가 되레 세로로 붇는다(2026-09-08 폰에서 확인).
            */}
            <span className="msig-name">{sig.regime ? sig.regime.name : `시장 신호등 ${meta.label}`}</span>
            {!folded && sig.level !== "unknown" && <span className="msig-score num">{sig.score}점</span>}
          </b>
          {/*
            **등급은 부연 줄에 둔다.** 제목·점수·등급 셋을 한 줄에 밀어 넣으면
            폰(390px 에서 제목 칸이 217px)에서 반드시 하나가 넘쳐 줄이 늘어난다.
            접었을 때와 위계를 맞춘 것이기도 하다 — 윗줄은 「무슨 장이고 몇 점인가」,
            아랫줄은 「어느 등급이고 그래서 어쩌라는 건가」.
          */}
          <span className="msig-note">
            {sig.regime && (
              <>
                <b className="msig-lv-in">{meta.label}</b>
                {" · "}
              </>
            )}
            {sig.regime ? sig.regime.action : meta.note}
          </span>
          {sig.note && <span className="msig-note msig-early">{sig.note}</span>}
        </div>
        {folded && sig.level !== "unknown" && <span className="msig-score num msig-score-fold">{sig.score}점</span>}
        {/* 접혀 있으면 등급 + 「우호 n · 중립 n」만 — 펴야 칩이 보인다 */}
        {folded && (
          <span className="msig-fold-sum">
            {sig.regime && <b className="msig-fold-lv">{meta.label}</b>}
            {sig.regime && " · "}
            우호 {sig.checks.filter((c) => c.pass === true).length} · 중립 {sig.checks.filter((c) => c.pass === null && c.neutral).length} · 비우호{" "}
            {sig.checks.filter((c) => c.pass === false).length}
            {sig.checks.some((c) => c.pass === null && !c.neutral) ? ` · 모름 ${sig.checks.filter((c) => c.pass === null && !c.neutral).length}` : ""}
          </span>
        )}
        <button className="filter-btn" onClick={() => void load(true)} disabled={loading} title="다시 판정">
          {loading ? "…" : "↻"}
        </button>
      </div>

      {!folded && (
      <div className="msig-chips">
        {sig.checks.map((c) => (
          <button
            key={c.key}
            className={`msig-chip ${c.pass === true ? "ok" : c.pass === false ? "bad" : c.neutral ? "mid" : "none"}${openWhy === c.key ? " open" : ""}`}
            onClick={() => setOpenWhy(openWhy === c.key ? null : c.key)}
            title={`${c.value}${c.why ? ` — 눌러서 근거 보기` : ""}`}
          >
            <i />
            {c.label}
            {c.arrow && c.arrow !== "flat" && <span className={`msig-arrow ${c.arrow}`}>{c.arrow === "up" ? "↗" : "↘"}</span>}
            <em className="num">{c.value.length > 30 ? `${c.value.slice(0, 30)}…` : c.value}</em>
          </button>
        ))}
      </div>
      )}
      {!folded && sig.regime && sig.regime.why.length > 0 && (
        <p className="msig-regime-why">
          왜 {sig.regime.name}인가 — {sig.regime.why.join(" · ")}
          <button className="ord-mk" onClick={() => void openVerify()}>
            {verify === "loading" ? "…" : verify ? "검증 닫기" : "맞았나? (검증)"}
          </button>
        </p>
      )}
      {!folded && verify && verify !== "loading" && (
        <div className="msig-verify">
          <div className="msig-verify-h">
            판정 뒤 코스피 수익률 — {verify.days}일치{verify.backfilled > 0 ? ` (그중 ${verify.backfilled}일은 지수·수급만으로 되짚은 부분 백필)` : ""}
          </div>
          <table className="ord-table msig-verify-t">
            <thead>
              <tr>
                <th>판정</th>
                <th className="r">일수</th>
                <th className="r">5일 뒤 평균</th>
                <th className="r">5일 승률</th>
                <th className="r">20일 뒤 평균</th>
                <th className="r">20일 승률</th>
              </tr>
            </thead>
            <tbody>
              {verify.rows.map((r) => (
                <tr key={r.level}>
                  <td>
                    <span className={`sig-dot ${r.level}`} /> {LEVEL_TEXT[r.level]?.label ?? r.level}
                  </td>
                  <td className="r">{r.n}</td>
                  <td className={`r ${r.avg5 !== null ? (r.avg5 > 0 ? "positive" : "negative") : ""}`}>{r.avg5 !== null ? `${r.avg5 > 0 ? "+" : ""}${r.avg5.toFixed(2)}%` : "-"}</td>
                  <td className="r">{r.win5 !== null ? `${r.win5.toFixed(0)}%` : "-"}</td>
                  <td className={`r ${r.avg20 !== null ? (r.avg20 > 0 ? "positive" : "negative") : ""}`}>{r.avg20 !== null ? `${r.avg20 > 0 ? "+" : ""}${r.avg20.toFixed(2)}%` : "-"}</td>
                  <td className="r">{r.win20 !== null ? `${r.win20.toFixed(0)}%` : "-"}</td>
                </tr>
              ))}
              {verify.byRegime.map((r) => (
                <tr key={`rg-${r.regime}`} className="msig-verify-rg">
                  <td>{REGIME_KO[r.regime] ?? r.regime}</td>
                  <td className="r">{r.n}</td>
                  <td className={`r ${r.avg5 !== null ? (r.avg5 > 0 ? "positive" : "negative") : ""}`}>{r.avg5 !== null ? `${r.avg5 > 0 ? "+" : ""}${r.avg5.toFixed(2)}%` : "-"}</td>
                  <td className="r">{r.win5 !== null ? `${r.win5.toFixed(0)}%` : "-"}</td>
                  <td className={`r ${r.avg20 !== null ? (r.avg20 > 0 ? "positive" : "negative") : ""}`}>{r.avg20 !== null ? `${r.avg20 > 0 ? "+" : ""}${r.avg20.toFixed(2)}%` : "-"}</td>
                  <td className="r">-</td>
                </tr>
              ))}
            </tbody>
          </table>
          <div className="table-note">문턱은 그대로다. 이 표가 나쁘게 쌓이면 그때 고칠 근거가 된다 (15:35 판정을 하루 한 줄 기록).</div>
        </div>
      )}
      {!folded && openWhy &&
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
