import { useEffect, useState } from "react";
import { api, normalizeStockCode, type TradeSummary } from "../api";

/**
 * 수출입 동향.
 *
 * 오늘 등락률만 보면 왜 오르는지 모른다. 수출이 같이 늘고 있으면 근거가 있는 강세고,
 * **수출이 꺾이는데 지수만 오르면 그게 짚어야 할 신호다.**
 *
 * 관세청 데이터는 월 단위 갱신이라 매일 볼 것은 아니지만,
 * 섹터를 고를 때 한 번 확인하면 판단이 달라진다.
 */

function pct(n: number | null): string {
  if (n === null) return "-";
  return `${n > 0 ? "+" : ""}${n.toFixed(1)}%`;
}

function rateClass(n: number | null): string {
  if (n === null) return "";
  return n > 0 ? "positive" : n < 0 ? "negative" : "";
}

/**
 * 「2026-07」 → 「2026년 7월 실적」.
 *
 * 관세청은 **월이 끝나야** 확정치를 낸다. 그래서 8월 하순에 봐도 7월이 최신이다.
 * 이걸 안 적어 두면 오늘 숫자로 읽는다 — 한 달 지난 값을 오늘 것으로 오해하는 게
 * 이 화면에서 제일 위험한 오독이다.
 */
function monthLabel(m: string): string {
  const [y, mm] = m.split("-");
  return y && mm ? `${y}년 ${Number(mm)}월 실적` : m;
}

/**
 * 받아온 시각 — **로컬 시각으로 적는다.**
 *
 * ⚠️ 예전엔 `fetchedAt.slice(5, 16)` 로 ISO 문자열을 그냥 잘랐다. 그 문자열은 UTC라
 * **아홉 시간 이른 시각**이 찍혔다. 새벽 2시에 받은 것이 전날 오후 5시로 보였다.
 * 문자열을 자르지 말고 Date 로 파싱해서 로컬로 찍는다.
 *
 * 12시간 캐시라 「언제 것인가」가 실제로 중요하므로 경과 시간을 같이 적는다.
 */
function fetchedLabel(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  /* toLocaleString 의 ko-KR 은 「8. 24. 19:28」처럼 점을 찍어 읽기 나쁘다 — 직접 짠다 */
  const two = (n: number) => String(n).padStart(2, "0");
  const stamp = `${d.getMonth() + 1}월 ${d.getDate()}일 ${two(d.getHours())}:${two(d.getMinutes())}`;
  const mins = Math.floor((Date.now() - d.getTime()) / 60_000);
  const ago = mins < 1 ? "방금" : mins < 60 ? `${mins}분 전` : `${Math.floor(mins / 60)}시간 전`;
  return `${stamp} 받음 (${ago})`;
}

interface Related {
  stocks: { code: string; name: string; changeRate: number; marketCap?: number | null }[];
  from: "theme" | "sector" | "none";
  label: string;
}

interface TradeMonth {
  month: string;
  exportUsd: number;
  importUsd: number;
}

/**
 * 월별 수출(또는 수입) 막대 — 36개월.
 *
 * 최신 한 달 + 전년동월 % 만으로는 「이 산업이 잘 되어 가고 있나」를 알 수 없다 —
 * 꺾이는 중인지, 바닥 찍고 도는 중인지는 **선의 모양**이 말한다.
 *
 * 막대색은 **전년 같은 달 대비**다(늘었으면 빨강, 줄었으면 파랑). 수출은 계절을 타는
 * 품목이 많아 전월 대비로 칠하면 매년 같은 자리에서 파랗게 보인다 — 설 연휴가 있는
 * 2월이 1월보다 작은 건 불황이 아니다.
 */
