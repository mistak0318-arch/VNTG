/**
 * 해외주식 풍부한 상세 (2026-09-07 밤) — 벤티지: "해외주식 눌렀을 때 나오는 정보가 굉장히 적어."
 * 서버 `/api/us-kiwoom/rich/:symbol` 한 덩어리를 받아 여섯 서브탭으로 나눈다:
 *   재무·실적(SEC EDGAR) · 밸류·의견(야후) · 수급 대체(기관·내부자·매물) · 뉴스(RSS + 한글 5줄) ·
 *   업종·동종(키움) · 국내 연동(우리 것). 출처를 칸마다 적고, 못 받은 조각은 「못 받음」으로 남긴다.
 */
import { useEffect, useState } from "react";
import { api, signClass, type UsRich, type FinPeriod } from "../../api";

export type UsRichTab = "fin" | "value" | "flow" | "news" | "sector" | "kr";

/** 달러 큰 수 — 1.23T / 45.6B / 789M */
export function usd(n: number | null | undefined, digits = 1): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return "-";
  const a = Math.abs(n);
  const s = n < 0 ? "−" : "";
  if (a >= 1e12) return `${s}$${(a / 1e12).toFixed(2)}T`;
  if (a >= 1e9) return `${s}$${(a / 1e9).toFixed(digits)}B`;
  if (a >= 1e6) return `${s}$${(a / 1e6).toFixed(digits)}M`;
  if (a >= 1e3) return `${s}$${(a / 1e3).toFixed(digits)}K`;
  return `${s}$${a.toFixed(2)}`;
}
const pct = (n: number | null | undefined, digits = 1, ratio = false): string => {
  if (n === null || n === undefined || !Number.isFinite(n)) return "-";
  const v = ratio ? n * 100 : n;
  return `${v > 0 ? "+" : ""}${v.toFixed(digits)}%`;
};
const numf = (n: number | null | undefined, digits = 2): string => (n === null || n === undefined || !Number.isFinite(n) ? "-" : n.toLocaleString(undefined, { maximumFractionDigits: digits }));
const qKo = (frame: string): string => {
  const m = frame.match(/^CY(\d{4})Q(\d)$/);
  if (m) return `${m[1].slice(2)}년 ${m[2]}분기`;
  const y = frame.match(/^CY(\d{4})$/);
  return y ? `${y[1]}년` : frame;
};

export function UsRichPanel({ symbol, tab }: { symbol: string; tab: UsRichTab }) {
  const [data, setData] = useState<UsRich | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [withSummary, setWithSummary] = useState(false);

  useEffect(() => {
    let alive = true;
    setData(null);
    setError(null);
    api
      .usRich(symbol, false)
      .then((d) => alive && setData(d))
      .catch((e: unknown) => alive && setError(e instanceof Error ? e.message : "조회 실패"));
    return () => {
      alive = false;
    };
  }, [symbol]);

  /* 뉴스 탭을 열 때만 한글 요약을 청한다 — 모델 호출은 하루 1회 캐시지만 열지도 않은 종목에 쓰지 않는다 */
  useEffect(() => {
    if (tab !== "news" || withSummary || !data) return;
    setWithSummary(true);
    api
      .usRich(symbol, true)
      .then((d) => setData(d))
      .catch(() => undefined);
  }, [tab, withSummary, data, symbol]);

  if (error) return <div className="page-note">{error}</div>;
  if (!data) return <div className="page-note">SEC · 야후 · 키움에 묻는 중… (첫 조회는 5초쯤)</div>;

  const miss = (part: string) => data.missing.find((m) => m.part === part);
  const Missing = ({ part }: { part: string }) => {
    const m = miss(part);
    return m ? (
      <div className="page-note">
        {part}: 못 받음 — {m.why}
      </div>
    ) : null;
  };

  if (tab === "fin") return <FinTab data={data} Missing={Missing} />;
  if (tab === "value") return <ValueTab data={data} Missing={Missing} />;
  if (tab === "flow") return <FlowTab data={data} Missing={Missing} />;
  if (tab === "news") return <NewsTab data={data} Missing={Missing} loadingKo={withSummary && data.newsKo === null && !miss("뉴스 한글 요약")} />;
  if (tab === "sector") return <SectorTab data={data} Missing={Missing} />;
  return <KrTab data={data} Missing={Missing} />;
}

