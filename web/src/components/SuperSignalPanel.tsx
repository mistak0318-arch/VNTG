import { useCallback, useEffect, useState } from "react";
import { api, fmtNum } from "../api";
import { WatchStar } from "../useWatchedCodes";
import { SuperMark } from "../useSuperMarks";
import { useTabActive } from "../tabActive";
import { useMarketOpen } from "../useLive";
import { SortableTh, useSortableTable } from "../useSortableTable";

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
  /** 교집합에 걸린 날이 몇 번인가 — **편입 후 며칠이 아니다** */
  seenCount: number;
  lastSeenDate: string;
  /** 편입일로부터 며칠 — 편입 당일은 0 */
  daysSince?: number;
  /** 오늘 편입됐나 — N 배지 */
  isNew?: boolean;
  /** 추적 중인가 — 이탈하면 false */
  active?: boolean;
  price: number | null;
  changeRate: number | null;
  sinceAdded: number | null;
  returns?: { d1: number | null; d5: number | null; d20: number | null };
}

interface GradeRow {
  label: string;
  d1: { avg: number | null; n: number };
  d5: { avg: number | null; n: number };
  d20: { avg: number | null; n: number };
  /** 지수 대비 초과수익(%p) — 절대수익만으로는 좋은지 나쁜지 모른다 */
  ex1?: { avg: number | null; n: number };
  ex5?: { avg: number | null; n: number };
  ex20?: { avg: number | null; n: number };
  /** 승률(%) — 평균과 같이 봐야 뜻이 산다 */
  win1?: { rate: number | null; n: number };
  win20?: { rate: number | null; n: number };
}

