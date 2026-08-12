import { useEffect, useRef, useState } from "react";
import {
  api,
  fmtNum,
  FLOW_SUBJECTS,
  normalizeStockCode,
  signClass,
  type AlgoConfig,
  type AlgoJob,
  type AlgoResult,
  type FlowSubject,
} from "../api";
import { CollapsibleSection } from "../components/CollapsibleSection";
import { SortableTh, useSortableTable } from "../useSortableTable";
import { WatchStar } from "../useWatchedCodes";

type Category = FlowSubject | "trend";

const CANDIDATE_SORTS: { key: AlgoConfig["candidateSort"]; label: string }[] = [
  { key: "3", label: "거래대금" },
  { key: "1", label: "거래량" },
  { key: "2", label: "거래회전율" },
];

const PERIOD_CHOICES = [3, 5, 10, 20, 60];
const MA_CHOICES = [5, 10, 20, 60, 120];

const DEFAULT_CONFIG: AlgoConfig = {
  candidateSort: "3",
  topN: 100,
  periods: [5, 10, 20],
  maPeriods: [5, 20, 60, 120],
  requirePriceAboveMa: true,
  minChangeRate: null,
  maxChangeRate: null,
  minPrice: null,
  maxPrice: null,
};

function filterByCategory(results: AlgoResult[], cat: Category): AlgoResult[] {
  if (cat === "trend") return results.filter((r) => r.trendPass === true);
  return results.filter((r) => r.pass[cat]);
}

/** 숫자 입력 — 비우면 null(제한 없음) */
function NumField({
  label,
  value,
  onChange,
  placeholder,
}: {
  label: string;
  value: number | null;
  onChange: (v: number | null) => void;
  placeholder?: string;
}) {
  return (
    <label className="cfg-field">
      <span>{label}</span>
      <input
        type="number"
        value={value ?? ""}
        placeholder={placeholder ?? "제한 없음"}
        onChange={(e) => onChange(e.target.value === "" ? null : Number(e.target.value))}
      />
    </label>
  );
}

function Chips<T extends number | string>({
  options,
  selected,
  onToggle,
}: {
  options: T[];
  selected: T[];
  onToggle: (v: T) => void;
}) {
  return (
    <div className="cfg-chips">
      {options.map((o) => (
        <button
          key={String(o)}
          className={`cfg-chip${selected.includes(o) ? " on" : ""}`}
          onClick={() => onToggle(o)}
        >
          {o}
          {typeof o === "number" ? "일" : ""}
        </button>
      ))}
    </div>
  );
}

