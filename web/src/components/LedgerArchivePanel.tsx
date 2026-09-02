import { useEffect, useState } from "react";
import { api, fmtNum, type ArchiveGroupStat, type ArchiveHorizon, type ArchiveMeta, type ArchiveReport, type ArchiveRow } from "../api";
import { AlertTags } from "./AlertTags";

/**
 * **보관함** (2026-09-02 저녁) — 선 긋기로 보관한 옛 원장을 **계속 쫓아간다.**
 *
 * 벤티지: "원장 선긋기 하고 백업시키잖아. 그거 설정의 특정 메뉴에 하나 차려가지고
 * 거기에서 트래킹하는 메뉴 하나 만들 수 있어? 그때의 신호등 옵션값 달고 있어서
 * 체크해볼 수 있게. 좋은 신호값을 버리는 건 아닐까 싶어서."
 *
 * 메인(슈퍼신호등·추적기·분석)은 지금 기준으로 가고, 여기서는 옛 편입들이 그 뒤로
 * 어떻게 됐나를 **지금 원장과 같은 자로** 재서 나란히 놓는다. 성적은 서버가 일봉
 * 캐시로 읽을 때 내므로(조회 0회) 매일 저절로 자란다.
 *
 * 옵션값은 선 긋기가 같이 남긴 `signalConfig.archive-*.json` 을 연다. 그 전 보관분
 * (2026-09-02 00:20)은 지문만 있다 — 없는 값을 지어내지 않는다.
 */

function h(x: ArchiveHorizon): string {
  if (x.n === 0 || x.med === null) return "—";
  return `${x.med > 0 ? "+" : ""}${x.med.toFixed(1)}% · 승 ${x.win}% (${x.n})`;
}
function cls(v: number | null | undefined): string {
  if (v === null || v === undefined) return "";
  return v > 0 ? "positive" : v < 0 ? "negative" : "";
}
function pct(v: number | null): string {
  return v === null ? "·" : `${v > 0 ? "+" : ""}${v.toFixed(1)}`;
}

