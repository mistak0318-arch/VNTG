import { useCallback, useEffect, useState } from "react";
import { api, signClass, type BetBacktest, type BetLogSummary, type BetVerdict } from "../api";

/**
 * 종가배팅 연습기 — **종가에 샀다고 치고 다음날 채점한다.**
 *
 * 화면은 위에서 아래로 세 층이다.
 *   ① 지금 조건    — 오늘 사도 되는 자리인가
 *   ② 과거 검증    — 이 조건이 과거에 통했나
 *   ③ 실전 추적    — 앞으로도 통하나 · 시장이 바뀌었나
 *
 * ①이 판단, ②가 근거, ③이 검증이다.
 */

function pct(v: number, unit = "%"): string {
  return `${v > 0 ? "+" : ""}${v.toFixed(2)}${unit}`;
}

const DEFAULT_CODES = "005930:삼성전자,000660:SK하이닉스";

export function CloseBetPanel() {
  const [verdicts, setVerdicts] = useState<BetVerdict[] | null>(null);
  const [gaugeDate, setGaugeDate] = useState("");

  const [codes, setCodes] = useState(DEFAULT_CODES);
  const [days, setDays] = useState(250);
  const [futuresMin, setFuturesMin] = useState(0);
  /*
   * 금리 문턱은 **상승폭 상한**(bp)이다. 절대값이 아니다 —
   * 금리가 크게 내린 날은 종가배팅에 좋은 자리라 버리면 안 된다.
   */
  const [y10Max, setY10Max] = useState(6);
  const [y30Max, setY30Max] = useState(8);
  const [bt, setBt] = useState<Record<string, BetBacktest | null>>({ krx: null, nxt: null });
  const [btLoading, setBtLoading] = useState(false);

  const [log, setLog] = useState<BetLogSummary | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api
      .betGauge()
      .then((r) => {
        setVerdicts(r.verdicts);
        setGaugeDate(r.day.date);
      })
      .catch(() => setVerdicts([]));
    api.betLog().then(setLog).catch(() => setLog(null));
  }, []);

  /*
   * 검증은 **눌렀을 때만**. 종목마다 일봉을 받아야 해서 몇 십 초 걸린다.
   * KRX·NXT 를 같이 받는다 — 견주는 게 요점이라 하나만 보면 뜻이 없다.
   */
  const runBacktest = useCallback(async () => {
    setBtLoading(true);
    setError(null);
    try {
      const [krx, nxt] = await Promise.all([
        api.betBacktest(codes, days, "krx", futuresMin, y10Max, y30Max),
        api.betBacktest(codes, days, "nxt", futuresMin, y10Max, y30Max),
      ]);
      setBt({ krx, nxt });
    } catch (e) {
      setError(e instanceof Error ? e.message : "검증 실패");
    } finally {
      setBtLoading(false);
    }
  }, [codes, days, futuresMin, y10Max, y30Max]);

  return (
    <div className="cb">
      <HowTo />

      {error && <div className="error-banner">{error}</div>}

      {/* ---------------- ① 지금 조건 ---------------- */}
      <section className="card">
        <h2>지금 조건 {gaugeDate && <span className="pt-n">{gaugeDate}</span>}</h2>
        {verdicts === null ? (
          <div className="empty">불러오는 중…</div>
        ) : verdicts.length === 0 ? (
          <div className="page-note">시장 조건을 받지 못했습니다.</div>
        ) : (
          <div className="cb-gauges">
            {verdicts.map((v) => (
              <div className={`cb-gauge ${v.level}`} key={v.key}>
                <div className="cb-gauge-l">
                  {v.label}
                  {/* 변동률만 보면 수준을 모른다 — 유가가 60달러대인지 90달러대인지 */}
                  {v.price && <b className="cb-gauge-p">{v.price}</b>}
                </div>
                <div className="cb-gauge-v">{v.value}</div>
                <div className="cb-gauge-w">{v.why}</div>
              </div>
            ))}
          </div>
        )}
        <div className="table-note">
          선물은 <b>몸통</b>(종가−시가)으로 봅니다 — 「양봉」의 뜻은 <b>장중에 올라서 끝났다</b>는
          것이지 전일 대비가 아닙니다. 갭으로 뜬 뒤 하루 내내 흘러내린 날은 플러스여도
          양봉이 아닙니다.
          <b> 장 마감 무렵에 보이는 선물은 미국 정규장 전</b>이라 그 밤을 다 담지 못합니다.
        </div>
      </section>

      {/* ---------------- ② 과거 검증 ---------------- */}
      <section className="card">
        <h2>과거 검증</h2>
        <div className="st-cfg-row">
          <span className="st-cfg-k">종목</span>
          <input
            type="text"
            className="ep-wide"
            value={codes}
            onChange={(e) => setCodes(e.target.value)}
            placeholder="005930:삼성전자,000660:SK하이닉스"
          />
        </div>
        <div className="st-cfg-row">
          <span className="st-cfg-k">기간·문턱</span>
          <span>
            최근{" "}
            <input
              type="number"
              min={20}
              max={400}
              step={10}
              value={days}
              onChange={(e) => setDays(Number(e.target.value))}
            />
            거래일 · 선물 몸통{" "}
            <input
              type="number"
              step={0.25}
              value={futuresMin}
              onChange={(e) => setFuturesMin(Number(e.target.value))}
            />
            % 이상
          </span>
        </div>
        <div className="st-cfg-row">
          <span className="st-cfg-k">금리 상승 한도</span>
          <span>
            10년물{" "}
            <input
              type="number"
              step={1}
              value={y10Max}
              onChange={(e) => setY10Max(Number(e.target.value))}
            />
            bp · 30년물{" "}
            <input
              type="number"
              step={1}
              value={y30Max}
              onChange={(e) => setY30Max(Number(e.target.value))}
            />
            bp <b>이하 상승</b>인 날만
          </span>
        </div>
        <div className="table-note">
          금리는 <b>오를 때만</b> 막습니다. 내린 날은 폭이 커도 통과합니다 — 금리 하락은
          주식에 좋은 쪽이라, 절대값으로 막으면 <b>좋은 날까지 같이 버립니다</b>.
          문턱을 크게(예: 999) 주면 조건을 안 거는 것과 같습니다.
        </div>
        <div className="filter-row">
          <button className="primary-btn" onClick={() => void runBacktest()} disabled={btLoading}>
            {btLoading ? "일봉 받는 중… (종목당 약 0.5초)" : "검증하기"}
          </button>
        </div>

        {(["krx", "nxt"] as const).map((v) => {
          const r = bt[v];
          if (!r) return null;
          return (
            <div className="cb-bt" key={v}>
              <h3 className="section-heading">
                {v === "krx" ? "KRX 정규장 마감 매수 (15:20 무렵)" : "NXT 마감 매수 (19:50 무렵)"}
              </h3>
              <div className="data-table-wrap">
                <table className="data-table num">
                  <thead>
                    <tr>
                      <th className="sticky-col">선물</th>
                      <th>건수</th>
                      <th title="다음날 시가에 팔았을 때">시가 승률</th>
                      <th>시가 평균</th>
                      <th title="같은 날 코스피 대비. 이게 없으면 시장이 오른 건지 종목을 고른 건지 모른다">
                        코스피 대비
                      </th>
                      <th>초과 승률</th>
                    </tr>
                  </thead>
                  <tbody>
                    {[r.matched, r.unmatched].map((s, i) => (
                      <tr key={s.key}>
                        <td className="sticky-col">{i === 0 ? "양봉" : "음봉"}</td>
                        <td>{s.n}</td>
                        <td className={s.openWin >= 50 ? "positive" : "negative"}>
                          {s.openWin.toFixed(0)}%
                        </td>
                        <td className={signClass(s.openAvg)}>{pct(s.openAvg)}</td>
                        <td className={signClass(s.openExcess)}>
                          <b>{pct(s.openExcess, "%p")}</b>
                        </td>
                        <td className={s.excessWin >= 50 ? "positive" : "negative"}>
                          {s.excessWin.toFixed(0)}%
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>

              {/*
                조건 하나씩 따로 — **어느 조건이 실제로 일을 하나.**
                위의 「조건 맞음/안 맞음」은 넷을 한꺼번에 건 결과라, 성적이 좋아도
                그게 선물 덕인지 금리 덕인지 알 수 없다. 여기서 갈린다.
                조건을 걸었는데 「전체」와 「코스피 대비」가 같으면 그 조건은 아무 일도 안 한 것이다.
              */}
              {r.perCondition.length > 0 && (
                <div className="data-table-wrap">
                  <table className="data-table num">
                    <thead>
                      <tr>
                        <th className="sticky-col">조건 하나씩</th>
                        <th>건수</th>
                        <th>시가 승률</th>
                        <th>시가 평균</th>
                        <th title="같은 날 코스피 대비. 조건을 걸어도 이 값이 안 오르면 그 조건은 쓸모가 없다">
                          코스피 대비
                        </th>
                      </tr>
                    </thead>
                    <tbody>
                      {r.perCondition.map((s) => (
                        <tr key={s.key} className={s.n === 0 ? "st-empty" : ""}>
                          <td className="sticky-col">{s.key}</td>
                          <td>{s.n}</td>
                          <td className={s.n === 0 ? "" : s.openWin >= 50 ? "positive" : "negative"}>
                            {s.n === 0 ? "-" : `${s.openWin.toFixed(0)}%`}
                          </td>
                          <td className={s.n === 0 ? "" : signClass(s.openAvg)}>
                            {s.n === 0 ? "-" : pct(s.openAvg)}
                          </td>
                          <td className={s.n === 0 ? "" : signClass(s.openExcess)}>
                            <b>{s.n === 0 ? "-" : pct(s.openExcess, "%p")}</b>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          );
        })}

        {(bt.krx || bt.nxt) && (
          <div className="table-note">
            <b>「코스피 대비」가 이 표의 결론입니다.</b> 승률이 70%여도 코스피 대비가 0 근처면
            종목을 고를 이유가 없습니다 — 지수 ETF 가 낫습니다.
            <b> 생존편향</b>이 있습니다: 지금 고른 종목의 과거만 보므로 그동안 망한 종목은
            안 들어옵니다.
          </div>
        )}
      </section>

      {/* ---------------- ③ 실전 추적 ---------------- */}
      <section className="card">
        <h2>실전 추적</h2>
        {!log ? (
          <div className="empty">불러오는 중…</div>
        ) : (
          <>
            <div className="alert-note">{log.note}</div>
            <div className="filter-row">
              <span className="pt-n">
                추적 종목 {log.watch.map((w) => w.name).join(", ")} · 기록 {log.days}일 · 채점{" "}
                {log.scored}일
              </span>
              <button
                className="filter-btn"
                onClick={() => void api.betLogRun().then(() => api.betLog().then(setLog))}
              >
                지금 기록
              </button>
            </div>

            {log.periods.some((p) => p.matched.n > 0) && (
              <div className="data-table-wrap">
                <table className="data-table num">
                  <thead>
                    <tr>
                      <th className="sticky-col">구간</th>
                      <th>선물</th>
                      <th>건수</th>
                      <th>시가 승률</th>
                      <th>시가 평균</th>
                      <th>코스피 대비</th>
                    </tr>
                  </thead>
                  <tbody>
                    {log.periods.map((p) =>
                      [p.matched, p.unmatched].map((s, i) => (
                        <tr key={`${p.label}-${i}`} className={s.n === 0 ? "st-empty" : ""}>
                          {i === 0 && (
                            <td className="sticky-col" rowSpan={2}>
                              <b>{p.label}</b>
                            </td>
                          )}
                          <td>{i === 0 ? "양봉" : "음봉"}</td>
                          <td>{s.n}</td>
                          <td className={s.n === 0 ? "" : s.openWin >= 50 ? "positive" : "negative"}>
                            {s.n === 0 ? "-" : `${s.openWin.toFixed(0)}%`}
                          </td>
                          <td className={s.n === 0 ? "" : signClass(s.openAvg)}>
                            {s.n === 0 ? "-" : pct(s.openAvg)}
                          </td>
                          <td className={s.n === 0 ? "" : signClass(s.openExcess)}>
                            {s.n === 0 ? "-" : pct(s.openExcess, "%p")}
                          </td>
                        </tr>
                      )),
                    )}
                  </tbody>
                </table>
              </div>
            )}

            <div className="table-note">
              <b>전체와 최근 20일이 다르면 시장 성격이 바뀐 것</b>입니다. 그때는 조건을 다시
              봐야 합니다. 통계는 <b>장 마감 때 보이던 선물</b> 기준입니다 — 실전에서 쓸 수
              있는 게 그것뿐입니다.
            </div>

            {log.recent.length > 0 && (
              <>
                <h3 className="section-heading">최근 기록</h3>
                <div className="data-table-wrap">
                  <table className="data-table num">
                    <thead>
                      <tr>
                        <th className="sticky-col">날짜</th>
                        <th>선물</th>
                        <th>종목</th>
                        <th>KRX 종가</th>
                        <th>NXT 종가</th>
                        <th title="다음날 시가">KRX 성적</th>
                        <th>NXT 성적</th>
                      </tr>
                    </thead>
                    <tbody>
                      {log.recent.flatMap((d) =>
                        d.stocks.map((s, i) => (
                          <tr key={`${d.date}-${s.code}`}>
                            {i === 0 && (
                              <td className="sticky-col" rowSpan={d.stocks.length}>
                                {d.date.slice(5)}
                              </td>
                            )}
                            {i === 0 && (
                              <td rowSpan={d.stocks.length} className={signClass(d.atClose?.futuresBody ?? 0)}>
                                {d.atClose?.futuresBody === undefined || d.atClose === null
                                  ? "-"
                                  : pct(d.atClose.futuresBody ?? 0)}
                              </td>
                            )}
                            <td>{s.name}</td>
                            <td>{s.close.toLocaleString("ko-KR")}</td>
                            <td>{s.nxtClose ? s.nxtClose.toLocaleString("ko-KR") : "-"}</td>
                            <td className={s.openRate === null ? "" : signClass(s.openRate)}>
                              {s.openRate === null ? "대기" : pct(s.openRate)}
                            </td>
                            <td className={s.nxtOpenRate === null ? "" : signClass(s.nxtOpenRate)}>
                              {s.nxtOpenRate === null ? "대기" : pct(s.nxtOpenRate)}
                            </td>
                          </tr>
                        )),
                      )}
                    </tbody>
                  </table>
                </div>
                <div className="table-note">
                  「대기」는 아직 다음 거래일이 안 온 것입니다. 평일 <b>15:35</b> 에 자동으로
                  찍고 다음 거래일에 채점합니다.
                </div>
              </>
            )}
          </>
        )}
      </section>
    </div>
  );
}

/** 매매기법 설명 — 접어 둔다 */
function HowTo() {
  return (
    <details className="ep-howto">
      <summary>종가배팅이란 — 어떻게 쓰나</summary>
      <div className="ep-howto-body">
        <p>
          <b>장 마감 무렵에 사서 다음날 아침에 파는 방식</b>입니다. 하룻밤만 들고 갑니다.
        </p>

        <h4>왜 미국 선물을 보나</h4>
        <p>
          한국 종가에 사면 <b>그날 밤 미국장을 지나</b> 다음날 아침을 맞습니다. 그 밤의 방향을
          미리 알려주는 게 미국 선물입니다. 「글로벌 시황지수」에 뜨는 그 값입니다.
        </p>
        <p className="ep-warn">
          ⚠️ <b>장 마감 무렵의 선물은 미완성입니다.</b> 15:30(한국)은 미 동부 02:30이라 정규장이
          7시간 남았습니다. 그래서 <b>실전에서 볼 수 있는 값</b>과 <b>다음날 확정된 값</b>을
          따로 찍어 견줍니다 — 확정값으로 낸 성적은 결과를 알고 본 숫자입니다.
        </p>

        <h4>어디서 사느냐도 전략이다</h4>
        <ul>
          <li>
            <b>KRX 15:20 무렵</b> — 선물 정보는 적지만 호가가 두텁습니다
          </li>
          <li>
            <b>NXT 19:50 무렵</b> — 미국 프리마켓이 세 시간 돌아 방향이 더 보입니다. 대신
            호가가 얇아 <b>페이크에 걸리기 쉽습니다</b>
          </li>
        </ul>
        <p>
          실측(삼성전자 10일)에서 두 종가가 <b>8일이나 달랐고</b> 하루는 10,000원(약 4%)
          벌어졌습니다. 그래서 둘을 갈라서 잽니다.
        </p>

        <h4>이 화면을 읽는 법</h4>
        <ol>
          <li>
            <b>「코스피 대비」가 결론입니다.</b> 승률 70%여도 코스피 대비가 0 근처면 종목을
            고를 이유가 없습니다 — 지수 ETF 가 낫습니다.
          </li>
          <li>
            <b>문턱을 올리면 좋아 보이지만 표본이 녹습니다.</b> 36건짜리 89%는 과최적화입니다.
          </li>
          <li>
            <b>전체와 최근 20일을 견주세요.</b> 다르면 시장 성격이 바뀐 것입니다.
          </li>
        </ol>
        <p className="ep-warn">
          <b>이 앱은 주문을 넣지 않습니다.</b> 연습기이고 검증 도구입니다.
        </p>
      </div>
    </details>
  );
}
