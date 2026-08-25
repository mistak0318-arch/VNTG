import { useCallback, useEffect, useState } from "react";
import { api, fmtNum } from "../api";
import { WatchStar } from "../useWatchedCodes";

/**
 * 슈퍼신호등 — **여러 목록에 동시에 걸린 초록의 관찰 목록.**
 *
 * 신호등 찾기의 모집단이 일곱 가지가 되면서 나온 다음 물음: 목록 하나에 걸린
 * 초록보다 **셋 이상에 같이 걸린 초록**이 진짜 아닐까. 매일 15:45 서버가
 * 알아서 뽑아 담고, 여기서는 그 뒤를 따라간다 — 추적기의 상위판이다.
 *
 * 「며칠째」가 이 표의 심장이다. 하루 반짝 교집합과 사흘째 계속 걸리는 종목은
 * 다른 이야기다. 편입가 대비는 지금 스냅샷과 견줘 낸다.
 */

type Universe = { key: string; label: string };

interface Row {
  code: string;
  name: string;
  addedDate: string;
  addedPrice: number;
  score: number;
  lists: string[];
  seenCount: number;
  lastSeenDate: string;
  price: number | null;
  changeRate: number | null;
  sinceAdded: number | null;
}

function pct(v: number | null): string {
  if (v === null || !Number.isFinite(v)) return "-";
  return `${v > 0 ? "+" : ""}${v.toFixed(2)}%`;
}

function cls(v: number | null): string {
  if (v === null || v === 0) return "";
  return v > 0 ? "positive" : "negative";
}

export function SuperSignalPanel({
  onSelectStock,
}: {
  onSelectStock: (code: string, name: string) => void;
}) {
  const [rows, setRows] = useState<Row[] | null>(null);
  const [lastRun, setLastRun] = useState<string | null>(null);
  const [minLists, setMinLists] = useState(3);
  const [universes, setUniverses] = useState<Universe[]>([]);
  const [job, setJob] = useState<{ status: string; step: string; done: number; total: number; added: number; error?: string } | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(() => {
    api
      .signalSuper()
      .then((r) => {
        setRows(r.entries);
        setLastRun(r.lastRunDate);
        setMinLists(r.minLists);
      })
      .catch((e: Error) => setError(e.message));
  }, []);

  useEffect(() => {
    load();
    api
      .signalScreenUniverses()
      .then((r) => setUniverses(r.universes))
      .catch(() => undefined);
  }, [load]);

  /* 돌고 있으면 진행을 따라간다 — 끝나면 목록을 새로 받는다 */
  useEffect(() => {
    let alive = true;
    const tick = async () => {
      try {
        const j = await api.signalSuperJob();
        if (!alive) return;
        setJob(j.status === "running" ? j : null);
        if (j.status !== "running") return;
        setTimeout(() => void tick(), 1500);
      } catch {
        /* 못 물어도 다음에 */
      }
    };
    void tick();
    return () => {
      alive = false;
    };
  }, []);

  async function runNow() {
    setError(null);
    try {
      await api.signalSuperRun();
      const poll = async () => {
        const j = await api.signalSuperJob().catch(() => null);
        if (j?.status === "running") {
          setJob(j);
          setTimeout(() => void poll(), 1500);
        } else {
          setJob(null);
          if (j?.error) setError(j.error);
          load();
        }
      };
      void poll();
    } catch (e) {
      setError(e instanceof Error ? e.message : "실행 실패");
    }
  }

  const uniLabel = (k: string) => universes.find((u) => u.key === k)?.label ?? k;

  return (
    <div>
      <div className="filter-row ctl-ribbon">
        <span className="breadth-count">
          목록 <b>{minLists}곳 이상</b>에 걸린 <b>초록</b>만 · 매일 15:45 자동
          {lastRun && ` · 마지막 편입 ${lastRun}`}
        </span>
        <button className="filter-btn" onClick={() => void runNow()} disabled={job !== null}>
          {job ? "돌고 있음…" : "지금 돌리기"}
        </button>
      </div>

      {job && (
        <div className="pub-progress">
          <div className="pub-progress-head">
            <b>슈퍼신호등 — {job.step}</b>
            <span className="pub-progress-count">
              {job.done}/{job.total}
              {job.added > 0 && ` · 새로 ${job.added}`}
            </span>
            <span className="pub-spinner" aria-hidden="true" />
          </div>
        </div>
      )}

      {error && <div className="error-banner">{error}</div>}

      {rows === null ? (
        <div className="empty">불러오는 중…</div>
      ) : rows.length === 0 ? (
        <div className="page-note">
          아직 걸린 종목이 없습니다. 목록 {minLists}곳 이상 + 신호등 초록 — 문턱이 높은 게
          정상입니다. 「이날은 없었다」도 정보입니다.
        </div>
      ) : (
        <div className="data-table-wrap">
          <table className="data-table">
            <thead>
              <tr>
                <th className="sticky-col">종목명</th>
                <th title="며칠째 교집합에 걸렸나 — 지속이 곧 신호">며칠째</th>
                <th title="어느 목록들에 걸렸나">걸린 목록</th>
                <th>편입일</th>
                <th>편입가</th>
                <th>지금</th>
                <th title="편입가 대비">편입 대비</th>
                <th>점수</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.code} className="clickable-row" onClick={() => onSelectStock(r.code, r.name)}>
                  <td className="sticky-col">
                    <WatchStar code={r.code} />
                    {r.name}
                  </td>
                  <td className="num">
                    <b>{r.seenCount}일</b>
                    {r.lastSeenDate !== r.addedDate && (
                      <i className="pt-n"> ~{r.lastSeenDate.slice(5)}</i>
                    )}
                  </td>
                  <td>
                    <span className="ss-lists">
                      {r.lists.map((k) => (
                        <i className="ss-list" key={k}>
                          {uniLabel(k)}
                        </i>
                      ))}
                    </span>
                  </td>
                  <td className="pt-n">{r.addedDate.slice(5)}</td>
                  <td className="num">{fmtNum(r.addedPrice)}</td>
                  <td className={`num ${cls(r.changeRate)}`}>
                    {r.price === null ? "-" : fmtNum(r.price)}
                  </td>
                  <td className={`num ${cls(r.sinceAdded)}`}>
                    <b>{pct(r.sinceAdded)}</b>
                  </td>
                  <td className="num">{r.score}</td>
                  <td>
                    <button
                      className="row-del-btn"
                      onClick={(e) => {
                        e.stopPropagation();
                        void api.signalSuperRemove(r.code).then(load);
                      }}
                      title="관찰에서 빼기"
                    >
                      ✕
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <div className="table-note">
        일곱 목록(거래대금·등락률·누적등락률·외국인 연속·기관외국인 연속·동일순매매·장중
        기관)을 <b>각 300개 기준</b>으로 받아, <b>{minLists}곳 이상</b>에 등장하면서 신호등이{" "}
        <b>초록</b>인 종목만 담습니다. 짧은 목록(동일순매매 등)은 키움이 주는 만큼(100건
        안팎)입니다. 편입가는 편입일 값이고, 「지금」은 전종목 스냅샷이라 10분쯤 늦을 수
        있습니다.
      </div>
    </div>
  );
}
