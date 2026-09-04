import { useEffect, useRef, useState } from "react";
import { api, type AskResult, type AskTurn, type SysBlock, type SysFact, type SysPack, type SysProposal, type SysRecap, type SysSection, type SysStockRef } from "../api";
import { setPref } from "../prefs";
import { SysIcon } from "./SysIcon";
import { speechText, TTS_RATES, useTts } from "../useTts";
import { useAppearance, type AppearanceContext } from "../useAppearance";

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
/** 되묻기 끔 — 「다」를 두 번 연속 고르면 화면이 스스로 켠다 (업그레이드 ②) */
export const SYS_NOASK_KEY = "vntg.sys.noask";
/** 답이 오면 스스로 읽어 줄까 (2026-09-03) — 기본 끔. 갑자기 소리가 나면 놀란다 */
export const SYS_AUTOREAD_KEY = "vntg.sys.autoread";
/** 설정 화면이 바꾸면 이 이벤트로 알린다 — 같은 창 안에서는 storage 이벤트가 안 온다 */
export const SYS_EVENT = "vntg:sys";
/**
 * 버튼 자리 (2026-09-03 — 벤티지: "위치도 옮길 수 있게 해줘. 모바일에서도").
 * **이 기기만의 값**이라 setPref 를 안 거친다(`prefs.ts` LOCAL_ONLY 에도 적어 둠) — 27인치에서
 * 둔 자리가 폰까지 따라오면 안 된다. 화면 비율로 저장해 창 크기가 바뀌어도 비슷한 자리에 선다.
 */
const SYS_POS_KEY = "vntg.sys.pos";
/** 이만큼 넘게 움직였으면 「끈 것」이다 — 손가락은 가만히 있어도 몇 px 씩 떨린다 */
const DRAG_SLOP = 6;

interface Pos {
  /** 버튼 가운데의 화면 비율 0~1 */
  fx: number;
  fy: number;
}
function readPos(): Pos | null {
  try {
    const v = JSON.parse(localStorage.getItem(SYS_POS_KEY) ?? "null") as Pos | null;
    return v && Number.isFinite(v.fx) && Number.isFinite(v.fy) ? v : null;
  } catch {
    return null;
  }
}
function clampPx(x: number, y: number): { x: number; y: number } {
  const m = 22;
  return {
    x: Math.min(Math.max(x, m), window.innerWidth - m),
    y: Math.min(Math.max(y, m), window.innerHeight - m),
  };
}

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
function readNoAsk(): boolean {
  try {
    return localStorage.getItem(SYS_NOASK_KEY) === "1";
  } catch {
    return false;
  }
}
function readAutoRead(): boolean {
  try {
    return localStorage.getItem(SYS_AUTOREAD_KEY) === "1";
  } catch {
    return false;
  }
}

/**
 * **낭독용 글** (2026-09-03 — 벤티지: "시스에 한글로 읽어주기 기능 추가해줄 수 있어?").
 *
 * AI 답이 있으면 그것을 읽는다 — 애초에 사람이 읽으라고 쓴 문장이다. 일반 모드는 카드가
 * 숫자 격자라 **그대로 읽으면 소음**이다. 그래서 골라 읽는다:
 *   섹션 제목 → 머리 숫자 → 블록의 줄글 → 목록은 위에서 셋까지.
 * 뉴스·텔레그램은 제목만(본문을 다 읽으면 한 종목에 5분이 걸린다).
 */
