import { useCallback, useEffect, useState } from "react";
import { api, fmtNum, signClass, type LeaderFlow, type LeaderScan } from "../api";
import { LeaderScanPanel, LeaderTrackSection, MarkRow } from "../components/LeaderScanPanel";
import { SortableTh, useSortableTable } from "../useSortableTable";

/**
 * 주도주 — 단독 메뉴 (2026-09-08). 벤티지: "주도주 탐색 메뉴 좀만 더 손보면 단독 메뉴로도 쓸 수 있을 것 같은데."
 *
 * 마켓브리핑 안의 탭이었다. 신조 ②추세의 「판(섹터)의 폭과 연속성」 그 자체고 ⚡교차·항해일지 후보가
 * 여기서 나오는데 두 단계 아래 있었다. 오늘 한 장에서 「판의 흐름」으로 넓힌다.
 *
 *   오늘        — 강한 섹터 · 태그 카드 넷 · 걸린 종목 (표식 붙음, 장중 10분 자동 갱신)
 *   판의 흐름   — 날짜 × 섹터 격자. 가로로 「이어지나」, 세로로 「어제와 같은 판인가」
 *   조용한 후보 — 폭 60%↑ 섹터의 구성원 중 아직 안 움직인 놈 (4~8월 표본에서 이긴 자리)
 *   성적        — 그때 뽑은 게 그 뒤 어떻게 됐나
 */
type Tab = "today" | "flow" | "quiet" | "track";
const TABS: { key: Tab; label: string; hint: string }[] = [
  { key: "today", label: "오늘", hint: "강한 섹터 · 태그 카드 · 걸린 종목" },
  { key: "flow", label: "판의 흐름", hint: "날짜 × 섹터 격자 — 이어지는 판과 하루 반짝" },
  { key: "quiet", label: "조용한 후보", hint: "판은 도는데 아직 안 움직인 놈" },
  { key: "track", label: "성적", hint: "그때 뽑은 게 그 뒤 어떻게 됐나" },
];

const pct = (v: number) => `${v > 0 ? "+" : ""}${v.toFixed(2)}%`;

export function LeadersPage({ onSelectStock }: { onSelectStock?: (code: string, name: string) => void }) {
  const [tab, setTab] = useState<Tab>(() => {
    try {
      const t = sessionStorage.getItem("vntg.leaders.tab");
      return (TABS.some((x) => x.key === t) ? t : "today") as Tab;
    } catch {
      return "today";
    }
  });
  useEffect(() => {
    try {
      sessionStorage.setItem("vntg.leaders.tab", tab);
    } catch {
      /* 저장 못 해도 화면은 그대로 */
    }
  }, [tab]);

  return (
    <div className="page leaders-page">
      <div className="page-head">
        <h1>🏁 주도주</h1>
        <p className="page-sub">오늘 시장이 어디에 반응하는가 — 판(섹터)의 폭과 연속성. 뜨거운 것과 아직 조용한 것을 나란히.</p>
      </div>
      <div className="cis-tabs">
        {TABS.map((t) => (
          <button key={t.key} className={`cis-tab ${tab === t.key ? "on" : ""}`} onClick={() => setTab(t.key)} title={t.hint}>
            {t.label}
          </button>
        ))}
      </div>
      {tab === "today" && <LeaderScanPanel onSelectStock={onSelectStock} hideTrack />}
      {tab === "flow" && <FlowTab />}
      {tab === "quiet" && <QuietTab onSelectStock={onSelectStock} />}
      {tab === "track" && <LeaderTrackSection onSelectStock={onSelectStock} />}
    </div>
  );
}

/* ══════════════════════════════════════════ 판의 흐름 */

