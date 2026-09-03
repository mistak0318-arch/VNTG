import { useEffect, useRef, useState } from "react";
import { api, type AskResult, type AskTurn, type SysBlock, type SysFact, type SysPack, type SysSection, type SysStockRef } from "../api";
import { setPref } from "../prefs";
import { SysIcon } from "./SysIcon";

/**
 * **시스 — 플로팅 도우미** (2026-09-03).
 *
 * 벤티지: "버튼 하나 만들어서 플로팅으로 AI 에게 물어보기 … 일반 모드에서는 뉴스랑 텔레랑
 * 종목이랑 ETF 관련 불러와서 보여주고(비용 0), AI 모드로 물어보면 API 써서 정리해서 …
 * 데이터는 많이 긁어오는데 한방에 보여주는 도우미. 「시스」라고 이름 붙이고 싶네."
 *
 * 어느 화면에서든 우하단 버튼. 열면 패널 — 질문 한 줄, 일반/AI 모드, 결과 섹션.
 *   · 일반: 서버가 질문을 읽고(종목·시장·ETF·거시·테마·CIS·관심종목·원장·일정·공시·뉴스·텔레)
 *     걸린 주제를 전부 긁어 **같은 모양의 섹션**으로 준다. 이 화면은 섹션 하나 그리는 법만 안다.
 *   · AI: 같은 섹션을 문맥으로 Claude 에 묻는다(웹 검색 포함). 답 아래에 검색어·출처·토큰.
 *   · 일반 결과 밑에 「AI 에게 정리시키기」 — 먼저 공짜로 보고 부족할 때만 돈을 쓴다.
 * 종목 상세를 보고 있으면 그 종목이 기본 대상이다 — 「뉴스 있어?」만 쳐도 그 종목 얘기다.
 *
 * 켜고 끄기·기본 모드는 설정 › 화면 (`vntg.sys.*`, 전역). 모델은 설정 › 분석 기준 › AI 모델의
 * 「시스 도우미」 줄(안 고르면 시황 질문하기 것).
 */

export const SYS_ENABLED_KEY = "vntg.sys.enabled";
export const SYS_MODE_KEY = "vntg.sys.mode";
export const SYS_SEARCH_KEY = "vntg.sys.search";
/** 설정 화면이 바꾸면 이 이벤트로 알린다 — 같은 창 안에서는 storage 이벤트가 안 온다 */
export const SYS_EVENT = "vntg:sys";

export function sysEnabled(): boolean {
  try {
    return localStorage.getItem(SYS_ENABLED_KEY) !== "0";
  } catch {
    return true;
  }
}
function readMode(): "plain" | "ai" {
  try {
    return localStorage.getItem(SYS_MODE_KEY) === "ai" ? "ai" : "plain";
  } catch {
    return "plain";
  }
}
function readSearch(): boolean {
  try {
    return localStorage.getItem(SYS_SEARCH_KEY) !== "0";
  } catch {
    return true;
  }
}

interface Turn {
  id: number;
  q: string;
  mode: "plain" | "ai";
  pack?: SysPack;
  ai?: AskResult | null;
  error?: string;
  busy?: boolean;
}

const EXAMPLES = [
  "오늘 시장 왜 이래?",
  "두산에너빌리티 뉴스 있어?",
  "두산에너빌리티 담은 ETF들 오늘 성적 어때?",
  "지금 미장 선물 어때? 유가는?",
  "금리 오늘 오르는 추세야?",
  "CIS 일지 요즘 수익권이래?",
  "관심종목 오늘 어때?",
  "슈퍼신호등 원장 잘 가?",
];

const TONE_CLASS: Record<string, string> = { up: "positive", down: "negative", good: "sys-good", warn: "sys-warn", bad: "negative", muted: "sys-dim" };
const cls = (t?: string) => (t ? TONE_CLASS[t] ?? "" : "");

