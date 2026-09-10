import { useEffect, useState } from "react";
import { api, type CollectProgress, type CollectRun, type DataReport, type LedgerStatus } from "../api";

/**
 * 데이터 보관 (2026-08-31 요청 — 「기간별로 드는 용량 표시해주고, 최종적으로 전체
 * 용량도. 조절해가면서 하거나 추가 용량을 붙일 수도 있으니」).
 *
 * ## 이 화면이 답하려는 물음
 *
 *   1. 지금 뭐가 얼마나 쌓여 있나
 *   2. **기간을 줄이면 얼마가 빠지나** — 그게 안 보이면 숫자를 고를 수가 없다
 *   3. 더 쌓으려면 어디에 붙여야 하나
 *
 * 실측으로 시작된 화면이다: `server/data` 221MB 중 **214MB 가 실시간 로그**였고
 * 하루 43MB 씩 늘고 있었는데 **지우는 코드가 없었다.**
 */

const CHOICES: { d: number | null; label: string }[] = [
  { d: 7, label: "7일" },
  { d: 14, label: "14일" },
  { d: 30, label: "30일" },
  { d: 60, label: "60일" },
  { d: 90, label: "90일" },
  { d: 180, label: "180일" },
  { d: 365, label: "1년" },
  { d: null, label: "안 지움" },
];

function mb(b: number): string {
  if (b >= 1073741824) return `${(b / 1073741824).toFixed(2)}GB`;
  if (b >= 1048576) return `${(b / 1048576).toFixed(1)}MB`;
  if (b >= 1024) return `${(b / 1024).toFixed(0)}KB`;
  return `${b}B`;
}

/**
 * **기간별로 얼마가 빠지나** (2026-08-31 2차).
 *
 * ⚠️ 처음엔 「지금 설정이면 −몇 MB」 한 칸만 뒀는데, 설정이 넉넉하면 그 값이 늘
 * 0 이라 **표 전체가 「—」로 보였다.** 「조절해 가면서 정하겠다」는 사람에게 그건
 * 아무 정보가 아니다 — 고르기 전에 결과를 알아야 고를 수 있다.
 *
 * 그래서 **후보 기간마다** 얼마가 빠지는지 미리 계산해 나란히 놓는다. 숫자 자체가
 * 단추라 눌러서 바로 그 기간으로 정할 수 있다.
 *
 * 서버가 주는 나이대별 용량(`byAge`)의 **누적 밖**이 빠지는 양이다.
 */
function freedAt(byAge: { d7: number; d30: number; d90: number; d365: number; older: number }, keep: number): number {
  if (keep <= 7) return byAge.d30 + byAge.d90 + byAge.d365 + byAge.older;
  if (keep <= 30) return byAge.d90 + byAge.d365 + byAge.older;
  if (keep <= 90) return byAge.d365 + byAge.older;
  if (keep <= 365) return byAge.older;
  return 0;
}

/** 나이대 문턱과 겹치는 후보만 보여 준다 — 안 그러면 0 만 늘어선다 */
const BANDS = [7, 30, 90, 365];

