import { useEffect, useState } from "react";
import { api, type PublishedReportResponse } from "../api";

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
  const [res, setRes] = useState<PublishedReportResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [showDigest, setShowDigest] = useState(false);
  const [pick, setPick] = useState<{ date?: string; edition?: string }>({});

  async function load(p: { date?: string; edition?: string } = pick) {
    setLoading(true);
    try {
      setRes(await api.publishedReport(p.date, p.edition));
    } catch {
      setRes(null);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    load({});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /** 아직 발행 전이거나 실패했을 때만 수동 발행 (AI 호출 = 비용 발생) */
  async function publishNow() {
    if (!res) return;
    if (!window.confirm("지금 발행하면 Claude API 비용이 발생합니다 (약 $0.04). 진행할까요?")) return;
    setBusy(true);
    setMsg(null);
    try {
      await api.reportPublish(res.requested.edition);
      setMsg("발행하고 텔레그램·메일로 보냈습니다.");
      await load();
    } catch (e) {
      setMsg(e instanceof Error ? e.message : "발행 실패");
    } finally {
      setBusy(false);
    }
  }

  /** 저장분 재발송 — AI를 다시 부르지 않아 비용이 없다 */
  async function deliverAgain() {
    if (!res?.report) return;
    setBusy(true);
    setMsg(null);
    try {
      const r = await api.reportDeliver(res.report.date, res.report.edition);
      setMsg(
        `텔레그램 ${r.telegram.ok ? "성공" : `실패(${r.telegram.error})`} / 메일 ${r.mail.ok ? "성공" : `실패(${r.mail.error})`}`,
      );
    } catch (e) {
      setMsg(e instanceof Error ? e.message : "발송 실패");
    } finally {
      setBusy(false);
    }
  }

  const report = res?.report ?? null;
  const s = report?.summary;
  const cost = s ? (s.inputTokens / 1e6) * 3 + (s.outputTokens / 1e6) * 15 : 0;
  const publishedLabel = report
    ? new Date(report.publishedAt).toLocaleString("ko-KR", {
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
        hour12: false,
      })
    : null;

  return (
    <section className="ai-card">
      <div className="ai-head">
        <span className="ai-badge">AI 정리</span>
        {report && <span className="ai-model">{report.label} · {publishedLabel} 발행</span>}
        {!report && <span className="ai-model">미발행</span>}

        {/* 지난 발행분 골라보기 */}
        {res && res.recent.length > 0 && (
          <select
            className="group-select"
            style={{ maxWidth: 160 }}
            value={`${res.requested.date}|${res.requested.edition}`}
            onChange={(e) => {
              const [date, edition] = e.target.value.split("|");
              setPick({ date, edition });
              load({ date, edition });
            }}
          >
            {res.recent.map((r) => {
              const label = res.editions.find((x) => x.key === r.edition)?.label ?? r.edition;
              return (
                <option key={`${r.date}|${r.edition}`} value={`${r.date}|${r.edition}`}>
                  {r.date} {label}
                </option>
              );
            })}
          </select>
        )}
      </div>

      {loading && <div className="empty">불러오는 중…</div>}

      {!loading && !report && (
        <div className="page-note">
          이 판은 아직 발행되지 않았습니다. 발행은 매일 <b>07시 / 12시 / 18시</b>에 자동으로 이뤄집니다.
          <div style={{ marginTop: 8 }}>
            <button className="filter-btn active" onClick={publishNow} disabled={busy}>
              {busy ? "발행 중…" : "지금 발행"}
            </button>
          </div>
        </div>
      )}

      {s?.error && <div className="page-note">AI 정리 생성 실패: {s.error}</div>}

      {s?.text && <div className="ai-body">{render(s.text)}</div>}

      {s?.text && (
        <div className="ai-foot">
          <span>
            {s.model} · 토큰 {s.inputTokens.toLocaleString()} / {s.outputTokens.toLocaleString()} · 약 $
            {cost.toFixed(4)}
          </span>
          <button className="ai-link" onClick={() => setShowDigest((v) => !v)}>
            {showDigest ? "근거 접기" : "근거 데이터"}
          </button>
          <button className="ai-link" onClick={deliverAgain} disabled={busy}>
            다시 보내기
          </button>
        </div>
      )}

      {msg && <div className="page-note">{msg}</div>}
      {showDigest && s?.digest && <pre className="ai-digest">{s.digest}</pre>}

      <div className="table-note">
        정해진 시각에 발행된 내용이라 다시 열어도 같습니다. AI 요약은 매매 판단의 근거가 아닙니다.
      </div>
    </section>
  );
}
