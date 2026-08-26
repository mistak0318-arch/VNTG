import { useCallback, useEffect, useState } from "react";
import { api, fmtNum, signClass, type MarketPulse, type PulseBrief } from "../api";

/**
 * 시장 맥박 — 「시장 흐름 분석」 맨 위.
 *
 * 이 화면의 다른 것들은 **무엇이 올랐나**를 본다. 여기는 **돈이 어디로 옮겨가고 있나**다.
 *
 * ## 순서에 뜻이 있다
 *
 * 1. **AI 판독** — 숫자를 다 읽고 나서야 보이는 것을 먼저 말해 준다
 * 2. **자금 국면** — 누가 끌고 있나
 * 3. **위험** — 이 판이 깨질 구석
 * 4. **바깥** — 밖에서 미는 것
 *
 * AI 는 **따로 부른다.** 숫자는 1분 캐시라 자주 열어도 되지만 AI 는 돈이 나가므로
 * 한 요청에 묶으면 화면을 열 때마다 요약이 돈다. 서버가 10분 캐시를 두고,
 * 국면·위험이 그대로면 다시 부르지도 않는다.
 */

function won(v: number): string {
  // 억 단위가 다섯 자리를 넘어가면 조로 읽는 게 빠르다
  if (Math.abs(v) >= 10000) return `${(v / 10000).toFixed(1)}조`;
  return `${fmtNum(v)}억`;
}

function signed(v: number): string {
  return `${v > 0 ? "+" : ""}${won(v)}`;
}

/** 연속 일수를 사람 말로 */
function streakText(n: number): string {
  if (n === 0) return "방향 없음";
  return n > 0 ? `${n}일 연속 순매수` : `${-n}일 연속 순매도`;
}

const PHASE_TONE: Record<string, string> = {
  bothIn: "good",
  foreignLed: "good",
  instLed: "mid",
  mixed: "mid",
  retailOnly: "bad",
  bothOut: "bad",
};