function FlowTab() {
  const [days, setDays] = useState(10);
  const [flow, setFlow] = useState<LeaderFlow | null>(null);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => {
    setFlow(null);
    api
      .leaderFlow(days)
      .then(setFlow)
      .catch((e: Error) => setErr(e.message));
  }, [days]);
  if (err) return <div className="error-banner">{err}</div>;
  if (!flow) return <div className="empty">기록을 읽는 중…</div>;
  if (flow.dates.length < 2) return <div className="empty">기록이 이틀은 있어야 흐름이 보입니다. 15:35에 하루 한 줄씩 쌓입니다.</div>;
  const dd = (d: string) => d.slice(5).replace("-", "/");
  const last = flow.dates[flow.dates.length - 1];
  const cellCls = (c: { picks: number; breadth: number | null }) =>
    c.picks === 0 ? "" : c.breadth === null ? "b-na" : c.breadth >= 80 ? "b4" : c.breadth >= 65 ? "b3" : c.breadth >= 50 ? "b2" : "b1";
  return (
    <section className="card">
      <h2>
        판의 흐름
        <span className="filter-row inline">
          {[10, 20, 40].map((n) => (
            <button key={n} className={`filter-btn ${days === n ? "active" : ""}`} onClick={() => setDays(n)}>
              {n}일
            </button>
          ))}
        </span>
      </h2>
      <div className="page-note">
        칸 = 그날 상위 섹터에 든 날. 색은 <b>폭</b>(오른 종목 비율, 09-08부터 기록). 가로로 읽으면 이어지는 판과 하루 반짝, 세로로 읽으면 오늘 판이 어제와 같은가(순환).
        굵은 줄은 오늘 상위이면서 사흘째 이상.
      </div>
      <div className="data-table-wrap ls-flow-wrap">
        <table className="data-table ls-flow">
          <thead>
            <tr>
              <th className="sticky-col">섹터</th>
              <th className="num" title="창 안에서 상위에 든 날 수">일수</th>
              {flow.dates.map((d) => (
                <th key={d} className={d === last ? "today" : ""}>
                  {dd(d)}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {flow.sectors.map((s) => (
              <tr key={s.name} className={s.today && s.streak >= 3 ? "ls-flow-strong" : s.today ? "ls-flow-today" : ""}>
                <td className="sticky-col">
                  {s.name}
                  {s.today && s.streak >= 2 && <i className="ls-streak">{s.streak}일째</i>}
                </td>
                <td className="num">{s.days}</td>
                {flow.dates.map((d) => {
                  const c = flow.cells[s.name]?.[d] ?? { picks: 0, breadth: null, rate: null };
                  return (
                    <td
                      key={d}
                      className={`ls-cell ${cellCls(c)}`}
                      title={c.picks > 0 ? `${d} · 뽑힌 ${c.picks}종목${c.breadth !== null ? ` · 폭 ${c.breadth}%` : ""}${c.rate !== null ? ` · 가중 ${pct(c.rate)}` : ""}` : `${d} · 상위 아님`}
                    >
                      {c.picks > 0 ? (c.breadth !== null ? `${c.breadth}` : "●") : ""}
                    </td>
                  );
                })}
              </tr>
            ))}
            <tr className="ls-flow-overlap">
              <td className="sticky-col">어제와 같은 판</td>
              <td />
              {flow.dates.map((d) => {
                const v = flow.overlap[d];
                return (
                  <td key={d} className="num" title="어제 상위 섹터 중 오늘도 상위인 비율 — 낮으면 순환, 높으면 지속">
                    {v === null || v === undefined ? "-" : `${v.toFixed(0)}%`}
                  </td>
                );
              })}
            </tr>
          </tbody>
        </table>
      </div>
    </section>
  );
}

/* ══════════════════════════════════════════ 조용한 후보 */

function QuietTab({ onSelectStock }: { onSelectStock?: (code: string, name: string) => void }) {
  const [data, setData] = useState<LeaderScan | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const load = useCallback(async () => {
    setLoading(true);
    try {
      setData(await api.leaderScan(false));
      setErr(null);
    } catch (e) {
      setErr(e instanceof Error ? e.message : "불러오지 못했습니다");
    } finally {
      setLoading(false);
    }
  }, []);
  useEffect(() => {
    void load();
  }, [load]);
  const rows = data?.quiet ?? [];
  const sort = useSortableTable<LeaderScan["quiet"] extends (infer T)[] | undefined ? T : never>(rows);
  type Row = (typeof rows)[number];
  const sectors = [...new Set(rows.map((r) => r.sector))];
  return (
    <section className="card">
      <h2>
        조용한 후보 ({rows.length})
        <button className="filter-btn" onClick={() => void load()} disabled={loading}>
          {loading ? "…" : "다시 훑기"}
        </button>
      </h2>
      <div className="page-note">
        <b>폭 60% 넘는 섹터</b>의 구성원(거래대금 상위 {data?.scanned ?? 200} 안) 중 오늘 <b>+3% 미만</b> · 신고가 아님 · 거래량 2배 미만. 판은 도는데 아직 안 움직인 놈이다 —
        4~8월 표본에서 이긴 자리가 「조용하고 아직 안 몰린」 쪽이었다. 신호등 점은 원장에 살아 있을 때만 붙고(없으면 ·), 이격은 5일선 대비.
        {sectors.length > 0 && <> 판: {sectors.join(" · ")}</>}
      </div>
      {err && <div className="error-banner">{err}</div>}
      {!data && !err && <div className="empty">거래대금 상위를 훑는 중…</div>}
      {data && rows.length === 0 && <div className="empty">폭 60% 넘는 판이 없거나, 그 판의 종목이 이미 다 움직였다.</div>}
      {rows.length > 0 && (
        <div className="data-table-wrap">
          <table className="data-table">
            <thead>
              <tr>
                <SortableTh columnKey="name" label="종목" accessor={(r: Row) => r.name} sort={sort} className="sticky-col" />
                <SortableTh columnKey="sector" label="판(섹터)" accessor={(r: Row) => r.sector} sort={sort} />
                <SortableTh columnKey="breadth" label="판 폭" accessor={(r: Row) => r.sectorBreadth} sort={sort} />
                <SortableTh columnKey="streak" label="판 며칠째" accessor={(r: Row) => r.sectorStreak ?? -1} sort={sort} thProps={{ title: "상위 섹터에 며칠째 드나. 「상위 아님」은 폭은 넓지만 오늘 상위 6개엔 못 든 판" }} />
                <SortableTh columnKey="rate" label="오늘" accessor={(r: Row) => r.changeRate} sort={sort} />
                <SortableTh columnKey="gap" label="5일선 이격" accessor={(r: Row) => r.ma5Gap ?? 99} sort={sort} />
                <SortableTh columnKey="tv" label="거래대금" accessor={(r: Row) => r.tradeValue} sort={sort} />
              </tr>
            </thead>
            <tbody>
              {sort.sorted.map((r) => (
                <tr key={r.code} className="clickable-row" onClick={() => onSelectStock?.(r.code, r.name)}>
                  <td className="sticky-col">
                    {r.name}
                    <MarkRow code={r.code} mark={r.mark} />
                  </td>
                  <td className="pt-n">{r.sector}</td>
                  <td className="num">
                    <span className={`ls-badge ${r.sectorBreadth >= 70 ? "ok" : "warn"}`}>{r.sectorBreadth.toFixed(0)}%</span>
                  </td>
                  <td className="num">{r.sectorStreak === null ? "-" : r.sectorStreak === 0 ? "상위 아님" : `${r.sectorStreak}일째`}</td>
                  <td className={`num ${signClass(r.changeRate)}`}>{pct(r.changeRate)}</td>
                  <td className={`num ${r.ma5Gap !== null && r.ma5Gap > 8 ? "negative" : ""}`} title={r.ma5Gap !== null && r.ma5Gap > 8 ? "이격 8% 넘음 — 조용하지 않다" : "5일선 대비"}>
                    {r.ma5Gap === null ? "-" : pct(r.ma5Gap)}
                  </td>
                  <td className="num">{fmtNum(r.tradeValue)}억</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <div className="table-note">
        이 표는 「살 것」이 아니라 「볼 것」이다. 사려면 항해일지의 체(잡주·신호등·경보)와 자리 조건을 그대로 지난다. 15:35에 이 표도 같이 기록돼 다음 달부터 뜨거운 쪽과 5·20일 성적을 나란히 낸다.
      </div>
    </section>
  );
}