function StatTable({ title, rows, note }: { title: string; rows: ArchiveGroupStat[]; note?: string }) {
  return (
    <div className="arch-stat">
      <h4>{title}</h4>
      {note && <p className="pt-n">{note}</p>}
      <div className="table-scroll">
        <table className="data-table num">
          <thead>
            <tr>
              <th>구간</th>
              <th>n</th>
              <th title="편입가 대비 1거래일 뒤 종가 — 중앙값 · 승률 · 잰 수">1일</th>
              <th title="5거래일 뒤">5일</th>
              <th title="20거래일 뒤">20일</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.label}>
                <td>{r.label}</td>
                <td>{r.n}</td>
                <td className={cls(r.d1.med)}>{h(r.d1)}</td>
                <td className={cls(r.d5.med)}>{h(r.d5)}</td>
                <td className={cls(r.d20.med)}>{h(r.d20)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

export function LedgerArchivePanel() {
  const [list, setList] = useState<ArchiveMeta[] | null>(null);
  const [stamp, setStamp] = useState<string | null>(null);
  const [report, setReport] = useState<ArchiveReport | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [showCfg, setShowCfg] = useState(false);
  const [kind, setKind] = useState<string>("superSignal");

  useEffect(() => {
    api
      .signalArchives()
      .then((r) => {
        setList(r.archives);
        if (r.archives.length > 0) setStamp(r.archives[0].stamp);
      })
      .catch((e) => setError(e instanceof Error ? e.message : String(e)));
  }, []);
  useEffect(() => {
    if (!stamp) return;
    setReport(null);
    api
      .signalArchive(stamp)
      .then(setReport)
      .catch((e) => setError(e instanceof Error ? e.message : String(e)));
  }, [stamp]);

  if (error) return <p className="error">{error}</p>;
  if (list === null) return <p className="pt-n">보관함을 여는 중…</p>;
  if (list.length === 0)
    return (
      <p className="pt-n">
        보관분이 없습니다. 「원장에 선 긋기」(비용·상태 › 마감 뒤 정리)를 누르면 그때까지의 편입이 여기로 옮겨 오고, 그 뒤로도
        성적을 계속 쫓아갑니다.
      </p>
    );

  const arch = report?.archived.find((a) => a.kind === kind) ?? report?.archived[0];
  const live = report?.live.find((l) => l.kind === (arch?.kind ?? kind));

  return (
    <div className="arch-panel">
      <p className="pt-n">
        메인(슈퍼신호등·추적기·분석)은 <b>지금 기준</b>으로 갑니다. 여기는 선 긋기로 보관한 <b>옛 편입</b>이 그 뒤로 어떻게 됐나를
        지금 원장과 <b>같은 자</b>(편입가 대비 1·5·20거래일 뒤 종가, 일봉 캐시)로 재서 나란히 놓습니다. 조회는 없고 매일 저절로 자랍니다.
      </p>

      <div className="filter-row">
        {list.map((m) => (
          <button key={m.stamp} className={`filter-btn${m.stamp === stamp ? " active" : ""}`} onClick={() => setStamp(m.stamp)} title={`${m.total}건 · ${m.files.map((f) => `${f.label} ${f.count}`).join(" · ")}${m.configFile ? " · 옵션값 있음" : " · 옵션값 없음(지문만)"}`}>
            {m.label} <span className="pt-n">({m.total}건{m.configFile ? " · ⚙" : ""})</span>
          </button>
        ))}
      </div>

      {report && (
        <>
          <div className="arch-meta pt-n">
            지문: {Object.entries(report.meta.fingerprints).map(([k, n]) => `${k}(${n})`).join(" · ")} · 일봉 {report.closesBuiltAt.slice(0, 10)} 까지
          </div>

          {/* 그때의 옵션값 */}
          <div className="arch-cfg">
            {report.config ? (
              <>
                <button className="filter-btn" onClick={() => setShowCfg((v) => !v)}>
                  {showCfg
                    ? "▾ 그때 옵션값 닫기"
                    : `▸ 그때 옵션값 (세대 ${report.config.configVersion ?? "-"}${report.config.configLabel ? ` · ${report.config.configLabel}` : ""} · 초록 ${report.config.greenAt} · 켜진 기준 ${report.config.checks.length})`}
                </button>
                {report.diff.length > 0 && (
                  <div className="arch-diff">
                    <b>지금과 다른 것 ({report.diff.length})</b>
                    <ul>
                      {report.diff.map((d) => (
                        <li key={d}>{d}</li>
                      ))}
                    </ul>
                  </div>
                )}
                {showCfg && (
                  <div className="table-scroll">
                    <table className="data-table">
                      <thead>
                        <tr>
                          <th>기준</th>
                          <th>축</th>
                          <th>무게</th>
                          <th>50점</th>
                          <th>100점</th>
                          <th>상한</th>
                          <th>장세</th>
                          <th>탈락</th>
                        </tr>
                      </thead>
                      <tbody>
                        {report.config.checks.map((c) => (
                          <tr key={c.key}>
                            <td>{c.label}</td>
                            <td>{c.axis}</td>
                            <td className="num">{c.weight}</td>
                            <td className="num">{c.threshold}</td>
                            <td className="num">{c.strongAt}</td>
                            <td className="num">{c.capAt ?? "-"}</td>
                            <td>{c.regime ?? "무관"}</td>
                            <td>{c.veto ? `≤ ${c.vetoAt}` : "-"}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                    <p className="pt-n">
                      축 무게 추세 {report.config.axisWeights.trend} · 수급 {report.config.axisWeights.flow} · 실적 {report.config.axisWeights.value} · 커버리지 {report.config.minCoverage} · 장세 전환 {report.config.regimeSwitch ? "켬" : "끔"}
                    </p>
                  </div>
                )}
              </>
            ) : (
              <p className="pt-n">이 보관분에는 옵션값 파일이 없습니다 (2026-09-02 저녁부터 선 긋기가 같이 남깁니다). 지문으로만 구별됩니다.</p>
            )}
          </div>

          {/* 원장 고르기 */}
          <div className="filter-row">
            {report.archived.map((a) => (
              <button key={a.kind} className={`filter-btn${a.kind === (arch?.kind ?? "") ? " active" : ""}`} onClick={() => setKind(a.kind)}>
                {a.label} <span className="pt-n">({a.rows.length})</span>
              </button>
            ))}
          </div>

          {arch && (
            <div className="arch-compare">
              <StatTable title={`보관분 — ${arch.label} (${report.meta.label} 선 긋기 전 편입)`} rows={[arch.total, ...arch.groups]} />
              {live && (
                <StatTable
                  title={`지금 원장 — ${live.label} (선 긋기 뒤 편입, 같은 자)`}
                  rows={[live.total, ...live.groups]}
                  note={live.total.n === 0 ? "아직 편입이 없거나 잴 봉이 안 쌓였습니다" : undefined}
                />
              )}
            </div>
          )}

          {arch && (
            <div className="table-scroll">
              <table className="data-table">
                <thead>
                  <tr>
                    <th>종목</th>
                    <th>편입일</th>
                    <th>{arch.kind === "signalTrack" ? "문턱" : arch.kind === "listTrack" ? "목록" : "점수"}</th>
                    {arch.kind !== "superSignal" && <th>점수</th>}
                    <th>편입가</th>
                    <th title="편입일 봉 다음부터 1·5·20거래일 뒤 종가의 편입가 대비 (%)">1 / 5 / 20일</th>
                    <th>지문</th>
                  </tr>
                </thead>
                <tbody>
                  {arch.rows.map((r: ArchiveRow) => (
                    <tr key={`${r.kind}-${r.code}-${r.date}-${r.tier ?? r.list ?? ""}`}>
                      <td>
                        {r.name} <AlertTags alerts={r.alerts} compact />
                      </td>
                      <td>{r.date.slice(5)}</td>
                      <td>{arch.kind === "signalTrack" ? r.tier : arch.kind === "listTrack" ? r.list : r.score}</td>
                      {arch.kind !== "superSignal" && <td className="num">{r.score}</td>}
                      <td className="num">{fmtNum(r.price)}</td>
                      <td className="num">
                        <span className={cls(r.d1)}>{pct(r.d1)}</span> / <span className={cls(r.d5)}>{pct(r.d5)}</span> /{" "}
                        <span className={cls(r.d20)}>{pct(r.d20)}</span>
                        {r.barsAfter < 20 && <i className="pt-n"> ({r.barsAfter}봉)</i>}
                      </td>
                      <td className="pt-n">{r.configHash ?? "-"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </>
      )}
    </div>
  );
}
