import { useCallback, useEffect, useState } from "react";
import {
  api,
  fmtNum,
  signClass,
  type LeaderConfig,
  type LeaderGroupStat,
  type LeaderScan,
  type LeaderTrackResult,
} from "../api";

/**
 * 주도주 탐색기 — **오늘 시장이 어디에 반응하는가.**
 *
 * 등락률 순위는 이미 있다. 그것만으로는 주도주를 못 고른다 — 하루 반짝 오른 것과
 * 사흘째 돈이 들어오는 것이 같은 목록에 섞여 나온다.
 *
 * 화면은 위에서 아래로 읽는 순서다.
 *   강한 섹터 (왜 강한가 · 이어지고 있나) → 걸린 종목 (왜 걸렸나)
 */

function pct(v: number): string {
  return `${v > 0 ? "+" : ""}${v.toFixed(2)}%`;
}

export function LeaderScanPanel({
  onSelectStock,
}: {
  onSelectStock?: (code: string, name: string) => void;
}) {
  const [data, setData] = useState<LeaderScan | null>(null);
  const [cfg, setCfg] = useState<LeaderConfig | null>(null);
  const [cfgOpen, setCfgOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async (withNews: boolean) => {
    setLoading(true);
    setError(null);
    try {
      setData(await api.leaderScan(withNews));
    } catch (e) {
      setError(e instanceof Error ? e.message : "불러오지 못했습니다");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    /*
     * 처음엔 **뉴스를 끄고** 부른다. 섹터마다 네이버를 부르므로 화면을 열 때마다
     * 돌면 하루 할당량이 녹는다. 「왜 강한가」는 눌러서 받는다.
     */
    void load(false);
    api.leaderConfig().then(setCfg).catch(() => setCfg(null));
  }, [load]);

  function saveCfg(patch: Partial<LeaderConfig>) {
    if (!cfg) return;
    const next = { ...cfg, ...patch };
    setCfg(next);
    void api.leaderConfigSave(next).then(setCfg).catch(() => {});
  }

  const hasNews = (data?.sectors ?? []).some((s) => s.news.length > 0);

  return (
    <div className="ls">
      <div className="filter-row">
        <button className="primary-btn" onClick={() => void load(false)} disabled={loading}>
          {loading ? "훑는 중…" : "다시 훑기"}
        </button>
        <button className="filter-btn" onClick={() => void load(true)} disabled={loading}>
          {hasNews ? "뉴스 다시" : "왜 강한가 (뉴스)"}
        </button>
        <button
          className={`filter-btn ${cfgOpen ? "active" : ""}`}
          onClick={() => setCfgOpen((v) => !v)}
        >
          조건
        </button>
        {data && (
          <span className="pt-n">
            거래대금 상위 {data.scanned}종목 · {data.config.minTradeValue}억 미만{" "}
            {data.belowThreshold}개 제외
          </span>
        )}
      </div>

      {error && <div className="error-banner">{error}</div>}
      {data?.note && <div className="alert-note">{data.note}</div>}

      {/* ---------------- 조건 ---------------- */}
      {cfgOpen && cfg && (
        <section className="card st-cfg">
          <h2>탐색 조건</h2>
          <div className="st-cfg-row">
            <span className="st-cfg-k">최소 거래대금</span>
            <span>
              <input
                type="number"
                min={0}
                step={100}
                value={cfg.minTradeValue}
                onChange={(e) => saveCfg({ minTradeValue: Number(e.target.value) })}
              />{" "}
              억원 이상
            </span>
          </div>
          <div className="st-cfg-note">
            <b>이 문턱이 이 화면의 핵심</b>입니다. 대금이 얇은 구간은 작전·휩쏘가 끼기 쉬워서,
            신호가 맞아도 실제로 사고팔 수 있는 자리가 아닙니다.
          </div>

          <div className="st-cfg-row">
            <span className="st-cfg-k">모집단</span>
            <span>
              거래대금 상위{" "}
              <input
                type="number"
                min={20}
                max={400}
                step={20}
                value={cfg.universe}
                onChange={(e) => saveCfg({ universe: Number(e.target.value) })}
              />{" "}
              종목
            </span>
          </div>

          <div className="st-cfg-row">
            <span className="st-cfg-k">급등 기준</span>
            <span>
              당일{" "}
              <input
                type="number"
                min={0}
                max={30}
                step={1}
                value={cfg.surgeRate}
                onChange={(e) => saveCfg({ surgeRate: Number(e.target.value) })}
              />
              % 이상
            </span>
          </div>

          <div className="st-cfg-row">
            <span className="st-cfg-k">거래량 급증</span>
            <span>
              전일 대비{" "}
              <input
                type="number"
                min={1}
                max={20}
                step={0.5}
                value={cfg.volumeSpike}
                onChange={(e) => saveCfg({ volumeSpike: Number(e.target.value) })}
              />
              배 이상
            </span>
          </div>

          <div className="st-cfg-row">
            <span className="st-cfg-k">섹터 표시</span>
            <span>
              상위{" "}
              <input
                type="number"
                min={1}
                max={20}
                value={cfg.topSectors}
                onChange={(e) => saveCfg({ topSectors: Number(e.target.value) })}
              />
              개 · 최소{" "}
              <input
                type="number"
                min={1}
                max={10}
                value={cfg.minMembers}
                onChange={(e) => saveCfg({ minMembers: Number(e.target.value) })}
              />
              종목
            </span>
          </div>
          <div className="st-cfg-note">
            바꾸면 <b>다음 훑기부터</b> 적용됩니다.
          </div>
        </section>
      )}

      {loading && !data && <div className="empty">거래대금 상위를 훑는 중…</div>}

      {/* ---------------- 강한 섹터 ---------------- */}
      {data && (
        <section className="card">
          <h2>강한 섹터</h2>
          {data.sectors.length === 0 ? (
            <div className="page-note">
              조건에 맞는 섹터가 없습니다. 장 시작 전이라 거래대금이 안 쌓였거나, 문턱이 높습니다.
            </div>
          ) : (
            <div className="ls-secs">
              {data.sectors.map((s) => (
                <div className="ls-sec" key={s.name}>
                  <div className="ls-sec-h">
                    <b className="ls-sec-nm">{s.name}</b>
                    <span className={`ls-sec-rt ${signClass(s.weightedRate)}`}>
                      {pct(s.weightedRate)}
                    </span>
                    {/*
                      폭이 낮으면 섹터가 아니라 **종목 이슈**다.
                      +3% 를 한 종목이 만든 것과 여덟 종목이 만든 것은 완전히 다른 장이다.
                    */}
                    <span
                      className={`ls-badge ${s.breadth >= 70 ? "ok" : "warn"}`}
                      title="오른 종목 비율 — 낮으면 섹터가 아니라 종목 이슈입니다"
                    >
                      폭 {s.breadth.toFixed(0)}% ({s.rising}/{s.members})
                    </span>
                    <span className="pt-n">{fmtNum(s.tradeValue)}억</span>
                  </div>

                  <div className="ls-sec-sub">
                    {/* 가중과 단순이 벌어지면 대형주 혼자 끌고 있다는 뜻이다 */}
                    <span title="단순평균. 가중과 크게 벌어지면 대형주 혼자 끌고 있다는 뜻입니다">
                      단순 {pct(s.simpleRate)}
                    </span>
                    <span title="며칠 연속 상위에 들었나">
                      연속 {s.streak === null ? "-" : `${s.streak}일`}
                    </span>
                    <span title="어제 뽑힌 종목 중 오늘도 남은 비율">
                      유지 {s.carryOver === null ? "-" : `${s.carryOver.toFixed(0)}%`}
                    </span>
                  </div>

                  <div className="ls-sec-leaders">
                    {s.leaders.map((l) => (
                      <button
                        key={l.code}
                        className="ls-chip"
                        onClick={() => onSelectStock?.(l.code, l.name)}
                        title={l.tags.join(" · ")}
                      >
                        {l.name}
                        <span className={signClass(l.changeRate)}> {pct(l.changeRate)}</span>
                      </button>
                    ))}
                  </div>

                  {s.news.length > 0 && (
                    <ul className="ls-news">
                      {s.news.map((n) => (
                        <li key={n.link}>
                          <a href={n.link} target="_blank" rel="noreferrer">
                            {n.title}
                          </a>
                          <span className="pt-n"> {n.press}</span>
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
              ))}
            </div>
          )}
          <div className="table-note">
            등락률은 <b>거래대금 가중</b>입니다 — 보려는 게 「돈이 어디로 갔나」이므로 돈으로
            가중하는 게 맞습니다. <b>폭</b>을 같이 보세요: 한 종목이 끌어올린 +3%와 여덟 종목이
            고르게 오른 +3%는 완전히 다른 장입니다. <b>연속·유지</b>는 기록이 쌓여야 나옵니다.
          </div>
        </section>
      )}

      {/* ---------------- 걸린 종목 ---------------- */}
      {data && (
        <section className="card">
          <h2>걸린 종목 ({data.stocks.length})</h2>
          {data.stocks.length === 0 ? (
            <div className="page-note">조건에 맞는 종목이 없습니다.</div>
          ) : (
            <div className="data-table-wrap">
              <table className="data-table">
                <thead>
                  <tr>
                    <th className="sticky-col">종목</th>
                    <th>업종</th>
                    <th>등락률</th>
                    <th>거래대금</th>
                    <th title="전일 거래량 대비">거래량</th>
                    <th title="왜 걸렸나">이유</th>
                  </tr>
                </thead>
                <tbody>
                  {data.stocks.map((t) => (
                    <tr
                      className="clickable-row"
                      key={t.code}
                      onClick={() => onSelectStock?.(t.code, t.name)}
                    >
                      <td className="sticky-col">{t.name}</td>
                      {/* 업종을 모르는 종목도 목록에는 남는다 — 신규상장은 스냅샷이 아직 못 담는다 */}
                      <td className="pt-n">{t.sector || "-"}</td>
                      <td className={`num ${signClass(t.changeRate)}`}>{pct(t.changeRate)}</td>
                      <td className="num">{fmtNum(t.tradeValue)}억</td>
                      <td className="num">
                        {t.volumeRatio === null ? "-" : `${t.volumeRatio.toFixed(1)}배`}
                      </td>
                      <td>
                        {t.tags.map((g) => (
                          <span className="ls-tag" key={g}>
                            {g}
                          </span>
                        ))}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          <div className="table-note">
            <b>거래대금만 큰 종목은 안 넣습니다.</b> 삼성전자처럼 늘 상위에 있는 종목이 매일
            목록을 채우면, 오늘 새로 반응한 종목이 묻힙니다. 신고가·거래량급증·급등 중
            <b> 하나라도 걸려야</b> 들어옵니다. 종목을 누르면 신호등·차트·수급으로 갑니다.
          </div>
        </section>
      )}

      <LeaderTrackSection onSelectStock={onSelectStock} />
    </div>
  );
}

/**
 * 성적 — **「그때 뽑은 게 그 뒤 어떻게 됐나」.**
 *
 * 고르는 것만으로는 눈이 안 자란다. 골라 놓고 결과를 안 보면 **맞은 것만 기억**한다.
 * 진짜 물음은 「탐색기가 맞나」가 아니라 **「나는 어떤 종류의 신호를 잘 고르나」**다.
 */
function LeaderTrackSection({
  onSelectStock,
}: {
  onSelectStock?: (code: string, name: string) => void;
}) {
  const [data, setData] = useState<LeaderTrackResult | null>(null);
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setData(await api.leaderTrack());
    } catch (e) {
      setError(e instanceof Error ? e.message : "불러오지 못했습니다");
    } finally {
      setLoading(false);
    }
  }, []);

  /*
   * 열었을 때만 부른다. 종목마다 일봉을 받아야 해서 몇 십 초 걸린다 —
   * 탐색하러 온 날에도 매번 기다리게 하면 안 된다.
   */
  useEffect(() => {
    if (open && !data) void load();
  }, [open, data, load]);

  return (
    <section className="card">
      <h2 className="ls-track-h">
        성적 — 그때 뽑은 게 그 뒤 어떻게 됐나
        <button className="filter-btn" onClick={() => setOpen((v) => !v)}>
          {open ? "접기" : "펼치기"}
        </button>
        {open && (
          <button className="filter-btn" onClick={() => void load()} disabled={loading}>
            {loading ? "…" : "↻"}
          </button>
        )}
      </h2>

      {!open ? (
        <div className="page-note">
          탐색기가 매일 뽑아 둔 것을 <b>1·5·20·60거래일</b>까지 따라갑니다. 종목마다 일봉을
          받아야 해서 눌렀을 때만 조회합니다.
        </div>
      ) : (
        <>
          {loading && !data && <div className="empty">일봉을 받는 중… (종목당 약 0.3초)</div>}
          {error && <div className="error-banner">{error}</div>}
          {data && <div className="alert-note">{data.note}</div>}

          {data && data.overall.n > 0 && (
            <>
              <h3 className="section-heading">어떤 신호를 잘 고르나</h3>
              <StatTable rows={data.byTag} label="이유" />
              <div className="table-note">
                <b>이게 이 화면의 본론입니다.</b> 신고가로 걸린 것과 거래량 급증으로 걸린 것은
                성격이 완전히 다릅니다 — 어느 쪽이 내 손에 맞는지는 세어 봐야 압니다. 한 종목이
                태그를 여럿 달면 <b>각 태그에 모두</b> 들어갑니다.
              </div>

              {data.bySector.length > 0 && (
                <>
                  <h3 className="section-heading">섹터는 이어졌나</h3>
                  <StatTable rows={data.bySector} label="섹터" />
                  <div className="table-note">
                    그때 강했던 섹터가 <b>그 뒤에도 강했는지</b>가 「주도 섹터」와 「하루 반짝」을
                    가릅니다.
                  </div>
                </>
              )}

              <h3 className="section-heading">전체</h3>
              <StatTable rows={[data.overall]} label="구분" />
            </>
          )}

          {data && data.picks.length > 0 && (
            <>
              <h3 className="section-heading">뽑힌 것들 ({data.picks.length})</h3>
              <div className="data-table-wrap">
                <table className="data-table">
                  <thead>
                    <tr>
                      <th className="sticky-col">종목</th>
                      <th>편입일</th>
                      <th>편입가</th>
                      <th>이유</th>
                      {[1, 5, 20, 60].map((d) => (
                        <th key={d}>{d}일</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {data.picks.slice(0, 200).map((p) => (
                      <tr
                        className="clickable-row"
                        key={`${p.date}-${p.code}`}
                        onClick={() => onSelectStock?.(p.code, p.name)}
                      >
                        <td className="sticky-col">{p.name}</td>
                        <td>{p.date.slice(5)}</td>
                        <td className="num">{fmtNum(p.price)}</td>
                        <td>
                          {p.tags.map((g) => (
                            <span className="ls-tag" key={g}>
                              {g}
                            </span>
                          ))}
                        </td>
                        {[1, 5, 20, 60].map((d) => {
                          const o = p.outcomes.find((x) => x.days === d);
                          return (
                            <td className={`num ${o ? signClass(o.rate) : ""}`} key={d}>
                              {o ? `${o.rate > 0 ? "+" : ""}${o.rate.toFixed(2)}%` : "-"}
                            </td>
                          );
                        })}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <div className="table-note">
                빈 칸은 <b>아직 그만큼 지나지 않은 것</b>입니다. 결과는 편입 <b>다음</b> 거래일부터
                셉니다.
                {data.failed > 0 && ` · ${data.failed}종목은 일봉을 받지 못했습니다.`}
              </div>
            </>
          )}
        </>
      )}
    </section>
  );
}

/** 태그·섹터·전체가 같은 모양이라 표 하나로 그린다 */
function StatTable({ rows, label }: { rows: LeaderGroupStat[]; label: string }) {
  if (rows.length === 0) return <div className="page-note">아직 셀 것이 없습니다.</div>;
  return (
    <div className="data-table-wrap">
      <table className="data-table num">
        <thead>
          <tr>
            <th className="sticky-col">{label}</th>
            <th>기간</th>
            <th>건수</th>
            <th title="편입가보다 오른 비율">승률</th>
            <th>평균</th>
            <th title="몇 종목이 크게 튀면 평균이 거짓말을 한다">중앙값</th>
            <th>최고</th>
            <th>최저</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((g) =>
            g.byHorizon.map((h, i) => (
              <tr key={`${g.key}-${h.days}`} className={h.n === 0 ? "st-empty" : ""}>
                {i === 0 && (
                  <td className="sticky-col" rowSpan={g.byHorizon.length}>
                    <b>{g.key}</b>
                  </td>
                )}
                <td>{h.days}일</td>
                <td>{h.n}</td>
                <td className={h.n === 0 ? "" : h.winRate >= 50 ? "positive" : "negative"}>
                  {h.n === 0 ? "-" : `${h.winRate.toFixed(0)}%`}
                </td>
                <td className={h.n === 0 ? "" : signClass(h.avg)}>
                  {h.n === 0 ? "-" : `${h.avg > 0 ? "+" : ""}${h.avg.toFixed(2)}%`}
                </td>
                <td className={h.n === 0 ? "" : signClass(h.median)}>
                  {h.n === 0 ? "-" : `${h.median > 0 ? "+" : ""}${h.median.toFixed(2)}%`}
                </td>
                {/*
                  최고가 음수일 수 있다 — 그 기간에 오른 게 하나도 없으면 그렇다.
                  거기에 「+」를 붙이면 `+-5.37%` 가 된다. 부호는 값이 정하게 둔다.
                */}
                <td className={h.n === 0 ? "" : signClass(h.best)}>
                  {h.n === 0 ? "-" : `${h.best > 0 ? "+" : ""}${h.best.toFixed(2)}%`}
                </td>
                <td className={h.n === 0 ? "" : signClass(h.worst)}>
                  {h.n === 0 ? "-" : `${h.worst > 0 ? "+" : ""}${h.worst.toFixed(2)}%`}
                </td>
              </tr>
            )),
          )}
        </tbody>
      </table>
    </div>
  );
}
