import { useEffect, useState } from "react";
import { api, type AiSummary } from "../api";

/**
 * 리포트 최상단 AI 정리.
 *
 * Claude가 돌려주는 건 마크다운 비슷한 텍스트라, 라이브러리 없이
 * "## 제목 / **굵게** / - 목록" 정도만 직접 해석해서 그린다.
 * 실패해도 리포트 나머지는 그대로 보여야 하므로 이 카드 안에서만 에러를 표시한다.
 */

/** **굵게** 처리 */
function inline(text: string): React.ReactNode[] {
  return text.split(/(\*\*[^*]+\*\*)/g).map((part, i) =>
    part.startsWith("**") && part.endsWith("**") ? (
      <b key={i}>{part.slice(2, -2)}</b>
    ) : (
      <span key={i}>{part}</span>
    ),
  );
}

function render(text: string): React.ReactNode[] {
  const out: React.ReactNode[] = [];
  const lines = text.split("\n");
  lines.forEach((raw, i) => {
    const line = raw.trim();
    if (!line) return;
    if (line.startsWith("## ")) {
      out.push(
        <h4 className="ai-h" key={i}>
          {line.slice(3)}
        </h4>,
      );
    } else if (/^[-*•]\s/.test(line) || /^\d+\.\s/.test(line)) {
      out.push(
        <div className="ai-li" key={i}>
          {inline(line.replace(/^([-*•]|\d+\.)\s/, ""))}
        </div>,
      );
    } else {
      out.push(
        <p className="ai-p" key={i}>
          {inline(line)}
        </p>,
      );
    }
  });
  return out;
}

export function AiSummaryCard() {
  const [data, setData] = useState<AiSummary | null>(null);
  const [loading, setLoading] = useState(true);
  const [showDigest, setShowDigest] = useState(false);

  async function load(force = false) {
    setLoading(true);
    try {
      setData(await api.aiSummary(force));
    } catch {
      setData(null);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    load();
  }, []);

  const cost = data ? (data.inputTokens / 1e6) * 3 + (data.outputTokens / 1e6) * 15 : 0;

  return (
    <section className="ai-card">
      <div className="ai-head">
        <span className="ai-badge">AI 정리</span>
        <span className="ai-model">{data?.model}</span>
        <button className="filter-btn" onClick={() => load(true)} disabled={loading}>
          {loading ? "분석 중…" : "↻ 다시 분석"}
        </button>
      </div>

      {loading && !data && <div className="empty">시장 데이터를 분석하는 중입니다…</div>}

      {data?.error && (
        <div className="page-note">
          AI 정리를 만들지 못했습니다: {data.error}
          <br />
          아래 리포트 본문은 정상적으로 볼 수 있습니다.
        </div>
      )}

      {data?.text && <div className="ai-body">{render(data.text)}</div>}

      {data?.text && (
        <div className="ai-foot">
          <span>
            토큰 {data.inputTokens.toLocaleString()} / {data.outputTokens.toLocaleString()} · 약 $
            {cost.toFixed(4)}
          </span>
          <button className="ai-link" onClick={() => setShowDigest((v) => !v)}>
            {showDigest ? "근거 데이터 접기" : "무엇을 보고 판단했는지"}
          </button>
        </div>
      )}

      {showDigest && data?.digest && <pre className="ai-digest">{data.digest}</pre>}

      <div className="table-note">
        AI가 시장 데이터를 요약한 것으로, 매매 판단의 근거가 아닙니다. 수치는 아래 본문에서 직접
        확인하세요.
      </div>
    </section>
  );
}
