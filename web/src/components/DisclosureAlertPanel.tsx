import { useEffect, useState } from "react";
import { api, type DisclosureAlertConfig, type DisclosureHit } from "../api";

/**
 * 관심종목 공시 알림.
 *
 * 공시는 **뉴스보다 빠르고 확실하다.** 유상증자·수주·실적은 기사로 나오기 전에 DART 에
 * 먼저 뜬다. 그런데 하루 2,000건이 쏟아지니 사람이 지켜볼 수가 없다.
 *
 * 판정은 「캘린더 > 오늘 공시」와 **같은 기준**을 쓴다 — 같은 규칙을 두 곳에 적으면
 * 언젠가 어긋난다.
 */

const WEIGHT_CHOICES = [
  { v: 0, label: "안 보냄" },
  { v: 9, label: "매우 높음만" },
  { v: 8, label: "높음 이상" },
  { v: 6, label: "보통 이상" },
];

export function DisclosureAlertPanel() {
  const [cfg, setCfg] = useState<DisclosureAlertConfig | null>(null);
  const [intervals, setIntervals] = useState<number[]>([]);
  const [ready, setReady] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [hits, setHits] = useState<DisclosureHit[] | null>(null);

  async function load() {
    try {
      const r = await api.disclosureAlert();
      setCfg(r.config);
      setIntervals(r.intervals);
      setReady(r.telegramReady);
    } catch (e) {
      setError(e instanceof Error ? e.message : "불러오기 실패");
    }
  }

  useEffect(() => {
    void load();
  }, []);

  async function save(patch: Partial<DisclosureAlertConfig>) {
    if (!cfg) return;
    setError(null);
    try {
      const r = await api.disclosureAlertSave({ ...cfg, ...patch });
      setCfg(r.config);
    } catch (e) {
      setError(e instanceof Error ? e.message : "저장 실패");
    }
  }

  async function run(send: boolean) {
    setBusy(send ? "send" : "test");
    setNote(null);
    setHits(null);
    try {
      const r = await api.disclosureAlertRun(send);
      setHits(r.hits);
      setNote(
        r.error ??
          `전체 ${r.scanned}건 · 보낼 것 ${r.matched}건` +
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

  return (
    <>
      <p className="page-note">
        관심종목·내 태그 종목에 <b>새 공시가 뜨면 바로</b> 텔레그램으로 보냅니다. 공시는
        뉴스보다 빠르고 확실합니다 — 유상증자·수주·실적은 기사로 나오기 전에 DART 에 먼저
        뜹니다. 같은 공시를 두 번 보내지 않습니다.
      </p>

      {error && <div className="error-banner">{error}</div>}

      {!ready && (
        <div className="alert-note">
          <b>텔레그램 방이 설정되지 않았습니다.</b> 미니PC 에서{" "}
          <code>node scripts/telegram-chatid.mjs</code> 를 돌려 채팅 ID 를 찾고,{" "}
          <code>.env</code> 에 <code>TELEGRAM_CHAT_ID_DISCLOSURE=…</code> 를 넣은 뒤 서버를
          재시작하세요. 설정 전에는 켜도 발송되지 않습니다.
        </div>
      )}

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
            DART 는 인증키당 하루 20,000건 · 5분 주기로 돌려도 6% 밖에 안 씁니다
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
        </div>
      </div>

      <div className="tg-ctl">
        <span className="tg-ctl-label">보낼 것</span>
        <div className="tg-ctl-body">
          <button
            className={`filter-btn ${cfg.watchedOnly ? "active" : ""}`}
            onClick={() => void save({ watchedOnly: !cfg.watchedOnly })}
          >
            ⭐ 관심종목
          </button>
        </div>
      </div>

      <div className="tg-ctl">
        <span className="tg-ctl-label">그 밖</span>
        <div className="tg-ctl-body">
          {WEIGHT_CHOICES.map((w) => (
            <button
              key={w.v}
              className={`filter-btn ${cfg.marketWeightMin === w.v ? "active" : ""}`}
              onClick={() => void save({ marketWeightMin: w.v })}
            >
              {w.label}
            </button>
          ))}
          <span className="tg-ctl-hint">
            내 종목이 아니어도 상장폐지·유상증자처럼 <b>되돌리기 어려운 사건</b>은 시장 전체에
            영향이 있습니다
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
          <span className="tg-ctl-hint">
            공시는 장 마감 뒤에도 올라오므로 19시까지 두는 게 낫습니다
          </span>
        </div>
      </div>

      <div className="filter-row">
        <button className="algo-run-btn" onClick={() => void run(false)} disabled={busy !== null}>
          {busy === "test" ? "훑는 중…" : "지금 훑어보기 (발송 안 함)"}
        </button>
        <button
          className="filter-btn"
          onClick={() => void run(true)}
          disabled={busy !== null || !ready}
        >
          {busy === "send" ? "발송 중…" : "지금 훑고 발송"}
        </button>
      </div>

      {note && <div className="alert-note">{note}</div>}

      {hits && hits.length > 0 && (
        <div className="dart-list" style={{ marginTop: 8 }}>
          {hits.map((h) => (
            <div className="dart-row hot" key={h.event.url}>
              <div className="dart-head">
                <span className="news-tag watch">{h.reason}</span>
                <span className="dart-name">{h.event.corpName}</span>
                <span className="pt-n">{h.event.market}</span>
                {h.event.amended && <span className="dart-amend">정정</span>}
              </div>
              <a className="dart-title" href={h.event.url} target="_blank" rel="noreferrer">
                {h.event.title}
              </a>
            </div>
          ))}
        </div>
      )}

      {hits && hits.length === 0 && !error && <div className="empty">보낼 공시가 없습니다.</div>}

      <div className="table-note">
        코스피·코스닥의 <b>주요사항보고·발행공시</b>만 봅니다(정기보고서 제외). 판정은
        「캘린더 &gt; 오늘 공시」와 같은 기준입니다. 접수번호로 중복을 막으며 최근 1,500건을
        기억합니다.
      </div>
    </>
  );
}
