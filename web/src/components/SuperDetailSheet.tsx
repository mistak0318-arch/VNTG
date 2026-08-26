import { useEffect, useState } from "react";
import { api, type SuperDetail } from "../api";
import { MiniLine } from "./MiniLine";

/**
 * 슈퍼신호등 종목 상세 (2026-08-26) — 대시보드에서 행을 눌렀을 때.
 *
 * 묻는 것 네 가지를 위에서 아래로 늘어놓는다:
 *   ① 편입 후 주가가 시장·업종 대비 어떻게 갔나 (상대 수익률, 편입일 = 0%)
 *   ② 신호등 점수는 어떻게 흘러갔나 (일별 기록 — 편입 이후만 존재한다)
 *   ③ 수급은 누가 사고 있었나 (외인·기관 누적 순매수)
 *   ④ 이탈 기록과 내 메모
 */

const LEVEL_KO: Record<string, string> = { green: "🟢 초록", yellow: "🟡 노랑", red: "🔴 빨강" };

function ymdShort(d: string): string {
  // 20260826 → 8/26
  return d.length === 8 ? `${Number(d.slice(4, 6))}/${Number(d.slice(6, 8))}` : d;
}

export function SuperDetailSheet({
  code,
  name,
  onClose,
  onOpenStock,
  onChanged,
}: {
  code: string;
  name: string;
  onClose: () => void;
  /** 본창 종목 상세(StockDetail)를 띄운다 */
  onOpenStock?: (code: string, name: string) => void;
  /** 이탈·메모 저장 뒤 목록을 다시 읽게 */
  onChanged?: () => void;
}) {
  const [data, setData] = useState<SuperDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState("");
  const [exitNote, setExitNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    setData(null);
    setError(null);
    api
      .signalSuperDetail(code)
      .then((d) => {
        if (!alive) return;
        setData(d);
        setNote(d.entry.note ?? "");
      })
      .catch((e) => alive && setError(e instanceof Error ? e.message : "불러오기 실패"));
    return () => {
      alive = false;
    };
  }, [code]);

  const entry = data?.entry;
  const active = entry?.active !== false;

  /* ── ① 상대 수익률 — 날짜 합집합 위에 세 시리즈를 편입일 값 기준으로 정규화 ── */
  function relSeries() {
    if (!data) return null;
    const addedYmd = data.entry.addedDate.replace(/-/g, "");
    const dates = data.stock.map((p) => p.date);
    if (dates.length < 2) return null;
    const base = (rows: { date: string; close: number }[]): number | null => {
      const hit = rows.find((r) => r.date >= addedYmd);
      return hit ? hit.close : null;
    };
    const toRel = (rows: { date: string; close: number }[]): (number | null)[] => {
      const b = base(rows);
      const map = new Map(rows.map((r) => [r.date, r.close]));
      return dates.map((d) => {
        const v = map.get(d);
        return b && v ? ((v - b) / b) * 100 : null;
      });
    };
    return {
      labels: dates.map(ymdShort),
      markX: dates.findIndex((d) => d >= addedYmd),
      series: [
        { label: name, color: "var(--blue)", values: toRel(data.stock), width: 2.2 },
        { label: data.index.name, color: "var(--muted)", values: toRel(data.index.series), dash: true },
        ...(data.sector
          ? [{ label: data.sector.name, color: "#c084fc", values: toRel(data.sector.series), dash: true }]
          : []),
      ],
    };
  }

  /* ── ③ 수급 누적 — 편입일부터, 백만원 → 억 (÷100) ── */
  function flowSeries() {
    if (!data || data.flows.length < 2) return null;
    const addedYmd = data.entry.addedDate.replace(/-/g, "");
    let f = 0;
    let i2 = 0;
    const labels: string[] = [];
    const foreign: (number | null)[] = [];
    const inst: (number | null)[] = [];
    for (const r of data.flows) {
      if (r.date < addedYmd) continue; // 누적은 편입일부터 — 그 앞을 섞으면 물음이 흐려진다
      f += r.foreign / 100;
      i2 += r.inst / 100;
      labels.push(ymdShort(r.date));
      foreign.push(f);
      inst.push(i2);
    }
    if (labels.length < 2) return null;
    return {
      labels,
      series: [
        { label: "외국인 누적", color: "var(--blue)", values: foreign },
        { label: "기관 누적", color: "#f59e0b", values: inst },
      ],
    };
  }

  const rel = relSeries();
  const flows = flowSeries();
  const daily = entry?.daily ?? [];

  async function doExit() {
    if (!confirm(`${name} 을(를) 이탈 처리할까요? 기록은 남고 추적만 멈춥니다.`)) return;
    setBusy(true);
    try {
      await api.signalSuperExit(code, exitNote);
      setMsg("이탈 처리했습니다 — 기록이 남았습니다.");
      onChanged?.();
      const d = await api.signalSuperDetail(code);
      setData(d);
    } catch (e) {
      setMsg(e instanceof Error ? e.message : "실패");
    } finally {
      setBusy(false);
    }
  }

  async function saveNote() {
    setBusy(true);
    try {
      await api.signalSuperNote(code, note);
      setMsg("메모를 저장했습니다.");
      onChanged?.();
    } catch (e) {
      setMsg(e instanceof Error ? e.message : "실패");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="overlay" onClick={onClose}>
      <div className="sheet sd-sheet" onClick={(e) => e.stopPropagation()}>
        <div className="sheet-header">
          <h2>
            🌟 {name} <span className="pt-n">{code}</span>
            <span className={`sd-state ${active ? "on" : "off"}`}>{active ? "추적 중" : "이탈"}</span>
          </h2>
          {onOpenStock && (
            <button className="watch-btn" onClick={() => onOpenStock(code, name)} title="종목 상세 열기">
              📈
            </button>
          )}
          <button className="close-btn" onClick={onClose}>
            ✕
          </button>
        </div>

        {error && <div className="error-banner">{error}</div>}
        {!data && !error && <div className="empty">불러오는 중...</div>}

        {data && entry && (
          <>
            <div className="sd-facts">
              <span>
                편입 <b>{entry.addedDate}</b> · {entry.addedPrice.toLocaleString("ko-KR")}원 ·{" "}
                {entry.score}점
              </span>
              <span>
                교집합 <b>{entry.seenCount}일</b> · 목록 {entry.lists.length}곳
              </span>
              {data.signalNow && (
                <span>
                  지금 신호등 <b>{LEVEL_KO[data.signalNow.level] ?? data.signalNow.level}</b>{" "}
                  {data.signalNow.score}점
                </span>
              )}
              {data.marketNow && (
                <span>
                  시장 <b>{LEVEL_KO[data.marketNow.level] ?? data.marketNow.level}</b>{" "}
                  {data.marketNow.score}점
                </span>
              )}
              {data.sector && (
                <span>
                  업종 {data.sector.name}{" "}
                  <b className={data.sector.changeRate >= 0 ? "positive" : "negative"}>
                    {data.sector.changeRate > 0 ? "+" : ""}
                    {data.sector.changeRate.toFixed(2)}%
                  </b>
                </span>
              )}
            </div>

            {rel && (
              <section className="sd-block">
                <h3>편입 후 상대 수익률 — 시장·업종과 나란히</h3>
                <p className="pt-n sd-hint">
                  편입일 종가를 0% 로 놓고 그린다. 종목 혼자 오르는지, 장이 밀어주는지가 갈린다.
                </p>
                <MiniLine
                  series={rel.series}
                  labels={rel.labels}
                  height={180}
                  yFmt={(v) => `${v > 0 ? "+" : ""}${v.toFixed(0)}%`}
                  refY={0}
                  markX={rel.markX}
                  markXLabel="편입"
                />
              </section>
            )}

            <section className="sd-block">
              <h3>신호등 점수 흐름</h3>
              {daily.length >= 2 ? (
                <MiniLine
                  series={[
                    {
                      label: "점수",
                      color: "var(--green)",
                      values: daily.map((d) => d.score),
                      width: 2,
                    },
                  ]}
                  labels={daily.map((d) => d.date.slice(5))}
                  height={120}
                  yFmt={(v) => v.toFixed(0)}
                />
              ) : (
                <p className="pt-n sd-hint">
                  일별 점수는 매일 15:45 실행이 쌓는다 — 기록이 이틀 이상 모이면 여기 곡선이
                  생깁니다. (지금 {daily.length}일치)
                </p>
              )}
              {daily.length > 0 && (
                <div className="sd-daily-dots">
                  {daily.slice(-30).map((d) => (
                    <span
                      key={d.date}
                      className={`sd-dot ${d.level}`}
                      title={`${d.date} · ${d.score}점 · ${LEVEL_KO[d.level] ?? d.level}`}
                    />
                  ))}
                </div>
              )}
            </section>

            {flows && (
              <section className="sd-block">
                <h3>수급 — 편입일부터 누적 순매수 (억원)</h3>
                <MiniLine
                  series={flows.series}
                  labels={flows.labels}
                  height={140}
                  yFmt={(v) => v.toFixed(0)}
                  refY={0}
                />
              </section>
            )}

            {/* 일별 표 — 그래프는 흐름, 표는 값. 최근 15일 */}
            {(daily.length > 0 || data.flows.length > 0) && (
              <section className="sd-block">
                <h3>일별 기록</h3>
                <div className="data-table-wrap">
                  <table className="data-table">
                    <thead>
                      <tr>
                        <th>날짜</th>
                        <th>종가</th>
                        <th>편입 대비</th>
                        <th>점수</th>
                        <th>신호등</th>
                        <th>외인(억)</th>
                        <th>기관(억)</th>
                      </tr>
                    </thead>
                    <tbody>
                      {[...daily].reverse().slice(0, 15).map((d) => {
                        const ymd = d.date.replace(/-/g, "");
                        const fl = data.flows.find((f) => f.date === ymd);
                        const since =
                          entry.addedPrice > 0 && d.close > 0
                            ? ((d.close - entry.addedPrice) / entry.addedPrice) * 100
                            : null;
                        return (
                          <tr key={d.date}>
                            <td>{d.date.slice(5)}</td>
                            <td className="num">{d.close > 0 ? d.close.toLocaleString("ko-KR") : "-"}</td>
                            <td className={`num ${since === null ? "" : since >= 0 ? "positive" : "negative"}`}>
                              {since === null ? "-" : `${since > 0 ? "+" : ""}${since.toFixed(1)}%`}
                            </td>
                            <td className="num">{d.score}</td>
                            <td>{LEVEL_KO[d.level] ?? d.level}</td>
                            <td className={`num ${fl && fl.foreign >= 0 ? "positive" : "negative"}`}>
                              {fl ? (fl.foreign / 100).toFixed(1) : "-"}
                            </td>
                            <td className={`num ${fl && fl.inst >= 0 ? "positive" : "negative"}`}>
                              {fl ? (fl.inst / 100).toFixed(1) : "-"}
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              </section>
            )}

            {(entry.exits ?? []).length > 0 && (
              <section className="sd-block">
                <h3>이탈 기록</h3>
                {(entry.exits ?? []).map((x, i) => (
                  <div className="sd-exit" key={`${x.date}-${i}`}>
                    <b>{x.date}</b> · {x.price ? `${x.price.toLocaleString("ko-KR")}원` : "-"}
                    {x.score !== null && ` · ${x.score}점`}
                    {x.marketLevel && ` · 시장 ${LEVEL_KO[x.marketLevel] ?? x.marketLevel} ${x.marketScore ?? ""}점`}
                    {" — "}
                    {x.note}
                    {x.auto ? " (자동)" : ""}
                  </div>
                ))}
              </section>
            )}

            <section className="sd-block">
              <h3>메모</h3>
              <textarea
                className="sd-note"
                rows={3}
                placeholder="복기 메모 — 왜 걸렸고, 어떻게 흘러갔고, 배운 것"
                value={note}
                onChange={(e) => setNote(e.target.value)}
              />
              <div className="filter-row" style={{ marginTop: 6 }}>
                <button className="filter-btn" onClick={saveNote} disabled={busy}>
                  메모 저장
                </button>
                {active && (
                  <>
                    <input
                      className="search-input sd-exit-input"
                      placeholder="이탈 사유 (예: 시장 급락, 수급 이탈)"
                      value={exitNote}
                      onChange={(e) => setExitNote(e.target.value)}
                    />
                    <button className="filter-btn" onClick={doExit} disabled={busy}>
                      ⛔ 이탈 처리
                    </button>
                  </>
                )}
              </div>
              {msg && <div className="alert-note">{msg}</div>}
              <p className="pt-n sd-hint">
                이탈은 목록에서 지우지 않습니다 — 이탈 시점의 시장 상태와 함께 기록으로 남고,
                교집합에 다시 걸리면 자동으로 되살아납니다. 신호등이 이틀 연속 초록에서
                떨어지면 자동 이탈됩니다.
              </p>
            </section>
          </>
        )}
      </div>
    </div>
  );
}
