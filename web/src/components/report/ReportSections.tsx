import { useEffect, useState } from "react";
import {
  api,
  fmtNum,
  type GlobalQuote,
  type IndexDetailData,
  type ScreenHit,
  type SectorFlowResult,
  type StockRow,
  type ThemeRow,
  type TrackedStock,
  type KiwoomGroupStock,
  type DartEvent,
  type ChannelReport,
  type NewsItem,
  type UsMajorResult,
} from "../../api";
import { TrendLineChart } from "../TrendLineChart";
import { useSection } from "../../useSection";
import { useWatchGroupTiles } from "../../useWatchGroupTiles";

/**
 * 데일리 리포트에 새로 들어가는 네 섹션.
 *
 * 넷 다 **이미 있는 데이터**를 리포트 문맥으로 다시 놓은 것이다 — 새 API 는 없다.
 * 리포트는 "아침에 한 번 훑고 판단을 시작하는 자리"라, 대시보드에 흩어진 것 중
 * 그 시각에 꼭 필요한 것만 골라 순서대로 세운다.
 */

function pct(v: number | null | undefined): string {
  if (v == null || !Number.isFinite(v)) return "-";
  return `${v > 0 ? "+" : ""}${v.toFixed(2)}%`;
}

function cls(v: number | null | undefined): string {
  if (v == null) return "";
  return v > 0 ? "positive" : v < 0 ? "negative" : "";
}

/* ───────────────────────────────── D3. 코스피 야간선물 · 환율 */

/**
 * 밤사이 한국 지수가 어디로 갔는지.
 *
 * 조간에 가장 먼저 봐야 할 값이다. 미국 현물은 05:30 에 닫혀 이미 굳었지만
 * **야간선물은 그 결과를 한국 지수로 환산해 준다** — 오늘 개장가의 예고편이다.
 * 환율을 같이 두는 건 외국인 수급이 환율과 붙어 움직이기 때문이다.
 */
