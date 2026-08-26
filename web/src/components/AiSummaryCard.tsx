import { useEffect, useState } from "react";
import { api, type PublishedReportResponse } from "../api";
import { speechText } from "./ReportTts";

/**
 * 리포트 최상단 AI 정리.
 *
 * Claude가 돌려주는 건 마크다운 비슷한 텍스트라, 라이브러리 없이
 * "## 제목 / **굵게** / - 목록" 정도만 직접 해석해서 그린다.
 * 실패해도 리포트 나머지는 그대로 보여야 하므로 이 카드 안에서만 에러를 표시한다.
 */

/**
 * 등락·수급 낱말에 색을 입힌다 (2026-08-25 — 시인성).
 *
 * AI 글은 숫자가 문장에 파묻혀 훑어지지 않았다 — 「외국인이 2조 3,394억 원을
 * 순매도하며」에서 눈이 잡아야 할 건 **부호와 크기**다. 부호 달린 수(+3.62%,
 * -4.73%, -573억)와 순매수/순매도 낱말만 물들인다. 문장 전체를 칠하면
 * 아무것도 안 칠한 것과 같다.
 */
const SIGN_RE = /([+＋]\s?\d[\d,]*(?:\.\d+)?\s?(?:%|조|억|원|p)|[-−▼]\s?\d[\d,]*(?:\.\d+)?\s?(?:%|조|억|원|p)|순매수|순매도|상승\s?마감|하락\s?마감)/g;

function paint(text: string, keyBase: number): React.ReactNode[] {
  return text.split(SIGN_RE).map((part, i) => {
    if (!part) return null;
    if (/^[+＋]/.test(part) || part === "순매수" || /^상승/.test(part))
      return (
        <em className="ai-up" key={`${keyBase}-${i}`}>
          {part}
        </em>
      );
    if (/^[-−▼]\s?\d/.test(part) || part === "순매도" || /^하락/.test(part))
      return (
        <em className="ai-down" key={`${keyBase}-${i}`}>
          {part}
        </em>
      );
    return <span key={`${keyBase}-${i}`}>{part}</span>;
  });
}

/** **굵게** 처리 + 등락 착색 */
function inline(text: string): React.ReactNode[] {
  return text.split(/(\*\*[^*]+\*\*)/g).map((part, i) =>
    part.startsWith("**") && part.endsWith("**") ? (
      <b key={i}>{paint(part.slice(2, -2), i)}</b>
    ) : (
      <span key={i}>{paint(part, i)}</span>
    ),
  );
}

/**
 * 섹션 제목 정규화 (2026-08-25).
 *
 * 발행본에 「시장の 폭」이 실제로 있었다 — AI 가 어쩌다 일본어 글자를 섞으면
 * 그대로 박제된다. 제목은 정해진 여섯 개 중 하나라, 한글·영문만 남겨 견주고
 * 맞으면 **우리 표기 + 아이콘**으로 갈아 끼운다. 지나간 발행분도 이 렌더러를
 * 타므로 소급해서 고쳐 보인다. 못 알아보는 제목은 그대로 둔다.
 */
const HEADINGS: { canon: string; icon: string }[] = [
  { canon: "오늘 시장 한 줄", icon: "📌" },
  { canon: "자금 흐름", icon: "💰" },
  { canon: "내 테마", icon: "🎯" },
  { canon: "시장 폭", icon: "🌡️" },
  { canon: "주도 섹터", icon: "🔥" },
  { canon: "관심종목 & 체크포인트", icon: "⭐" },
];

function normalizeHeading(raw: string): { label: string; icon: string } {
  const bare = raw.replace(/[^가-힣a-zA-Z&]/g, "");
  const hit = HEADINGS.find((h) => h.canon.replace(/[^가-힣a-zA-Z&]/g, "") === bare);
  return hit ? { label: hit.canon, icon: hit.icon } : { label: raw, icon: "" };
}