function Facts({ facts }: { facts: SysFact[] }) {
  return (
    <div className="sys-facts">
      {facts.map((f, i) => (
        <span key={`${f.label}-${i}`} title={f.hint} className={f.tone === "muted" ? "sys-dim" : ""}>
          {f.label} {f.value && <b className={cls(f.tone)}>{f.value}</b>}
        </span>
      ))}
    </div>
  );
}

function Block({ b, onSelectStock }: { b: SysBlock; onSelectStock: (code: string, name: string) => void }) {
  return (
    <div className="sys-sec">
      {b.title && <div className="sys-sec-t">{b.title}</div>}
      {b.facts && b.facts.length > 0 && <Facts facts={b.facts} />}
      {b.lines?.map((l, i) => (
        <div key={i} className={`sys-line ${cls(l.tone)}`}>
          {l.text}
        </div>
      ))}
      {b.items && b.items.length > 0 && (
        <ul className="sys-list">
          {b.items.map((it, i) => (
            <li key={i}>
              {it.stock ? (
                <button type="button" className={`sys-item-stock ${cls(it.tone)}`} onClick={() => onSelectStock(it.stock!.code, it.stock!.name)} title="종목 열기">
                  {it.text}
                </button>
              ) : it.link ? (
                <a href={it.link} target="_blank" rel="noreferrer noopener" className={cls(it.tone)}>
                  {it.text}
                </a>
              ) : (
                <span className={`sys-item-text ${cls(it.tone)}`}>{it.text}</span>
              )}
              {it.sub && (
                <span className="sys-dim">
                  {it.sub}
                  {it.stock && it.link && (
                    <>
                      {" "}
                      <a href={it.link} target="_blank" rel="noreferrer noopener">
                        원문
                      </a>
                    </>
                  )}
                </span>
              )}
            </li>
          ))}
        </ul>
      )}
      {b.text && <div className="sys-brief">{b.text}</div>}
    </div>
  );
}

function Section({ s, onSelectStock }: { s: SysSection; onSelectStock: (code: string, name: string) => void }) {
  return (
    <div className="sys-card">
      <div className="sys-card-h">
        {s.stock ? (
          <button type="button" className="sys-stock" onClick={() => onSelectStock(s.stock!.code, s.stock!.name)} title="종목 상세 열기">
            {s.title} <small>{s.stock.code}</small>
          </button>
        ) : (
          <b className="sys-sec-title">{s.title}</b>
        )}
        <span className="sys-dim sys-ms">{(s.ms / 1000).toFixed(1)}초</span>
      </div>
      {s.error && <div className="error-banner">{s.error}</div>}
      {s.head && s.head.length > 0 && <Facts facts={s.head} />}
      {s.blocks.map((b, i) => (
        <Block key={i} b={b} onSelectStock={onSelectStock} />
      ))}
      {s.missing && s.missing.length > 0 && <div className="sys-dim sys-line">못 받은 것: {s.missing.join(" · ")}</div>}
    </div>
  );
}

function PackView({ pack, onSelectStock }: { pack: SysPack; onSelectStock: (code: string, name: string) => void }) {
  return (
    <div className="sys-pack">
      <div className="sys-dim sys-intent">
        {pack.intent.note} · {(pack.ms / 1000).toFixed(1)}초
      </div>
      {pack.sections.map((s) => (
        <Section key={s.key} s={s} onSelectStock={onSelectStock} />
      ))}
      {pack.sections.length === 0 && <div className="sys-dim">아무것도 못 알아들었다 — 종목·시장·ETF·금리처럼 물어봐</div>}
    </div>
  );
}

