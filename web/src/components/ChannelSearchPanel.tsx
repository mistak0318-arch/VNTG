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
  /** 실제로 닿은 가장 오래된 글 — 고른 구간보다 짧을 수 있다 (2026-09-05) */
  oldest?: string | null;
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
  /*
   * 긴 구간 (2026-09-05) — 창고가 생겨서 열 수 있게 됐다.
   * 예전엔 고를 수 있어도 그때그때 훑느라 실제로는 몇 시간치만 봤다.
   * 이제 검색은 창고만 읽으므로 한 달을 골라도 텔레그램을 안 부른다.
   */
  { min: 10_080, label: "1주" },
  { min: 20_160, label: "2주" },
  { min: 44_640, label: "한 달" },
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
 * **찾은 것을 남긴다** (2026-09-04).
 *
 * 벤티지: "채널에서 찾기 한 거 돌려놓고 다른 데 갔다왔더니 다 지워져버렸네. 히스토리 좀
 * 남게 해주면 안 되나. 다시 돌려야 되잖아."
 *
 * 위 `searchMemory` 는 **모듈 변수**라 탭을 옮기는 것은 견디지만 **새로고침에는 날아간다.**
 * 그런데 이 검색은 채널 일흔 곳을 텔레그램에서 통째로 끌어오는 무거운 조회다 —
 * 날아가면 돈과 시간이 다시 든다. 그래서 브라우저에 적어 둔다.
 *
 * 기기마다 다른 것이고 서버가 알 이유가 없어 `localStorage` 에만 둔다(동기화 설정 아님).
 * 결과가 크므로 **최근 여섯 판**만, 판마다 걸린 글 **여든 건**까지 남긴다 —
 * 저장이 꽉 차면 브라우저가 통째로 거절해서 하나도 안 남는다.
 */
/*
 * 열쇠에 판 번호가 붙어 있다 — **모양을 바꾸면 올린다.** 옛 판을 읽다 터지느니
 * 통째로 버리는 편이 낫다(어차피 다시 찾으면 되는 것이다). v1 은 2026-09-05 에
 * 버렸다: `hits` 없는 판이 저장돼 있으면 렌더가 터지고 스스로 안 낫는 고장이 됐다.
 */
const HIST_KEY = "vntg.chsearch.v2";
const HIST_MAX = 6;
/**
 * 판마다 남길 글 수. 80 → **40** 으로 줄였다 (2026-09-05).
 *
 * 채널 글은 한 건이 길다. 80건 × 6판이면 몇 MB 가 되고 `localStorage` 5MB 를 넘긴다 —
 * 넘기면 `setItem` 이 던지고, 그게 어제 검색이 통째로 안 보이던 사고의 방아쇠였을
 * 가능성이 가장 크다. 되살리기는 **어떤 검색이었나**를 다시 보는 것이라 40건이면 넉넉하다.
 * (전체는 「다시 찾기」로 받는다 — 그 사실을 화면이 적어 준다.)
 */
const HIST_HITS = 40;

interface HistEntry {
  /** 같은 검색인지 가리는 열쇠 — 검색어와 구간 */
  id: string;
  words: string[];
  minutes: number;
  /** 찾은 시각 (ISO) */
  at: string;
  result: Result;
}

function loadHist(): HistEntry[] {
  try {
    const raw = JSON.parse(localStorage.getItem(HIST_KEY) ?? "[]") as HistEntry[];
    if (!Array.isArray(raw)) return [];
    /*
     * ⚠️ **`hits` 가 배열인지까지 본다** (2026-09-05).
     *
     * 여태 `h.result` 가 있기만 하면 통과시켰다. 그런데 그리는 쪽은 `h.result.hits.length`
     * 를 읽는다 — 모양이 깨진 판이 하나라도 저장돼 있으면 **렌더가 통째로 터지고,
     * 그 판은 localStorage 에 남아 있으니 새로고침해도 계속 터진다.** 스스로 낫지 않는
     * 고장이라 「검색이 아예 안 된다」로 보인다.
     *
     * 읽을 때 거르면 나쁜 판이 저절로 빠진다.
     */
    return raw.filter(
      (h) => h && h.result && Array.isArray(h.result.hits) && Array.isArray(h.words) && h.words.length > 0,
    );
  } catch {
    return [];
  }
}