function render(text: string): React.ReactNode[] {
  const out: React.ReactNode[] = [];
  const lines = text.split("\n");
  lines.forEach((raw, i) => {
    const line = raw.trim();
    if (!line) return;
    if (line.startsWith("## ")) {
      const h = normalizeHeading(line.slice(3));
      out.push(
        <h4 className="ai-h" key={i}>
          {h.icon && <span className="ai-h-ico">{h.icon}</span>}
          {h.label}
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

/**
 * @param edition 상단 조간/장중/석간 탭이 정한 판.
 *   판 선택은 화면 상단이 이미 하고 있으므로 여기서 또 고르게 하면 두 곳이 어긋난다.
 *   이 카드의 드롭박스는 **지난 날짜**만 고르는 용도로 좁힌다.
 */
export function AiSummaryCard({ edition }: { edition?: string }) {
  const [res, setRes] = useState<PublishedReportResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [showDigest, setShowDigest] = useState(false);
  const [pick, setPick] = useState<{ date?: string; edition?: string }>({});
  const [copied, setCopied] = useState(false);

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

  // 상단 탭에서 판이 바뀌면 날짜 선택을 버리고 그 판의 최신분을 불러온다
  useEffect(() => {
    setPick({});
    load({ edition });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [edition]);

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
  // 지금 보고 있는 판 (상단 탭 값이 없으면 서버가 정해준 값)
  const currentEdition = edition ?? res?.requested.edition;
  /*
   * 지난 리포트 전체 — 날짜만이 아니라 **판까지** 고른다.
   *
   * 예전엔 "같은 판의 지난 날짜"만 줬는데, 그러면 즉시발행(now-HHMM)이 목록에 아예
   * 안 나온다. 방금 눌러 만든 걸 다시 볼 방법이 없었다.
   * 복기 노트·신호등 찾기와 같은 방식으로 맞춘다 — 하나의 드롭박스에서 전부 고른다.
   */
  const editionLabel = (e: string) => {
    if (e.startsWith("now-")) return `즉시 ${e.slice(4, 6)}:${e.slice(6, 8)}`;
    return { morning: "조간", midday: "장중", closing: "석간", weekend: "주말" }[e] ?? e;
  };
  const history = (res?.recent ?? [])
    .slice()
    .sort((a, b) => b.date.localeCompare(a.date) || b.edition.localeCompare(a.edition));
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

        {/*
          복사 (2026-08-26) — 다른 앱의 읽어주기(TTS)에 붙여넣는 용도.
          마크다운 기호를 그대로 복사하면 「별표 별표」를 읽어 대므로,
          낭독용으로 다듬은 텍스트(speechText — 읽어주기와 같은 정제)를 담는다.
        */}
        {s?.text && (
          <button
            className="filter-btn"
            onClick={() => {
              const label = report
                ? `${report.date.slice(5).replace("-", "월 ")}일 ${report.label} AI 정리. `
                : "";
              void navigator.clipboard
                .writeText(label + speechText(s.text ?? ""))
                .then(() => setCopied(true))
                .catch(() => setCopied(false));
              window.setTimeout(() => setCopied(false), 2000);
            }}
            title="낭독용으로 다듬은 본문을 복사합니다 — 다른 앱의 읽어주기에 붙여넣기 좋게 마크다운 기호를 걷어냅니다"
          >
            {copied ? "✓ 복사됨" : "📋 복사"}
          </button>
        )}

        {/* 지난 리포트 — 날짜와 판을 한 곳에서 고른다 */}
        {history.length > 1 && (
          <select
            className="group-select"
            style={{ maxWidth: 210 }}
            value={`${res?.requested.date ?? ""}|${res?.requested.edition ?? ""}`}
            onChange={(e) => {
              const [date, ed] = e.target.value.split("|");
              setPick({ date, edition: ed });
              load({ date, edition: ed });
            }}
          >
            {history.map((r) => (
              <option key={`${r.date}|${r.edition}`} value={`${r.date}|${r.edition}`}>
                {r.date.slice(5)} {editionLabel(r.edition)}
              </option>
            ))}
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