export function SysAssist({
  focus,
  onSelectStock,
}: {
  /** 지금 열려 있는 종목 — 질문에 종목이 없으면 이 종목 얘기로 듣는다 */
  focus: SysStockRef | null;
  onSelectStock: (code: string, name: string) => void;
}) {
  const [enabled, setEnabled] = useState(sysEnabled);
  const [open, setOpen] = useState(false);
  const [mode, setMode] = useState<"plain" | "ai">(readMode);
  const [useSearch, setUseSearch] = useState(readSearch);
  const [aiReady, setAiReady] = useState(true);
  const [input, setInput] = useState("");
  const [turns, setTurns] = useState<Turn[]>([]);
  const bottomRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const seq = useRef(0);

  useEffect(() => {
    const sync = () => {
      setEnabled(sysEnabled());
      setMode(readMode());
      setUseSearch(readSearch());
    };
    window.addEventListener(SYS_EVENT, sync);
    window.addEventListener("storage", sync);
    return () => {
      window.removeEventListener(SYS_EVENT, sync);
      window.removeEventListener("storage", sync);
    };
  }, []);

  useEffect(() => {
    if (!open) return;
    api
      .sysStatus()
      .then((r) => setAiReady(r.aiReady))
      .catch(() => setAiReady(false));
    inputRef.current?.focus();
  }, [open]);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [turns]);

  const busy = turns.some((t) => t.busy);

  function pickMode(m: "plain" | "ai") {
    setMode(m);
    setPref(SYS_MODE_KEY, m);
  }
  function toggleSearch() {
    const v = !useSearch;
    setUseSearch(v);
    setPref(SYS_SEARCH_KEY, v ? "1" : "0");
  }

  async function send(text: string, m: "plain" | "ai" = mode) {
    const q = text.trim();
    if (!q || busy) return;
    const id = ++seq.current;
    /* AI 대화 맥락은 AI 로 주고받은 것만 — 일반 결과는 서버가 매번 새로 긁는다 */
    const history: AskTurn[] = turns
      .filter((t) => t.mode === "ai" && t.ai?.text)
      .flatMap((t) => [
        { role: "user" as const, text: t.q },
        { role: "assistant" as const, text: t.ai?.text ?? "" },
      ])
      .slice(-8);
    setTurns((prev) => [...prev, { id, q, mode: m, busy: true }]);
    setInput("");
    try {
      const r = await api.sysAsk(q, { mode: m, history, focus, useSearch });
      setTurns((prev) => prev.map((t) => (t.id === id ? { ...t, pack: r.pack, ai: r.ai, busy: false } : t)));
    } catch (err) {
      setTurns((prev) => prev.map((t) => (t.id === id ? { ...t, busy: false, error: err instanceof Error ? err.message : "실패" } : t)));
    }
  }

  if (!enabled) return null;

  return (
    <>
      {!open && (
        <button type="button" className="sys-fab" onClick={() => setOpen(true)} title="시스 — 물어보기 (종목·시장·ETF·거시·뉴스·텔레그램·CIS·관심종목)">
          <SysIcon size="1.7em" />
          <span className="sys-fab-t">시스</span>
        </button>
      )}
      {open && (
        <div className="sys-panel" role="dialog" aria-label="시스 도우미">
          <div className="sys-head">
            <b className="sys-title">
              <SysIcon size="1.5em" /> 시스
            </b>
            <span className="sys-seg">
              <button type="button" className={mode === "plain" ? "on" : ""} onClick={() => pickMode("plain")} title="우리 데이터만 긁어서 보여준다 — 비용 0">
                일반
              </button>
              <button
                type="button"
                className={mode === "ai" ? "on" : ""}
                onClick={() => pickMode("ai")}
                disabled={!aiReady}
                title={aiReady ? "긁은 묶음을 Claude 에 넘겨 정리 — 질문당 수십~수백 원" : "ANTHROPIC_API_KEY 가 없다"}
              >
                AI
              </button>
            </span>
            {mode === "ai" && (
              <button type="button" className={`sys-mini${useSearch ? " on" : ""}`} onClick={toggleSearch} title="AI 가 웹도 검색한다 (회당 약 $0.01, 최대 5회)">
                웹 검색
              </button>
            )}
            {focus && (
              <span className="sys-focus" title="질문에 종목이 없으면 이 종목 얘기로 듣는다">
                📌 {focus.name}
              </span>
            )}
            {turns.length > 0 && (
              <button type="button" className="sys-mini" onClick={() => setTurns([])} disabled={busy} title="대화 지우기">
                지우기
              </button>
            )}
            <button type="button" className="sys-x" onClick={() => setOpen(false)} title="닫기">
              ✕
            </button>
          </div>

          <div className="sys-body">
            {turns.length === 0 && (
              <div className="sys-intro">
                <p className="sys-dim">
                  종목·시장·ETF·미장·유가·금리·환율·테마·CIS 일지·관심종목·신호등 원장·일정·공시·뉴스·텔레그램 — 한 질문에 여럿을
                  섞어도 된다. <b>일반</b>은 우리 데이터를 한 번에 긁어 보여주고(공짜), <b>AI</b>는 그 묶음을 Claude 에 넘겨 정리한다.
                  매수·매도는 말하지 않는다.
                </p>
                <div className="sys-ex">
                  {EXAMPLES.map((e) => (
                    <button key={e} type="button" onClick={() => void send(e)}>
                      {e}
                    </button>
                  ))}
                </div>
              </div>
            )}
            {turns.map((t) => (
              <div key={t.id} className="sys-turn">
                <div className="sys-q">
                  <span className="sys-dim">{t.mode === "ai" ? "AI" : "일반"}</span> {t.q}
                </div>
                {t.busy && <div className="sys-dim sys-line">{t.mode === "ai" ? "긁어서 Claude 에 묻는 중…" : "긁는 중…"}</div>}
                {t.error && <div className="error-banner">{t.error}</div>}
                {t.ai && (
                  <div className="sys-ai">
                    {t.ai.error && <div className="error-banner">{t.ai.error}</div>}
                    {t.ai.text && <div className="ask-text">{t.ai.text}</div>}
                    {t.ai.searches.length > 0 && <div className="ask-searches">검색: {t.ai.searches.map((s) => `"${s}"`).join(" · ")}</div>}
                    {t.ai.sources.length > 0 && (
                      <div className="ask-sources">
                        {t.ai.sources.map((s) => (
                          <a key={s.url} href={s.url} target="_blank" rel="noreferrer noopener" className="ask-source">
                            {s.title}
                          </a>
                        ))}
                      </div>
                    )}
                    <div className="ask-meta">
                      {t.ai.model} · 토큰 {t.ai.inputTokens.toLocaleString("ko-KR")}/{t.ai.outputTokens.toLocaleString("ko-KR")}
                    </div>
                  </div>
                )}
                {t.pack && (
                  <details className="sys-packwrap" open={t.mode === "plain"}>
                    <summary>
                      {t.mode === "ai" ? "시스가 모은 것 (AI 가 본 재료)" : "모은 것"} — {t.pack.intent.note}
                    </summary>
                    <PackView pack={t.pack} onSelectStock={onSelectStock} />
                  </details>
                )}
                {t.pack && t.mode === "plain" && aiReady && (
                  <button type="button" className="sys-toai" onClick={() => void send(t.q, "ai")} disabled={busy}>
                    이걸로 AI 에게 정리시키기 →
                  </button>
                )}
              </div>
            ))}
            <div ref={bottomRef} />
          </div>

          <div className="sys-input-row">
            <textarea
              ref={inputRef}
              className="sys-input"
              rows={2}
              placeholder={focus ? `${focus.name}에 대해, 또는 시장·ETF·금리… (Enter 전송)` : "종목·시장·ETF·금리·CIS… (Enter 전송 · Shift+Enter 줄바꿈)"}
              value={input}
              disabled={busy}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  void send(input);
                }
                if (e.key === "Escape") setOpen(false);
              }}
            />
            <button type="button" className="primary-btn" onClick={() => void send(input)} disabled={busy || !input.trim()}>
              {busy ? "…" : mode === "ai" ? "AI" : "찾기"}
            </button>
          </div>
        </div>
      )}
    </>
  );
}
