import { useEffect, useState } from "react";
import { BreadthHelp, BreadthPanel } from "../components/BreadthPanel";
import {
  api,
  fmtNum,
  normalizeStockCode,
  type IndexCard,
  type MarketFlow,
  type MarketStatus,
  type GlobalQuote,
  type SectorRow,
  type StockRow,
  type ThemeRow,
  type ViRow,
  type UsMajorResult,
  type RateRow,
  type TopTraderRow,
} from "../api";
import { ConstituentSheet, type ConstituentTarget } from "../components/overview/ConstituentSheet";
import { FlowBars } from "../components/overview/FlowBars";
import { FlowIntradayChart } from "../components/overview/FlowIntradayChart";
import { IndexDetailSheet } from "../components/overview/IndexDetailSheet";
import { OverviewCard } from "../components/overview/OverviewCard";
import { RankList, SegmentToggle } from "../components/overview/RankList";
import { RefreshBar } from "../components/RefreshBar";
import { Sparkline } from "../components/overview/Sparkline";
import { useSection } from "../useSection";
import { WatchStar } from "../useWatchedCodes";

type SubTab = "summary" | "flow" | "rank";

const SUBTABS: { key: SubTab; label: string }[] = [
  { key: "summary", label: "요약" },
  { key: "flow", label: "수급" },
  { key: "rank", label: "순위" },
];

function signCls(v: number): string {
  return v > 0 ? "up" : v < 0 ? "down" : "flat";
}

function fmtPct(v: number): string {
  return `${v > 0 ? "+" : ""}${v.toFixed(2)}%`;
}

function fmtSigned(v: number): string {
  return `${v > 0 ? "▲ " : v < 0 ? "▼ " : ""}${fmtNum(Math.abs(v))}`;
}