function TradeChart({ months, watch }: { months: TradeMonth[]; watch: "export" | "import" }) {
  const val = (m: TradeMonth) => (watch === "import" ? m.importUsd : m.exportUsd);
  const W = 720;
  /* 낮게 (2026-08-25) — 「칸을 너무 차지한다」. 흐름의 모양은 이 높이로도 보인다 */
  const H = 110;
  /* 오른쪽은 눈금 값(「35억$」)이 앉을 자리 */
  const PAD = { l: 4, r: 48, t: 8, b: 16 };
  const max = Math.max(1, ...months.map(val));
  const bw = (W - PAD.l - PAD.r) / months.length;
  const prevOf = (m: TradeMonth): TradeMonth | undefined => {
    const [y, mm] = m.month.split("-");
    return months.find((x) => x.month === `${Number(y) - 1}-${mm}`);
  };
  const latest = months[months.length - 1];

  /*
   * 주석 있는 그래프 (2026-08-25 — 「막대만 있으니 식별이 안 된다」).
   * 가로 눈금 두 줄(최대·절반)에 값을 적고, 마지막 달은 막대 위에 값·전년비를
   * 직접 단다. 연 경계는 세로 점선 — 계절 비교(작년 같은 자리)가 눈으로 된다.
   */
  const latestPrev = latest ? prevOf(latest) : undefined;
  const latestYoy =
    latest && latestPrev && val(latestPrev) > 0
      ? ((val(latest) - val(latestPrev)) / val(latestPrev)) * 100
      : null;
  const yOf = (v: number) => H - PAD.b - ((H - PAD.t - PAD.b) * v) / max;

  return (
    <div className="trade-chart">
      {/*
        마지막 달 주석은 **그래프 밖 HTML 로** (2026-08-25) — SVG 안 오른쪽 위에 두니
        눈금 값(「35억$」)과 겹쳐 둘 다 안 읽혔다. 글자는 글자 자리에.
      */}
      {latest && (
        <div className="tc-head">
          <b>{latest.month}</b> {(val(latest) / 1e8).toFixed(1)}억$
          {latestYoy !== null && (
            <b className={latestYoy >= 0 ? "positive" : "negative"}>
              {" "}
              전년동월 {latestYoy > 0 ? "+" : ""}
              {latestYoy.toFixed(0)}%
            </b>
          )}
        </div>
      )}
      <svg viewBox={`0 0 ${W} ${H}`} role="img">
        {/* 가로 눈금 — 최대와 절반. 이게 없으면 막대 높이가 서로만 견줘진다 */}
        {[max, max / 2].map((v, i) => (
          <g key={i}>
            <line className="tc-grid" x1={PAD.l} x2={W - PAD.r} y1={yOf(v)} y2={yOf(v)} />
            <text className="tc-tick" x={W - PAD.r} y={yOf(v) - 2} textAnchor="end">
              {(v / 1e8).toFixed(0)}억$
            </text>
          </g>
        ))}
        {/* 연 경계 세로 점선 — 1월 자리. 작년 같은 자리와 견주라고 있는 선이다 */}
        {months.map((m, i) =>
          m.month.endsWith("-01") ? (
            <line
              key={`v${m.month}`}
              className="tc-year"
              x1={PAD.l + i * bw}
              x2={PAD.l + i * bw}
              y1={PAD.t}
              y2={H - PAD.b}
            />
          ) : null,
        )}
        {months.map((m, i) => {
          const h = ((H - PAD.t - PAD.b) * val(m)) / max;
          const prev = prevOf(m);
          const cls =
            prev === undefined
              ? "tc-bar-flat"
              : val(m) >= val(prev)
                ? "tc-bar-up"
                : "tc-bar-down";
          return (
            <rect
              key={m.month}
              className={cls}
              x={PAD.l + i * bw + bw * 0.15}
              y={H - PAD.b - h}
              width={bw * 0.7}
              height={Math.max(1, h)}
            >
              <title>
                {m.month} · {(val(m) / 1e8).toFixed(1)}억$
              </title>
            </rect>
          );
        })}
        {/* 연 경계 눈금 — 1월 자리에만 */}
        {months.map((m, i) =>
          m.month.endsWith("-01") ? (
            <text key={`y${m.month}`} className="tc-tick" x={PAD.l + i * bw} y={H - 4}>
              {m.month.slice(2, 4)}년
            </text>
          ) : null,
        )}
      </svg>
      <div className="trade-note">
        월 {watch === "import" ? "수입" : "수출"}액(억$) 36개월 · 막대색은{" "}
        <b>전년 같은 달 대비</b> — 계절을 타는 품목이라 전월 대비로 보면 매년 같은 자리에서
        꺾여 보입니다. 첫 12개월은 비교 대상이 없어 회색입니다.
      </div>
    </div>
  );
}

/**
 * 나라별 월별 흐름 (2026-08-25) — 「미국에서 갑자기 장사가 잘되네?」는 한 달
 * 스냅샷으로는 안 보인다. 상위 5개 나라의 최근 13개월을 선으로 겹쳐 그린다.
 * 13개월인 이유: 마지막 달의 전년 동월이 시리즈 안에 있어 눈으로 YoY 가 된다.
 */
