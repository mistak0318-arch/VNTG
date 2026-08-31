import { useEffect, useState } from "react";
import { useSheetBack } from "../useSheetBack";
import { api, type SuperDetail, type ThemeSeries } from "../api";
import { MiniLine } from "./MiniLine";

/**
 * 슈퍼신호등 종목 상세 (2026-08-26) — 대시보드에서 행을 눌렀을 때.
 *
 * 묻는 것 네 가지를 위에서 아래로 늘어놓는다:
 *   ① 편입 후 주가가 시장·**테마** 대비 어떻게 갔나 (상대 수익률, 편입일 = 0%)
 *   ② 신호등 점수는 어떻게 흘러갔나 (일별 기록 — 편입 이후만 존재한다)
 *   ③ 수급은 누가 사고 있었나 (외인·기관 누적 순매수)
 *   ④ 이탈 기록과 내 메모
 *
 * ①의 세 번째 선은 원래 **업종**이었는데 테마로 바꿨다 (2026-08-27).
 * 「화학」 한 칸에 화장품·이차전지·정유가 같이 들어가는 분류라, 업종 대비
 * 어떻다는 말이 이 종목에 대해 아무것도 알려 주지 않았다.
 */

const LEVEL_KO: Record<string, string> = { green: "🟢 초록", yellow: "🟡 노랑", red: "🔴 빨강" };

function ymdShort(d: string): string {
  // 20260826 → 8/26
  return d.length === 8 ? `${Number(d.slice(4, 6))}/${Number(d.slice(6, 8))}` : d;
}

/** 범례에 쓸 이름 — 어느 쪽 테마인지가 이름만큼 중요하다 */
function themeLabel(t: ThemeSeries): string {
  return `${t.name} (${t.kind === "custom" ? "내 테마" : t.kind === "naver" ? "네이버 테마" : "키움"})`;
}

/** 테마 지수의 전일 대비 — 마지막 두 점에서 낸다 */
function themeRate(t: ThemeSeries): number | null {
  const n = t.series.length;
  if (n < 2) return null;
  const prev = t.series[n - 2].close;
  return prev > 0 ? ((t.series[n - 1].close - prev) / prev) * 100 : null;
}

