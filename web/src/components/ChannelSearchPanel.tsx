import { useEffect, useMemo, useRef, useState } from "react";

/**
 * 텔레그램 채널 **검색** — 보드에 띄우는 그것.
 *
 * ## 정리(digest)와 다른 물음이다
 *
 * 「동향」은 채널 전체가 무슨 말을 하나를 묶어 본다. 시장을 훑을 때 쓴다.
 * 종목 하나를 파고들 때 궁금한 건 다르다 — **이 종목이 언급됐나, 뭐라고 하나.**
 * 정리본에는 그 종목이 아예 안 뽑혔을 수 있고, 뽑혔어도 한 줄로 줄어 있다.
 *
 * 보드에 텔레그램을 띄우는 값어치가 여기에 있다. **보고 있는 종목으로 저절로 찾아 주고**,
 * 키워드를 바꿔 더 좁힐 수 있어야 한다.
 *
 * ## 종목 이름 하나로는 안 잡힌다
 *
 * 「한화에어로스페이스」를 채널에서는 「한화에어로」라고 쓴다. 종목코드로 쓰는 데도 있다.
 * 그래서 **이름·짧은 이름·코드**를 같이 넣어 하나라도 걸리면 나오게 한다.
 * 사람이 키워드를 더 넣을 수도 있다(쉼표로 구분).
 */

interface Hit {
  channelId: string;
  channelName: string;
  messageId: number;
  at: string;
  text: string;
  link: string;
  matched: string[];
}

interface Result {
  query: string[];
  minutes: number;
  scanned: number;
  hits: Hit[];
  error: string | null;
}

/** 수집 구간 — 앞쪽이 짧다. 평소에 쓰는 건 이쪽이다 */
const WINDOWS: { min: number; label: string }[] = [
  { min: 60, label: "1시간" },
  { min: 180, label: "3시간" },
  { min: 720, label: "12시간" },
  { min: 1440, label: "하루" },
  { min: 4320, label: "3일" },
];

/**
 * 종목 이름에서 **채널이 쓸 법한 짧은 이름**을 만든다.
 *
 * 「한화에어로스페이스」 → 「한화에어로」. 긴 이름은 채널에서 거의 줄여 쓴다.
 * 짧은 이름이 원래 이름과 같으면(대부분) 안 넣는다 — 같은 말을 두 번 찾을 이유가 없다.
 */
function shortName(name: string): string | null {
  const n = name.replace(/\s+/g, "");
  if (n.length < 7) return null;
  return n.slice(0, 4);
}