type MissingC = ({ part }: { part: string }) => JSX.Element | null;

/* ── 재무·실적 ── */
function FinTab({ data, Missing }: { data: UsRich; Missing: MissingC }) {
  const f = data.financials;
  const op = data.opinion;
  const [mode, setMode] = useState<"q" | "y">("q");
  return (
    <div className="usr">
      {op && (
        <div className="usr-cards">
          <Card label="다음 실적 발표" v={op.nextEarnings || "-"} sub={op.nextEarningsIsEstimate ? "추정일" : "확정일"} src="야후" />
          <Card label="예상 EPS" v={numf(op.epsEstimateNext)} sub={op.revenueEstimateNext ? `예상 매출 ${usd(op.revenueEstimateNext)}` : ""} src="야후" />
          <Card label="최근 매출(TTM)" v={usd(op.revenueTtm)} sub={`성장 ${pct(op.revenueGrowth, 1, true)}`} src="야후" />
          <Card label="이익률" v={`${pct(op.profitMargin, 1, true)} 순`} sub={`영업 ${pct(op.operatingMargin, 1, true)} · 매출총 ${pct(op.grossMargin, 1, true)}`} src="야후" />
        </div>
      )}
      {op && op.epsHistory.length > 0 && (
        <>
          <h4 className="usr-h">
            분기 EPS — 실적 vs 예상 <i>야후</i>
          </h4>
          <div className="usr-eps">
            {op.epsHistory.map((h) => (
              <div key={h.quarter} className={`usr-eps-c ${h.surprisePct !== null ? (h.surprisePct >= 0 ? "beat" : "miss") : ""}`}>
                <span>{h.quarter.slice(2, 7).replace("-", ".")}</span>
                <b>{numf(h.actual)}</b>
                <small>예상 {numf(h.estimate)}</small>
                <em>{h.surprisePct !== null ? `${h.surprisePct >= 0 ? "▲" : "▼"} ${Math.abs(h.surprisePct).toFixed(1)}%` : ""}</em>
              </div>
            ))}
          </div>
        </>
      )}
      <Missing part="SEC EDGAR 재무" />
      {f && (
        <>
          <div className="usr-hrow">
            <h4 className="usr-h">
              재무제표 <i>SEC EDGAR · {f.entity}</i>
            </h4>
            <span className="kb-seg">
              <button type="button" className={mode === "q" ? "on" : ""} onClick={() => setMode("q")}>
                분기
              </button>
              <button type="button" className={mode === "y" ? "on" : ""} onClick={() => setMode("y")}>
                연간
              </button>
            </span>
          </div>
          <FinBars rows={mode === "q" ? f.quarterly : f.annual} />
          <FinTable rows={mode === "q" ? f.quarterly : f.annual} />
          <div className="table-note">
            분기는 XBRL frame 이 CYyyyyQn 인 값만(누적치 제외). 영업현금흐름은 분기 단독 값이 없는 회사가 많다. 개념:{" "}
            {Object.entries(f.concepts)
              .map(([k, v]) => `${k}=${v}`)
              .join(" · ")}
          </div>
        </>
      )}
    </div>
  );
}

