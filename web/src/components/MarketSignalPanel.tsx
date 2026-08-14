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

export function MarketSignalPanel() {
  const [sig, setSig] = useState<MarketSignal | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [openWhy, setOpenWhy] = useState<string | null>(null);

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

  return (
    <section className={`msig msig-${sig.level}`}>
      <div className="msig-head">
        <span className={`sig-dot big ${sig.level}`} />
        <div className="msig-title">
          <b>시장 신호등 — {meta.label}</b>
          <span className="msig-note">{meta.note}</span>
        </div>
        {sig.level !== "unknown" && <span className="msig-score num">{sig.score}점</span>}
        <button className="filter-btn" onClick={() => void load(true)} disabled={loading}>
          {loading ? "…" : "↻"}
        </button>
      </div>

      <p className="msig-summary">{sig.summary}</p>

      <div className="msig-checks">
        {sig.checks.map((c) => (
          <div className="msig-check" key={c.key}>
            <div className="msig-check-row">
              <span
                className={`msig-mark ${c.pass === true ? "ok" : c.pass === false ? "bad" : "mid"}`}
              >
                {c.pass === true ? "우호" : c.pass === false ? "비우호" : "중립"}
              </span>
              <span className="msig-check-label">{c.label}</span>
              <span className="msig-check-value">{c.value}</span>
              {c.why && (
                <button
                  className="msig-why-btn"
                  onClick={() => setOpenWhy(openWhy === c.key ? null : c.key)}
                  title="이 항목을 왜 보는가"
                >
                  {openWhy === c.key ? "닫기" : "왜?"}
                </button>
              )}
            </div>
            {openWhy === c.key && c.why && <p className="msig-why">{c.why}</p>}
          </div>
        ))}
      </div>

      <div className="table-note">
        이건 <b>개별 종목이 아니라 시장 전체</b>의 상태입니다. 초록이라고 아무거나 사도 되는
        게 아니고, 빨강이라고 모든 종목이 빠지는 것도 아닙니다 — 내 종목 판단에 얹는
        배경으로 쓰세요.
      </div>
    </section>
  );
}