function packToSpeech(pack: SysPack, aiText?: string | null): string {
  if (aiText?.trim()) return speechText(aiText);
  /* 값이 없는 칸(「-」)은 읽지 않는다 — 「실적 가치 마이너스」로 들린다 */
  const fact = (f: SysFact) => (!f.value || f.value === "-" ? "" : `${f.label} ${f.value}`.trim());
  const facts = (arr: SysFact[], n: number) => arr.slice(0, n).map(fact).filter(Boolean).join(", ");
  const out: string[] = [];
  for (const p of pack.proposals ?? []) out.push(`${p.title} ${facts(p.facts, 8)}.`);
  for (const s of pack.sections) {
    const L: string[] = [`${s.title}.`];
    if (s.head?.length) L.push(`${facts(s.head, 8)}.`);
    for (const b of s.blocks) {
      const bits: string[] = [];
      if (b.title) bits.push(`${b.title}.`);
      if (b.facts?.length) bits.push(`${facts(b.facts, 6)}.`);
      /* 신호등의 ＋/－ 줄은 기호가 아니라 말로 — 그냥 읽히면 「플러스」도 아니고 침묵이다 */
      if (b.lines?.length) bits.push(b.lines.map((l) => l.text.replace(/^＋\s*/, "좋은 쪽은, ").replace(/^－\s*/, "나쁜 쪽은, ")).join(" "));
      if (b.items?.length) {
        /* 목록은 셋까지. 종목 줄은 「이름, 당일 +5%」가 뜻이 있으니 sub 도 읽고, 뉴스는 제목만 */
        bits.push(
          b.items
            .slice(0, 3)
            .map((i) => (i.stock && i.sub && i.sub.length <= 60 ? `${i.text}, ${i.sub}` : i.text))
            .join(". "),
        );
      }
      if (b.text) bits.push(b.text.slice(0, 400));
      if (bits.length) L.push(bits.join(" "));
    }
    out.push(L.join(" "));
  }
  return speechText(out.join("\n")).slice(0, 4000);
}

/* ── 화면 명령 (2026-09-04) ───────────────────────────────────────────────
 *
 * 벤티지: "시스한테 명령어 좀 하나 입력하자 — 사이드바 숨겨줘 / 사이드바 숨김취소.
 * 비슷한 명령어도 인식할 수 있게."
 *
 * 이건 **서버에 안 간다.** 화면 설정을 바꾸는 일이라 여기서 바로 처리하고 한 줄로 답한다 —
 * 조회가 0회이고, 일반 모드든 AI 모드든 똑같이 즉시 듣는다.
 *
 * 「비슷한 말」은 정규식 하나로 받는다. **대상**(사이드바·메뉴·왼쪽 메뉴…)과 **방향**(숨겨·감춰 /
 * 다시·취소·보여)을 따로 잡고 둘을 조합한다 — 말을 하나씩 나열하면 반드시 빠뜨린다.
 * 방향을 안 적으면(그냥 "사이드바") **토글**이다.
 *
 * 새 명령을 붙일 땐 이 배열에 한 칸. `examples` 는 도움말 줄에 그대로 나간다.
 */
interface UiCommandCtx {
  appearance: AppearanceContext;
}

interface UiCommand {
  key: string;
  test: (q: string) => boolean;
  /** 무엇을 했는지 한 줄로. 안 바꿨으면 그 이유를 적는다 */
  run: (q: string, ctx: UiCommandCtx) => string;
  examples: string[];
}

/** 대상 — 사이드바를 부르는 온갖 말 */
const RE_SIDEBAR = /(사이드\s*바|사이드바|사이드|좌측\s*메뉴|왼쪽\s*메뉴|우측\s*메뉴|오른쪽\s*메뉴|메뉴\s*바|메뉴바|네비|내비|nav|sidebar)/i;
/** 감추는 쪽 */
const RE_HIDE = /(숨겨|숨김|숨기|감춰|감추|접어|접기|치워|치우|없애|안\s*보이게|가려|축소|자동\s*숨김|hide)/;
/** 되돌리는 쪽 — 「숨김취소」처럼 감추는 말과 붙어 오므로 **이쪽을 먼저** 본다 */
const RE_SHOW = /(취소|해제|되돌|원래대로|다시\s*보|보여|보이게|펼쳐|펴|고정|끄기|끄고|풀어|show)/;

const UI_COMMANDS: UiCommand[] = [
  {
    key: "sidebar",
    test: (q) => RE_SIDEBAR.test(q) && (RE_HIDE.test(q) || RE_SHOW.test(q)),
    run: (q, { appearance }) => {
      /*
       * 순서가 중요하다. 「사이드바 숨김취소」에는 감추는 말(숨김)과 되돌리는 말(취소)이
       * 둘 다 들어 있다 — 되돌리는 쪽을 먼저 보지 않으면 반대로 동작한다.
       */
      const want = RE_SHOW.test(q) ? false : RE_HIDE.test(q) ? true : !appearance.sidebarAuto;
      if (want === appearance.sidebarAuto) {
        return want ? "이미 숨김이야 (☰ 로 열어)" : "이미 늘 보이는 상태야";
      }
      appearance.set({ sidebarAuto: want });
      return want
        ? "사이드바를 숨겼어 — 왼쪽 위 ☰ 로 열면 돼. 본문이 200px 넓어진다"
        : "사이드바를 도로 붙였어 — 이제 늘 보인다";
    },
    examples: ["사이드바 숨겨줘", "사이드바 숨김취소", "메뉴 감춰", "왼쪽 메뉴 다시 보여줘"],
  },
];