function saveHist(list: HistEntry[]): void {
  /*
   * 자리가 모자라면 **한 판씩 줄여 가며** 다시 해 본다. 예전엔 6판 → 1판 한 번만
   * 시도했는데, 1판도 클 수 있다(긴 글 40건). 끝까지 안 되면 **비운다** —
   * 옛 값을 남겨 두면 다음에 읽을 때 「저장은 됐다」고 오해하게 된다.
   */
  for (let n = Math.min(list.length, HIST_MAX); n >= 1; n -= 1) {
    try {
      localStorage.setItem(HIST_KEY, JSON.stringify(list.slice(0, n)));
      return;
    } catch {
      /* 다음 바퀴에서 더 줄인다 */
    }
  }
  try {
    localStorage.removeItem(HIST_KEY);
  } catch {
    /* 여기까지 막히면 브라우저가 저장을 통째로 막은 것이다 — 화면은 그대로 돈다 */
  }
}

/** 새 결과를 히스토리 맨 앞에. 같은 검색이면 갈아 끼운다 */
function pushHist(words: string[], minutes: number, result: Result): HistEntry[] {
  const id = `${words.join(",")}|${minutes}`;
  const trimmed: Result = { ...result, hits: result.hits.slice(0, HIST_HITS) };
  const entry: HistEntry = { id, words, minutes, at: new Date().toISOString(), result: trimmed };
  const next = [entry, ...loadHist().filter((h) => h.id !== id)].slice(0, HIST_MAX);
  saveHist(next);
  return next;
}