export function MarketPulsePanel({
  onSelectStock,
}: {
  /** 교차 신호의 종목을 눌렀을 때 — 본창 종목 상세 */
  onSelectStock?: (code: string, name: string) => void;
}) {
  const [pulse, setPulse] = useState<MarketPulse | null>(null);
  const [brief, setBrief] = useState<PulseBrief | null>(null);
  const [loading, setLoading] = useState(true);
  const [briefing, setBriefing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async (force = false) => {
    setLoading(true);
    setError(null);
    try {
      setPulse(await api.pulse(force));
    } catch (e) {
      setError(e instanceof Error ? e.message : "불러오지 못했습니다");
    } finally {
      setLoading(false);
    }
  }, []);

  const loadBrief = useCallback(async (force = false) => {
    setBriefing(true);
    try {
      setBrief(await api.pulseBrief(force));
    } catch {
      // 판독이 없어도 숫자는 그대로 봐야 한다
    } finally {
      setBriefing(false);
    }
  }, []);

  useEffect(() => {
    void load();
    void loadBrief();
  }, [load, loadBrief]);

  if (loading && !pulse) return <div className="empty">시장 맥박을 재는 중…</div>;
  if (error && !pulse) return <div className="error-banner">{error}</div>;
  if (!pulse) return null;

  const tone = PHASE_TONE[pulse.phase.key] ?? "mid";

  return (
    <div className="mp-wrap">
      {/* ---------------- AI 판독 ---------------- */}
      <section className="card mp-brief">
        <div className="mp-brief-head">
          <h2>지금 돈은 어디로</h2>
          <div className="mp-brief-actions">
            {brief?.model && <span className="pt-n">{brief.model}</span>}
            <button className="filter-btn" onClick={() => void loadBrief(true)} disabled={briefing}>
              {briefing ? "읽는 중…" : "↻ 다시 읽기"}
            </button>
          </div>
        </div>

        {briefing && !brief?.text && <div className="empty">판독하는 중…</div>}
        {brief?.error && (
          <div className="alert-note">
            판독을 못 했습니다 — {brief.error}
            {/* 실제로 겪은 원인이라 먼저 적는다 */}
            <br />
            <b>설정 &gt; 분석 기준 &gt; AI 모델</b>에서 「시장 흐름 요약」 모델을 바꿔 보세요.
          </div>
        )}
        {brief?.text && (
          <div className="mp-brief-body">
            {brief.text.split("\n").map((line, i) =>
              line.trim() === "" ? null : (
                <p key={i} dangerouslySetInnerHTML={{ __html: mdBold(line) }} />
              ),
            )}
          </div>
        )}
        <div className="table-note">
          숫자를 다시 읽어 주는 요약이 아니라 <b>그 숫자들이 겹쳐서 무슨 뜻인지</b>를 씁니다.
          맨 끝의 <b>「틀릴 조건」</b>이 이 판독의 핵심입니다 — 나중에 맞았는지 볼 수 있어야 훈련이 됩니다.
          매매 판단의 근거가 아닙니다.
        </div>
      </section>

      {/* ---------------- 자금 국면 ---------------- */}
      <section className="card">
        <h2>
          자금 국면
          {/* 표본이 얇으면 판정 옆에서 바로 말한다 (재검토 #1) — 라벨이 거짓말하면 안 된다 */}
          {pulse.days < 10 && <span className="mp-prov">표본 {pulse.days}일 — 잠정</span>}
        </h2>
        <div className="mp-phase">
          <span className={`mp-phase-tag ${tone}`}>{pulse.phase.label}</span>
          <span className="mp-phase-note">{pulse.phase.note}</span>
        </div>

        {/* 방향 전환이 있으면 국면 바로 밑에 — 국면 이름만으로는 안 보이는 것이다 */}
        {pulse.turn.turning && (
          <div className="alert-note mp-turn">
            <b>{pulse.turn.who} 방향 전환</b> — {pulse.turn.note}
          </div>
        )}

        <div className="mp-flow">
          {[
            { key: "외국인", d5: pulse.flow.foreign5, d20: pulse.flow.foreign20, st: pulse.flow.foreignStreak },
            { key: "기관", d5: pulse.flow.inst5, d20: pulse.flow.inst20, st: pulse.flow.instStreak },
            { key: "개인", d5: pulse.flow.individual5, d20: pulse.flow.individual20, st: null },
          ].map((r) => (
            <div className="mp-flow-item" key={r.key}>
              <div className="mp-flow-who">{r.key}</div>
              <div className={`mp-flow-5 ${signClass(r.d5)}`}>{signed(r.d5)}</div>
              {/* 실제 며칠치로 계산했는지를 라벨에 — 「20일」이 9일치면 그렇게 적는다 */}
              <div className="mp-flow-sub">
                20일{pulse.flow.days20 < 20 ? `(${pulse.flow.days20}일치)` : ""}{" "}
                <span className={signClass(r.d20)}>{signed(r.d20)}</span>
              </div>
              {r.st !== null && <div className="mp-flow-streak">{streakText(r.st)}</div>}
            </div>
          ))}
        </div>

        <div className="mp-diverge">
          <b>지수 vs 시장 폭</b> — {pulse.divergence.note}
          {pulse.divergence.indexMove !== null && (
            <span className="pt-n">
              {" "}
              (5일 지수 {pulse.divergence.indexMove.toFixed(2)}% · 상승비율{" "}
              {pulse.divergence.breadthMove !== null &&
                `${pulse.divergence.breadthMove > 0 ? "+" : ""}${pulse.divergence.breadthMove.toFixed(0)}%p`}
              )
            </span>
          )}
        </div>

        <div className="table-close-note table-note">
          5일 누적이 방향이고 <b>연속 일수가 그 방향의 힘</b>입니다. 둘이 어긋나면 위에
          「방향 전환」이 뜹니다 — 누적은 지나간 매수가 만든 것이고 지금 손은 반대로 가고 있다는 뜻입니다.
          {pulse.days < 10 && (
            <>
              {" "}
              <b>아직 {pulse.days}일치만 쌓였습니다.</b> 키움이 과거분을 안 주므로 소급이 안 되고,
              서버가 켜져 있는 동안 하루씩만 쌓입니다.
            </>
          )}
        </div>
      </section>

      {/* ---------------- 교차 신호 (재검토 #2) ---------------- */}
      {pulse.cross && (
        <section className="card">
          <h2>교차 신호 — 세 화면이 동시에 가리키는 종목</h2>
          <p className="page-note">
            <b>주도주 태그</b>(신고가·거래량급증·급등)와 <b>🌟 슈퍼신호등</b>에 동시에 걸린
            종목입니다. 업종 자금(최근 5일 외인+기관)까지 들어오고 있으면 「업종유입」이 붙습니다.
          </p>
          {pulse.cross.stocks.length === 0 ? (
            <div className="page-note">{pulse.cross.note}</div>
          ) : (
            <>
              <div className="mp-cross-note">{pulse.cross.note}</div>
              <div className="mp-cross">
                {pulse.cross.stocks.map((s) => (
                  <button
                    className="mp-cross-item"
                    key={s.code}
                    onClick={() => onSelectStock?.(s.code, s.name)}
                  >
                    <b>{s.name}</b>
                    <span className={`num ${signClass(s.changeRate)}`}>
                      {s.changeRate > 0 ? "+" : ""}
                      {s.changeRate.toFixed(2)}%
                    </span>
                    <span className="mp-cross-tags">
                      {s.tags.join(" · ")}
                      {s.sectorInflow && " · 업종유입"}
                    </span>
                    {s.sector && <span className="pt-n">{s.sector}</span>}
                  </button>
                ))}
              </div>
            </>
          )}
        </section>
      )}

      {/* ---------------- 위험 ---------------- */}
      <section className="card">
        <h2>이 판이 깨질 구석 ({pulse.risks.length})</h2>
        {pulse.risks.length === 0 ? (
          <div className="page-note">지금 눈에 띄는 위험 신호는 없습니다.</div>
        ) : (
          <div className="mp-risks">
            {pulse.risks.map((r) => (
              <div className={`mp-risk ${r.level}`} key={r.key}>
                <span className="mp-risk-label">{r.label}</span>
                <span className="mp-risk-detail">{r.detail}</span>
              </div>
            ))}
          </div>
        )}
        {pulse.signal && (
          <div className="mp-signal">
            <span className={`sig-dot big ${pulse.signal.level}`} />
            시장 신호등 <b>{pulse.signal.score}점</b>
            <span className="pt-n"> · {pulse.signal.summary}</span>
          </div>
        )}
      </section>

      {/* ---------------- 바깥 ---------------- */}
      <section className="card">
        <h2>바깥에서 미는 것</h2>
        <div className="mp-ext">
          {pulse.external.map((e) => (
            <div className="mp-ext-item" key={e.label}>
              <div className="mp-ext-label">{e.label}</div>
              <div className="mp-ext-value">
                {e.value}
                {e.changeRate !== null && (
                  <span className={`mp-ext-rate ${signClass(e.changeRate)}`}>
                    {e.changeRate > 0 ? "+" : ""}
                    {e.changeRate.toFixed(2)}%
                  </span>
                )}
              </div>
              {e.note && <div className="mp-ext-note">{e.note}</div>}
            </div>
          ))}
        </div>
        {pulse.basis !== null && (
          <div className="table-note">
            선물 베이시스 <b>{pulse.basis.toFixed(2)}</b> — 음수면 선물이 현물보다 싸다는 뜻이고,
            그 자리에서 프로그램 매도가 붙기 쉽습니다.
          </div>
        )}
        {/* 「못 봤다」와 「정상」을 가른다 (재검토 #1) — 값이 없으면 없다고 말한다 */}
        {pulse.basis === null && pulse.basisNote && (
          <div className="table-note">{pulse.basisNote}</div>
        )}
      </section>
    </div>
  );
}

/** `**굵게**` 만 살린다. 판독은 우리가 만든 프롬프트의 답이라 마크다운이 이것뿐이다 */
function mdBold(line: string): string {
  const escaped = line
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
  return escaped.replace(/\*\*(.+?)\*\*/g, "<b>$1</b>");
}