function CountryTrend({
  series,
}: {
  series: { months: string[]; countries: { country: string; values: number[] }[] };
}) {
  const W = 720;
  const H = 130;
  const PAD = { l: 4, r: 48, t: 8, b: 16 };
  const max = Math.max(1, ...series.countries.flatMap((c) => c.values));
  const n = series.months.length;
  const xOf = (i: number) => PAD.l + ((W - PAD.l - PAD.r) * i) / Math.max(1, n - 1);
  const yOf = (v: number) => H - PAD.b - ((H - PAD.t - PAD.b) * v) / max;

  return (
    <div className="trade-chart">
      <div className="tct-legend">
        {series.countries.map((c, ci) => {
          const last = c.values[c.values.length - 1] ?? 0;
          const yearAgo = c.values[0] ?? 0;
          const yoy = yearAgo > 0 ? ((last - yearAgo) / yearAgo) * 100 : null;
          return (
            <span className={`tct-key tct-l${ci}`} key={c.country}>
              <i className="tct-dot" />
              {c.country} {(last / 1e6).toFixed(0)}백만$
              {yoy !== null && (
                <b className={yoy >= 0 ? "positive" : "negative"}>
                  {" "}
                  {yoy > 0 ? "+" : ""}
                  {yoy.toFixed(0)}%
                </b>
              )}
            </span>
          );
        })}
      </div>
      <svg viewBox={`0 0 ${W} ${H}`} role="img">
        {[max, max / 2].map((v, i) => (
          <g key={i}>
            <line className="tc-grid" x1={PAD.l} x2={W - PAD.r} y1={yOf(v)} y2={yOf(v)} />
            <text className="tc-tick" x={W - PAD.r} y={yOf(v) - 2} textAnchor="end">
              {(v / 1e6).toFixed(0)}백만$
            </text>
          </g>
        ))}
        {series.countries.map((c, ci) => (
          <polyline
            key={c.country}
            className={`tct-line tct-l${ci}`}
            points={c.values.map((v, i) => `${xOf(i)},${yOf(v)}`).join(" ")}
          />
        ))}
        {/* 달 눈금은 세 달마다 — 열세 개 다 적으면 겹쳐서 하나도 안 읽힌다 */}
        {series.months.map((m, i) =>
          i % 3 === 0 ? (
            <text key={m} className="tc-tick" x={xOf(i)} y={H - 4} textAnchor="middle">
              {m.slice(2).replace("-", ".")}
            </text>
          ) : null,
        )}
      </svg>
      <div className="trade-note">
        상위 5개 나라의 월별 흐름(13개월) · 범례 %는 <b>1년 전 같은 달 대비</b> · 0으로 꺼진
        달은 그 달 조회가 빈 것일 수 있습니다.
      </div>
    </div>
  );
}