function agoText(iso: string): string {
  const m = Math.floor((Date.now() - new Date(iso).getTime()) / 60000);
  if (m < 1) return "방금";
  if (m < 60) return `${m}분 전`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}시간 전`;
  return `${Math.floor(h / 24)}일 전`;
}


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
  /* 새로고침에도 남는 최근 판들 — 누르면 조회 없이 그대로 되살린다 */
  /*
   * 한 번만 읽는다. 예전엔 `loadHist()` 를 초기값 셋에서 각각 불렀는데(세 번),
   * 저장된 판이 몇 MB 짜리라 첫 그림이 그만큼 늦었다. 같은 값이면 한 번이면 된다.
   */
  const first = useMemo(() => loadHist(), []);
  const [hist, setHist] = useState<HistEntry[]>(first);
  const [minutes, setMinutes] = useState(saved?.minutes ?? 720);
  /** 사람이 더 넣은 말 (쉼표) */
  const [extra, setExtra] = useState(saved?.extra ?? "");
  /*
   * 모듈 기억이 먼저, 없으면 **저장해 둔 맨 앞 판**을 되살린다 — 새로고침 뒤에도
   * 「다시 돌려야 되잖아」가 안 되게. 언제 찾은 것인지는 아래 줄이 적어 준다.
   */
  const [result, setResult] = useState<Result | null>(saved?.result ?? first[0]?.result ?? null);
  const [shownAt, setShownAt] = useState<string | null>(saved?.result ? null : (first[0]?.at ?? null));
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

        /*
         * ⚠️ **보여 주는 것이 먼저다** (2026-09-05 고침).
         *
         * 어제까지 `pushHist(...)` 가 이 줄들 **앞**에 있었다. 그래서 히스토리를 적다가
         * 한 번이라도 던지면 — 저장 공간이 찼거나, 응답에 `hits` 가 없거나 — 아래
         * `setResult(j)` 가 **아예 실행되지 않고** 바깥 `.catch` 로 빠져 결과가 null 이 됐다.
         * 검색은 제대로 돌았는데 화면에는 아무것도 안 뜬다. 벤티지: "어제 고친 이후로
         * 검색이 안 되네 아예."
         *
         * **곁다리가 본 일을 막으면 안 된다.** 결과를 먼저 세우고, 저장은 그다음에,
         * 그것도 제 안에서 조용히 실패하게 한다.
         */
        setResult(j);
        setRan({ words: w, minutes: m });

        /* 새로고침에도 남게 — 무거운 조회라 두 번 돌릴 이유가 없다. 실패해도 화면은 그대로 */
        if (!j.error && Array.isArray(j.hits)) {
          try {
            setHist(pushHist(w.split(","), m, j));
            setShownAt(null);
          } catch {
            /* 못 남겨도 이번 결과는 보인다 — 다음에 다시 찾으면 될 일이다 */
          }
        }
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

      {/*
        최근 찾기 (2026-09-04) — 누르면 **조회 없이** 그때 결과를 되살린다.
        채널 일흔 곳을 훑는 무거운 조회라, 이미 받아 둔 것을 다시 받을 이유가 없다.
        새로 받고 싶으면 되살린 뒤 「다시 찾기」를 누른다.
      */}
      {hist.length > 0 && (
        <div className="cs-hist">
          <span className="pt-n">최근 찾기</span>
          {hist.map((h) => (
            <button
              key={h.id}
              type="button"
              className={`cs-hist-btn${result && h.result === result ? " on" : ""}`}
              title={`${h.words.join(", ")} · ${h.result.hits?.length ?? 0}건 · ${agoText(h.at)}`}
              onClick={() => {
                setResult(h.result);
                setShownAt(h.at);
                setAi(null);
                setExtra(h.words.join(", "));
                setMinutes(h.minutes);
                setRan({ words: h.words.join(","), minutes: h.minutes });
              }}
            >
              {h.words[0]}
              {h.words.length > 1 ? ` +${h.words.length - 1}` : ""}
              <i>{h.result.hits?.length ?? 0}</i>
            </button>
          ))}
          <button
            type="button"
            className="cs-hist-clear"
            onClick={() => {
              saveHist([]);
              setHist([]);
            }}
            title="최근 찾기를 비웁니다"
          >
            비우기
          </button>
        </div>
      )}

      {result && !result.error && (
        <>
          <div className="table-note">
            원문 <b>{result.scanned.toLocaleString("ko-KR")}건</b> 중{" "}
            <b>{result.hits.length}건</b>이 걸렸습니다.
            {/*
              **고른 구간과 실제로 본 구간은 다를 수 있다** (2026-09-05).
              채널마다 가져오는 글 수에 상한이 있어서, 활발한 채널은 상한이 먼저 찬다.
              이걸 안 적어 두면 「3일을 골랐는데 안 나온다」가 고장으로 보인다.
            */}
            {(() => {
              const o = result.oldest;
              if (!o) return null;
              const reachedMin = (Date.now() - new Date(o).getTime()) / 60_000;
              if (!Number.isFinite(reachedMin) || reachedMin >= result.minutes * 0.8) return null;
              const h = reachedMin / 60;
              return (
                <>
                  {" "}
                  <b className="negative">
                    실제로는 {h < 1 ? `${Math.round(reachedMin)}분` : `${h.toFixed(h < 10 ? 1 : 0)}시간`}치까지만
                    닿았습니다
                  </b>{" "}
                  — 채널마다 가져오는 글 수에 상한이 있어, 글이 잦은 채널은 그 위로 못 올라갑니다.
                </>
              );
            })()}
            {shownAt && (
              <>
                {" "}
                — <b>{agoText(shownAt)}</b> 받아 둔 것입니다. 새로 보려면 「다시 찾기」.
              </>
            )}
          </div>

          {/*
            **0건은 고장이 아니다 — 그런데 고장처럼 보인다** (2026-09-05).

            벤티지: "로보티즈라고 검색했는데 하나도 안 나온다. 어제는 잘 나왔는데."
            그런데 같은 자리에서 「연준」·「금리」는 나왔다. 즉 수집도 매칭도 도는데
            **그 구간에 그 말이 없었을 뿐**이다 — 아침 12시간 창은 대개 간밤이고,
            그때 채널은 미국장 이야기를 하지 국내 개별종목 얘기는 잘 안 한다.
            원문 수까지 적어 두고도 「0건」만 크게 보이니 검색이 죽은 것으로 읽혔다.

            그래서 **0건일 때만** 왜 0인지 말하고, 넓히는 단추를 그 자리에 둔다.
            사람이 다음에 뭘 해야 하는지가 화면에 있어야 한다.
          */}
          {result.hits.length === 0 && result.scanned > 0 && (
            <div className="cs-empty">
              <b>이 구간에는 그 말이 없었습니다.</b>{" "}
              원문 {result.scanned.toLocaleString("ko-KR")}건을 다 봤지만{" "}
              <b>{(result.query ?? []).join(" · ")}</b> 가 안 나옵니다 — 검색이 멈춘 것이
              아니라 <b>안 나온 것</b>입니다.
              {(() => {
                const wider = WINDOWS.filter((w) => w.min > minutes);
                if (wider.length === 0) return null;
                return (
                  <span className="cs-empty-more">
                    구간을 넓혀 보세요:
                    {wider.map((w) => (
                      <button
                        key={w.min}
                        type="button"
                        className="filter-btn"
                        disabled={busy}
                        onClick={() => {
                          setMinutes(w.min);
                          runFetch(wordKey, w.min);
                        }}
                      >
                        {w.label}
                      </button>
                    ))}
                  </span>
                );
              })()}
            </div>
          )}
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
