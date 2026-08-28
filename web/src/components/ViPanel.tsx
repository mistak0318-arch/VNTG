import { useEffect, useState } from "react";
import { fmtNum } from "../api";
import { SortableTh, useSortableTable } from "../useSortableTable";

/**
 * VI 발동/해제 — **오늘 어디가 튀었나.**
 *
 * ## 지금까지 없던 정보다
 *
 * VI(변동성완화장치)는 값이 급하게 튀면 걸리는 단일가 전환이다. 걸렸다는 것 자체가
 * **그 종목에 무슨 일이 났다**는 신호라, 종목을 찾는 자리에서 제일 빠른 단서다.
 * REST 에는 없었고 웹소켓 `1h` 로만 온다.
 *
 * ## 종목과 무관하다
 *
 * `1h` 는 종목을 지정해도 **전체 종목**이 온다. 그래서 이 칸은 보드에서 종목을
 * 안 따라간다 — 시장 신호등이나 상승·하락 종목수와 같은 층이다.
 *
 * ## 발동과 해제가 같은 줄로 온다
 *
 * 해제 시각이 채워져 있으면 해제다. 둘을 갈라 보여주지 않으면
 * 「지금 걸려 있는 것」과 「아까 걸렸다 풀린 것」이 섞여서 못 쓴다.
 */

interface ViEvent {
  at: string;
  code: string;
  name: string;
  kind: string;
  apply: string;
  price: number;
  base: number;
  market: string;
  firedAt: string;
  clearedAt: string;
}

function hhmm(t: string): string {
  return t.length >= 6 ? `${t.slice(0, 2)}:${t.slice(2, 4)}:${t.slice(4, 6)}` : t;
}

export function ViPanel({ onSelectStock }: { onSelectStock?: (c: string, n: string) => void }) {
  const [events, setEvents] = useState<ViEvent[] | null>(null);
  const [healthy, setHealthy] = useState(false);
  /** 걸린 것만 볼지 — 해제까지 섞이면 줄이 두 배가 된다 */
  const [firedOnly, setFiredOnly] = useState(true);

  useEffect(() => {
    let alive = true;
    const load = async () => {
      try {
        const r = await fetch("/api/realtime/vi?limit=120");
        const j = (await r.json()) as { healthy: boolean; events: ViEvent[] };
        if (!alive) return;
        setEvents(j.events ?? []);
        setHealthy(Boolean(j.healthy));
      } catch {
        if (alive) setEvents([]);
      }
    };
    void load();
    const t = setInterval(() => void load(), 5000);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, []);

  // 컬럼 정렬 — 모든 표 공통 규칙(2026-08-26). 훅이라 조기 return 앞에 둔다
  const rows = firedOnly ? (events ?? []).filter((e) => !e.clearedAt) : events ?? [];
  const sort = useSortableTable<ViEvent>(rows);

  if (events === null) return <div className="empty">불러오는 중…</div>;

  return (
    <div>
      <div className="filter-row">
        <button
          className={`filter-btn ${firedOnly ? "active" : ""}`}
          onClick={() => setFiredOnly((v) => !v)}
        >
          {firedOnly ? "발동만" : "발동+해제"}
        </button>
        <span className="pt-n">
          {healthy ? "실시간" : "끊김"} · 오늘 {events.length}건
        </span>
      </div>

      {rows.length === 0 ? (
        <div className="empty">
          {healthy
            ? "아직 걸린 종목이 없습니다."
            : "실시간이 안 붙어 있습니다 — 장 시간(평일 08:00~20:00)에만 들어옵니다."}
        </div>
      ) : (
        <div className="data-table-wrap">
          <table className="data-table num">
            <thead>
              <tr>
                <SortableTh columnKey="at" label="시각" accessor={(e: ViEvent) => e.at} sort={sort} className="sticky-col" />
                <SortableTh columnKey="name" label="종목" accessor={(e: ViEvent) => e.name} sort={sort} />
                <SortableTh columnKey="kind" label="구분" accessor={(e: ViEvent) => e.kind} sort={sort} />
                <SortableTh columnKey="price" label="발동가" accessor={(e: ViEvent) => e.price} sort={sort} />
                <SortableTh columnKey="base" label="기준가" accessor={(e: ViEvent) => e.base} sort={sort} />
                <SortableTh columnKey="gap" label="괴리" accessor={(e: ViEvent) => (e.base > 0 ? ((e.price - e.base) / e.base) * 100 : 0)} sort={sort} />
              </tr>
            </thead>
            <tbody>
              {sort.sorted.map((e, i) => {
                // 기준가 대비 얼마나 튀어서 걸렸나 — 이게 「얼마나 센 일인가」다
                const gap = e.base > 0 ? ((e.price - e.base) / e.base) * 100 : null;
                return (
                  <tr
                    key={`${e.code}-${e.firedAt}-${i}`}
                    className={onSelectStock ? "clickable-row" : ""}
                    onClick={() => onSelectStock?.(e.code, e.name)}
                  >
                    <td className="sticky-col">{hhmm(e.firedAt || e.at)}</td>
                    <td>{e.name || e.code}</td>
                    <td>
                      {/* ▲상방/▼하방 (2026-08-28) — 급등 VI 와 급락 VI 는 정반대 신호다 */}
                      {gap !== null && gap !== 0 && (
                        <b className={gap > 0 ? "positive" : "negative"}>
                          {gap > 0 ? "▲상방 " : "▼하방 "}
                        </b>
                      )}
                      {e.apply}
                      {e.clearedAt && <span className="pt-n"> 해제</span>}
                    </td>
                    <td>{fmtNum(e.price)}</td>
                    <td>{fmtNum(e.base)}</td>
                    <td className={gap === null ? "" : gap >= 0 ? "positive" : "negative"}>
                      {gap === null ? "-" : `${gap > 0 ? "+" : ""}${gap.toFixed(1)}%`}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      <div className="table-note">
        VI 는 값이 급하게 튀면 걸리는 <b>단일가 전환</b>입니다 — 걸렸다는 것 자체가 그 종목에
        무슨 일이 났다는 신호입니다. <b>괴리</b>는 기준가 대비 얼마나 튀어서 걸렸는지입니다.
        서버가 물고 있는 동안만 쌓이므로 <b>서버를 껐던 시간은 비어 있습니다</b>.
      </div>
    </div>
  );
}
