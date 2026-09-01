import { useEffect, useState } from "react";
import { api, type KeywordConfig, type KeywordHit, type KeywordSource } from "../api";

/**
 * 내 관심 키워드.
 *
 * 「동향」은 **모아서 정리하는** 자리다 — 여러 채널이 겹친 주제를 하루 몇 번 보낸다.
 * 그런데 내 종목 얘기가 한 채널에만 떠도 그건 알아야 한다. 겹치기를 기다리면 늦는다.
 * 그래서 여기는 **거르지 않고 곧바로** 보낸다. 성격이 반대라 탭을 따로 뒀다.
 *
 * 키워드를 손으로 다 적게 하지 않는다 — 관심종목·내 테마는 이미 담아 둔 것이므로
 * 켜기만 하면 따라온다. 직접 등록은 종목이 아닌 것(정책·인물·제품명)에 쓴다.
 */

function stamp(iso: string): string {
  return new Date(new Date(iso).getTime() + 9 * 3600_000).toISOString().slice(5, 16).replace("T", " ");
}

export function KeywordAlertPanel() {
  const [cfg, setCfg] = useState<KeywordConfig | null>(null);
  const [words, setWords] = useState<KeywordSource[]>([]);
  const [intervals, setIntervals] = useState<number[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [hits, setHits] = useState<KeywordHit[] | null>(null);
  const [input, setInput] = useState("");

  async function load() {
    try {
      const r = await api.keywordConfig();
      setCfg(r.config);
      setWords(r.keywords);
      setIntervals(r.intervals);
    } catch (e) {
      setError(e instanceof Error ? e.message : "불러오기 실패");
    }
  }

  useEffect(() => {
    void load();
  }, []);

  async function save(patch: Partial<KeywordConfig>) {
    if (!cfg) return;
    setError(null);
    try {
      const r = await api.keywordSave({ ...cfg, ...patch });
      setCfg(r.config);
      setWords(r.keywords);
    } catch (e) {
      setError(e instanceof Error ? e.message : "저장 실패");
    }
  }

  async function run(send: boolean) {
    setBusy(send ? "send" : "test");
    setNote(null);
    setHits(null);
    try {
      const r = await api.keywordRun(send);
      setHits(r.hits);
      setNote(
        r.error
          ? r.error
          : `원본 ${r.scanned}건 · 걸림 ${r.matched}건` +
            (r.skipped > 0 ? ` · 이미 보낸 것 ${r.skipped}건 제외` : "") +
            (send ? ` · ${r.sent}건 발송` : " (미리보기 — 발송 안 함)"),
      );
    } catch (e) {
      setError(e instanceof Error ? e.message : "실패");
    } finally {
      setBusy(null);
    }
  }

  if (!cfg) return <div className="page-note">불러오는 중…</div>;

  const own = words.filter((w) => w.from === "직접");
  const auto = words.filter((w) => w.from !== "직접");

  return (
    <>
      <p className="page-note">
        구독 채널에 <b>내 키워드가 걸린 메시지</b>가 뜨면 바로 텔레그램으로 보냅니다.
        「동향」이 모아서 정리하는 자리라면 여기는 <b>놓치지 않는 자리</b>입니다. 같은 메시지를
        두 번 보내지 않으니, 주기를 짧게 잡아도 중복이 오지 않습니다.
      </p>

      {error && <div className="error-banner">{error}</div>}

      {/* 켜기 / 주기 */}
      <div className="tg-ctl">
        <span className="tg-ctl-label">알림</span>
        <div className="tg-ctl-body">
          <button
            className={`filter-btn ${cfg.enabled ? "active" : ""}`}
            onClick={() => void save({ enabled: !cfg.enabled })}
          >
            {cfg.enabled ? "켜짐" : "꺼짐"}
          </button>
          <span className="tg-ctl-hint">
            {cfg.enabled ? "설정한 주기로 자동 발송합니다" : "켜야 자동으로 돕니다"}
          </span>
        </div>
      </div>

      <div className="tg-ctl">
        <span className="tg-ctl-label">주기</span>
        <div className="tg-ctl-body">
          {intervals.map((m) => (
            <button
              key={m}
              className={`filter-btn ${cfg.intervalMin === m ? "active" : ""}`}
              onClick={() => void save({ intervalMin: m })}
            >
              {m}분
            </button>
          ))}
          <span className="tg-ctl-hint">
            훑는 구간은 주기의 두 배로 잡습니다 — 경계에 걸친 메시지를 놓치지 않게
          </span>
        </div>
      </div>

      <div className="tg-ctl">
        <span className="tg-ctl-label">시간대</span>
        <div className="tg-ctl-body">
          <input
            className="pt-input short"
            type="number"
            min={0}
            max={23}
            value={cfg.startHour}
            onChange={(e) => void save({ startHour: Number(e.target.value) })}
          />
          <span className="tg-ctl-hint">시 ~</span>
          <input
            className="pt-input short"
            type="number"
            min={1}
            max={24}
            value={cfg.endHour}
            onChange={(e) => void save({ endHour: Number(e.target.value) })}
          />
          <span className="tg-ctl-hint">시</span>
          <button
            className={`filter-btn ${cfg.weekdayOnly ? "active" : ""}`}
            onClick={() => void save({ weekdayOnly: !cfg.weekdayOnly })}
          >
            평일만
          </button>
          <span className="news-scope-sep" />
          <span className="tg-ctl-hint">한 번에 최대</span>
          <input
            className="pt-input short"
            type="number"
            min={1}
            max={30}
            value={cfg.maxPerRun}
            onChange={(e) => void save({ maxPerRun: Number(e.target.value) })}
          />
          <span className="tg-ctl-hint">건 — 쏟아지면 안 읽게 됩니다</span>
        </div>
      </div>

      {/* 어디서 키워드를 가져올지 */}
      <div className="tg-ctl">
        <span className="tg-ctl-label">자동 등록</span>
        <div className="tg-ctl-body">
          <button
            className={`filter-btn ${cfg.useWatchlist ? "active" : ""}`}
            onClick={() => void save({ useWatchlist: !cfg.useWatchlist })}
          >
            관심종목 (VNTG)
          </button>
          <button
            className={`filter-btn ${cfg.useThemes ? "active" : ""}`}
            onClick={() => void save({ useThemes: !cfg.useThemes })}
          >
            내 태그 이름
          </button>
          <span className="tg-ctl-hint">
            이미 담아 둔 것을 또 적을 이유가 없습니다 · 지금 {auto.length}개
          </span>
        </div>
      </div>

      {/* 직접 등록 */}
      <div className="tg-ctl">
        <span className="tg-ctl-label">직접 등록</span>
        <div className="tg-ctl-body">
          <input
            className="pt-input"
            placeholder="키워드 (예: 밸류업, 관세, 젠슨황)"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key !== "Enter") return;
              const w = input.trim();
              if (w.length < 2) return;
              void save({ keywords: [...cfg.keywords, w] });
              setInput("");
            }}
          />
          <button
            className="filter-btn"
            disabled={input.trim().length < 2}
            onClick={() => {
              void save({ keywords: [...cfg.keywords, input.trim()] });
              setInput("");
            }}
          >
            + 추가
          </button>
          <span className="tg-ctl-hint">
            두 글자 이상 · 종목이 아닌 것(정책·인물·제품명)에 씁니다
          </span>
        </div>
      </div>

      {own.length > 0 && (
        <div className="jn-tags" style={{ margin: "4px 0 10px" }}>
          {own.map((w) => (
            <button
              key={w.word}
              className="jn-tag on"
              onClick={() => void save({ keywords: cfg.keywords.filter((k) => k !== w.word) })}
              title="눌러서 빼기"
            >
              {w.word} ✕
            </button>
          ))}
        </div>
      )}

      <div className="filter-row">
        <button className="algo-run-btn" onClick={() => void run(false)} disabled={busy !== null}>
          {busy === "test" ? "훑는 중…" : "지금 훑어보기 (발송 안 함)"}
        </button>
        <button className="filter-btn" onClick={() => void run(true)} disabled={busy !== null}>
          {busy === "send" ? "발송 중…" : "지금 훑고 발송"}
        </button>
        <span className="tg-ctl-hint">전체 키워드 {words.length}개로 훑습니다</span>
      </div>

      {note && <div className="alert-note">{note}</div>}

      {hits && hits.length > 0 && (
        <div className="jn-trades" style={{ marginTop: 8 }}>
          {hits.map((h) => (
            <div className="kw-hit" key={h.key}>
              <div className="kw-hit-head">
                <span className="kw-word">🔔 {h.words.join(", ")}</span>
                <span className="pt-n">
                  {h.channelName} · {stamp(h.at)}
                </span>
                {h.link && (
                  <a className="link-btn" href={h.link} target="_blank" rel="noreferrer">
                    원문 →
                  </a>
                )}
              </div>
              <div className="chan-item-text">{h.text.slice(0, 300)}</div>
            </div>
          ))}
        </div>
      )}

      {hits && hits.length === 0 && !error && (
        <div className="empty">걸린 메시지가 없습니다.</div>
      )}

      <div className="table-note">
        같은 메시지는 <b>두 번 보내지 않습니다</b>(채널+메시지 ID로 판정, 최근 800건 기억).
        「지금 훑고 발송」으로 보낸 것도 기억하므로, 자동 발송이 그걸 다시 보내지 않습니다.
        채널 목록은 <b>채널 관리</b> 탭에서 켠 것을 그대로 씁니다.
      </div>
    </>
  );
}