export function TradePanel({ onSelectStock }: { onSelectStock?: (code: string, name: string) => void }) {
  const [items, setItems] = useState<TradeSummary[]>([]);
  const [fetchedAt, setFetchedAt] = useState("");
  const [configured, setConfigured] = useState(true);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  // 관련 종목·시계열·나라별은 펼칠 때만 부른다 — 31품목을 한꺼번에 받으면 첫 조회가 훨씬 느려진다
  const [related, setRelated] = useState<Record<string, Related | "loading">>({});
  const [history, setHistory] = useState<Record<string, TradeMonth[] | "loading" | "error">>({});
  type Countries = { month: string; watch: "export" | "import"; rows: { country: string; exportUsd: number; importUsd: number; yoy: number | null; top: { name: string; usd: number; share: number }[] }[]; series: { months: string[]; countries: { country: string; values: number[] }[] } | null };
  const [countries, setCountries] = useState<Record<string, Countries | "loading" | "error">>({});

  function toggle(key: string) {
    if (open === key) {
      setOpen(null);
      return;
    }
    setOpen(key);
    if (!related[key]) {
      setRelated((p) => ({ ...p, [key]: "loading" }));
      api
        .tradeStocks(key)
        .then((r) => setRelated((p) => ({ ...p, [key]: r })))
        .catch(() => setRelated((p) => ({ ...p, [key]: { stocks: [], from: "none", label: "" } })));
    }
    if (!history[key]) {
      setHistory((p) => ({ ...p, [key]: "loading" }));
      api
        .tradeHistory(key)
        .then((r) => setHistory((p) => ({ ...p, [key]: r.months })))
        .catch(() => setHistory((p) => ({ ...p, [key]: "error" })));
    }
    if (!countries[key]) {
      setCountries((p) => ({ ...p, [key]: "loading" }));
      api
        .tradeCountries(key)
        .then((r) => setCountries((p) => ({ ...p, [key]: r })))
        .catch(() => setCountries((p) => ({ ...p, [key]: "error" })));
    }
  }

  function load(force = false) {
    setLoading(true);
    api
      .trade(force)
      .then((r) => {
        setItems(r.items);
        setFetchedAt(r.fetchedAt);
        setConfigured(r.configured);
        setError(r.error ?? null);
      })
      .catch((err: Error) => setError(err.message))
      .finally(() => setLoading(false));
  }

  useEffect(() => load(), []);

  if (!configured) {
    return (
      <div className="page-note">
        <b>수출입 API 키가 설정되지 않았습니다.</b>
        <br />
        관세청 수출입 통계는 공공데이터포털 키가 필요합니다 (개발계정 자동승인, 무료, 일 1만건).
        <br />
        발급 절차는 <code>docs/수출입API_설정가이드.md</code> 를 보세요. 키를 받으면{" "}
        <code>server/.env</code> 의 <code>DATA_GO_KR_KEY</code> 에 <b>Decoding 키</b>를 넣습니다.
      </div>
    );
  }

  if (loading && items.length === 0) return <div className="empty">수출입 통계 불러오는 중…</div>;

  const month = items[0]?.month ?? "";
  const val = (i: TradeSummary) => (i.watch === "import" ? i.importUsd : i.exportUsd);
  const rate = (i: TradeSummary) => (i.watch === "import" ? i.importYoy : i.exportYoy);
  const sorted = [...items].sort((a, b) => (rate(b) ?? -999) - (rate(a) ?? -999));

  return (
    <div className="trade">
      {/*
        두 시각이 다르다는 걸 눈에 보이게 갈라 둔다.
          · **기준 월** — 숫자가 말하는 시점. 관세청은 월이 끝나야 확정치를 낸다
          · **받은 시각** — 우리가 조회한 시점. 12시간 캐시라 오늘 받았어도 값은 지난달 것이다
        하나만 적으면 「어제 받았으니 어제 수출」로 읽힌다.
      */}
      <div className="filter-row trade-stamp">
        <b style={{ marginLeft: 0 }}>{monthLabel(month)}</b>
        <span className="breadth-count" style={{ marginLeft: 0 }}>
          관세청 무역통계
        </span>
        <button className="filter-btn" onClick={() => load(true)} disabled={loading}>
          {loading ? "받는 중…" : "↻ 새로고침"}
        </button>
        {fetchedAt && <span className="breadth-count">{fetchedLabel(fetchedAt)}</span>}
      </div>
      <div className="table-note" style={{ marginTop: 0 }}>
        관세청은 <b>달이 끝난 뒤</b> 확정치를 냅니다 — 오늘 받아도 최신은 지난달입니다.
        증감률은 <b>전년 같은 달</b> 대비고, 12시간마다 다시 받습니다.
      </div>

      {error && <div className="page-note">{error}</div>}

      <div className="data-table-wrap">
        <table className="data-table num">
          <thead>
            <tr>
              <th className="sticky-col">품목</th>
              <th>구분</th>
              <th>금액(억$)</th>
              <th>전년동월</th>
              <th>대응 업종</th>
            </tr>
          </thead>
          <tbody>
            {sorted.map((i) => (
              <tr
                key={i.key}
                className="trade-row"
                onClick={() => toggle(i.key)}
                title={i.note}
              >
                <td className="sticky-col">{i.label}</td>
                <td>{i.watch === "import" ? "수입" : "수출"}</td>
                <td>{(val(i) / 1e8).toFixed(1)}</td>
                <td className={rateClass(rate(i))}>{pct(rate(i))}</td>
                <td style={{ textAlign: "left" }}>{i.sectors.join(" · ")}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {open && (
        <div className="trade-detail">
          {(() => {
            const i = items.find((x) => x.key === open);
            if (!i) return null;
            return (
              <>
                <div className="trade-note">{i.note}</div>

                {(() => {
                  const h = history[i.key];
                  if (h === "loading") return <div className="trade-sub">시계열 받는 중…</div>;
                  if (h === "error" || !h || h.length === 0) return null;
                  return <TradeChart months={h} watch={i.watch} />;
                })()}

                {(() => {
                  const c = countries[i.key];
                  if (c === "loading") return <div className="trade-sub">나라별 받는 중…</div>;
                  if (c === "error" || !c || c.rows.length === 0) return null;
                  const side = (r: (typeof c.rows)[number]) =>
                    c.watch === "import" ? r.importUsd : r.exportUsd;
                  const max = Math.max(...c.rows.map(side), 1);
                  return (
                    <>
                      <div className="trade-sub">
                        나라별 {c.watch === "import" ? "수입" : "수출"} · {c.month} —{" "}
                        <b>어디로 나가는지가 곧 수요처</b>다
                      </div>
                      {c.series && c.series.countries.length > 0 && <CountryTrend series={c.series} />}
                      <div className="trade-cty">
                        {c.rows.map((r) => (
                          <div className="trade-cty-row" key={r.country}>
                            <span className="trade-cty-name">{r.country}</span>
                            <span className="trade-cty-bar">
                              <i style={{ width: `${(side(r) / max) * 100}%` }} />
                            </span>
                            <span className="num trade-cty-amt">{(side(r) / 1e6).toFixed(1)}백만$</span>
                            <span className={`num trade-cty-yoy ${rateClass(r.yoy)}`}>{pct(r.yoy)}</span>
                            {/* 그 나라 안의 세부 품목 — 같은 8504 라도 대형 변압기인지 부품인지 갈린다 */}
                            {r.top.length > 0 && (
                              <span className="trade-cty-items">
                                {r.top.map((t) => (
                                  <i key={t.name} title={`${t.name} · ${(t.usd / 1e6).toFixed(1)}백만$`}>
                                    {t.name.length > 22 ? `${t.name.slice(0, 22)}…` : t.name}{" "}
                                    {t.share.toFixed(0)}%
                                  </i>
                                ))}
                              </span>
                            )}
                          </div>
                        ))}
                      </div>
                      <div className="table-note">
                        관세청 국가별 통계(월간 확정치) · 증감률은 전년 같은 달 대비 · 세부 품목
                        비중은 그 나라 안에서의 몫입니다. 품목명에 마우스를 올리면 금액이 보입니다.
                      </div>
                    </>
                  );
                })()}

                {i.top.length > 0 && (
                  <>
                    <div className="trade-sub">세부 품목</div>
                    <div className="trade-top">
                      {i.top.map((t) => (
                        <div className="trade-top-row" key={t.name}>
                          <span className="trade-top-name">{t.name}</span>
                          <span className="num">{(t.exportUsd / 1e8).toFixed(1)}억$</span>
                          <span className={`num ${rateClass(t.yoy)}`}>{pct(t.yoy)}</span>
                        </div>
                      ))}
                    </div>
                  </>
                )}

                {(() => {
                  const r = related[i.key];
                  if (r === "loading") return <div className="trade-sub">관련 종목 찾는 중…</div>;
                  if (!r || r.stocks.length === 0) return null;
                  return (
                    <>
                      <div className="trade-sub">
                        관련 종목 · {r.label}
                        {r.from === "sector" && " (업종 전체 — 테마가 없어 거칠 수 있습니다)"}
                      </div>
                      <div className="trade-stocks">
                        {r.stocks.map((st) => (
                          <button
                            key={st.code}
                            className="trade-stock"
                            onClick={(e) => {
                              e.stopPropagation();
                              onSelectStock?.(normalizeStockCode(st.code), st.name);
                            }}
                          >
                            <span className="trade-stock-name">{st.name}</span>
                            <span className={`num ${st.changeRate > 0 ? "positive" : st.changeRate < 0 ? "negative" : ""}`}>
                              {st.changeRate > 0 ? "+" : ""}
                              {st.changeRate.toFixed(2)}%
                            </span>
                          </button>
                        ))}
                      </div>
                    </>
                  );
                })()}
              </>
            );
          })()}
        </div>
      )}

      <div className="table-note">
        품목을 누르면 <b>세부 항목과 관련 종목</b>이 열립니다. 종목을 누르면 상세로 이동합니다.
        종목은 <b>키움 테마 구성종목</b>을 그대로 씁니다 — 종목코드를 손으로 적으면 상장폐지·합병을
        따라갈 수 없습니다. 관세청은 월 단위로 확정치를
        내고 우리는 12시간 캐시를 둡니다. <b>원유·반도체 장비는 수입 기준</b>입니다 — 사오기만 하는
        품목이라 수출로 보면 의미가 없습니다. 반도체 장비 수입 증가는 향후 증설을 뜻해 소부장 실적을
        선행합니다.
      </div>
    </div>
  );
}
