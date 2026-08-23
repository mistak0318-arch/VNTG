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

export function ChannelSearchPanel({ code, name }: { code?: string; name?: string }) {
  const [minutes, setMinutes] = useState(720);
  /** 사람이 더 넣은 말 (쉼표) */
  const [extra, setExtra] = useState("");
  const [result, setResult] = useState<Result | null>(null);
  const [busy, setBusy] = useState(false);
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

  useEffect(() => {
    if (words.length === 0) {
      setResult(null);
      return;
    }
    let alive = true;
    setBusy(true);
    const t = setTimeout(() => {
      fetch(
        `/api/channels/search?q=${encodeURIComponent(words.join(","))}&minutes=${minutes}`,
      )
        .then((r) => r.json() as Promise<Result>)
        .then((j) => alive && setResult(j))
        .catch(() => alive && setResult(null))
        .finally(() => alive && setBusy(false));
      // 글자를 칠 때마다 부르지 않는다 — 채널 일흔세 개를 훑는 조회다
    }, 400);
    return () => {
      alive = false;
      clearTimeout(t);
    };
  }, [words, minutes]);

  if (words.length === 0) {
    return (
      <div className="page-note">
        종목을 고르거나 키워드를 넣으면 <b>채널에서 찾아 줍니다.</b> 지금 보고 있는 종목이
        어디서 언급되는지 보는 자리입니다.
      </div>
    );
  }

  return (
    <div className="cs">
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

      {busy && <div className="empty">채널을 훑는 중…</div>}
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
                <div className="cs-text">{h.text}</div>
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