/** 화면 명령이면 그 명령을, 아니면 null */
function matchUiCommand(q: string): UiCommand | null {
  return UI_COMMANDS.find((c) => c.test(q)) ?? null;
}

interface Turn {
  id: number;
  q: string;
  mode: "plain" | "ai";
  /** 화면 명령이면 서버에 안 간다 — 한 일을 한 줄로 (2026-09-04) */
  done?: string;
  pack?: SysPack;
  ai?: AskResult | null;
  error?: string;
  busy?: boolean;
  /** 서버가 어떻게 알아들었나 — 긁는 동안 먼저 보여 준다 */
  plan?: string;
  planTopics?: string[];
  startedAt?: number;
  /** 정지 버튼이 끊는 손잡이 */
  controller?: AbortController;
}

const EXAMPLES = [
  "오늘 시장 왜 이래?",
  "두산에너빌리티 뉴스 있어?",
  "두산에너빌리티 담은 ETF들 오늘 성적 어때?",
  "지금 미장 선물 어때? 유가는?",
  "금리 오늘 오르는 추세야?",
  "항해일지 요즘 수익권이래?",
  /* 화면 명령도 예시에 — 있는 줄 모르면 아무도 안 쓴다 */
  "사이드바 숨겨줘",
  "관심종목 오늘 어때?",
  "슈퍼신호등 원장 잘 가?",
  "9월 일정 뭐 있어?",
  "하이닉스 메모 적어 둔 거 있나?",
  "복기 노트에서 손절 관련 찾아줘",
  "내일 오후 2시 FOMC 결과 확인 일정 넣어줘",
  "메모: 하이닉스 눌림 대기, 20일선 지지 보고",
  "두산에너빌리티 관심종목에 넣어줘",
  "반도체 업종 어때?",
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
        <span
          className="sys-dim sys-ms"
          title={
            s.took
              ? Object.entries(s.took)
                  .sort((a, b) => b[1] - a[1])
                  .map(([k, v]) => `${k} ${v < 0 ? "시간 초과" : `${(v / 1000).toFixed(1)}초`}`)
                  .join("\n")
              : undefined
          }
        >
          {(s.ms / 1000).toFixed(1)}초
        </span>
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

/**
 * 제안 카드 — 「이렇게 넣을까?」 (2026-09-03). 시스는 바로 안 쓴다. 벤티지가 「넣기」를 눌러야
 * 서버가 저장한다. 잘못 알아들은 걸 바로 넣으면 지우는 게 더 일이다.
 */
const PROPOSAL_META: Record<SysProposal["kind"], { icon: string; verb: string }> = {
  addEvent: { icon: "📅", verb: "넣기" },
  addMemo: { icon: "📝", verb: "남기기" },
  addWatch: { icon: "⭐", verb: "넣기" },
  setStop: { icon: "🛑", verb: "걸기" },
};

function ProposalCard({ p }: { p: SysProposal }) {
  const [state, setState] = useState<{ busy: boolean; done?: string; error?: string }>({ busy: false });
  const meta = PROPOSAL_META[p.kind] ?? { icon: "✎", verb: "넣기" };
  return (
    <div className="sys-card sys-proposal">
      <div className="sys-card-h">
        <b className="sys-sec-title">{meta.icon} {p.title}</b>
      </div>
      <Facts facts={p.facts} />
      {state.done ? (
        <div className="sys-line sys-good">✓ {state.done}</div>
      ) : (
        <div className="sys-proposal-act">
          <button
            type="button"
            className="primary-btn"
            disabled={state.busy}
            onClick={() => {
              setState({ busy: true });
              api
                .sysAct(p.kind, p.payload)
                .then((r) => setState({ busy: false, done: r.ok ? r.message : undefined, error: r.ok ? undefined : r.message }))
                .catch((e: Error) => setState({ busy: false, error: e.message }));
            }}
          >
            {state.busy ? "저장 중…" : meta.verb}
          </button>
          <span className="sys-dim">아니면 질문을 고쳐서 다시 — 날짜·시각·제목을 그대로 적으면 잘 알아듣는다</span>
        </div>
      )}
      {state.error && <div className="error-banner">{state.error}</div>}
    </div>
  );
}

function PackView({ pack, onSelectStock }: { pack: SysPack; onSelectStock: (code: string, name: string) => void }) {
  return (
    <div className="sys-pack">
      <div className="sys-dim sys-intent">
        {pack.intent.note} · {(pack.ms / 1000).toFixed(1)}초
      </div>
      {pack.proposals?.map((p) => (
        <ProposalCard key={p.id} p={p} />
      ))}
      {pack.sections.map((s) => (
        <Section key={s.key} s={s} onSelectStock={onSelectStock} />
      ))}
      {pack.sections.length === 0 && !pack.proposals?.length && <div className="sys-dim">아무것도 못 알아들었다 — 종목·시장·ETF·금리처럼 물어봐</div>}
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
  const appearance = useAppearance();
  const [enabled, setEnabled] = useState(sysEnabled);
  const [open, setOpen] = useState(false);
  const [mode, setMode] = useState<"plain" | "ai">(readMode);
  const [useSearch, setUseSearch] = useState(readSearch);
  const [aiReady, setAiReady] = useState(true);
  const [input, setInput] = useState("");
  const [turns, setTurns] = useState<Turn[]>([]);
  const [noAsk, setNoAsk] = useState(readNoAsk);
  /* 읽어주기 — 리포트와 같은 장치(백그라운드 우회·잠금화면 버튼). 어느 턴을 읽는 중인지 기억한다 */
  const tts = useTts();
  const [autoRead, setAutoRead] = useState(readAutoRead);
  const [speakingId, setSpeakingId] = useState<number | null>(null);
  const autoReadRef = useRef(autoRead);
  autoReadRef.current = autoRead;
  /** 「다」를 연속으로 몇 번 골랐나 — 둘이면 그 뒤로 안 묻는다 */
  const allStreak = useRef(0);
  /** ① 오늘 되짚기 — 열 때 한 번 받는다 */
  const [recap, setRecap] = useState<SysRecap | null>(null);
  const bottomRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const seq = useRef(0);

  /*
   * 끌어서 옮기기 — CornerToggle 과 같은 포인터 처리(마우스·터치 한 갈래). 조금이라도
   * 움직였으면 끈 것이라 패널을 안 연다. 모서리로 붙이지 않고 **놓은 자리 그대로** —
   * 벤티지가 "보는 시야를 가리지 않게" 둘 자리를 직접 고른다. 화면 밖으로는 못 나간다.
   */
  const [pos, setPos] = useState<Pos | null>(readPos);
  const [drag, setDrag] = useState<{ x: number; y: number } | null>(null);
  const dragStart = useRef<{ x: number; y: number } | null>(null);
  const moved = useRef(false);
  const fabRef = useRef<HTMLButtonElement>(null);
  const onFabDown = (e: React.PointerEvent<HTMLButtonElement>) => {
    dragStart.current = { x: e.clientX, y: e.clientY };
    moved.current = false;
    fabRef.current?.setPointerCapture(e.pointerId);
  };
  const onFabMove = (e: React.PointerEvent<HTMLButtonElement>) => {
    const s = dragStart.current;
    if (!s) return;
    if (!moved.current && Math.hypot(e.clientX - s.x, e.clientY - s.y) < DRAG_SLOP) return;
    moved.current = true;
    setDrag(clampPx(e.clientX, e.clientY));
  };
  const onFabUp = (e: React.PointerEvent<HTMLButtonElement>) => {
    const s = dragStart.current;
    dragStart.current = null;
    setDrag(null);
    if (!s) return;
    if (!moved.current) {
      setOpen(true);
      return;
    }
    const p = clampPx(e.clientX, e.clientY);
    const next: Pos = { fx: p.x / window.innerWidth, fy: p.y / window.innerHeight };
    setPos(next);
    try {
      localStorage.setItem(SYS_POS_KEY, JSON.stringify(next));
    } catch {
      /* 저장 못 해도 이번 화면은 옮겨진다 */
    }
  };
  useEffect(() => {
    if (!drag) return;
    const prev = document.body.style.touchAction;
    document.body.style.touchAction = "none";
    return () => {
      document.body.style.touchAction = prev;
    };
  }, [drag]);
  /** 버튼이 있는 쪽에 패널을 연다 — 왼쪽에 두고 오른쪽에서 열리면 옮긴 뜻이 없다 */
  const anchor = (() => {
    if (!pos) return { side: "right" as const, vert: "bottom" as const };
    return { side: pos.fx < 0.5 ? ("left" as const) : ("right" as const), vert: pos.fy < 0.45 ? ("top" as const) : ("bottom" as const) };
  })();
  const fabStyle: React.CSSProperties | undefined = drag
    ? { left: drag.x, top: drag.y, right: "auto", bottom: "auto", transform: "translate(-50%, -50%)" }
    : pos
      ? { left: `${(pos.fx * 100).toFixed(2)}vw`, top: `${(pos.fy * 100).toFixed(2)}vh`, right: "auto", bottom: "auto", transform: "translate(-50%, -50%)" }
      : undefined;

  useEffect(() => {
    const sync = () => {
      setEnabled(sysEnabled());
      setMode(readMode());
      setUseSearch(readSearch());
      setNoAsk(readNoAsk());
      setAutoRead(readAutoRead());
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
    api
      .sysRecap()
      .then((r) => setRecap(r.stocks.length ? r : null))
      .catch(() => undefined);
    inputRef.current?.focus();
  }, [open]);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [turns]);

  const busy = turns.some((t) => t.busy);

  /*
   * 진행 표시 (2026-09-03 — 벤티지: "대답을 안 하고 긁는 중이라고만 나와… 멈춘 줄. 생각하는 중이라던가
   * 프로그래스바라도 보여주던가, 아니면 중간에 멈추는 정지 버튼이라도").
   * 보내자마자 해석(수 ms)을 먼저 받아 「종목 두산에너빌리티 · 시세·수급·신호등…」을 띄우고,
   * 경과 초를 0.5초마다 올린다. 텔레그램을 콕 집어 물었으면 채널 진행(n/70)까지 보여 준다.
   */
  const [, setTick] = useState(0);
  const [chanProg, setChanProg] = useState<{ done: number; total: number; name: string } | null>(null);
  useEffect(() => {
    if (!busy) {
      setChanProg(null);
      return;
    }
    const t = setInterval(() => setTick((n) => n + 1), 500);
    const wantsChan = turns.some((x) => x.busy && x.planTopics?.includes("telegram"));
    const p = wantsChan
      ? setInterval(() => {
          api
            .sysSearchProgress()
            .then((r) => setChanProg(r.running ? { done: r.done, total: r.total, name: r.name } : null))
            .catch(() => undefined);
        }, 1000)
      : null;
    return () => {
      clearInterval(t);
      if (p) clearInterval(p);
    };
  }, [busy, turns]);

  function stop() {
    for (const t of turns) if (t.busy) t.controller?.abort();
  }

  /** 이 턴을 읽는다 — 버튼을 누른 그 자리에서 잠금을 풀어야 iOS 가 소리를 낸다 */
  function speakTurn(t: Turn) {
    if (!t.pack) return;
    tts.unlock();
    setSpeakingId(t.id);
    tts.speak(packToSpeech(t.pack, t.ai?.text), { title: `시스 — ${t.q}`, artist: "VNTG 시스" });
  }

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
    /*
     * 화면 명령이면 여기서 끝난다 (2026-09-04) — 서버·AI 를 안 부른다.
     * 「사이드바 숨겨줘」에 조회 한 번 나가고 3초 기다리는 건 말이 안 된다.
     */
    const cmd = matchUiCommand(q);
    if (cmd) {
      const done = cmd.run(q, { appearance });
      setTurns((prev) => [...prev, { id, q, mode: m, done }]);
      setInput("");
      return;
    }
    /* AI 대화 맥락은 AI 로 주고받은 것만 — 일반 결과는 서버가 매번 새로 긁는다 */
    const history: AskTurn[] = turns
      .filter((t) => t.mode === "ai" && t.ai?.text)
      .flatMap((t) => [
        { role: "user" as const, text: t.q },
        { role: "assistant" as const, text: t.ai?.text ?? "" },
      ])
      .slice(-8);
    const controller = new AbortController();
    setTurns((prev) => [...prev, { id, q, mode: m, busy: true, startedAt: Date.now(), controller }]);
    setInput("");
    /* 자동 읽기면 **보내는 이 순간**에 잠금을 푼다 — 답이 온 뒤엔 제스처가 아니라 iOS 가 막는다 */
    if (autoReadRef.current) tts.unlock();
    /* 해석은 수 ms — 긁는 동안 「무엇을」 보여 주려고 먼저 받는다. 실패해도 본 요청은 간다 */
    api
      .sysInterpret(q, focus)
      .then((r) => setTurns((prev) => prev.map((t) => (t.id === id ? { ...t, plan: r.intent.note, planTopics: r.intent.topics } : t))))
      .catch(() => undefined);
    try {
      const r = await api.sysAsk(q, { mode: m, history, focus, useSearch, noClarify: noAsk }, controller.signal);
      /* 되묻지 않고 답이 왔으면(되묻기 화면이 아니면) 「다」 연속 세기는 그대로 둔다 — 칩을 눌러야만 센다 */
      setTurns((prev) => prev.map((t) => (t.id === id ? { ...t, pack: r.pack, ai: r.ai, busy: false, controller: undefined } : t)));
      /* 자동 읽기 — 되묻는 중이면 읽지 않는다(질문이 화면에 떠 있어야 고른다) */
      if (autoReadRef.current && !r.pack.clarify) {
        setSpeakingId(id);
        tts.speak(packToSpeech(r.pack, r.ai?.text), { title: `시스 — ${q}`, artist: "VNTG 시스" });
      }
    } catch (err) {
      const aborted = err instanceof DOMException && err.name === "AbortError";
      setTurns((prev) =>
        prev.map((t) =>
          t.id === id ? { ...t, busy: false, controller: undefined, error: aborted ? "중단했다" : err instanceof Error ? err.message : "실패" } : t,
        ),
      );
    }
  }

  /** 되묻기 칩 — 「다」를 두 번 연속 고르면 그 뒤로 안 묻는다 */
  function pickClarify(opt: { label: string; send: string }) {
    if (opt.label === "다") {
      allStreak.current += 1;
      if (allStreak.current >= 2 && !noAsk) {
        setNoAsk(true);
        setPref(SYS_NOASK_KEY, "1");
      }
    } else {
      allStreak.current = 0;
    }
    void send(opt.send);
  }

  if (!enabled) return null;

  return (
    <>
      {!open && (
        <button
          ref={fabRef}
          type="button"
          className={`sys-fab${drag ? " dragging" : ""}`}
          style={fabStyle}
          onPointerDown={onFabDown}
          onPointerMove={onFabMove}
          onPointerUp={onFabUp}
          onPointerCancel={onFabUp}
          /* 폰에서 길게 누르면 컨텍스트 메뉴가 끼어들어 끌기가 끊긴다 */
          onContextMenu={(e) => e.preventDefault()}
          title="시스 — 물어보기 (종목·시장·ETF·거시·뉴스·텔레그램·CIS·관심종목). 끌어서 옮길 수 있다"
        >
          <SysIcon size="1.7em" />
          <span className="sys-fab-t">시스</span>
        </button>
      )}
      {open && (
        <div className={`sys-panel at-${anchor.side} at-${anchor.vert}`} role="dialog" aria-label="시스 도우미">
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
            {/* 읽는 중이면 어느 턴을 보고 있든 여기서 멈춘다 */}
            {tts.status !== "idle" && (
              <button type="button" className="sys-mini on" onClick={tts.stop} title="읽기 멈추기">
                ⏹ 읽는 중 {tts.pos}/{tts.total}
              </button>
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
            {/* ① 오늘 되짚기 — 시스가 먼저 말을 건다 */}
            {recap && turns.length === 0 && (
              <div className="sys-card sys-recap">
                <div className="sys-card-h">
                  <b className="sys-sec-title">오늘 물어본 종목, 그 뒤로</b>
                  <span className="sys-dim sys-ms">{recap.asked}번 물음</span>
                </div>
                <ul className="sys-list">
                  {recap.stocks.map((s) => (
                    <li key={s.code}>
                      <button type="button" className={`sys-item-stock ${cls(s.move === null ? undefined : s.move > 0 ? "up" : s.move < 0 ? "down" : undefined)}`} onClick={() => onSelectStock(s.code, s.name)}>
                        {s.line}
                      </button>
                    </li>
                  ))}
                </ul>
              </div>
            )}
            {turns.length === 0 && (
              <div className="sys-intro">
                <p className="sys-dim">
                  종목·시장·ETF·미장·유가·금리·환율·테마·항해일지·관심종목·신호등 원장·일정·공시·뉴스·텔레그램 — 한 질문에 여럿을
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
                {t.busy && (
                  <div className="sys-progress">
                    <div className="sys-progress-bar">
                      <span />
                    </div>
                    <div className="sys-line sys-dim">
                      {t.plan ? `${t.plan} — ` : "알아듣는 중 — "}
                      {t.mode === "ai" ? "긁은 뒤 AI 에 묻는 중" : "긁는 중"} · {Math.floor((Date.now() - (t.startedAt ?? Date.now())) / 1000)}초
                      {chanProg && chanProg.total > 0 && ` · 텔레그램 채널 ${chanProg.done}/${chanProg.total} ${chanProg.name}`}
                      {t.mode === "ai" && Date.now() - (t.startedAt ?? 0) > 15_000 && " · 웹 검색이 붙으면 1~3분 걸린다"}
                    </div>
                    <button type="button" className="sys-stop" onClick={stop} title="이 질문을 멈춘다">
                      ■ 정지
                    </button>
                  </div>
                )}
                {t.done && <div className="sys-done">✔ {t.done}</div>}
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
                {/* ② 되묻기 — 칩을 누르면 그 말을 붙여 다시 묻는다 */}
                {t.pack?.clarify && (
                  <div className="sys-clarify">
                    <div className="sys-line">{t.pack.clarify.question}</div>
                    <div className="sys-ex">
                      {t.pack.clarify.options.map((o) => (
                        <button key={o.label} type="button" onClick={() => pickClarify(o)} disabled={busy}>
                          {o.label}
                        </button>
                      ))}
                    </div>
                    <div className="sys-dim">「다」를 두 번 연속 고르면 그 뒤로는 안 묻는다 (설정에서 되돌림)</div>
                  </div>
                )}
                {t.pack && !t.pack.clarify && (
                  <details className="sys-packwrap" open={t.mode === "plain"}>
                    <summary>
                      {t.mode === "ai" ? "시스가 모은 것 (AI 가 본 재료)" : "모은 것"} — {t.pack.intent.note}
                    </summary>
                    <PackView pack={t.pack} onSelectStock={onSelectStock} />
                  </details>
                )}
                {/* 읽어주기 — 화면을 못 볼 때(운전·출근길). 백그라운드·잠금화면에서도 이어진다 */}
                {t.pack && !t.pack.clarify && tts.supported && (
                  <div className="sys-tts">
                    {speakingId === t.id && tts.status !== "idle" ? (
                      <>
                        {tts.status === "playing" ? (
                          <button type="button" className="sys-mini on" onClick={tts.pause}>⏸ 잠깐</button>
                        ) : (
                          <button type="button" className="sys-mini on" onClick={tts.resume}>▶ 이어서</button>
                        )}
                        <button type="button" className="sys-mini" onClick={tts.stop}>⏹</button>
                        <span className="sys-dim">{tts.pos}/{tts.total} 문장</span>
                        {TTS_RATES.map((x) => (
                          <button key={x} type="button" className={`sys-mini${tts.rate === x ? " on" : ""}`} onClick={() => tts.setRate(x)} title="다음 문장부터">
                            {x}×
                          </button>
                        ))}
                        <button
                          type="button"
                          className={`sys-mini${tts.keepAwake ? " on" : ""}`}
                          onClick={() => void tts.setWake(!tts.keepAwake)}
                          title="켜면 낭독 중 화면이 안 꺼진다 — 화면이 꺼지면 기기에 따라 낭독이 멈춘다"
                        >
                          🔅 화면 유지
                        </button>
                      </>
                    ) : (
                      <button type="button" className="sys-mini" onClick={() => speakTurn(t)} title="한국어로 읽어준다 — 다른 앱을 보거나 화면을 꺼도 이어진다">
                        🔊 읽어주기
                      </button>
                    )}
                  </div>
                )}
                {t.pack && !t.pack.clarify && t.mode === "plain" && aiReady && (
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
            {busy ? (
              <button type="button" className="primary-btn sys-stop-main" onClick={stop} title="멈춘다">
                ■
              </button>
            ) : (
              <button type="button" className="primary-btn" onClick={() => void send(input)} disabled={!input.trim()}>
                {mode === "ai" ? "AI" : "찾기"}
              </button>
            )}
          </div>
        </div>
      )}
    </>
  );
}