export function OverviewPage({ onSelectStock }: { onSelectStock: (code: string, name: string) => void }) {
  const [sub, setSub] = useState<SubTab>("summary");
  const [status, setStatus] = useState<MarketStatus | null>(null);
  const [now, setNow] = useState(new Date());

  const indices = useSection<IndexCard[]>("indices", 10_000);
  const flow = useSection<MarketFlow>("flow", 60_000);
  const movers = useSection<{ rising: StockRow[]; falling: StockRow[] }>("movers", 60_000);
  const sectors = useSection<{ kospi: SectorRow[]; kosdaq: SectorRow[] }>("sectors", 180_000);
  const themes = useSection<{ top: ThemeRow[]; bottom: ThemeRow[] }>("themes", 180_000);
  const highLow = useSection<{ high: StockRow[]; low: StockRow[] }>("highLow", 300_000);
  const vi = useSection<ViRow[]>("vi", 60_000);
  const global = useSection<GlobalQuote[]>("global", 60_000);
  const usMajor = useSection<UsMajorResult>("usMajor", 60_000);
  const rates = useSection<RateRow[]>("rates", 60_000);
  const topTraders = useSection<TopTraderRow[]>("topTraders", 300_000);

  const [flowMarket, setFlowMarket] = useState<"kospi" | "kosdaq">("kospi");
  const [moverDir, setMoverDir] = useState<"rising" | "falling">("rising");
  const [sectorMarket, setSectorMarket] = useState<"kospi" | "kosdaq">("kospi");
  const [themeDir, setThemeDir] = useState<"top" | "bottom">("top");
  const [hlDir, setHlDir] = useState<"high" | "low">("high");
  const [constituent, setConstituent] = useState<ConstituentTarget | null>(null);
  /** 눌러서 연 지수 상세 (001 코스피 / 101 코스닥) */
  const [indexDetail, setIndexDetail] = useState<string | null>(null);

  /** 모든 섹션을 한 번에 다시 불러온다 */
  function refreshAll() {
    indices.refresh();
    flow.refresh();
    movers.refresh();
    sectors.refresh();
    themes.refresh();
    highLow.refresh();
    vi.refresh();
    global.refresh();
  }

  useEffect(() => {
    api.marketStatus().then(setStatus).catch(() => {});
    const timer = setInterval(() => {
      setNow(new Date());
      api.marketStatus().then(setStatus).catch(() => {});
    }, 30_000);
    return () => clearInterval(timer);
  }, []);

  // 데스크톱(700px~)에서는 서브탭 없이 전 섹션을 보여준다
  const [wide, setWide] = useState(() => window.matchMedia("(min-width:700px)").matches);
  useEffect(() => {
    const mq = window.matchMedia("(min-width:700px)");
    const handler = (e: MediaQueryListEvent) => setWide(e.matches);
    mq.addEventListener("change", handler);
    return () => mq.removeEventListener("change", handler);
  }, []);

  const show = (sec: SubTab) => wide || sub === sec;

  const idx = indices.data ?? [];
  const kospiCard = idx.find((i) => i.code === "001");
  const kosdaqCard = idx.find((i) => i.code === "101");

  function stockRow(r: StockRow, i: number) {
    const code = normalizeStockCode(r.code);
    return (
      <button key={`${r.code}-${i}`} className="ov-li" onClick={() => onSelectStock(code, r.name)}>
        <span className="ov-rank num">{i + 1}</span>
        <span className="ov-nm">
          <WatchStar code={code} />
          {r.name}
        </span>
        <span className={`ov-px num ${signCls(r.changeRate)}`}>{fmtNum(r.price)}</span>
        <span className={`ov-pct num ${signCls(r.changeRate)}`}>{fmtPct(r.changeRate)}</span>
      </button>
    );
  }

  return (
    <div className="ov">
      <RefreshBar onRefresh={refreshAll} loading={indices.loading}>
        <span className="ov-statusbar" style={{ padding: 0 }}>
          <span className={`ov-dot ${status?.state ?? ""}`} />
          <span>
            {status?.label ?? "-"} · {now.toLocaleTimeString("ko-KR", { hour12: false })}
          </span>
        </span>
      </RefreshBar>

      {!wide && (
        <div className="ov-subtabs">
          {SUBTABS.map((t) => (
            <button
              key={t.key}
              className={`ov-subtab${sub === t.key ? " on" : ""}`}
              onClick={() => setSub(t.key)}
            >
              {t.label}
            </button>
          ))}
        </div>
      )}

      <div className="ov-grid">
        {/* ---------------- 요약 ---------------- */}
        {show("summary") && (
          <OverviewCard title="국내 지수" updatedAt={indices.updatedAt} loading={indices.loading} error={indices.error}>
            <div className="ov-idx-grid">
              {idx.map((c) => {
                /*
                 * **선물에는 수급을 붙이지 않는다.**
                 *
                 * 여기 수급은 `ka10051` 주식시장 투자자 순매수다. 선물은 완전히 다른
                 * 시장이라 그 값을 갖다 붙이면 **틀린 값을 보여주는 것**이 된다 —
                 * 키움 화면의 선물 수급(외국인 2,240 / 기관 6,152)과 숫자가 전혀 다르다.
                 * 없는 것보다 틀린 게 나쁘다.
                 *
                 * 코스피200 은 코스피 구성종목의 부분집합이라 참고로 붙여 둔다.
                 *
                 * 한투 339개 API 에 선물 투자자별 매매동향이 없다(투자자 매매동향 7개가
                 * 전부 국내주식이고, 「시장별」도 KSP/KSQ 만 받는다). 키움에 있는지는
                 * 아직 확인 못 했다 — 찾으면 여기에 붙인다.
                 */
                const f =
                  c.code === "F"
                    ? null
                    : c.code === "101"
                      ? flow.data?.kosdaq
                      : flow.data?.kospi;
                /*
                  코스피·코스닥은 눌러서 상세로 간다. 코스피200·선물은 아직 상세가 없어
                  누르는 시늉만 하면 안 되므로 그대로 둔다.
                */
                const openable = c.code === "001" || c.code === "101";
                return (
                  <div
                    className={`ov-idx${openable ? " clickable" : ""}`}
                    key={c.code}
                    onClick={openable ? () => setIndexDetail(c.code) : undefined}
                    title={openable ? "눌러서 추이·일별 수급 보기" : undefined}
                  >
                    <div className="ov-idx-name">{c.name}</div>
                    <div className={`ov-idx-val num ${signCls(c.changeRate)}`}>{fmtNum(c.price)}</div>
                    <div className={`ov-idx-chg num ${signCls(c.changeRate)}`}>
                      {fmtSigned(c.change)} {fmtPct(c.changeRate)}
                    </div>
                    <Sparkline values={c.sparkline} up={c.changeRate >= 0} />
                    {/* 선물 카드에만 — 베이시스와 미결제는 지수엔 없는 값이다 */}
                    {c.futures && (
                      <div className="ov-fut">
                        {c.futures.basis != null && (
                          <span
                            className={`ov-basis ${c.futures.basis < 0 ? "negative" : "positive"}`}
                            title="선물 − 현물. 음수면 백워데이션 — 프로그램 매도가 붙기 쉽습니다"
                          >
                            베이시스 {c.futures.basis > 0 ? "+" : ""}
                            {c.futures.basis.toFixed(2)}
                          </span>
                        )}
                        {c.futures.openInterest != null && (
                          <span className="pt-n">미결제 {fmtNum(c.futures.openInterest)}</span>
                        )}
                        <span className="pt-n">{c.futures.name}</span>
                      </div>
                    )}
                    {c.code === "F" && (
                      <div className="ov-idx-note">선물 수급은 아직 받을 데가 없습니다</div>
                    )}
                    {f && (
                      <div className="ov-idx-flow num">
                        <div>
                          <span className="lbl">외국인</span>
                          <span className={signCls(f.foreign)}>
                            {f.foreign > 0 ? "+" : ""}
                            {fmtNum(f.foreign)}
                          </span>
                        </div>
                        <div>
                          <span className="lbl">기관</span>
                          <span className={signCls(f.institution)}>
                            {f.institution > 0 ? "+" : ""}
                            {fmtNum(f.institution)}
                          </span>
                        </div>
                        <div>
                          <span className="lbl">개인</span>
                          <span className={signCls(f.individual)}>
                            {f.individual > 0 ? "+" : ""}
                            {fmtNum(f.individual)}
                          </span>
                        </div>
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          </OverviewCard>
        )}

        {show("summary") && (
          <OverviewCard
            title="종목등락현황"
            updatedAt={indices.updatedAt}
            loading={indices.loading}
            error={indices.error}
          >
            <div className="ov-card-b">
              <table className="ov-table num">
                <thead>
                  <tr>
                    <th>구분</th>
                    <th className="up">상한</th>
                    <th className="up">상승</th>
                    <th>보합</th>
                    <th className="down">하락</th>
                    <th className="down">하한</th>
                  </tr>
                </thead>
                <tbody>
                  {[kospiCard, kosdaqCard].map(
                    (c) =>
                      c && (
                        <tr key={c.code}>
                          <td>{c.name}</td>
                          <td className="up">{c.upperLimit}</td>
                          <td className="up">{fmtNum(c.rising)}</td>
                          <td className="flat">{c.flat}</td>
                          <td className="down">{fmtNum(c.falling)}</td>
                          <td className="down">{c.lowerLimit}</td>
                        </tr>
                      ),
                  )}
                </tbody>
              </table>
            </div>
          </OverviewCard>
        )}

        {/*
          글로벌 — **종목등락현황 바로 밑**이다.

          국내 지수 → 종목등락현황으로 "우리 시장이 지금 어떤가"를 본 직후,
          "그 힘이 어디서 왔나"를 이어서 본다. 예전엔 업종 뒤에 있어서 국내를 다 훑고
          한참 내려가야 나왔는데, 그러면 국내와 견주는 일이 안 된다.
        */}
        {show("summary") && (
          <OverviewCard title="글로벌" updatedAt={global.updatedAt} loading={global.loading} error={global.error}>
            <div className="ov-card-b">
              {/*
                섹터별로 묶는다. 스무 줄을 그냥 나열하면 **어디까지가 원자재이고
                어디부터가 아시아 지수인지** 알 수 없다 — 서버는 이미 group 을 주는데
                화면이 그걸 버리고 있었다.
              */}
              {[...new Set((global.data ?? []).map((g) => g.group))].map((grp) => {
                // 색은 서버가 정한다 — 리포트도 같은 색을 쓴다
                const color = (global.data ?? []).find((g) => g.group === grp)?.color ?? "#8b98a5";
                return (
                <div className="ov-g-sec" key={grp} style={{ ["--g" as string]: color }}>
                  <div className="ov-g-sec-h">{grp}</div>
                  {(global.data ?? [])
                    .filter((g) => g.group === grp)
                    .map((g) => (
                <div className="ov-g-row" key={g.key}>
                  {/* 미장 주요지수와 같은 신호등. 판단할 게 없으면 자리만 비워 둔다 */}
                  <span
                    className={`ov-g-sig${g.signal ? ` ${g.signal.level}` : ""}`}
                    title={g.signal?.why}
                  />
                  <span className="ov-g-nm">
                    {g.label}
                    <span className="ov-g-tk">{g.symbol}</span>
                  </span>
                  {g.error ? (
                    <span className="ov-g-pct" style={{ color: "var(--flat)" }}>
                      조회 실패
                    </span>
                  ) : (
                    <>
                      <span className="ov-g-px num">
                        {g.price === null ? "-" : fmtNum(Number(g.price.toFixed(g.isRate ? 3 : 2)))}
                      </span>
                      <span className={`ov-g-pct num ${signCls(g.changeRate ?? 0)}`}>
                        {g.change === null
                          ? "-"
                          : `${g.change > 0 ? "+" : ""}${g.change.toFixed(g.isRate ? 3 : 2)} (${fmtPct(
                              g.changeRate ?? 0,
                            )})`}
                      </span>
                    </>
                  )}
                </div>
                    ))}
                </div>
                );
              })}
            </div>
          </OverviewCard>
        )}

        {/*
          미장 주요지수 — 국내 지수 → 종목등락현황 **다음** 자리다.
          아침에 "밤사이 무슨 일이 있었나"를 한 표로 읽는 곳이라, 국내를 본 직후에 와야 한다.
        */}
        {show("summary") && (
          <OverviewCard
            title="미장 주요지수"
            updatedAt={usMajor.updatedAt}
            loading={usMajor.loading}
            error={usMajor.error}
          >
            <div className="ov-card-b">
              <table className="ov-table num">
                <thead>
                  <tr>
                    <th>구분</th>
                    <th>종가</th>
                    <th>대비</th>
                    <th>등락률</th>
                  </tr>
                </thead>
                <tbody>
                  {usMajor.data?.nightFutures && (
                    /* 야간선물만 지금 움직이는 값이라 맨 위에 두고 줄을 나눈다 */
                    <tr className="ov-night">
                      <td>{usMajor.data.nightFutures.label}</td>
                      <td className={signCls(usMajor.data.nightFutures.changeRate ?? 0)}>
                        {usMajor.data.nightFutures.price?.toFixed(2)}
                      </td>
                      <td className={signCls(usMajor.data.nightFutures.changeRate ?? 0)}>
                        {fmtSigned(usMajor.data.nightFutures.change ?? 0)}
                      </td>
                      <td className={signCls(usMajor.data.nightFutures.changeRate ?? 0)}>
                        {fmtPct(usMajor.data.nightFutures.changeRate ?? 0)}
                      </td>
                    </tr>
                  )}
                  {(usMajor.data?.rows ?? []).map((r) => (
                    <tr key={r.key}>
                      <td>
                        {/*
                          색만 있으면 왜 빨간지 모른다. 점 옆에 이유를 한 줄로 붙인다 —
                          숫자는 경험칙이라 사람이 "이번엔 아니다" 라고 판단할 여지를 남긴다.
                        */}
                        {r.signal && <span className={`um-dot ${r.signal.level}`} />}
                        {r.label}
                        {/* 야후가 막혀 한투로 메운 줄은 밝힌다 — 두 출처가 섞이니까 */}
                        {r.source === "hantoo" && <span className="pt-n"> 한투</span>}
                        {r.signal && <div className="um-why">{r.signal.why}</div>}
                      </td>
                      <td className={signCls(r.changeRate ?? 0)}>
                        {r.price == null
                          ? "-"
                          : r.price.toLocaleString("ko-KR", {
                              minimumFractionDigits: r.digits,
                              maximumFractionDigits: r.digits,
                            })}
                        {/* 금리는 값 자체가 % 라 단위를 붙여야 오해가 없다 */}
                        {r.isRate && "%"}
                      </td>
                      <td className={signCls(r.changeRate ?? 0)}>{fmtSigned(r.change ?? 0)}</td>
                      <td className={signCls(r.changeRate ?? 0)}>{fmtPct(r.changeRate ?? 0)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {/* 장단기 금리차는 어느 줄에도 안 들어가는 값이라 따로 둔다 */}
              {usMajor.data?.curveNote && (
                <div className="alert-note">{usMajor.data.curveNote}</div>
              )}
              <div className="table-note">
                야간선물을 뺀 나머지는 <b>전일 마감값</b>입니다. 기본은 야후이고, 못 받은 줄만
                한투로 메웁니다(그 줄엔 「한투」라고 적습니다). — 미국 현물은 우리 시간 05:30 에
                닫혀 낮에는 움직이지 않습니다. 지금 움직이는 걸 보시려면 「글로벌 시황지수」의
                선물을 보세요.
              </div>
            </div>
          </OverviewCard>
        )}

        {/*
          금리 — 야후는 미국 것만 준다(일본·한국은 심볼 자체가 없다). 한투가 국내
          국고채부터 일본 10년까지 한 번에 준다. 요즘 시장을 흔드는 건 일본 금리라
          미장 바로 뒤에 둔다 — 엔 캐리가 풀리면 전 세계 위험자산에서 돈이 빠진다.
        */}
        {show("summary") && (
          <OverviewCard
            title="금리"
            updatedAt={rates.updatedAt}
            loading={rates.loading}
            error={rates.error}
          >
            <div className="ov-card-b">
              <div className="rt-grid">
                {(["국내", "해외"] as const).map((g) => (
                  <div key={g}>
                    <div className="rt-h">{g}</div>
                    {(rates.data ?? [])
                      .filter((r) => r.group === g)
                      .map((r) => (
                        <div className="rt-row" key={r.code}>
                          <span>{r.name}</span>
                          <b className="num">{r.rate?.toFixed(3)}%</b>
                          {/* 금리는 변화폭(%p)으로 읽는다 — 등락률로 보면 감이 안 온다 */}
                          <em className={`num ${signCls(r.change ?? 0)}`}>
                            {(r.change ?? 0) > 0 ? "+" : ""}
                            {(r.change ?? 0).toFixed(3)}%p
                          </em>
                        </div>
                      ))}
                  </div>
                ))}
              </div>
              <div className="table-note">
                <b>%p</b> 는 등락률이 아니라 <b>변화폭</b>입니다 — 4.71% 가 4.72% 로 가는 건
                등락률로는 0.2% 지만 시장이 반응하는 건 0.01%p 라는 폭 자체입니다.
                <b>일본 10년</b>은 엔 캐리와 붙어 있어, 오르면 전 세계 위험자산에서 돈이
                빠집니다. 한국투자증권 제공.
              </div>
            </div>
          </OverviewCard>
        )}

        {show("summary") && (
          <OverviewCard title="시장 폭 추이">
            <div className="ov-card-b">
              <BreadthPanel />
            </div>
          </OverviewCard>
        )}

        {/*
          여기가 ⑤ 증시주변자금 동향 자리다 — 고객예탁금·미수금·신용잔고·선물예수금.
          키움에도 한투에도 없어서 공공데이터포털 키가 생겨야 붙는다. 그때 여기 끼운다.
        */}

        {show("summary") && (
          <OverviewCard title="업종" updatedAt={sectors.updatedAt} loading={sectors.loading} error={sectors.error}>
            <SegmentToggle
              options={[
                { key: "kospi" as const, label: "코스피" },
                { key: "kosdaq" as const, label: "코스닥" },
              ]}
              value={sectorMarket}
              onChange={setSectorMarket}
            />
            <RankList
              items={sectors.data?.[sectorMarket] ?? []}
              renderItem={(s: SectorRow, i) => (
                <button
                  className="ov-li"
                  key={`${s.code}-${i}`}
                  onClick={() =>
                    setConstituent({ kind: "sector", code: s.code, name: s.name, market: sectorMarket })
                  }
                >
                  <span className="ov-nm">{s.name}</span>
                  <span className={`ov-pct num ${signCls(s.changeRate)}`}>{fmtPct(s.changeRate)}</span>
                </button>
              )}
            />
          </OverviewCard>
        )}



        {/* ---------------- 수급 ---------------- */}
        {show("flow") && (
          <OverviewCard
            title="투자자별 수급"
            subtitle={`${flowMarket === "kospi" ? "코스피" : "코스닥"} · 억원`}
            loading={flow.loading}
            error={flow.error}
            span2
          >
            <SegmentToggle
              options={[
                { key: "kospi" as const, label: "코스피" },
                { key: "kosdaq" as const, label: "코스닥" },
              ]}
              value={flowMarket}
              onChange={setFlowMarket}
            />
            {flow.data && <FlowBars flow={flow.data[flowMarket]} />}
            {/*
              누적 막대 밑에 장중 변화. 막대만 보면 오전에 팔다 오후에 산 날과
              하루 종일 판 날이 똑같이 생긴다 — 방향이 바뀐 지점이 보여야 한다.
            */}
            <FlowIntradayChart market={flowMarket} />
          </OverviewCard>
        )}

        {/* ---------------- 순위 ---------------- */}
        {/*
          순위 탭의 맨 위. 상위 계좌들이 무엇을 사는지가 다른 순위표보다 먼저 온다 —
          거래대금·등락률 순위는 "무엇이 움직였나"이고 이건 "누가 움직였나"다.
        */}
        {show("rank") && (
          <OverviewCard
            title="수익률 상위 고객 매매동향"
          updatedAt={topTraders.updatedAt}
          loading={topTraders.loading}
          error={topTraders.error}
        >
          <div className="ov-card-b">
            <div className="data-table-wrap">
              <table className="data-table">
                <thead>
                  <tr>
                    <th className="sticky-col">종목</th>
                    <th>현재가</th>
                    <th>등락률</th>
                    <th title="상위 계좌들의 순매수 금액">순매수</th>
                    <th title="이 종목을 들고 있는 상위 계좌 수 — 한 계좌의 몰빵인지 여럿이 보는지">
                      계좌
                    </th>
                    <th>평균단가</th>
                    <th title="그 계좌들의 이 종목 수익률">수익률</th>
                  </tr>
                </thead>
                <tbody>
                  {(topTraders.data ?? []).slice(0, 20).map((r) => (
                    <tr
                      key={r.code}
                      className="clickable-row"
                      onClick={() => onSelectStock(normalizeStockCode(r.code), r.name)}
                    >
                      <td className="sticky-col">{r.name}</td>
                      <td className="num">{fmtNum(r.price)}</td>
                      <td className={`num ${signCls(r.changeRate)}`}>{fmtPct(r.changeRate)}</td>
                      <td className={`num ${signCls(r.netAmount)}`}>
                        {Math.round(r.netAmount).toLocaleString("ko-KR")}억
                      </td>
                      <td className="num">{r.accounts}</td>
                      <td className="num pt-n">{fmtNum(r.avgBuyPrice)}</td>
                      <td className={`num ${signCls(r.profitRate)}`}>
                        {r.profitRate > 0 ? "+" : ""}
                        {r.profitRate.toFixed(0)}%
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div className="table-note">
              키움 <b>수익률 상위 고객</b> 계좌들의 매매입니다(상위 20종목). 금액은 억원.
              <b>계좌 수</b>를 같이 보세요 — 한 계좌가 크게 담은 것과 여럿이 함께 담은 것은
              뜻이 다릅니다. <b>참고 자료</b>이지 매매 근거가 아닙니다.
            </div>
          </div>
        </OverviewCard>
      )}

        {show("rank") && (
          <OverviewCard title="등락률 순위" updatedAt={movers.updatedAt} loading={movers.loading} error={movers.error}>
            <SegmentToggle
              options={[
                { key: "rising" as const, label: "상승" },
                { key: "falling" as const, label: "하락" },
              ]}
              value={moverDir}
              onChange={setMoverDir}
            />
            <RankList items={movers.data?.[moverDir] ?? []} renderItem={stockRow} />
          </OverviewCard>
        )}

        {show("rank") && (
          <OverviewCard title="테마" updatedAt={themes.updatedAt} loading={themes.loading} error={themes.error}>
            <SegmentToggle
              options={[
                { key: "top" as const, label: "상위" },
                { key: "bottom" as const, label: "하위" },
              ]}
              value={themeDir}
              onChange={setThemeDir}
            />
            <RankList
              items={themes.data?.[themeDir] ?? []}
              renderItem={(t: ThemeRow, i) => (
                <button
                  className="ov-li"
                  key={`${t.code}-${i}`}
                  onClick={() => setConstituent({ kind: "theme", code: t.code, name: t.name })}
                >
                  <span className="ov-nm">
                    {t.name}
                    <span className="ov-sub-nm">
                      {t.stockCount}종목 · {t.mainStock}
                    </span>
                  </span>
                  <span className={`ov-pct num ${signCls(t.changeRate)}`}>{fmtPct(t.changeRate)}</span>
                </button>
              )}
            />
          </OverviewCard>
        )}

        {/*
          250일 신고가·VI 는 **순위**다. 시황이 아니다 —
          시황은 시장이 어디로 가는지를 보는 자리이고, 이 둘은 종목을 고르는 자리다.
          요약 탭에 섞여 있으니 지수·수급·금리를 훑는 흐름이 끊겼다. 순위 맨 아래로 옮긴다.
        */}
        {show("rank") && (
          <OverviewCard
            title="250일 신고가 / 신저가"
            updatedAt={highLow.updatedAt}
            loading={highLow.loading}
            error={highLow.error}
          >
            <SegmentToggle
              options={[
                { key: "high" as const, label: "신고가" },
                { key: "low" as const, label: "신저가" },
              ]}
              value={hlDir}
              onChange={setHlDir}
            />
            <RankList items={highLow.data?.[hlDir] ?? []} renderItem={stockRow} />
          </OverviewCard>
        )}

        {show("rank") && (
          <OverviewCard title="변동성 완화 (VI)" updatedAt={vi.updatedAt} loading={vi.loading} error={vi.error}>
            <RankList
              items={vi.data ?? []}
              emptyText="발동 종목 없음"
              renderItem={(v: ViRow, i) => (
                <button
                  key={`${v.code}-${i}`}
                  className="ov-li"
                  onClick={() => onSelectStock(normalizeStockCode(v.code), v.name)}
                >
                  <span className="ov-nm">
                    <WatchStar code={normalizeStockCode(v.code)} />
                    {v.name}
                    <span className="ov-sub-nm">{v.motionCount}회 발동</span>
                  </span>
                  <span className="ov-px num">{fmtNum(v.motionPrice)}</span>
                  <span className={`ov-pct num ${signCls(v.openChangeRate)}`}>{fmtPct(v.openChangeRate)}</span>
                </button>
              )}
            />
          </OverviewCard>
        )}



      </div>

      {/*
        수익률 상위 고객 매매동향 — **맨 아래**다.

        키움에서 실제로 잘 벌고 있는 계좌들이 무엇을 사는지 보여 준다. 외국인·기관은
        규모가 커서 방향이 굼뜨고 개인 수급은 방향이 없는데, 이건 그 사이다 —
        개인이되 **결과로 걸러진** 개인이다.

        맨 아래인 이유는 **참고 자료**이기 때문이다. 이걸 보고 따라 사는 건 이 프로젝트가
        하려는 일이 아니라, 앞의 지표들을 다 보고 난 뒤 곁눈질하는 자리에 둔다.
      */}

      {/*
        지표 설명은 **맨 아래**다. 원래 시장 폭 그래프 바로 밑에 있었는데 설명이 길어서
        본문을 밀어냈다 — 세 지표를 보러 왔다가 다음 카드까지 한참 스크롤해야 했다.
        처음 몇 번만 읽으면 되는 것이라 뒤로 뺀다.
      */}
      {show("summary") && (
        <details className="ov-help">
          <summary>시장 폭 지표는 어떻게 읽나</summary>
          <BreadthHelp />
        </details>
      )}

      {indexDetail && (
        <IndexDetailSheet code={indexDetail} onClose={() => setIndexDetail(null)} />
      )}

      {constituent && (
        <ConstituentSheet
          target={constituent}
          onClose={() => setConstituent(null)}
          onSelectStock={(code, name) => {
            setConstituent(null);
            onSelectStock(code, name);
          }}
        />
      )}
    </div>
  );
}