export function AlgoPicksPage({ onSelectStock }: { onSelectStock: (code: string, name: string) => void }) {
  const [config, setConfig] = useState<AlgoConfig>(DEFAULT_CONFIG);
  const [job, setJob] = useState<AlgoJob | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [category, setCategory] = useState<Category>("combined");
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    return () => {
      if (pollRef.current) clearInterval(pollRef.current);
    };
  }, []);

  function patch(p: Partial<AlgoConfig>) {
    setConfig((prev) => ({ ...prev, ...p }));
  }

  function toggleIn(list: number[], v: number): number[] {
    const next = list.includes(v) ? list.filter((x) => x !== v) : [...list, v];
    return next.length === 0 ? list : next.sort((a, b) => a - b); // 최소 1개는 유지
  }

  function runScan() {
    setError(null);
    setJob(null);
    api
      .algoScanStart(config)
      .then(({ jobId }) => {
        pollRef.current = setInterval(() => {
          api
            .algoScanStatus(jobId)
            .then((j) => {
              setJob(j);
              if (j.status !== "running" && pollRef.current) {
                clearInterval(pollRef.current);
                pollRef.current = null;
              }
            })
            .catch((err: Error) => {
              setError(err.message);
              if (pollRef.current) {
                clearInterval(pollRef.current);
                pollRef.current = null;
              }
            });
        }, 1500);
      })
      .catch((err: Error) => setError(err.message));
  }

  const running = job?.status === "running";
  const progressPct = job && job.total > 0 ? Math.round((job.done / job.total) * 100) : 0;
  const rows = job ? filterByCategory(job.results, category) : [];
  const sort = useSortableTable(rows);
  // 결과는 실행 당시 설정 기준으로 렌더링해야 컬럼이 어긋나지 않는다
  const runConfig = job?.config ?? config;

  const categories: { key: Category; label: string }[] = [
    ...FLOW_SUBJECTS.map((s) => ({ key: s.key as Category, label: s.short })),
    { key: "trend" as Category, label: "정배열" },
  ];

  return (
    <div>
      <CollapsibleSection title="알고리즘 조건 설정" defaultOpen={!job}>
        <div className="card">
          <div className="cfg-grid">
            <div className="cfg-block">
              <div className="cfg-label">후보 선정 기준</div>
              <div className="filter-row">
                {CANDIDATE_SORTS.map((s) => (
                  <button
                    key={s.key}
                    className={`filter-btn ${config.candidateSort === s.key ? "active" : ""}`}
                    onClick={() => patch({ candidateSort: s.key })}
                  >
                    {s.label}
                  </button>
                ))}
              </div>
              <NumField
                label="시장별 상위 N종목 (10~200)"
                value={config.topN}
                onChange={(v) => patch({ topN: v ?? 100 })}
                placeholder="100"
              />
            </div>

            <div className="cfg-block">
              <div className="cfg-label">수급 판정 기간 (선택한 기간이 모두 매수우위)</div>
              <Chips
                options={PERIOD_CHOICES}
                selected={config.periods}
                onToggle={(v) => patch({ periods: toggleIn(config.periods, v) })}
              />
            </div>

            <div className="cfg-block">
              <div className="cfg-label">정배열 기준 이평선</div>
              <Chips
                options={MA_CHOICES}
                selected={config.maPeriods}
                onToggle={(v) => patch({ maPeriods: toggleIn(config.maPeriods, v) })}
              />
              <label className="cfg-check">
                <input
                  type="checkbox"
                  checked={config.requirePriceAboveMa}
                  onChange={(e) => patch({ requirePriceAboveMa: e.target.checked })}
                />
                현재가가 최단기 이평선 위에 있을 것
              </label>
            </div>

            <div className="cfg-block">
              <div className="cfg-label">추가 필터</div>
              <div className="cfg-row">
                <NumField label="등락률 최소(%)" value={config.minChangeRate} onChange={(v) => patch({ minChangeRate: v })} />
                <NumField label="등락률 최대(%)" value={config.maxChangeRate} onChange={(v) => patch({ maxChangeRate: v })} />
              </div>
              <div className="cfg-row">
                <NumField label="주가 최소(원)" value={config.minPrice} onChange={(v) => patch({ minPrice: v })} />
                <NumField label="주가 최대(원)" value={config.maxPrice} onChange={(v) => patch({ maxPrice: v })} />
              </div>
            </div>
          </div>

          <div className="cfg-actions">
            <button className="filter-btn" onClick={() => setConfig(DEFAULT_CONFIG)} disabled={running}>
              기본값으로
            </button>
            <button className="refresh-btn algo-run-btn" onClick={runScan} disabled={running}>
              {running ? "분석 중..." : "조회"}
            </button>
          </div>

          <div className="algo-desc">
            코스피/코스닥 {CANDIDATE_SORTS.find((s) => s.key === config.candidateSort)?.label} 상위 각{" "}
            {config.topN}종목을 대상으로, 수급({config.periods.join("·")}일)과 정배열(
            {[...config.maPeriods].sort((a, b) => a - b).join("≥")}일선)을 계산합니다.
          </div>

          {error && <div className="error-banner">{error}</div>}

          {job && (
            <div className="algo-progress">
              <div className="progress-bar">
                <div className="progress-bar-fill" style={{ width: `${progressPct}%` }} />
              </div>
              <div className="table-note">
                {job.usedPreviousDay && "※ 장 시작 전이라 전일 거래 순위를 기준으로 후보를 뽑았습니다. "}
                {job.status === "running" && `분석 중: ${job.done}/${job.total}종목`}
                {job.status === "done" &&
                  `완료: ${job.total}종목 중 ` +
                    categories.map((c) => `${c.label} ${filterByCategory(job.results, c.key).length}`).join(" · ")}
                {job.status === "error" && `오류: ${job.error}`}
              </div>
            </div>
          )}
        </div>
      </CollapsibleSection>

      {job && job.status === "done" && (
        <>
          <div className="filter-row">
            {categories.map((c) => (
              <button
                key={c.key}
                className={`filter-btn ${category === c.key ? "active" : ""}`}
                onClick={() => setCategory(c.key)}
              >
                {c.label} ({filterByCategory(job.results, c.key).length})
              </button>
            ))}
          </div>

          {rows.length === 0 && <div className="empty">조건을 만족하는 종목이 없습니다.</div>}

          {rows.length > 0 && (
            <div className="data-table-wrap">
              <table className="data-table">
                <thead>
                  <tr>
                    <SortableTh columnKey="name" label="종목명" accessor={(r: AlgoResult) => r.name} sort={sort} className="sticky-col" />
                    <SortableTh columnKey="market" label="시장" accessor={(r: AlgoResult) => r.market} sort={sort} />
                    <SortableTh columnKey="curPrc" label="현재가" accessor={(r: AlgoResult) => r.curPrc} sort={sort} />
                    <SortableTh columnKey="fluRt" label="등락률" accessor={(r: AlgoResult) => r.fluRt} sort={sort} />
                    {category === "trend"
                      ? runConfig.maPeriods.map((p) => (
                          <SortableTh
                            key={p}
                            columnKey={`ma${p}`}
                            label={`${p}일선`}
                            accessor={(r: AlgoResult) => r.ma?.[String(p)] ?? 0}
                            sort={sort}
                          />
                        ))
                      : runConfig.periods.map((p) => (
                          <SortableTh
                            key={p}
                            columnKey={`net${p}`}
                            label={`${p}일순매매`}
                            accessor={(r: AlgoResult) => r.net[category as FlowSubject]?.[String(p)] ?? 0}
                            sort={sort}
                          />
                        ))}
                    <SortableTh columnKey="trend" label="정배열" accessor={(r: AlgoResult) => (r.trendPass ? 1 : 0)} sort={sort} />
                  </tr>
                </thead>
                <tbody>
                  {sort.sorted.map((r) => {
                    const code = normalizeStockCode(r.code);
                    return (
                      <tr key={r.code} onClick={() => onSelectStock(code, r.name)} className="clickable-row">
                        <td className="sticky-col">
                          <WatchStar code={code} />
                          {r.name}
                        </td>
                        <td>{r.market}</td>
                        <td>{fmtNum(r.curPrc)}</td>
                        <td className={signClass(r.fluRt)}>{fmtNum(r.fluRt)}%</td>
                        {category === "trend"
                          ? runConfig.maPeriods.map((p) => (
                              <td key={p}>{fmtNum(Math.round(r.ma?.[String(p)] ?? 0))}</td>
                            ))
                          : runConfig.periods.map((p) => {
                              const v = r.net[category as FlowSubject]?.[String(p)] ?? 0;
                              return (
                                <td key={p} className={signClass(v)}>
                                  {fmtNum(v)}
                                </td>
                              );
                            })}
                        <td>{r.trendPass === null ? "-" : r.trendPass ? "O" : ""}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
              <div className="table-note">단위: 원(가격) · 백만원(순매매) · 이동평균은 종가 기준</div>
            </div>
          )}
        </>
      )}

      {!job && (
        <div className="page-note">조건을 설정하고 "조회"를 누르세요. 종목 수에 따라 30초~2분 걸릴 수 있습니다.</div>
      )}
    </div>
  );
}
