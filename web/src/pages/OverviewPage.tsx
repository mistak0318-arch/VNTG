import { useEffect, useState } from "react";
import { BreadthPanel } from "../components/BreadthPanel";
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
} from "../api";
import { ConstituentSheet, type ConstituentTarget } from "../components/overview/ConstituentSheet";
import { FlowBars } from "../components/overview/FlowBars";
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

  const [flowMarket, setFlowMarket] = useState<"kospi" | "kosdaq">("kospi");
  const [moverDir, setMoverDir] = useState<"rising" | "falling">("rising");
  const [sectorMarket, setSectorMarket] = useState<"kospi" | "kosdaq">("kospi");
  const [themeDir, setThemeDir] = useState<"top" | "bottom">("top");
  const [hlDir, setHlDir] = useState<"high" | "low">("high");
  const [constituent, setConstituent] = useState<ConstituentTarget | null>(null);

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
                // 코스피200은 별도 수급 집계가 없어 코스피 수급을 함께 보여준다
                const f = c.code === "101" ? flow.data?.kosdaq : flow.data?.kospi;
                return (
                  <div className="ov-idx" key={c.code}>
                    <div className="ov-idx-name">{c.name}</div>
                    <div className={`ov-idx-val num ${signCls(c.changeRate)}`}>{fmtNum(c.price)}</div>
                    <div className={`ov-idx-chg num ${signCls(c.changeRate)}`}>
                      {fmtSigned(c.change)} {fmtPct(c.changeRate)}
                    </div>
                    <Sparkline values={c.sparkline} up={c.changeRate >= 0} />
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

        {show("summary") && (
          <OverviewCard title="시장 폭 추이">
            <div className="ov-card-b">
              <BreadthPanel />
            </div>
          </OverviewCard>
        )}

        {show("summary") && (
          <OverviewCard title="글로벌" updatedAt={global.updatedAt} loading={global.loading} error={global.error}>
            <div className="ov-card-b">
              {(global.data ?? []).map((g) => (
                <div className="ov-g-row" key={g.key}>
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
          </OverviewCard>
        )}

        {/* ---------------- 순위 ---------------- */}
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

        {show("rank") && (
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