export function DataRetentionPanel() {
  const [rep, setRep] = useState<DataReport | null>(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  /** 일별 원장 — 얼마나 쌓였나 · 지금 수집 중인가 (2026-09-01) */
  const [led, setLed] = useState<{
    ledger: LedgerStatus;
    collect: CollectProgress;
    history: CollectRun[];
  } | null>(null);

  useEffect(() => {
    api.dataReport().then(setRep).catch(() => undefined);
    api.dataLedger().then(setLed).catch(() => undefined);
  }, []);

  /* 수집이 도는 동안에는 따라간다 — 41분짜리라 멈춘 것처럼 보이면 안 된다 */
  useEffect(() => {
    if (!led?.collect.running) return;
    const t = setInterval(() => {
      void api.dataLedger().then(setLed).catch(() => undefined);
    }, 5000);
    return () => clearInterval(t);
  }, [led?.collect.running]);

  /*
   * **끝난 뒤에도 한 번 더 받는다** (2026-09-01).
   *
   * 위 폴링은 `running` 이 false 가 되면 멈춘다. 그런데 마지막 폴링과 실제 완료
   * 사이에 최대 5초가 있어서, 그 사이에 끝나면 화면이 **끝나기 직전 숫자**를
   * 붙들고 만다 — 실제로 「1005/2627 수집 중」이 남아 있던 일이 그것이다.
   */
  useEffect(() => {
    if (led?.collect.running) return;
    const t = setTimeout(() => {
      void api.dataLedger().then(setLed).catch(() => undefined);
    }, 6000);
    return () => clearTimeout(t);
  }, [led?.collect.running]);

  /**
   * **압축** — 지우기 전에 줄인다.
   *
   * 실시간 로그는 같은 JSON 키가 하루 40만 번 반복돼 4.2:1 로 눌린다. 실측에서
   * 4일치 222MB 가 48MB 가 됐다. 「작게 오래 두기」가 「크게 짧게 두기」보다 낫다 —
   * 이 데이터는 키움이 지나간 것을 안 줘서 지우면 영영 못 받는다.
   */
  /**
   * **다시 수집** — 실패한 날을 손으로 돌린다.
   *
   * ⚠️ 그날 값을 되살리는 게 아니다. 키움은 과거 시점의 수급을 안 준다 —
   * 지금 받으면 지금까지의 최신 100일이 온다. 최근 며칠이 빠졌으면 메워지고,
   * 100일보다 오래 빠진 구간은 못 메운다. 버튼 옆에 그렇게 적어 둔다.
   */
  async function recollect() {
    if (
      !window.confirm(
        [
          "지금 다시 수집합니다 (전종목 5콜, 약 41분).",
          "",
          "⚠️ 그날 값을 되살리는 게 아니라 지금 다시 받아 빈 곳을 메웁니다 —",
          "키움이 과거 시점의 수급을 안 주기 때문입니다.",
          "",
          "진행할까요?",
        ].join("\n"),
      )
    ) {
      return;
    }
    setBusy(true);
    try {
      await api.dataLedgerCollect();
      setMsg("수집을 시작했습니다 — 진행률이 위에 뜹니다");
      const r = await api.dataLedger();
      setLed(r);
    } catch (e) {
      setMsg(e instanceof Error ? e.message : "시작 실패");
    } finally {
      setBusy(false);
    }
  }

  async function compress() {
    setBusy(true);
    try {
      const r = await api.dataCompress();
      setRep(r.report);
      setMsg(
        r.done > 0
          ? `지난 로그 ${r.done}개 압축 — ${mb(r.saved)} 절약`
          : "압축할 것이 없었습니다 (오늘·어제 파일은 아직 쓰는 중이라 건드리지 않습니다)",
      );
    } catch (e) {
      setMsg(e instanceof Error ? e.message : "압축 실패");
    } finally {
      setBusy(false);
    }
  }

  async function prune() {
    if (!window.confirm("보관 기간이 지난 파일을 지웁니다. 되돌릴 수 없습니다. 진행할까요?")) return;
    setBusy(true);
    try {
      const r = await api.dataPrune();
      setRep(r.report);
      setMsg(r.removed > 0 ? `${r.removed}개 지움 — ${mb(r.bytes)} 확보` : "지울 것이 없었습니다");
    } catch (e) {
      setMsg(e instanceof Error ? e.message : "정리 실패");
    } finally {
      setBusy(false);
    }
  }

  if (!rep) return <div className="table-note">불러오는 중…</div>;

  /*
   * **한눈에** (2026-09-10 — 벤티지: "지금까지 데이터 수집이 680메가로 되어 있거든. 이 상태로 일년치일 때
   * 어떨지 보고 … 데이터 보관 항목도 많이 바꿔놨으니까 이 부분도 알맞게 바꿔주고, 한 눈에 눈에 들어오게끔").
   *
   * 위에 네 숫자 — 지금 · 하루 · 1년 뒤 · 디스크. 그 밑은 갈래를 **셋으로 묶는다**: 날짜별로 쌓여 기간을
   * 고를 수 있는 것 / 한 파일에 덧붙어 크기만 보는 것 / 매번 덮어써 자랄 일이 없는 것. 「1년 뒤」는
   * 하루치 × 보관일(1년 이하면 거기서 멈춘다)이다.
   */
  const perDayAll = rep.perDayBytes ?? rep.cats.reduce((a, c) => a + c.perDay, 0);
  const afterYear = rep.afterYearBytes ?? rep.totalBytes + perDayAll * 365;
  const groups: { kind: "daily" | "append" | "single"; title: string; note: string }[] = [
    { kind: "daily", title: "날짜별로 쌓이는 것", note: "기간을 고를 수 있습니다 — 6시간마다 지난 파일을 지웁니다" },
    { kind: "append", title: "한 파일에 덧붙는 것", note: "날짜로 못 자릅니다. 원장은 한도(거래일)로 따로 다스립니다" },
    { kind: "single", title: "매번 덮어쓰는 것", note: "이력이 없어 자랄 일도, 자를 것도 없습니다" },
  ];
  const keepLabel = (d: number | null) => (d === null ? "안 지움" : d >= 365 ? `${(d / 365).toFixed(d % 365 === 0 ? 0 : 1)}년` : `${d}일`);

  return (
    <div className="dret">
      <div className="dret-kpis">
        <div className="dret-kpi">
          <span>지금</span>
          <b>{mb(rep.totalBytes)}</b>
          <i>{rep.cats.length}갈래 + 그 밖 {mb(rep.otherBytes)}</i>
        </div>
        <div className="dret-kpi">
          <span>하루에</span>
          <b>{perDayAll > 0 ? `+${mb(perDayAll)}` : "—"}</b>
          <i>한 달 ≈ {mb(perDayAll * 30)}</i>
        </div>
        <div className="dret-kpi hi">
          <span>1년 뒤 (지금 설정)</span>
          <b>{mb(afterYear)}</b>
          <i>보관 기간이 1년 이하면 거기서 멈춤</i>
        </div>
        {rep.disk && (
          <div className={`dret-kpi${rep.disk.free < afterYear * 2 ? " warn" : ""}`}>
            <span>디스크 여유</span>
            <b>{mb(rep.disk.free)}</b>
            <i>
              전체 {mb(rep.disk.total)} · 1년 뒤의 {rep.disk.free > 0 ? Math.round((afterYear / rep.disk.free) * 100) : 0}% 씀
            </i>
          </div>
        )}
        <div className="dret-acts">
          <button className="filter-btn" onClick={compress} disabled={busy} title="지난 날 로그를 gzip 으로 눌러 둡니다 — 실측 4.2:1. 오늘·어제 파일은 아직 쓰는 중이라 건드리지 않습니다">
            {busy ? "…" : "🗜 지난 로그 압축"}
          </button>
          <button className="filter-btn" onClick={prune} disabled={busy || rep.prunableBytes === 0}>
            {busy ? "정리 중…" : rep.prunableBytes > 0 ? `지금 정리 (−${mb(rep.prunableBytes)})` : "지울 것 없음"}
          </button>
        </div>
      </div>
      {msg && <div className="table-note">{msg}</div>}

      {groups.map((g) => {
        const cats = rep.cats.filter((c) => c.kind === g.kind);
        if (cats.length === 0) return null;
        return (
          <div className="dret-group" key={g.kind}>
            <div className="dret-group-h">
              <b>{g.title}</b>
              <span className="pt-n">{g.note}</span>
              <span className="dret-group-sum num">{mb(cats.reduce((a, c) => a + c.bytes, 0))}</span>
            </div>
            <div className="data-table-wrap">
              <table className="data-table dret-table">
                <thead>
                  <tr>
                    <th>갈래</th>
                    <th className="num">지금</th>
                    <th className="num">하루</th>
                    {g.kind !== "single" && <th className="num">1년 뒤</th>}
                    {g.kind === "daily" && <th>보관</th>}
                    {g.kind === "daily" && <th>기간별로 줄이면</th>}
                  </tr>
                </thead>
                <tbody>
                  {cats.map((c) => (
                    <tr key={c.key}>
                      <td>
                        <b>{c.label}</b>
                        {c.rebuildable === false && <i className="dret-tag" title="지우면 다시 못 만든다">되살릴 수 없음</i>}
                        <div className="pt-n">{c.what}</div>
                        {c.oldest && (
                          <div className="pt-n">
                            {c.oldest} ~ {c.newest} · 파일 {c.files}개
                          </div>
                        )}
                      </td>
                      <td className="num">{mb(c.bytes)}</td>
                      <td className="num pt-n">
                        {c.perDay > 0 ? `${c.perDayEstimated ? "≈" : ""}${mb(c.perDay)}` : "—"}
                      </td>
                      {g.kind !== "single" && (
                        <td className="num">
                          {c.afterYear != null && c.afterYear > 0 ? mb(c.afterYear) : "—"}
                        </td>
                      )}
                      {g.kind === "daily" && (
                        <td>
                          <select
                            className="ma-input"
                            style={{ width: "6.5rem" }}
                            value={c.keepDays === null ? "" : String(c.keepDays)}
                            onChange={async (e) => {
                              const v = e.target.value === "" ? null : Number(e.target.value);
                              setRep(await api.dataKeep(c.key, v));
                            }}
                          >
                            {CHOICES.map((x) => (
                              <option key={x.label} value={x.d === null ? "" : String(x.d)}>
                                {x.label}
                              </option>
                            ))}
                            {c.keepDays !== null && !CHOICES.some((x) => x.d === c.keepDays) && (
                              <option value={String(c.keepDays)}>{keepLabel(c.keepDays)}</option>
                            )}
                          </select>
                        </td>
                      )}
                      {g.kind === "daily" && (
                        <td>
                          {BANDS.every((d) => freedAt(c.byAge, d) === 0) ? (
                            <span className="pt-n">
                              {c.bytes === 0 ? "쌓인 것 없음" : `전부 ${c.oldest ?? ""} 이후 — 줄여도 안 빠짐`}
                            </span>
                          ) : (
                            <div className="dret-bands">
                              {BANDS.map((d) => {
                                const f = freedAt(c.byAge, d);
                                return (
                                  <button
                                    key={d}
                                    className={`dret-band${c.keepDays === d ? " on" : ""}`}
                                    title={`${d}일만 남기면 ${mb(f)} 가 빠집니다`}
                                    onClick={async () => setRep(await api.dataKeep(c.key, d))}
                                  >
                                    <em>{d === 365 ? "1년" : `${d}일`}</em>
                                    <b className={f > 0 ? "negative" : ""}>{f > 0 ? `−${mb(f)}` : "0"}</b>
                                  </button>
                                );
                              })}
                            </div>
                          )}
                        </td>
                      )}
                    </tr>
                  ))}
                  {g.kind === "single" && (
                    <tr>
                      <td>
                        <b>그 밖</b>
                        <div className="pt-n">테마 분류·관심종목·설정처럼 작은 파일들</div>
                      </td>
                      <td className="num">{mb(rep.otherBytes)}</td>
                      <td className="num pt-n">—</td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          </div>
        );
      })}

      {led && (
        <div className={`dret-ledger${led.ledger.atLimit ? " full" : ""}`}>
          <div className="dret-ledger-head">
            <b>종목별 일별 원장</b>
            <span className="pt-n">
              {led.ledger.codes.toLocaleString("ko-KR")}종목 · {mb(led.ledger.bytes)}
              {led.ledger.from && led.ledger.to && ` · ${led.ledger.from}~${led.ledger.to}`}
            </span>
            {led.collect.running && (
              <span className="dret-run">
                수집 중 {led.collect.done}/{led.collect.total}
                {led.collect.at && ` · ${led.collect.at}`}
              </span>
            )}
          </div>
          {/*
            **막대가 둘이다** (2026-09-01) — 뜻이 다른데 하나만 있으면 오해한다.

            아래 막대는 **보관 한도까지 몇 %**다. 수집 진행률이 아니라서 수집이
            도는 동안에도 안 움직인다 — 실제로 「프로그레스바가 안 움직인다」는
            말을 들었다. 이름을 붙이고, 수집 중에는 진행률 막대를 따로 그린다.
          */}
          {led.collect.running && led.collect.total > 0 && (
            <>
              <div className="dret-bar-label">
                수집 진행 {led.collect.done}/{led.collect.total} (
                {Math.round((led.collect.done / led.collect.total) * 100)}%)
              </div>
              <div className="dret-bar collecting">
                <span
                  style={{ width: `${Math.round((led.collect.done / led.collect.total) * 100)}%` }}
                />
              </div>
            </>
          )}
          <div className="dret-bar-label">
            보관 한도까지 {led.ledger.fullPct}% ({led.ledger.maxDays}/{led.ledger.keep}일)
          </div>
          <div className="dret-bar" title={`${led.ledger.maxDays}일 / 한도 ${led.ledger.keep}일`}>
            <span style={{ width: `${Math.min(100, led.ledger.fullPct)}%` }} />
          </div>
          <div className="table-note">
            가장 긴 원장 <b>{led.ledger.maxDays}거래일</b> (대부분 {led.ledger.medDays}일) ·
            한도 <b>{led.ledger.keep}일</b>
            {" ≈ "}
            {(led.ledger.keep / 250).toFixed(1)}년 · <b>{led.ledger.fullPct}%</b> 찼습니다.
            <br />
            {led.ledger.atLimit ? (
              <b className="dret-warn">
                ⚠️ 한도에 닿았습니다 — 백업할지, 리셋할지, 한도를 늘릴지 정해야 합니다.
              </b>
            ) : (
              <>
                자동 삭제는 {led.ledger.trim ? <b>켜져</b> : <b>꺼져</b>} 있습니다
                {led.ledger.trim
                  ? " — 한도를 넘으면 앞에서부터 지웁니다."
                  : " — 지금은 계속 쌓이기만 합니다."}
              </>
            )}
            <br />
            한도는 <code>VNTG_DAILY_KEEP</code>(거래일, 최대 1300 ≈ 5년), 자동 삭제는{" "}
            <code>VNTG_DAILY_TRIM=1</code> 로 켭니다. ⚠️ 지운 것은 <b>다시 못 받습니다</b> —
            키움이 과거 수급을 100일치쯤만 줍니다.
          </div>
          {/*
            **수집 이력** (2026-09-01) — 언제 성공했고 언제 실패했나.

            벤티지: "이거 언제 성공했고 실패했는지 보여주자 화면에. 그리고 실패한
            날에 대해서는 수동 버튼 하나 만들어서 재수집하게 하는 거야."

            필요한 이유가 그날 드러났다 — 41분짜리가 도는 중에 서버가 재시작되면
            작업이 죽는데 **아무 흔적이 없었다.** 화면에는 「1005/2627 수집 중」이
            남아 있는데 서버에는 아무것도 안 돌고 있었다.
          */}
          {led.history.length > 0 && (
            <div className="table-wrap dret-hist">
              <table className="sim-table">
                <thead>
                  <tr>
                    <th>날짜</th>
                    <th>결과</th>
                    <th className="num">진행</th>
                    <th className="num">담은 줄</th>
                    <th className="num">실패</th>
                  </tr>
                </thead>
                <tbody>
                  {led.history.slice(0, 10).map((h) => {
                    /*
                     * **도는 중이면 실시간 값으로 덮는다** (2026-09-01).
                     *
                     * 이력은 시작할 때 한 번 적고 끝날 때 갱신하는 구조라, 도는
                     * 동안에는 `0/2627 · 0줄` 로 남는다. 그런데 바로 위 배지에는
                     * `2305/2627 · 356,680` 이 뜬다 — 같은 화면에서 두 숫자가
                     * 어긋나면 「멈춘 건가」로 읽힌다. 실제로 그렇게 보였다.
                     */
                    const live = h.status === "running" && led.collect.running;
                    const done = live ? led.collect.done : h.done;
                    const total = live ? led.collect.total : h.total;
                    const rows = Object.values(live ? led.collect.added : h.added).reduce(
                      (a, b) => a + b,
                      0,
                    );
                    const fails = live ? led.collect.fails : h.fails;
                    return (
                      <tr key={h.day} className={h.status === "done" ? "" : "dret-fail"}>
                        <td>
                          {h.day.slice(5)}
                          {h.manual && <i className="pt-n"> 수동</i>}
                        </td>
                        <td>
                          {h.status === "done"
                            ? "✅ 완료"
                            : h.status === "running"
                              ? "⏳ 도는 중"
                              : `⚠️ ${h.error ?? "중단"}`}
                        </td>
                        <td className="num">
                          {done}/{total}
                          {live && total > 0 && (
                            <i className="pt-n"> ({Math.round((done / total) * 100)}%)</i>
                          )}
                        </td>
                        <td className="num">{rows.toLocaleString("ko-KR")}</td>
                        <td className="num">{fails}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}

          <div className="filter-row dret-hist-act">
            <button className="filter-btn" onClick={() => void recollect()} disabled={busy || led.collect.running}>
              {led.collect.running ? "수집 중…" : "↻ 지금 다시 수집"}
            </button>
            <span className="table-note">
              전종목 5콜, 약 41분. ⚠️ <b>그날 값을 되살리는 게 아닙니다</b> — 키움이
              과거 시점의 수급을 안 줘서, 지금 다시 받아 <b>빈 곳을 메우는</b> 것입니다.
              최근 며칠이 빠졌으면 메워지고 100일보다 오래 빠진 구간은 못 메웁니다.
            </span>
          </div>

          {Object.keys(led.collect.added).length > 0 && (
            <div className="table-note">
              마지막 수집 —{" "}
              {Object.entries(led.collect.added)
                .map(([k, v]) => `${k} ${v.toLocaleString("ko-KR")}줄`)
                .join(" · ")}
              {led.collect.fails > 0 && ` · 실패 ${led.collect.fails}`}
            </div>
          )}
        </div>
      )}

      <div className="table-note">
        정리는 <b>6시간마다</b> 저절로 돕니다. 파일 이름의 날짜로만 자르므로, 이름에서 날짜를 못 읽는 파일은
        건드리지 않습니다. 텔레그램 창고·뉴스 키워드·버즈·이벤트 로그는 <b>여기 기간을 따릅니다</b>(기본 1년).
      </div>
      <div className="table-note">
        ⚠️ <b>지운 날은 다시 만들 수 없습니다.</b> 신호등 점수·이벤트 로그·텔레그램 원문은 그 시점에만 있는 값이라
        특히 그렇습니다. 실시간 로그는 크지만 압축(4.2:1)하면 하루 4MB 안팎이라 길게 둬도 됩니다.
      </div>

      <details className="dret-move">
        <summary>저장 위치를 옮기려면 (용량을 더 붙였을 때)</summary>
        <div className="table-note">
          지금 위치: <code>{rep.dir}</code>
        </div>
        <div className="table-note">
          데이터 경로는 <b>서버 코드 67곳</b>이 저마다 들고 있어서, 설정에서 바꾸는 단추를 다는 것은 그 전부를
          손대는 일입니다. 위험 대비 얻는 것이 적어 그렇게 하지 않았습니다. 대신 <b>폴더 자체를 옮기고 링크를
          거는 쪽</b>이 안전하고 결과가 같습니다 — 서버는 원래 자리로 알고 씁니다.
        </div>
        <pre className="dret-cmd">{`# 관리자 PowerShell에서 (서버를 먼저 끄세요)
Stop-Service vntg-hts        # 서비스로 돌리는 경우
Move-Item C:\\vntg-hts\\server\\data D:\\vntg-data
New-Item -ItemType Junction -Path C:\\vntg-hts\\server\\data -Target D:\\vntg-data
Start-Service vntg-hts`}</pre>
        <div className="table-note">
          옮긴 뒤 이 화면을 새로 열어 <b>디스크 여유</b>가 새 드라이브 값으로 바뀌었는지 확인하세요. 안 바뀌었으면
          링크가 안 걸린 것입니다.
        </div>
      </details>
    </div>
  );
}