function themeHint(t: ThemeSeries): string {
  const how = t.used < t.total ? `시가총액 상위 ${t.used}종목` : `${t.used}종목`;
  return `${how}의 동일가중 평균입니다 (테마엔 지수가 없어 구성종목으로 만듭니다)`;
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
  /** 본창을 개별종목분석 화면으로 옮긴다 (2026-09-01 이전엔 상세 모달이었다) */
  onOpenStock?: (code: string, name: string) => void;
  /** 이탈·메모 저장 뒤 목록을 다시 읽게 */
  onChanged?: () => void;
}) {
  /* 뒤로가기로 닫힌다 — 폰에서 시트를 열고 뒤로 누르면 페이지가 넘어갔다 (2026-08-28) */
  useSheetBack(true, onClose);
  const [data, setData] = useState<SuperDetail | null>(null);
  /**
   * 테마 지수 — 비교선 세 번째.
   *
   * **따로 받는다.** 테마엔 지수가 없어 구성종목 일봉으로 만드는 값이라(최대 8콜)
   * 상세 응답에 실으면 시트가 그만큼 늦게 열린다. 선 하나가 뒤늦게 그려지는 편이 낫다.
   */
  const [theme, setTheme] = useState<ThemeSeries | null>(null);
  /** ETF 뒷배 비교선 — 네 번째 선. 뒷배 점수와 같은 규칙으로 고른 ETF 하나다 */
  const [etf, setEtf] = useState<Awaited<ReturnType<typeof api.signalSuperEtf>>["etf"]>(null);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState("");
  /** 펼쳐 놓은 메모(날짜) — 그날 상황 브리핑이 아래로 열린다 */
  const [openNote, setOpenNote] = useState<string | null>(null);
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
        /*
         * 메모 칸은 **오늘 것만** 채운다 (2026-08-27 이력화) — 어제 메모를 칸에
         * 미리 넣어 두면 오늘 저장할 때 어제 글이 오늘 날짜로 복제된다.
         * 지난 메모는 아래 이력에서 읽는다.
         */
        const notes = d.entry.notes ?? [];
        const last = notes[notes.length - 1];
        const today = new Date(Date.now() + 9 * 3600_000).toISOString().slice(0, 10);
        setNote(last && last.date === today ? last.text : "");
      })
      .catch((e) => alive && setError(e instanceof Error ? e.message : "불러오기 실패"));
    /* 테마 지수는 뒤따라온다 — 못 받아도 나머지 화면은 그대로다 */
    setTheme(null);
    api
      .signalSuperTheme(code)
      .then((r) => alive && setTheme(r.theme))
      .catch(() => undefined);
    setEtf(null);
    api
      .signalSuperEtf(code)
      .then((r) => alive && setEtf(r.etf))
      .catch(() => undefined);
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
        /*
         * 세 번째 선은 **테마**다 (2026-08-27, 업종에서 교체).
         * 업종이었을 때는 「업종은 올랐는데 이 종목은」이 아무 뜻이 없었다 —
         * 「화학」 한 칸에 화장품·이차전지·정유가 같이 들어 있어서다.
         * 늦게 도착하므로(따로 받는다) 없으면 선 없이 그린다.
         */
        ...(theme && theme.series.length > 1
          ? [{ label: themeLabel(theme), color: "#c084fc", values: toRel(theme.series), dash: true }]
          : []),
        /*
         * 네 번째 선 — **ETF 뒷배** (2026-08-28). 테마선이 「같은 무리가 가는가」면
         * 이건 「그 무리에 실제로 돈을 태우는 상품이 가는가」다. 편입 점수의
         * ETF 뒷배 기준과 같은 규칙으로 고른 ETF 라 점수와 선이 같은 것을 본다.
         */
        ...(etf && etf.series.length > 1
          ? [
              {
                label: `${etf.name}${etf.weight !== null ? ` (비중 ${etf.weight.toFixed(1)}%)` : ""}`,
                color: "#4dd0e1",
                values: toRel(etf.series),
                dash: true,
              },
            ]
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

  /*
   * ── 점수 변동 사유 (2026-08-27) ──
   * 매일 기록에 실린 체크별 grade 를 전날과 견줘 「무엇 때문에 올랐고 무엇 때문에
   * 빠졌나」를 만든다. 체크 내역은 이 기능이 생긴 날부터 쌓이므로, 그 전 날짜는
   * 사유 없이 점수만 남는다 — 과거로는 못 되짚는 값이다(신호등은 그날 데이터로만).
   */
  const reasons = (() => {
    const rows: { date: string; from: number; to: number; up: string[]; down: string[] }[] = [];
    for (let i = 1; i < daily.length; i += 1) {
      const a = daily[i - 1];
      const b = daily[i];
      if (!a.checks || !b.checks) continue;
      const prev = new Map(a.checks.map((c) => [c.l, c.g]));
      const up: string[] = [];
      const down: string[] = [];
      for (const c of b.checks) {
        if (!prev.has(c.l)) continue; // 기준이 바뀌어 새로 생긴 체크 — 변동으로 안 센다
        const pg = prev.get(c.l) ?? null;
        if (pg === c.g) continue;
        const s = (g: number | null) => (g === null ? "판단불가" : String(g));
        const line = `${c.l} ${s(pg)}→${s(c.g)}`;
        if ((c.g ?? 0) > (pg ?? 0)) up.push(line);
        else down.push(line);
      }
      if (up.length === 0 && down.length === 0) continue;
      rows.push({ date: b.date, from: a.score, to: b.score, up, down });
    }
    return rows.reverse(); // 최신이 위 — 이력은 어제부터 읽는다
  })();

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
      setMsg("메모를 저장했습니다 — 이력에 쌓였습니다.");
      onChanged?.();
      // 이력이 바로 보여야 저장됐다는 걸 안다
      const d = await api.signalSuperDetail(code);
      setData(d);
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
              {/* 현재가(등락률) — 오늘 어떤지가 첫 물음 (2026-08-27) */}
              {data.now && data.now.price !== null && (
                <span>
                  현재가 <b>{data.now.price.toLocaleString("ko-KR")}원</b>
                  {data.now.changeRate !== null && (
                    <b className={data.now.changeRate >= 0 ? "positive" : "negative"}>
                      {" "}({data.now.changeRate > 0 ? "+" : ""}
                      {data.now.changeRate.toFixed(2)}%)
                    </b>
                  )}
                </span>
              )}
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
              {/* 테마 — 내 테마가 먼저다. 등락률은 지수의 마지막 두 점에서 낸다 */}
              {theme && themeRate(theme) !== null && (
                <span title={themeHint(theme)}>
                  {theme.kind === "custom" ? "내 테마" : theme.kind === "naver" ? "네이버 테마" : "키움 테마"} {theme.name}{" "}
                  <b className={themeRate(theme)! >= 0 ? "positive" : "negative"}>
                    {themeRate(theme)! > 0 ? "+" : ""}
                    {themeRate(theme)!.toFixed(2)}%
                  </b>
                </span>
              )}
            </div>

            {rel && (
              <section className="sd-block">
                <h3>편입 후 상대 수익률 — 시장·테마와 나란히</h3>
                <p className="pt-n sd-hint">
                  편입일 종가를 0% 로 놓고 그린다. 종목 혼자 오르는지, 장이 밀어주는지,{" "}
                  <b>테마가 같이 가는지</b>가 갈린다.
                  {etf ? ` ETF선은 「${etf.name}」 — 이 종목을 테마로 가장 많이 담은 ETF입니다(신호등 ETF 뒷배와 같은 기준).` : ""}
                  {theme
                    ? ` 테마선은 「${themeLabel(theme)}」 — ${themeHint(theme)}.`
                    : " 테마선은 잠시 뒤에 붙습니다."}
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
              {/* 왜 움직였나 — 체크별 판정을 전날과 견준 이력. 트래킹의 핵심이다 */}
              {reasons.length > 0 && (
                <div className="sd-why">
                  <h4>점수 변동 사유</h4>
                  {reasons.map((r) => (
                    <div className="sd-why-row" key={r.date}>
                      <b>{r.date.slice(5)}</b>
                      <span
                        className={`num ${r.to > r.from ? "positive" : r.to < r.from ? "negative" : ""}`}
                      >
                        {r.from}→{r.to}점
                      </span>
                      <span className="sd-why-items">
                        {r.up.map((t) => (
                          <i className="sd-why-up" key={t}>
                            ▲ {t}
                          </i>
                        ))}
                        {r.down.map((t) => (
                          <i className="sd-why-down" key={t}>
                            ▼ {t}
                          </i>
                        ))}
                      </span>
                    </div>
                  ))}
                </div>
              )}
              {reasons.length === 0 && daily.length >= 2 && (
                <p className="pt-n sd-hint">
                  점수 변동 사유는 2026-08-27 부터 체크 내역을 함께 적어 만들어집니다 —
                  내일 기록부터 「무엇 때문에 올랐고 빠졌는지」가 여기 쌓입니다.
                </p>
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
              {/* 이력 — 덮어쓰지 않는다. 그날 무엇을 보고 추적하려 했는지가 복기의 전부다.
                  줄을 누르면 **그날의 상황 브리핑**(주가·점수·시장·수급·체크)이 펼쳐진다 */}
              {(entry.notes ?? []).length > 0 && (
                <div className="sd-note-hist">
                  {[...(entry.notes ?? [])].reverse().map((n, i) => {
                    const open = openNote === n.date;
                    /* 그날의 기록을 이미 받아 둔 것에서 찾는다 — 추가 조회 없음 */
                    const di = daily.findIndex((d) => d.date === n.date);
                    const d = di >= 0 ? daily[di] : null;
                    const prev = di > 0 ? daily[di - 1] : null;
                    const ymd = n.date.replace(/-/g, "");
                    const fl = data.flows.find((f) => f.date === ymd) ?? null;
                    const since =
                      d && entry.addedPrice > 0 && d.close > 0
                        ? ((d.close - entry.addedPrice) / entry.addedPrice) * 100
                        : null;
                    const dayChg =
                      d && prev && prev.close > 0 && d.close > 0
                        ? ((d.close - prev.close) / prev.close) * 100
                        : null;
                    const byGrade = (g: number) =>
                      (d?.checks ?? []).filter((c) => c.g === g).map((c) => c.l);
                    const p = (v: number | null) =>
                      v === null ? "-" : `${v > 0 ? "+" : ""}${v.toFixed(1)}%`;
                    return (
                      <div key={`${n.date}-${i}`}>
                        <button
                          type="button"
                          className={`sd-note-row sd-note-click${open ? " open" : ""}`}
                          onClick={() => setOpenNote(open ? null : n.date)}
                          title="눌러서 그날 상황 보기"
                        >
                          <b>{n.date.slice(5)}</b> {n.text}
                          <i className="sd-note-caret">{open ? "▴" : "▾"}</i>
                        </button>
                        {open && (
                          <div className="sd-note-ctx">
                            {d ? (
                              <>
                                <div>
                                  주가 <b>{d.close > 0 ? d.close.toLocaleString("ko-KR") : "-"}</b>
                                  <span className={`num ${since !== null && since >= 0 ? "positive" : "negative"}`}>
                                    {" "}편입 대비 {p(since)}
                                  </span>
                                  {dayChg !== null && (
                                    <span className={`num ${dayChg >= 0 ? "positive" : "negative"}`}>
                                      {" "}· 그날 {p(dayChg)}
                                    </span>
                                  )}
                                </div>
                                <div>
                                  신호등 <b>{LEVEL_KO[d.level] ?? d.level} {d.score}점</b>
                                  {prev && prev.score !== d.score && (
                                    <span className="pt-n"> (전일 {prev.score}점에서)</span>
                                  )}
                                  {d.market && (
                                    <>
                                      {" "}· 시장{" "}
                                      <b>
                                        {LEVEL_KO[d.market.level] ?? d.market.level} {d.market.score}점
                                      </b>
                                    </>
                                  )}
                                </div>
                                {fl && (
                                  <div>
                                    수급{" "}
                                    <span className={`num ${fl.foreign >= 0 ? "positive" : "negative"}`}>
                                      외인 {(fl.foreign / 100).toFixed(1)}억
                                    </span>{" "}
                                    ·{" "}
                                    <span className={`num ${fl.inst >= 0 ? "positive" : "negative"}`}>
                                      기관 {(fl.inst / 100).toFixed(1)}억
                                    </span>
                                  </div>
                                )}
                                {(d.checks ?? []).length > 0 && (
                                  <div className="sd-note-checks">
                                    {byGrade(100).length > 0 && (
                                      <span className="positive">충족 {byGrade(100).join("·")}</span>
                                    )}
                                    {byGrade(50).length > 0 && (
                                      <span> 절반 {byGrade(50).join("·")}</span>
                                    )}
                                    {byGrade(0).length > 0 && (
                                      <span className="negative"> 미충족 {byGrade(0).join("·")}</span>
                                    )}
                                  </div>
                                )}
                              </>
                            ) : (
                              <div className="pt-n">
                                그날의 일별 기록이 없습니다 — 기록은 평일 15:45 실행이 쌓습니다
                                (주말이거나 기록 기능 이전의 메모).
                              </div>
                            )}
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
              )}
              <textarea
                className="sd-note"
                rows={3}
                placeholder="오늘 메모 — 왜 걸렸고, 무엇을 추적하려는지. 날짜와 함께 이력으로 쌓입니다"
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