/** %p — 초과수익은 퍼센트포인트다. %와 섞이면 둘 다 못 읽는다 */
function pp(v: number | null | undefined): string {
  if (v === null || v === undefined || !Number.isFinite(v)) return "-";
  return `${v > 0 ? "+" : ""}${v.toFixed(2)}%p`;
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
  /*
   * **이탈분은 기본으로 안 보인다** (2026-08-31 — "슈퍼신호등에 걸렸던 애들
   * 신호등 찾기 서브탭에 계속 남아있네").
   *
   * 이 화면은 「지금 뭘 보고 있나」를 묻는 자리다 — 이탈한 종목이 섞이면
   * 그 물음의 답이 흐려진다. 이탈 후 추적은 **슈퍼신호등 대시보드**의 몫이고,
   * 거기는 반대로 이탈 포함이 기본이다(같은 자료를 다른 물음으로 본다).
   */
  const [showExited, setShowExited] = useState(false);
  const [grade, setGrade] = useState<GradeRow[]>([]);
  const [lastRun, setLastRun] = useState<string | null>(null);
  const [minLists, setMinLists] = useState(3);
  const [universes, setUniverses] = useState<Universe[]>([]);
  const [job, setJob] = useState<{ status: string; step: string; done: number; total: number; added: number; error?: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const tabActive = useTabActive();
  const marketOpen = useMarketOpen();
  /* 이탈분을 걸러 낸 뒤 정렬한다 — 순서를 매기는 대상 자체가 달라져야 한다 */
  const visible = (rows ?? []).filter((r) => showExited || r.active !== false);
  /* 머리 클릭 정렬 — 훅이라 조기 return 앞에 둔다 (rows 가 없으면 빈 배열) */
  const sort = useSortableTable<Row>(visible);

  const load = useCallback(() => {
    api
      .signalSuper()
      .then((r) => {
        setRows(r.entries);
        setGrade((r as { grade?: GradeRow[] }).grade ?? []);
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

  /*
   * 시세 갱신 (2026-08-28 — "당일 시세가 실시간 반영이 안 된다").
   *
   * 마운트 때 한 번만 받고 있었다. 열어 두고 보는 표인데 값이 그 시점에서 멈춰
   * 있으면 **지난 시세로 판단하게 된다** — 편입가 대비도 같이 굳는다.
   * 값 자체는 서버가 전종목 스냅샷에서 붙이므로 다시 부르면 최신이다.
   *
   * 장중 20초 · 장 밖 2분. 탭이 뒤에 있으면 쉰다 — 탭 상한을 없앤 뒤로 화면이
   * 전부 살아 있어서, 이 게이트가 없으면 안 보는 표까지 계속 폴링한다.
   */
  useEffect(() => {
    const tick = () => {
      if (document.visibilityState !== "visible") return;
      if (!tabActive) return;
      load();
    };
    const t = setInterval(tick, marketOpen ? 20_000 : 120_000);
    return () => clearInterval(t);
  }, [load, marketOpen, tabActive]);

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
        {/*
          이탈분 보기 — **기본은 끔.** 이 화면은 「지금 뭘 보고 있나」를 묻는
          자리라 이탈한 종목이 섞이면 답이 흐려진다. 이탈 후 추적은
          슈퍼신호등 대시보드가 맡는다(거기는 반대로 포함이 기본이다).
        */}
        <button
          className={`filter-btn ${showExited ? "active" : ""}`}
          onClick={() => setShowExited((v) => !v)}
          title="이탈한 종목까지 볼지 — 이탈 후 성적은 슈퍼신호등 대시보드에 있습니다"
        >
          이탈 포함 {showExited ? "켬" : "끔"}
        </button>
        {(rows ?? []).some((r) => r.active === false) && !showExited && (
          <span className="breadth-count">
            이탈 {(rows ?? []).filter((r) => r.active === false).length}종목 숨김
          </span>
        )}
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

      {grade.some((g) => g.d1.n > 0 || g.d5.n > 0 || g.d20.n > 0) && (
        <div className="ss-grade">
          <div className="ss-grade-title">
            편입 후 성적 <i>— 편입가 대비 평균, ( ) 안은 표본 수</i>
          </div>
          {/*
            정의를 밝힌다 (2026-08-31 점검). 편입 15:45 시점에 NXT 애프터마켓이
            열려 있어 매수 자체는 가능하다 — 다만 별도 호가라 종가와 값이 다르다.
            그 차이를 안 적으면 「종가에 샀다면」이 「종가에 샀다」로 읽힌다.
          */}
          <div className="table-note">
            편입가는 <b>편입일 종가</b>입니다. 편입 시각(15:45)에는 NXT 애프터마켓이
            열려 있어 매수는 가능하지만 <b>애프터마켓은 별도 호가라 종가와 값이
            다릅니다</b> — 「종가에 샀다면」이라는 근삿값으로 읽으세요.
          </div>
          <table className="data-table ss-grade-table">
            <thead>
              <tr>
                <th>가르는 축</th>
                <th className="num">표본</th>
                <th className="num">1일</th>
                <th className="num">5일</th>
                <th className="num">20일</th>
                {/*
                  지수 대비 — **이 열이 이 표의 핵심**이다 (2026-08-31).
                  「1일 -0.13%」가 나쁜 건지는 그날 시장을 알아야 답할 수 있다.
                */}
                <th className="num ss-grade-key" title="같은 날짜 코스피를 뺀 값(%p) — 「남보다 나았나」">
                  지수 대비 1일
                </th>
                <th className="num ss-grade-key">지수 대비 20일</th>
                <th className="num" title="추세추종은 승률이 낮고 손익비가 높은 것이 정상입니다 — 평균과 같이 보세요">
                  승률 1일
                </th>
              </tr>
            </thead>
            <tbody>
              {grade.map((g) => {
                const n = Math.max(g.d1.n, g.d5.n, g.d20.n);
                /* 표본이 적으면 흐리게 — 세 건으로 낸 평균이 눈에 세게 박히면 안 된다 */
                return (
                  <tr key={g.label} className={n < 5 ? "ss-thin" : g.label === "전체" ? "ss-base" : ""}>
                    <td>{g.label}</td>
                    <td className="num">{n}</td>
                    {([g.d1, g.d5, g.d20] as const).map((h, i) => (
                      <td key={i} className={`num ${cls(h.avg)}`}>
                        {h.avg === null ? "-" : <b>{pct(h.avg)}</b>}
                      </td>
                    ))}
                    {([g.ex1, g.ex20] as const).map((h, i) => (
                      <td key={`x${i}`} className={`num ss-grade-key ${cls(h?.avg ?? null)}`}>
                        {h?.avg == null ? "-" : <b>{pp(h.avg)}</b>}
                      </td>
                    ))}
                    <td className="num">
                      {g.win1?.rate == null ? "-" : `${g.win1.rate.toFixed(0)}%`}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {rows === null ? (
        <div className="empty">불러오는 중…</div>
      ) : visible.length === 0 ? (
        /*
         * ⚠️ `rows` 가 아니라 `visible` 을 본다 — 전부 이탈한 상태에서 이탈을
         * 숨기면 표만 텅 비고 「왜 없지」에 답이 없다.
         */
        <div className="page-note">
          {rows.length > 0 ? (
            <>
              추적 중인 종목이 없습니다 — {rows.length}종목 모두 이탈했습니다.
              위의 <b>이탈 포함 켬</b>으로 지난 것을 볼 수 있습니다.
            </>
          ) : (
            <>
              아직 걸린 종목이 없습니다. 목록 {minLists}곳 이상 + 신호등 초록 — 문턱이 높은 게
              정상입니다. 「이날은 없었다」도 정보입니다.
            </>
          )}
        </div>
      ) : (
        <div className="data-table-wrap">
          <table className="data-table">
            {/* 머리 클릭 정렬 (2026-08-28) — 다른 표들과 같은 규칙 */}
            <thead>
              <tr>
                <SortableTh
                  columnKey="name"
                  label="종목명"
                  accessor={(r: Row) => r.name}
                  sort={sort}
                  className="sticky-col"
                />
                {/*
                  「며칠째」를 「걸린 날」로 고쳤다 (2026-08-31 — "죄다 1일째라고
                  적혀 있어서 편입일 기준하고 맞지를 않네").
                  seenCount 는 **교집합에 걸린 날이 몇 번인가**이지 편입 후 며칠이
                  아니다. 8/28 편입 후 다시 안 걸렸으면 오늘이 8/31 이어도 1 이다.
                  「며칠째」라고 적으니 편입일과 어긋나 보였다 — 이름이 틀렸던 것이다.
                  경과일은 바로 옆에 따로 낸다.
                */}
                <SortableTh
                  columnKey="seen"
                  label="걸린 날"
                  accessor={(r: Row) => r.seenCount}
                  sort={sort}
                  thProps={{ title: "교집합에 걸린 날이 몇 번인가 — 지속이 곧 신호. 편입 후 며칠과는 다른 값입니다" }}
                />
                <SortableTh
                  columnKey="dsince"
                  label="경과"
                  accessor={(r: Row) => r.daysSince ?? 0}
                  sort={sort}
                  thProps={{ title: "편입일로부터 며칠 — 편입 당일은 0일" }}
                />
                <SortableTh
                  columnKey="lists"
                  label="걸린 목록"
                  accessor={(r: Row) => r.lists.length}
                  sort={sort}
                  thProps={{ title: "어느 목록들에 걸렸나 — 정렬은 걸린 곳 수로" }}
                />
                <SortableTh
                  columnKey="added"
                  label="편입일"
                  accessor={(r: Row) => r.addedDate}
                  sort={sort}
                />
                <SortableTh
                  columnKey="addedPrice"
                  label="편입가"
                  accessor={(r: Row) => r.addedPrice}
                  sort={sort}
                  /*
                   * ⚠️ **관심종목의 편입가와 다를 수 있다** (2026-08-31 점검).
                   * 여기는 「슈퍼로 편입된 날의 값」이고, 관심종목은 「내가 담은 날의
                   * 값」이다. 그 종목을 전에 손으로 담아 뒀으면 두 값이 갈린다
                   * (실측: 삼성전기 슈퍼 1,386,000 vs 관심 1,560,000).
                   * 둘 다 맞는 값이라 맞출 것이 아니라, 어느 기준인지 말해야 한다.
                   */
                  thProps={{
                    title:
                      "슈퍼신호등으로 편입된 날의 값입니다. 관심종목 화면의 편입가(내가 담은 날의 값)와 다를 수 있습니다",
                  }}
                />
                <SortableTh
                  columnKey="price"
                  label="지금"
                  accessor={(r: Row) => r.price ?? -1}
                  sort={sort}
                />
                <SortableTh
                  columnKey="since"
                  label="편입 대비"
                  accessor={(r: Row) => r.sinceAdded ?? -9999}
                  sort={sort}
                  thProps={{ title: "편입가 대비" }}
                />
                {/* 셋을 한 칸에 넣었으므로 정렬은 **20일**로 — 가장 긴 답이 이 표의 물음이다 */}
                <SortableTh
                  columnKey="rets"
                  label="1·5·20일"
                  accessor={(r: Row) => r.returns?.d20 ?? -9999}
                  sort={sort}
                  thProps={{
                    title: "편입 후 1·5·20거래일 종가의 편입가 대비 — 매일 15:45 채점 (정렬은 20일 기준)",
                  }}
                />
                <SortableTh columnKey="score" label="점수" accessor={(r: Row) => r.score} sort={sort} />
                <th></th>
              </tr>
            </thead>
            <tbody>
              {sort.sorted.map((r) => (
                <tr key={r.code} className="clickable-row" onClick={() => onSelectStock(r.code, r.name)}>
                  <td className="sticky-col">
                    <WatchStar code={r.code} />
<SuperMark code={r.code} />
                    {r.name}
                  </td>
                  <td className="num">
                    <b>{r.seenCount}일</b>
                    {r.lastSeenDate !== r.addedDate && (
                      <i className="pt-n"> ~{r.lastSeenDate.slice(5)}</i>
                    )}
                  </td>
                  {/* 경과 — 편입일로부터. 편입 당일은 0일이고 그때만 N 이 붙는다 */}
                  <td className="num">
                    {r.daysSince ?? 0}일
                    {r.isNew && (
                      <span className="ss-new" title="오늘 편입됐습니다">
                        N
                      </span>
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
                  <td className="num ss-rets">
                    {([r.returns?.d1 ?? null, r.returns?.d5 ?? null, r.returns?.d20 ?? null] as const).map(
                      (v, i) => (
                        <i key={i} className={cls(v)}>
                          {v === null ? "·" : `${v > 0 ? "+" : ""}${v.toFixed(1)}`}
                        </i>
                      ),
                    )}
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