export function NightFuturesSection() {
  const [us, setUs] = useState<UsMajorResult | null>(null);
  const [fx, setFx] = useState<GlobalQuote[]>([]);

  useEffect(() => {
    let alive = true;
    api
      .overviewSection<UsMajorResult>("usMajor")
      .then((r) => alive && setUs(r.data))
      .catch(() => undefined);
    api
      .overviewSection<GlobalQuote[]>("global")
      .then((r) => alive && setFx(r.data ?? []))
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, []);

  const night = us?.nightFutures ?? null;
  // 환율은 원/달러가 본체다. 엔·유로는 곁가지라 여기선 안 쓴다
  const usdkrw = fx.find((q) => q.symbol === "KRW=X") ?? null;

  if (!night && !usdkrw) return <div className="empty">아직 값이 없습니다.</div>;

  return (
    <div className="rp-kv">
      {night && (
        <div className="rp-kv-item">
          <span className="rp-kv-label">코스피 야간선물</span>
          <b className={`rp-kv-val ${cls(night.changeRate)}`}>{night.price?.toFixed(2)}</b>
          <span className={cls(night.changeRate)}>{pct(night.changeRate)}</span>
          <span className="pt-n">{night.symbol}</span>
        </div>
      )}
      {usdkrw && (
        <div className="rp-kv-item">
          <span className="rp-kv-label">원/달러</span>
          <b className={`rp-kv-val ${cls(usdkrw.changeRate)}`}>{usdkrw.price?.toFixed(2)}</b>
          <span className={cls(usdkrw.changeRate)}>{pct(usdkrw.changeRate)}</span>
        </div>
      )}
      <div className="table-note">
        야간선물은 미국장이 열려 있는 동안 움직인 값이라 <b>오늘 개장가의 예고편</b>입니다.
        환율을 같이 두는 건 외국인 수급이 환율과 붙어 움직이기 때문입니다.
      </div>
    </div>
  );
}

/* ───────────────────────────────── D4. 코스피·코스닥 추이 */

function IndexChart({ code, label }: { code: string; label: string }) {
  const [d, setD] = useState<IndexDetailData | null>(null);
  useEffect(() => {
    let alive = true;
    api
      .indexDetail(code, "day")
      .then((r) => alive && setD(r))
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, [code]);

  // 60거래일이면 석 달이다 — 리포트에서는 이 정도가 "요즘 흐름"이다
  const candles = (d?.candles ?? []).slice(-60);
  if (candles.length < 2) return null;

  return (
    <div className="rp-chart">
      <div className="rp-chart-title">
        {label}
        <b className="pt-n"> {candles[candles.length - 1].close.toFixed(2)}</b>
      </div>
      <TrendLineChart
        height={150}
        series={[
          {
            label,
            color: code === "101" ? "#f5c542" : "#4c8dff",
            axis: "right",
            data: candles.map((c) => ({
              time: {
                year: Number(c.dt.slice(0, 4)),
                month: Number(c.dt.slice(4, 6)),
                day: Number(c.dt.slice(6, 8)),
              },
              value: c.close,
            })),
          },
        ]}
      />
    </div>
  );
}

/**
 * 코스피·코스닥 60거래일 추이.
 *
 * 숫자만으로는 "오늘 −1.5%" 가 어디쯤에서 난 하락인지 모른다.
 * 고점에서 흘러내리는 중인지 바닥에서 튀는 중인지가 판단을 가른다.
 */
export function IndexTrendSection() {
  return (
    <div className="rp-charts">
      <IndexChart code="001" label="코스피" />
      <IndexChart code="101" label="코스닥" />
    </div>
  );
}

/* ───────────────────────────────── D5. 시장 자금 흐름 */

/**
 * 업종별로 돈이 어디서 빠져 어디로 갔나.
 *
 * "오늘 외국인 +800억" 같은 총액은 방향을 못 말해 준다. **같은 총액이라도**
 * 반도체에서 빼서 방산으로 옮긴 날과 전 업종을 고르게 산 날은 완전히 다른 장이다.
 * 5일 누적으로 보는 건 하루치는 노이즈가 크기 때문이다.
 */
export function MoneyFlowSection() {
  const [d, setD] = useState<SectorFlowResult | null>(null);
  const [subject, setSubject] = useState("foreign");

  useEffect(() => {
    let alive = true;
    setD(null);
    api
      .sectorFlow(subject, 5)
      .then((r) => alive && setD(r))
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, [subject]);

  const stats = d?.stats ?? [];
  const inflow = stats.slice(0, 5);
  const outflow = [...stats].reverse().slice(0, 5);

  return (
    <>
      <div className="filter-row">
        {[
          { k: "foreign", l: "외국인" },
          { k: "institution", l: "기관" },
          { k: "pension", l: "연기금" },
        ].map((s) => (
          <button
            key={s.k}
            className={`filter-btn ${subject === s.k ? "active" : ""}`}
            onClick={() => setSubject(s.k)}
          >
            {s.l}
          </button>
        ))}
        {d && <span className="pt-n">5일 누적 · 억원</span>}
      </div>

      {!d && <div className="page-note">불러오는 중…</div>}

      {d && (
        <div className="rp-flow">
          <div>
            <div className="rp-flow-h positive">들어온 곳</div>
            {inflow.map((s) => (
              <div className="rp-flow-row" key={s.code}>
                <span>{s.label}</span>
                <b className="positive">+{fmtNum(Math.round(s.sum))}</b>
              </div>
            ))}
          </div>
          <div>
            <div className="rp-flow-h negative">빠져나간 곳</div>
            {outflow.map((s) => (
              <div className="rp-flow-row" key={s.code}>
                <span>{s.label}</span>
                <b className="negative">{fmtNum(Math.round(s.sum))}</b>
              </div>
            ))}
          </div>
        </div>
      )}

      <div className="table-note">
        총액이 아니라 <b>어디서 빼서 어디로 넣었나</b>를 봅니다. 같은 +800억이라도 반도체에서
        빼서 방산으로 옮긴 날과 전 업종을 고르게 산 날은 완전히 다른 장입니다.
      </div>
    </>
  );
}

/* ───────────────────────────────── D6·D7. 테마 MAP */

/** MAP 페이지와 같은 색 규칙 — 두 화면에서 같은 등락률이 다른 색이면 안 된다 */
function tileStyle(rate: number): React.CSSProperties {
  const capped = Math.min(Math.abs(rate), 5) / 5; // 5% 이상은 최대 강도
  const alpha = 0.12 + capped * 0.55;
  if (rate > 0) return { background: `rgba(240, 85, 95, ${alpha})` };
  if (rate < 0) return { background: `rgba(74, 139, 245, ${alpha})` };
  return { background: "rgba(139, 150, 165, 0.12)" };
}

interface MiniTile {
  key: string;
  name: string;
  rate: number;
  sub?: string;
}

function MapMini({ tiles, empty }: { tiles: MiniTile[]; empty: string }) {
  if (tiles.length === 0) return <div className="empty">{empty}</div>;
  return (
    <div className="rp-map">
      {tiles.map((t) => (
        <div className="rp-map-tile" style={tileStyle(t.rate)} key={t.key} title={t.name}>
          <span className="rp-map-name">{t.name}</span>
          <span className="rp-map-pct num">{pct(t.rate)}</span>
          {t.sub && <span className="rp-map-sub">{t.sub}</span>}
        </div>
      ))}
    </div>
  );
}

/**
 * 미국 테마 MAP.
 *
 * **밤사이 미국에서 무엇이 돌았나**가 오늘 국내 무엇이 도는지를 상당 부분 정한다.
 * 반도체가 밤에 빠졌으면 아침에 국내 반도체도 빠진 채로 시작한다 — 그걸 개장 전에
 * 알고 들어가는 것과 모르고 들어가는 것은 다르다.
 *
 * 내가 짜 둔 미국 관심종목 그룹을 그대로 쓴다. 남의 분류가 아니라 **내 분류**여야
 * 국내 종목과 머릿속에서 이어진다.
 */
export function UsThemeMapSection() {
  const { tiles, loading } = useWatchGroupTiles("watchUs");
  if (loading) return <div className="page-note">불러오는 중…</div>;
  return (
    <>
      <MapMini
        tiles={tiles.map((t) => ({
          key: t.id,
          name: t.name,
          rate: t.changeRate,
          sub: `▲${t.risingCount}/▼${t.fallingCount}`,
        }))}
        empty="미국 관심종목 그룹이 없습니다."
      />
      <div className="table-note">
        내 미국 관심종목 그룹입니다. <b>밤사이 무엇이 돌았나</b>가 오늘 국내 무엇이 도는지를
        상당 부분 정합니다. ▲/▼ 는 그 그룹에서 오른/내린 종목 수입니다.
      </div>
    </>
  );
}

/**
 * 국내 테마 MAP.
 *
 * 키움 테마 순위를 쓴다. 상승·하락을 **한 판에 같이** 놓는 게 중요하다 —
 * 오른 것만 보면 "장이 좋다"고 착각하는데, 실제로는 돈이 옮겨 다닌 것뿐인 날이 많다.
 */
export function KrThemeMapSection() {
  const themes = useSection<{ top: ThemeRow[]; bottom: ThemeRow[] }>("themes", 180_000);
  const merged = (() => {
    const m = new Map<string, ThemeRow>();
    for (const t of [...(themes.data?.top ?? []), ...(themes.data?.bottom ?? [])]) m.set(t.code, t);
    return [...m.values()].sort((a, b) => b.changeRate - a.changeRate);
  })();

  if (themes.loading) return <div className="page-note">불러오는 중…</div>;
  return (
    <>
      <MapMini
        tiles={merged.map((t) => ({ key: t.code, name: t.name, rate: t.changeRate }))}
        empty="테마 데이터가 없습니다."
      />
      <div className="table-note">
        키움 테마 분류입니다. 오른 것과 내린 것을 <b>한 판에 같이</b> 놓았습니다 — 오른 것만
        보면 장이 좋다고 착각하는데, 돈이 옮겨 다닌 것뿐인 날이 많습니다.
      </div>
    </>
  );
}

/* ───────────────────────────────── D8. 내 관심종목 */

/**
 * 내 종목이 오늘 어떤가.
 *
 * 리포트가 시장 전체를 아무리 잘 정리해도 **내가 든 종목이 어떤지**가 없으면
 * 결국 다른 화면을 열게 된다. 아침에 한 번 훑고 판단을 시작하는 자리라면
 * 여기서 끝나야 한다.
 *
 * 두 묶음을 나란히 둔다 — AI_HTS(내가 짠 것)와 키움 첫 그룹(원래 보던 것).
 * 그리고 **오늘 공시가 뜬 종목은 따로 모은다.** 등락률만 보면 왜 움직였는지 모르는데,
 * 공시 한 줄이 그 답인 경우가 많다.
 */
export function MyStocksSection({
  onSelectStock,
}: {
  onSelectStock: (code: string, name: string) => void;
}) {
  const [mine, setMine] = useState<TrackedStock[] | null>(null);
  const [kiwoom, setKiwoom] = useState<{ name: string; items: KiwoomGroupStock[] } | null>(null);
  const [dart, setDart] = useState<DartEvent[]>([]);

  useEffect(() => {
    let alive = true;
    api
      .watchlistTracking()
      .then((r) => alive && setMine(r.items))
      .catch(() => alive && setMine([]));

    api
      .kiwoomGroups()
      .then(async (r) => {
        // "첫번째 관심종목 그룹" — 키움에서 맨 위에 둔 것이 가장 자주 보는 것이다
        const first = r.groups[0];
        if (!first || !alive) return;
        const { items } = await api.kiwoomGroupStocks(first.code);
        if (alive) setKiwoom({ name: first.name, items });
      })
      .catch(() => undefined);

    api
      .dartToday()
      .then((r) => alive && setDart((r.events ?? []).filter((e) => e.watched)))
      .catch(() => undefined);

    return () => {
      alive = false;
    };
  }, []);

  const line = (code: string, name: string, price: number, rate: number, extra?: string) => (
    <button className="ov-li" key={code} onClick={() => onSelectStock(code, name)}>
      <span className="ov-nm">{name}</span>
      <span className={`ov-px num ${cls(rate)}`}>{fmtNum(price)}</span>
      <span className={`ov-pct num ${cls(rate)}`}>{pct(rate)}</span>
      {extra && <span className="pt-n">{extra}</span>}
    </button>
  );

  // 많이 움직인 것부터 — 안 움직인 종목을 위에 둘 이유가 없다
  const sorted = [...(mine ?? [])].sort((a, b) => Math.abs(b.changeRate) - Math.abs(a.changeRate));

  return (
    <>
      {dart.length > 0 && (
        <div className="rp-issue">
          <div className="rp-flow-h">오늘 공시 — 내 종목 {dart.length}건</div>
          {dart.slice(0, 6).map((e) => (
            <a className="rp-issue-row" href={e.url} target="_blank" rel="noreferrer" key={e.url}>
              <b>{e.corpName}</b>
              <span>{e.title}</span>
              {e.amended && <em className="dart-amend">정정</em>}
            </a>
          ))}
        </div>
      )}

      <div className="rp-featured">
        <div>
          <div className="rp-flow-h">
            관심종목 (AI_HTS)
            {mine && <span className="pt-n"> · {mine.length}종목</span>}
          </div>
          {mine === null && <div className="page-note">불러오는 중…</div>}
          {mine?.length === 0 && <div className="empty">담은 종목이 없습니다.</div>}
          {sorted
            .slice(0, 12)
            .map((s) =>
              line(s.code, s.name, s.price, s.changeRate, `${s.passCount}/${s.passTotal}`),
            )}
        </div>

        <div>
          <div className="rp-flow-h">
            키움 {kiwoom?.name ?? "관심종목"}
            {kiwoom && <span className="pt-n"> · {kiwoom.items.length}종목</span>}
          </div>
          {!kiwoom && <div className="page-note">불러오는 중…</div>}
          {kiwoom?.items
            .slice()
            .sort((a, b) => Math.abs(b.changeRate) - Math.abs(a.changeRate))
            .slice(0, 12)
            .map((s) => line(s.code, s.name, s.price, s.changeRate))}
        </div>
      </div>

      <div className="table-note">
        많이 <b>움직인 순</b>입니다 — 안 움직인 종목을 위에 둘 이유가 없습니다. AI_HTS 옆 숫자는
        조건충족수입니다. 공시는 <b>내 종목 것만</b> 걸렀습니다.
      </div>
    </>
  );
}

/* ───────────────────────────────── D11. 특징주 */

/**
 * 오늘 볼 만한 종목.
 *
 * 세 갈래로 모은다 — **신호등이 높은 것**, **52주 신고가**, **급등**.
 * 셋은 성격이 다르다. 신호등은 조건을 갖춘 것이고, 신고가는 이미 올라간 것이고,
 * 급등은 오늘 움직인 것이다. 섞어 놓으면 무엇을 보고 있는지 모르게 되므로 나눠 둔다.
 *
 * 신호등은 **마지막으로 돌린 스캔 결과**를 그대로 쓴다 — 리포트를 열 때마다
 * 전종목 스캔을 돌리면 몇 분이 걸리고 API 한도를 먹는다.
 */
export function FeaturedSection({
  onSelectStock,
}: {
  onSelectStock: (code: string, name: string) => void;
}) {
  const [hits, setHits] = useState<ScreenHit[] | null>(null);
  const [scanAt, setScanAt] = useState<string | null>(null);
  const [high, setHigh] = useState<StockRow[]>([]);
  const [rising, setRising] = useState<StockRow[]>([]);

  useEffect(() => {
    let alive = true;
    api
      .signalScreenRuns()
      .then(async (r) => {
        const latest = r.runs[0];
        if (!latest || !alive) return;
        const run = await api.signalScreenRun(latest.id);
        if (!alive) return;
        setScanAt(latest.at);
        // 점수 높은 것부터. 80점 미만은 "볼 만하다"고 하기 어렵다
        setHits(run.results.filter((h) => h.score >= 80).slice(0, 8));
      })
      .catch(() => alive && setHits([]));

    api
      .overviewSection<{ high: StockRow[]; low: StockRow[] }>("highLow")
      .then((r) => alive && setHigh((r.data?.high ?? []).slice(0, 8)))
      .catch(() => undefined);
    api
      .overviewSection<{ rising: StockRow[]; falling: StockRow[] }>("movers")
      .then((r) => alive && setRising((r.data?.rising ?? []).slice(0, 8)))
      .catch(() => undefined);

    return () => {
      alive = false;
    };
  }, []);

  const row = (code: string, name: string, price: number, rate: number, extra?: string) => (
    <button className="ov-li" key={`${code}-${name}`} onClick={() => onSelectStock(code, name)}>
      <span className="ov-nm">{name}</span>
      <span className={`ov-px num ${cls(rate)}`}>{fmtNum(price)}</span>
      <span className={`ov-pct num ${cls(rate)}`}>{pct(rate)}</span>
      {extra && <span className="pt-n">{extra}</span>}
    </button>
  );

  return (
    <div className="rp-featured">
      <div>
        <div className="rp-flow-h">
          신호등 80점 이상
          {scanAt && (
            <span className="pt-n"> · {new Date(scanAt).toLocaleString("ko-KR").slice(5, 16)} 스캔</span>
          )}
        </div>
        {hits === null && <div className="page-note">불러오는 중…</div>}
        {hits?.length === 0 && (
          <div className="empty">
            아직 스캔 결과가 없습니다. 「신호등 찾기」에서 한 번 돌리면 여기에 뜹니다.
          </div>
        )}
        {hits?.map((h) => row(h.code, h.name, h.price, h.changeRate, `${h.score}점`))}
      </div>

      <div>
        <div className="rp-flow-h">52주 신고가</div>
        {high.length === 0 && <div className="empty">없음</div>}
        {high.map((s) => row(s.code, s.name, s.price, s.changeRate))}
      </div>

      <div>
        <div className="rp-flow-h">오늘 급등</div>
        {rising.length === 0 && <div className="empty">없음</div>}
        {rising.map((s) => row(s.code, s.name, s.price, s.changeRate))}
      </div>
    </div>
  );
}

/* ───────────────────────────────── D9. 텔레그램 채널 요약 */

/**
 * 마지막으로 만든 채널 요약.
 *
 * **여기서 새로 돌리지 않는다.** 채널 수집은 텔레그램 세션을 쓰고 AI 호출도 붙는데,
 * 리포트를 열 때마다 그게 돌면 화면 하나 여는 값이 너무 비싸다. 「텔레그램 동향」에서
 * 만든 것을 그대로 가져와 보여 준다.
 *
 * AI 정리에 이미 이 내용이 녹아 있지만 **원문도 같이** 둔다 — 요약이 무엇을 보고
 * 그렇게 말했는지 확인할 데가 있어야 요약을 믿거나 의심할 수 있다.
 */
export function ChannelDigestSection() {
  const [report, setReport] = useState<ChannelReport | null | undefined>(undefined);

  useEffect(() => {
    let alive = true;
    api
      .channelReports(1)
      .then((r) => alive && setReport(r.reports[0] ?? null))
      .catch(() => alive && setReport(null));
    return () => {
      alive = false;
    };
  }, []);

  if (report === undefined) return <div className="page-note">불러오는 중…</div>;
  if (!report) {
    return (
      <div className="empty">
        아직 만든 채널 요약이 없습니다. 「텔레그램 동향」에서 한 번 돌리면 여기에 뜹니다.
      </div>
    );
  }

  return (
    <>
      <div className="pt-n" style={{ marginBottom: 6 }}>
        {new Date(report.generatedAt).toLocaleString("ko-KR").slice(5, 16)} 기준 · 채널{" "}
        {report.channels}개 · 원문 {report.rawCount}건 중 {report.usedCount}건 선별
      </div>

      {report.summary && <div className="report-ai-body">{report.summary}</div>}

      {report.items.length > 0 && (
        <details className="ov-help">
          <summary>선별된 원문 {report.items.length}건</summary>
          {report.items.slice(0, 20).map((it, i) => (
            <div className="rp-issue-row" key={`${it.at}-${i}`}>
              <b>{hhmm(it.at)}</b>
              <span>{it.text.slice(0, 140)}</span>
              {it.stocks && it.stocks.length > 0 && (
                <em className="pt-n">{it.stocks.slice(0, 3).join(", ")}</em>
              )}
            </div>
          ))}
        </details>
      )}
    </>
  );
}

function hhmm(iso: string): string {
  const d = new Date(iso);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

/* ───────────────────────────────── D10. 국내외 주요뉴스 종합 */

/**
 * 시간대별 주요 뉴스.
 *
 * 위의 「주요 뉴스 클리핑」은 종목·테마에 붙은 뉴스다. 이건 **시장 전체** 뉴스라
 * 성격이 다르다 — 겹쳐 보여도 둘 다 있는 게 낫다는 판단이다.
 *
 * 조간은 직전 6시간, 장중은 아침~점심, 석간은 점심~저녁을 본다. 지금 판이 무엇인지에
 * 따라 창이 달라지므로 **무엇을 보고 있는지 화면에 밝힌다.**
 */
export function MarketNewsSection({ edition }: { edition: string }) {
  const [items, setItems] = useState<NewsItem[] | null>(null);

  const window =
    edition === "morning"
      ? "직전 6시간"
      : edition === "intraday"
        ? "아침 ~ 점심"
        : edition === "closing"
          ? "점심 ~ 저녁"
          : "최근";

  useEffect(() => {
    let alive = true;
    // 시장 전체를 훑는 검색어. 종목명을 넣으면 그 종목 뉴스만 나와 성격이 달라진다
    api
      .news("증시 코스피 코스닥", { scope: "major", display: 20 })
      .then((r) => alive && setItems(r.items))
      .catch(() => alive && setItems([]));
    return () => {
      alive = false;
    };
  }, []);

  return (
    <>
      <div className="pt-n" style={{ marginBottom: 6 }}>
        {window} 기준 · 주요 매체
      </div>
      {items === null && <div className="page-note">불러오는 중…</div>}
      {items?.length === 0 && <div className="empty">가져온 뉴스가 없습니다.</div>}
      {items?.slice(0, 12).map((n) => (
        <a className="rp-issue-row" href={n.link} target="_blank" rel="noreferrer" key={n.link}>
          <span>{n.title}</span>
          {n.press && <em className="pt-n">{n.press}</em>}
        </a>
      ))}
    </>
  );
}