function FinBars({ rows }: { rows: FinPeriod[] }) {
  if (rows.length === 0) return <div className="page-note">기간 값이 없다</div>;
  const max = Math.max(1, ...rows.map((r) => Math.max(r.revenue ?? 0, r.netIncome ?? 0)));
  return (
    <div className={`usr-bars${rows.length === 8 ? " n8" : ""}`}>
      {rows.map((r, i) => {
        const prev = rows[i - 1];
        const yoy = mode4(rows, i);
        return (
          <div key={r.frame} className="usr-bar">
            <div className="usr-bar-stack">
              <i className="rev" style={{ height: `${((r.revenue ?? 0) / max) * 100}%` }} title={`매출 ${usd(r.revenue)}`} />
              <i className={`ni${(r.netIncome ?? 0) < 0 ? " neg" : ""}`} style={{ height: `${(Math.abs(r.netIncome ?? 0) / max) * 100}%` }} title={`순이익 ${usd(r.netIncome)}`} />
            </div>
            <span className="usr-bar-l">{qKo(r.frame)}</span>
            <small>{usd(r.revenue, 0)}</small>
            {yoy !== null && <em className={signClass(yoy)}>{pct(yoy, 0)}</em>}
            {!yoy && prev && r.revenue && prev.revenue ? <em className={signClass(r.revenue - prev.revenue)}>{pct(((r.revenue - prev.revenue) / prev.revenue) * 100, 0)}</em> : null}
          </div>
        );
      })}
      <div className="usr-bars-legend">
        <i className="rev" /> 매출 <i className="ni" /> 순이익 · 숫자는 매출, %는 전년동기(분기)·전년(연간) 대비
      </div>
    </div>
  );
}
/** 분기면 4개 전(전년동기), 연간이면 1개 전 대비 매출 성장률 */
function mode4(rows: FinPeriod[], i: number): number | null {
  const r = rows[i];
  const isQ = /Q\d$/.test(r.frame);
  const j = isQ ? i - 4 : i - 1;
  if (j < 0) return null;
  const p = rows[j];
  if (!p.revenue || !r.revenue) return null;
  return ((r.revenue - p.revenue) / p.revenue) * 100;
}