function stamp(at: string): string {
  const d = new Date(at);
  if (Number.isNaN(d.getTime())) return at;
  return d.toLocaleString("ko-KR", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" });
}

/*
 * 탭을 떠났다 와도 검색이 이어 보이게 — **마지막 검색을 모듈이 들고 있는다** (2026-08-25).
 *
 * 패널은 탭을 옮기면 내려간다. 그동안 서버는 계속 훑고 있는데, 돌아오면 진행바도
 * 결과도 사라져 「죽었나?」가 됐다. 검색어·구간·결과·「아직 안 끝난 검색」을 모듈
 * 변수에 남겨 두고, 다시 올라올 때 그대로 잇는다. 끝난 결과는 fetch 콜백이 화면
 * 유무와 상관없이 여기에 적는다 — 돌아오면 바로 있다.
 */
interface SearchMemory {
  extra: string;
  minutes: number;
  result: Result | null;
  ran: { words: string; minutes: number } | null;
  /** 아직 결과를 못 받은 검색의 검색어 — 남아 있으면 돌아왔을 때 이어받는다 */
  pending: { words: string; minutes: number } | null;
}
const searchMemory = new Map<string, SearchMemory>();

/**
 * 찾은 낱말을 **원문 안에서 칠한다** (2026-09-04).
 *
 * 벤티지: "로보티즈라고 검색했으면 해당 문구는 강조 처리되어서 어디에 포함되었는지
 * 알 수 있게 해줘야겠지?"
 *
 * 맞다. 원문이 길면 어디서 걸렸는지 눈으로 찾아야 했다 — 그 찾는 일을 사람이 할 이유가 없다.
 *
 * ⚠️ `dangerouslySetInnerHTML` 을 쓰지 않는다. 여기 들어오는 글은 **남이 쓴 텔레그램 원문**이라
 * HTML 로 심으면 그게 곧 XSS 다. 조각으로 잘라 React 가 그리게 한다.
 * 정규식에 넣기 전에 특수문자를 막고(`esc`), 대소문자를 안 가린다(영문 종목명·티커).
 */
function mark(text: string, words: string[]): React.ReactNode {
  const ws = words.map((w) => w.trim()).filter((w) => w.length > 0);
  if (ws.length === 0) return text;
  const esc = (w: string) => w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  let re: RegExp;
  try {
    re = new RegExp(`(${ws.map(esc).join("|")})`, "gi");
  } catch {
    return text;
  }
  const parts = text.split(re);
  return parts.map((p, i) =>
    /* split 의 홀수 자리가 잡힌 조각이다 — 값으로 다시 견주면 겹치는 낱말에서 어긋난다 */
    i % 2 === 1 ? (
      <mark className="cs-mark" key={i}>
        {p}
      </mark>
    ) : (
      p
    ),
  );
}

export function ChannelSearchPanel({ code, name }: { code?: string; name?: string }) {
  const memKey = code ?? "";
  const saved = searchMemory.get(memKey);
  const [minutes, setMinutes] = useState(saved?.minutes ?? 720);
  /** 사람이 더 넣은 말 (쉼표) */
  const [extra, setExtra] = useState(saved?.extra ?? "");
  const [result, setResult] = useState<Result | null>(saved?.result ?? null);
  const [busy, setBusy] = useState(false);
  /*
   * AI 정리 — **원문을 대신하지 않는다.**
   *
   * 원문 그대로 보는 게 기본이다. 채널 말투와 숫자가 그대로 있어야 판단이 된다.
   * 그런데 걸린 게 마흔 건이면 다 못 읽는다 — 그때 몇 줄로 줄여서 훑는다.
   * 눈에 걸리는 게 있으면 아래 원문을 봐야 한다.
   *
   * 호출당 비용이 있으므로 **누를 때만** 돈다. 검색어를 바꿀 때마다 자동으로 돌면
   * 글자를 칠 때마다 돈이 나간다.
   */
  const [ai, setAi] = useState<{ text: string | null; model: string | null; error: string | null } | null>(null);
  const [aiBusy, setAiBusy] = useState(false);
  /** 종목이 바뀌면 사람이 넣어 둔 키워드는 지운다 — 다른 종목에 남아 있으면 헷갈린다 */
  const lastCode = useRef(code);

  useEffect(() => {
    if (lastCode.current !== code) {
      lastCode.current = code;
      setExtra("");
    }
  }, [code]);

  /** 실제로 찾을 말들 — 종목 이름·짧은 이름·코드 + 사람이 넣은 것 */
  const words = useMemo(() => {
    const out: string[] = [];
    if (name) {
      out.push(name);
      const s = shortName(name);
      if (s) out.push(s);
    }
    if (code) out.push(code);
    for (const w of extra.split(",")) {
      const t = w.trim();
      if (t) out.push(t);
    }
    return [...new Set(out)];
  }, [name, code, extra]);

  /*
   * ⚠️ **저절로 돌지 않는다.**
   *
   * 예전엔 종목이 바뀌거나 구간을 누르면 400ms 뒤에 알아서 돌았다. 그런데 이건 채널
   * 일흔 개를 텔레그램에서 통째로 끌어오는 조회다 — 보드에서 종목을 넘기며 훑기만 해도
   * 넘길 때마다 그게 돌았다. 무거운 일은 **사람이 시작을 눌러야** 맞다.
   *
   * 대신 무엇으로 찾을지가 바뀌면 「다시 찾기」라고 알려 준다 — 눌러야 하는 걸 모르면
   * 안 도는 게 고장으로 보인다.
   */
  const [ran, setRan] = useState<{ words: string; minutes: number } | null>(saved?.ran ?? null);
  const wordKey = words.join(",");
  const stale = ran !== null && (ran.words !== wordKey || ran.minutes !== minutes);

  /* 입력이 바뀔 때마다 모듈 기억을 갱신 — 탭을 떠나도 남는다 */
  useEffect(() => {
    const m = searchMemory.get(memKey) ?? { extra: "", minutes: 720, result: null, ran: null, pending: null };
    searchMemory.set(memKey, { ...m, extra, minutes, result, ran });
  }, [memKey, extra, minutes, result, ran]);

  /** 지금 어디까지 훑었나 — 검색이 도는 동안만 물어본다 */
  const [prog, setProg] = useState<{ done: number; total: number; name: string } | null>(null);

  /**
   * 실제 조회 — 결과는 **모듈 기억에도** 적는다. 화면이 내려간 사이에 끝나도
   * 결과가 살아 있고, 돌아오면 그대로 보인다.
   */
  const runFetch = (w: string, m: number) => {
    setBusy(true);
    setProg(null);
    setAi(null);
    const mem = searchMemory.get(memKey);
    if (mem) searchMemory.set(memKey, { ...mem, pending: { words: w, minutes: m } });
    fetch(`/api/channels/search?q=${encodeURIComponent(w)}&minutes=${m}`)
      .then((r) => r.json() as Promise<Result>)
      .then((j) => {
        const cur = searchMemory.get(memKey);
        if (cur) searchMemory.set(memKey, { ...cur, result: j, ran: { words: w, minutes: m }, pending: null });
        setResult(j);
        setRan({ words: w, minutes: m });
      })
      .catch(() => {
        const cur = searchMemory.get(memKey);
        if (cur) searchMemory.set(memKey, { ...cur, pending: null });
        setResult(null);
      })
      .finally(() => {
        setBusy(false);
        setProg(null);
      });
  };

  const run = () => {
    if (words.length === 0 || busy) return;
    runFetch(wordKey, minutes);
  };

  /*
   * 다시 올라왔을 때 **하다 만 검색을 잇는다.**
   * pending 이 남아 있으면 그 검색어로 다시 부른다 — 서버가 아직 훑는 중이면
   * 같은 inflight 에 붙고, 이미 끝났으면 3분 캐시라 그 자리에서 결과가 온다.
   * 어느 쪽이든 진행바(busy)와 결과가 자연스럽게 이어진다.
   */
  useEffect(() => {
    const pend = searchMemory.get(memKey)?.pending;
    if (pend) runFetch(pend.words, pend.minutes);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [memKey]);

  useEffect(() => {
    if (!busy) return;
    let alive = true;
    const tick = () => {
      fetch("/api/channels/search-progress")
        .then((r) => r.json() as Promise<{ running: boolean; done: number; total: number; name: string }>)
        .then((p) => {
          if (!alive) return;
          setProg(p.running && p.total > 0 ? { done: p.done, total: p.total, name: p.name } : null);
        })
        .catch(() => {
          /* 진행 상황을 못 받아도 검색 자체는 돈다 */
        });
    };
    tick();
    const t = setInterval(tick, 600);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, [busy]);

  /*
   * ⚠️ 예전엔 찾을 말이 없으면 안내문만 내고 **입력창까지 통째로 숨겼다.**
   * 보드에선 종목이 늘 있으니 몰랐는데, 텔레그램 동향의 「검색」 탭처럼 종목 없이
   * 열면 **키워드를 넣을 자리가 없어** 시작조차 못 했다. 입력창은 늘 그린다.
   */
  return (
    <div className="cs">
      {words.length === 0 && (
        <div className="page-note">
          찾을 말을 쉼표로 넣으세요 — 종목이든 테마든 (예: <b>유리기판, 전력기기</b>).
          구독 중인 채널 전체에서 그 말이 든 글을 찾아 줍니다.
        </div>
      )}
      <div className="filter-row">
        <span className="st-cfg-k">구간</span>
        {WINDOWS.map((w) => (
          <button
            key={w.min}
            className={`filter-btn ${minutes === w.min ? "active" : ""}`}
            onClick={() => setMinutes(w.min)}
          >
            {w.label}
          </button>
        ))}
      </div>

      <div className="cs-q">
        <input
          className="search-input"
          placeholder="키워드 더 넣기 — 쉼표로 구분 (예: 수주, 증설)"
          value={extra}
          onChange={(e) => setExtra(e.target.value)}
        />
      </div>

      {/* 무엇으로 찾고 있는지 보인다 — 안 보이면 왜 안 걸리는지 알 수가 없다 */}
      <div className="cs-words">
        {words.map((w) => (
          <span className="cs-word" key={w}>
            {w}
          </span>
        ))}
      </div>

      {/*
        찾기 버튼 — **이게 있어야 이 칸을 띄워 놓을 수 있다.**
        저절로 돌면 종목을 넘길 때마다 채널 일흔 개를 다시 끌어온다.
      */}
      <div className="filter-row">
        <button className="filter-btn primary" disabled={busy || words.length === 0} onClick={run}>
          {busy ? "훑는 중…" : ran ? "다시 찾기" : "채널에서 찾기"}
        </button>
        {stale && !busy && (
          <span className="cs-stale">찾을 말이 바뀌었습니다 — 다시 눌러 주세요</span>
        )}
        {result && !busy && (
          <span className="pt-n">
            원문 {result.scanned.toLocaleString("ko-KR")}건 중 {result.hits.length}건
          </span>
        )}
      </div>

      {/*
        진행바 — 채널 일흔 개를 도는 동안 어디까지 왔는지.
        「훑는 중」만 띄우면 멈춘 건지 도는 건지 알 수가 없다.
      */}
      {busy && (
        <div className="cs-prog">
          <div className="cs-prog-bar">
            <i style={{ width: prog && prog.total > 0 ? `${(prog.done / prog.total) * 100}%` : "6%" }} />
          </div>
          <span className="cs-prog-t">
            {prog && prog.total > 0
              ? `${prog.done} / ${prog.total} · ${prog.name}`
              : "채널 목록을 받는 중…"}
          </span>
        </div>
      )}

      <div className="filter-row">
        <button
          className="filter-btn"
          disabled={aiBusy || !result || result.hits.length === 0}
          onClick={() => {
            setAiBusy(true);
            setAi(null);
            fetch(
              `/api/channels/search-ai?q=${encodeURIComponent(words.join(","))}&minutes=${minutes}`,
              { method: "POST" },
            )
              .then((r) => r.json())
              .then((j) => setAi(j))
              .catch((e: Error) => setAi({ text: null, model: null, error: e.message }))
              .finally(() => setAiBusy(false));
          }}
          title="걸린 글을 AI 가 몇 줄로 줄입니다 (호출당 비용)"
        >
          {aiBusy ? "정리 중…" : "AI 로 정리"}
        </button>
        <span className="pt-n">
          {result ? `${result.hits.length}건을 줄입니다` : ""}
        </span>
      </div>

      {ai?.error && <div className="error-banner">{ai.error}</div>}
      {ai?.text && (
        <div className="cs-ai">
          <div className="cs-ai-h">
            <b>AI 정리</b>
            {ai.model && <span className="pt-n">{ai.model}</span>}
          </div>
          <div className="cs-ai-b">{mark(ai.text, words)}</div>
          <div className="table-note">
            ⚠️ <b>원문을 대신하지 않습니다.</b> AI 는 숫자를 잘못 옮기고 뉘앙스를 지웁니다 —
            눈에 걸리는 게 있으면 아래 원문을 보세요.
          </div>
        </div>
      )}

      {result?.error && <div className="error-banner">{result.error}</div>}

      {result && !result.error && (
        <>
          <div className="table-note">
            원문 <b>{result.scanned.toLocaleString("ko-KR")}건</b> 중{" "}
            <b>{result.hits.length}건</b>이 걸렸습니다.
          </div>
          <div className="cs-list">
            {result.hits.map((h) => (
              <div className="cs-item" key={`${h.channelId}-${h.messageId}`}>
                <div className="cs-head">
                  <b>{h.channelName}</b>
                  <span className="pt-n">{stamp(h.at)}</span>
                  {h.matched.map((m) => (
                    <span className="cs-hit" key={m}>
                      {m}
                    </span>
                  ))}
                  {h.link && (
                    <a className="cs-link" href={h.link} target="_blank" rel="noreferrer">
                      원문
                    </a>
                  )}
                </div>
                <div className="cs-text">{mark(h.text, words)}</div>
              </div>
            ))}
            {result.hits.length === 0 && (
              <div className="empty">
                이 구간에서는 언급이 없습니다. 구간을 넓혀 보세요.
              </div>
            )}
          </div>
        </>
      )}

      <div className="table-note">
        채널 원문을 <b>그대로</b> 보여줍니다 — AI 정리가 아닙니다. 정리본에는 안 뽑힌 종목도
        여기서는 걸립니다. 같은 구간은 <b>3분간</b> 다시 안 읽습니다(채널 일흔여 개를 훑는
        조회라 자주 부르면 텔레그램이 막습니다).
      </div>
    </div>
  );
}
