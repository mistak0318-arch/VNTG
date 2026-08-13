import { useEffect, useRef, useState } from "react";
import { api, type AskResult, type AskTurn } from "../api";

/**
 * 시황 질문하기.
 *
 * 리포트는 정해진 틀로 나가지만 궁금한 건 그때그때 다르다.
 * 여기서는 **우리 실시간 데이터 + 웹 검색**을 함께 물려서 묻는다.
 *
 * 답변만 보여주지 않고 **무엇을 검색했는지와 출처를 같이 보여준다.**
 * AI가 지어낸 건지 실제로 찾아본 건지는 그걸 봐야 알 수 있다.
 */

const EXAMPLES = [
  "오늘 반도체가 강했던 이유가 뭐야?",
  "간밤 미국 시장 어땠고 오늘 우리 시장에 뭐가 영향 줄까?",
  "내 관심종목 중에 오늘 특이한 움직임 있었어?",
  "환율이 여기서 더 오르면 어떤 업종이 부담이야?",
  "지금 외국인 수급이 어느 쪽으로 가고 있어?",
];

interface Message {
  role: "user" | "assistant";
  text: string;
  searches?: string[];
  sources?: { title: string; url: string }[];
  tokens?: { input: number; output: number };
  error?: string;
}

export function AskPage() {
  const [ready, setReady] = useState(true);
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [useSearch, setUseSearch] = useState(true);
  const [useMarketData, setUseMarketData] = useState(true);
  const bottomRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    api
      .askStatus()
      .then((r) => setReady(r.ready))
      .catch(() => setReady(false));
  }, []);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, busy]);

  async function send(text: string) {
    const q = text.trim();
    if (!q || busy) return;

    // 서버에는 텍스트만 넘긴다 (출처·검색어는 화면용)
    const history: AskTurn[] = messages.map((m) => ({ role: m.role, text: m.text }));
    setMessages((prev) => [...prev, { role: "user", text: q }]);
    setInput("");
    setBusy(true);

    try {
      const r: AskResult = await api.ask(q, history, { useSearch, useMarketData });
      setMessages((prev) => [
        ...prev,
        {
          role: "assistant",
          text: r.text ?? "",
          searches: r.searches,
          sources: r.sources,
          tokens: { input: r.inputTokens, output: r.outputTokens },
          error: r.error,
        },
      ]);
    } catch (err) {
      setMessages((prev) => [
        ...prev,
        {
          role: "assistant",
          text: "",
          error: err instanceof Error ? err.message : "질문 처리 실패",
        },
      ]);
    } finally {
      setBusy(false);
    }
  }

  if (!ready) {
    return (
      <div className="page-note">
        <b>ANTHROPIC_API_KEY가 설정되지 않았습니다.</b>
        <br />
        시황 질문하기는 웹 검색 도구를 쓰기 때문에 Claude API가 필요합니다.
        <code> server/.env</code> 의 <code>ANTHROPIC_API_KEY</code> 를 확인하세요.
      </div>
    );
  }

  return (
    <div className="ask">
      <div className="ask-head">
        <h2>시황 질문하기</h2>
        <div className="filter-row" style={{ margin: 0 }}>
          <button
            className={`filter-btn ${useMarketData ? "active" : ""}`}
            onClick={() => setUseMarketData((v) => !v)}
            title="내 HTS가 방금 조회한 지수·수급·테마·관심종목을 함께 넘깁니다"
          >
            내 시장 데이터
          </button>
          <button
            className={`filter-btn ${useSearch ? "active" : ""}`}
            onClick={() => setUseSearch((v) => !v)}
            title="AI가 직접 웹을 검색합니다 (검색 1회당 약 $0.01)"
          >
            웹 검색
          </button>
          {messages.length > 0 && (
            <button className="filter-btn" onClick={() => setMessages([])} disabled={busy}>
              대화 지우기
            </button>
          )}
        </div>
      </div>

      {messages.length === 0 && (
        <div className="ask-intro">
          <p className="page-note">
            내 화면의 <b>실시간 데이터</b>와 <b>웹 검색</b>을 함께 물려서 묻습니다. 답변 아래에
            무엇을 검색했고 어디서 가져왔는지 같이 표시되니, 지어낸 건지 찾아본 건지 확인하고
            판단하세요. 매수·매도 추천은 하지 않습니다.
          </p>
          <div className="ask-examples">
            {EXAMPLES.map((e) => (
              <button key={e} className="ask-example" onClick={() => void send(e)}>
                {e}
              </button>
            ))}
          </div>
        </div>
      )}

      <div className="ask-thread">
        {messages.map((m, i) => (
          <div className={`ask-msg ${m.role}`} key={i}>
            <div className="ask-role">{m.role === "user" ? "나" : "AI"}</div>
            <div className="ask-body">
              {m.error && <div className="error-banner">{m.error}</div>}
              {m.text && <div className="ask-text">{m.text}</div>}

              {m.searches && m.searches.length > 0 && (
                <div className="ask-searches">
                  검색: {m.searches.map((s) => `"${s}"`).join(" · ")}
                </div>
              )}

              {m.sources && m.sources.length > 0 && (
                <div className="ask-sources">
                  {m.sources.map((s) => (
                    <a
                      key={s.url}
                      href={s.url}
                      target="_blank"
                      rel="noreferrer noopener"
                      className="ask-source"
                    >
                      {s.title}
                    </a>
                  ))}
                </div>
              )}

              {m.tokens && (
                <div className="ask-meta">
                  토큰 {m.tokens.input.toLocaleString("ko-KR")}/
                  {m.tokens.output.toLocaleString("ko-KR")}
                </div>
              )}
            </div>
          </div>
        ))}

        {busy && (
          <div className="ask-msg assistant">
            <div className="ask-role">AI</div>
            <div className="ask-body">
              <div className="ask-thinking">
                {useSearch ? "검색하고 정리하는 중…" : "정리하는 중…"}
              </div>
            </div>
          </div>
        )}
        <div ref={bottomRef} />
      </div>

      <div className="ask-input-row">
        <textarea
          className="ask-input"
          rows={2}
          placeholder="시황·종목에 대해 물어보세요 (Enter 전송 · Shift+Enter 줄바꿈)"
          value={input}
          disabled={busy}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              void send(input);
            }
          }}
        />
        <button className="primary-btn" onClick={() => void send(input)} disabled={busy || !input.trim()}>
          {busy ? "…" : "질문"}
        </button>
      </div>

      <div className="table-note">
        첫 질문에만 시장 데이터를 함께 넘깁니다 — 매 턴 넘기면 토큰이 배로 듭니다. 대화가 길어지면
        최근 8턴만 유지합니다. 웹 검색은 회당 약 $0.01이며, 한 질문에 최대 5회로 제한됩니다.
      </div>
    </div>
  );
}