function FinTable({ rows }: { rows: FinPeriod[] }) {
  const show = [...rows].reverse();
  return (
    <div className="ord-scroll">
      <table className="ord-table usr-table">
        <thead>
          <tr>
            <th>기간</th>
            <th className="r">매출</th>
            <th className="r">영업이익</th>
            <th className="r">순이익</th>
            <th className="r">EPS</th>
            <th className="r">영업현금</th>
            <th className="r">자산 / 부채</th>
            <th className="r">자본</th>
          </tr>
        </thead>
        <tbody>
          {show.map((r) => (
            <tr key={r.frame}>
              <td>
                {qKo(r.frame)} <span className="ord-code">{r.end.slice(2)}</span>
              </td>
              <td className="r">{usd(r.revenue)}</td>
              <td className={`r ${signClass(r.operatingIncome ?? 0)}`}>{usd(r.operatingIncome)}</td>
              <td className={`r ${signClass(r.netIncome ?? 0)}`}>{usd(r.netIncome)}</td>
              <td className={`r ${signClass(r.eps ?? 0)}`}>{numf(r.eps)}</td>
              <td className="r">{usd(r.operatingCashFlow)}</td>
              <td className="r">
                {usd(r.assets, 0)} / {usd(r.liabilities, 0)}
              </td>
              <td className="r">{usd(r.equity, 0)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/* ── 밸류·의견 ── */
function ValueTab({ data, Missing }: { data: UsRich; Missing: MissingC }) {
  const op = data.opinion;
  const ex = data.extra;
  if (!op) return <Missing part="야후 의견·실적" />;
  const recKo: Record<string, string> = { strong_buy: "적극 매수", buy: "매수", hold: "보유", underperform: "비중 축소", sell: "매도" };
  const upside = op.currentPrice && op.targetMean ? ((op.targetMean - op.currentPrice) / op.currentPrice) * 100 : null;
  const t0 = op.trend[0];
  const tot = t0 ? t0.strongBuy + t0.buy + t0.hold + t0.sell + t0.strongSell : 0;
  return (
    <div className="usr">
      <div className="usr-cards">
        <Card label="애널리스트 목표가(평균)" v={op.targetMean !== null ? `$${numf(op.targetMean)}` : "-"} sub={upside !== null ? `지금 대비 ${pct(upside)} · ${op.analysts ?? "?"}명` : ""} src="야후" cls={signClass(upside ?? 0)} />
        <Card label="목표가 범위" v={op.targetLow !== null && op.targetHigh !== null ? `$${numf(op.targetLow, 0)} ~ $${numf(op.targetHigh, 0)}` : "-"} sub={op.targetMedian !== null ? `중앙값 $${numf(op.targetMedian, 0)}` : ""} src="야후" />
        <Card label="투자의견" v={recKo[op.recommendationKey] ?? op.recommendationKey ?? "-"} sub={op.recommendationMean !== null ? `평점 ${op.recommendationMean.toFixed(2)} (1 적극매수 ~ 5 매도)` : ""} src="야후" />
        <Card label="선행 PER · PEG" v={`${numf(op.forwardPE, 1)} · ${numf(op.peg, 2)}`} sub={`후행 PER ${numf(op.trailingPE, 1)}`} src="야후" />
        <Card label="베타 · 숏" v={`β ${numf(op.beta, 2)}`} sub={`숏 비율 ${numf(op.shortRatio, 1)}일 · 유동주식의 ${pct(op.shortPctFloat, 1, true)}`} src="야후" />
        <Card label="EV / EBITDA" v={numf(op.evToEbitda, 1)} sub={`EV ${usd(op.enterpriseValue)} · FCF ${usd(op.freeCashflow)}`} src="야후" />
        <Card label="ROE · 부채/자본" v={pct(op.returnOnEquity, 1, true)} sub={`D/E ${numf(op.debtToEquity, 1)}`} src="야후" />
        {ex && (ex.uncertainty || ex.competitiveAdvantage) && <Card label="불확실성 · 경쟁우위" v={`${ex.uncertainty || "-"} · ${ex.competitiveAdvantage || "-"}`} sub="키움(모닝스타 등급)" src="키움" />}
      </div>
      {t0 && tot > 0 && (
        <>
          <h4 className="usr-h">
            의견 분포 (최근 3개월 변화) <i>야후</i>
          </h4>
          <div className="usr-trend">
            {op.trend.map((t) => {
              const n = t.strongBuy + t.buy + t.hold + t.sell + t.strongSell || 1;
              return (
                <div key={t.period} className="usr-trend-row">
                  <span>{t.period === "0m" ? "지금" : `${t.period.replace("-", "")} 전`}</span>
                  <div className="usr-trend-bar">
                    <i className="sb" style={{ width: `${(t.strongBuy / n) * 100}%` }} title={`적극매수 ${t.strongBuy}`} />
                    <i className="b" style={{ width: `${(t.buy / n) * 100}%` }} title={`매수 ${t.buy}`} />
                    <i className="h" style={{ width: `${(t.hold / n) * 100}%` }} title={`보유 ${t.hold}`} />
                    <i className="s" style={{ width: `${(t.sell / n) * 100}%` }} title={`매도 ${t.sell}`} />
                    <i className="ss" style={{ width: `${(t.strongSell / n) * 100}%` }} title={`적극매도 ${t.strongSell}`} />
                  </div>
                  <small>
                    {t.strongBuy + t.buy}매수 · {t.hold}보유 · {t.sell + t.strongSell}매도
                  </small>
                </div>
              );
            })}
          </div>
        </>
      )}
      {op.profile.summary && (
        <>
          <h4 className="usr-h">
            회사 <i>야후</i>
          </h4>
          <div className="usr-profile">
            <div className="usr-profile-meta">
              {op.profile.sector} › {op.profile.industry}
              {op.profile.employees ? ` · 직원 ${op.profile.employees.toLocaleString()}명` : ""}
              {op.profile.city ? ` · ${op.profile.city}, ${op.profile.country}` : ""}
              {op.profile.website && (
                <>
                  {" · "}
                  <a href={op.profile.website} target="_blank" rel="noreferrer">
                    {op.profile.website.replace(/^https?:\/\//, "")}
                  </a>
                </>
              )}
            </div>
            <p>{op.profile.summary}</p>
          </div>
        </>
      )}
    </div>
  );
}

/* ── 수급 대체 ── */
function FlowTab({ data, Missing }: { data: UsRich; Missing: MissingC }) {
  const op = data.opinion;
  return (
    <div className="usr">
      <div className="page-note">미국엔 외국인·기관 순매수 같은 일별 수급이 없다. 대신 보유 구조와 내부자 매매로 본다.</div>
      <Missing part="야후 의견·실적" />
      {op && (
        <>
          <div className="usr-cards">
            <Card label="기관 보유" v={pct(op.holders.institutionsPct, 1, true).replace("+", "")} sub={op.holders.institutionsCount ? `${op.holders.institutionsCount.toLocaleString()}개 기관` : ""} src="야후" />
            <Card label="내부자 보유" v={pct(op.holders.insidersPct, 2, true).replace("+", "")} sub="임원·이사·10% 주주" src="야후" />
            <Card label="유동주식" v={op.floatShares ? `${(op.floatShares / 1e9).toFixed(2)}B주` : "-"} sub={`숏 비율 ${numf(op.shortRatio, 1)}일`} src="야후" />
          </div>
          <h4 className="usr-h">
            최근 내부자 매매 <i>야후 · SEC Form 4</i>
          </h4>
          {op.insiders.length === 0 ? (
            <div className="page-note">최근 내부자 매매가 없다</div>
          ) : (
            <div className="ord-scroll">
              <table className="ord-table usr-table">
                <thead>
                  <tr>
                    <th>날짜</th>
                    <th>누구</th>
                    <th>무엇</th>
                    <th className="r">주식</th>
                    <th className="r">금액</th>
                  </tr>
                </thead>
                <tbody>
                  {op.insiders.map((t, i) => {
                    const sell = /sale|sold/i.test(t.text);
                    const buy = /purchase|bought|buy/i.test(t.text);
                    return (
                      <tr key={i}>
                        <td>{t.date}</td>
                        <td>
                          {t.name} <span className="ord-code">{t.relation}</span>
                        </td>
                        <td className={sell ? "negative" : buy ? "positive" : ""}>{t.text}</td>
                        <td className="r">{t.shares !== null ? t.shares.toLocaleString() : "-"}</td>
                        <td className="r">{usd(t.value)}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </>
      )}
    </div>
  );
}

/* ── 뉴스 ── */
function NewsTab({ data, Missing, loadingKo }: { data: UsRich; Missing: MissingC; loadingKo: boolean }) {
  const list = data.news ?? [];
  const ago = (iso: string) => {
    if (!iso) return "";
    const h = (Date.now() - Date.parse(iso)) / 3600_000;
    return h < 1 ? `${Math.max(1, Math.round(h * 60))}분 전` : h < 48 ? `${Math.round(h)}시간 전` : `${Math.round(h / 24)}일 전`;
  };
  return (
    <div className="usr">
      <Missing part="야후 뉴스" />
      <div className="usr-newsko">
        <h4 className="usr-h">
          밤사이 5줄 <i>제목 묶음을 모델이 요약 · 하루 1회</i>
        </h4>
        {data.newsKo ? (
          <ol>
            {data.newsKo
              .split(/\n+/)
              .filter(Boolean)
              .slice(0, 6)
              .map((l, i) => (
                <li key={i}>{l.replace(/^\d+[.)]\s*/, "")}</li>
              ))}
          </ol>
        ) : loadingKo ? (
          <div className="page-note">요약하는 중…</div>
        ) : (
          <Missing part="뉴스 한글 요약" />
        )}
      </div>
      {list.length === 0 ? (
        <div className="page-note">뉴스가 없다</div>
      ) : (
        <ul className="usr-news">
          {list.map((n, i) => (
            <li key={i}>
              <a href={n.link} target="_blank" rel="noreferrer">
                {n.title}
              </a>
              <small>
                {n.source} · {ago(n.at)}
              </small>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/* ── 업종·동종 ── */
function SectorTab({ data, Missing }: { data: UsRich; Missing: MissingC }) {
  const s = data.sector;
  const rows = [s?.sm, s?.lg].filter((x): x is NonNullable<typeof x> => Boolean(x));
  return (
    <div className="usr">
      <Missing part="업종 수익률" />
      {rows.length > 0 && (
        <>
          <h4 className="usr-h">
            업종 기간 수익률 <i>키움</i>
          </h4>
          <div className="ord-scroll">
            <table className="ord-table usr-table">
              <thead>
                <tr>
                  <th>업종</th>
                  <th className="r">1일</th>
                  <th className="r">5일</th>
                  <th className="r">1개월</th>
                  <th className="r">3개월</th>
                  <th className="r">6개월</th>
                  <th className="r">YTD</th>
                  <th className="r">1년</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.code}>
                    <td>{r.name}</td>
                    {[r.d1, r.d5, r.m1, r.m3, r.m6, r.ytd, r.y1].map((v, i) => (
                      <td key={i} className={`r ${signClass(v ?? 0)}`}>
                        {pct(v)}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
      <Missing part="동종(업종 등락 상하위)" />
      {data.peers && data.peers.length > 0 && (
        <>
          <h4 className="usr-h">
            같은 업종 오늘 상위·하위 <i>키움 · {s?.sm?.name}</i>
          </h4>
          <div className="usr-peers">
            {data.peers.map((p) => (
              <div key={p.symbol} className={`usr-peer ${signClass(p.changeRate ?? 0)}`}>
                <b>{p.symbol}</b>
                <span>{p.name}</span>
                <em>{pct(p.changeRate, 2)}</em>
                <small>${numf(p.price)}</small>
              </div>
            ))}
          </div>
        </>
      )}
      {s && s.all.length > 0 && (
        <details className="usr-details">
          <summary>전체 업종 {s.all.length}개 YTD 순</summary>
          <div className="ord-scroll">
            <table className="ord-table usr-table">
              <tbody>
                {[...s.all]
                  .sort((a, b) => (b.ytd ?? -999) - (a.ytd ?? -999))
                  .map((r) => (
                    <tr key={r.code} className={r.code === s.sm?.code ? "usr-me" : ""}>
                      <td>{r.name}</td>
                      <td className={`r ${signClass(r.d1 ?? 0)}`}>{pct(r.d1)}</td>
                      <td className={`r ${signClass(r.m1 ?? 0)}`}>{pct(r.m1)}</td>
                      <td className={`r ${signClass(r.ytd ?? 0)}`}>{pct(r.ytd)}</td>
                    </tr>
                  ))}
              </tbody>
            </table>
          </div>
        </details>
      )}
    </div>
  );
}

/* ── 국내 연동 ── */
function KrTab({ data, Missing }: { data: UsRich; Missing: MissingC }) {
  const rows = data.krLinks ?? [];
  return (
    <div className="usr">
      <Missing part="국내 연동" />
      {rows.length === 0 ? (
        <div className="page-note">이 종목에 걸어 둔 한국 관련주가 없다 — 「미국 ↔ 한국」 매핑에서 추가할 수 있다</div>
      ) : (
        rows.map((l) => (
          <div key={l.label} className="usr-kr">
            <div className="usr-kr-head">
              <b>{l.label}</b>
              {l.nextDay !== null && (
                <small>
                  미국 D → 국내 D+1 상관 {l.nextDay.toFixed(2)} · 기울기 {l.beta !== null ? l.beta.toFixed(2) : "-"} · 표본 {l.samples}일
                </small>
              )}
            </div>
            <div className="usr-kr-themes">
              {l.krThemes.map((t) => (
                <span key={t.name} className={`usr-peer ${signClass(t.changeRate ?? 0)}`}>
                  <b>{t.name}</b>
                  <em>{t.changeRate !== null ? pct(t.changeRate, 2) : "장 밖"}</em>
                </span>
              ))}
            </div>
            {l.gap !== null && <div className="table-note">미국 대비 국내가 {l.gap >= 0 ? "더" : "덜"} 반영 — 차이 {pct(l.gap, 2)}p</div>}
          </div>
        ))
      )}
    </div>
  );
}

function Card({ label, v, sub, src, cls }: { label: string; v: string; sub?: string; src: string; cls?: string }) {
  return (
    <div className="usr-card">
      <span className="usr-card-l">
        {label} <i>{src}</i>
      </span>
      <b className={cls ?? ""}>{v}</b>
      {sub && <small>{sub}</small>}
    </div>
  );
}
