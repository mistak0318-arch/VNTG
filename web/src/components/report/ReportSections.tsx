import { useCallback, useEffect, useState } from "react";
import { tileHeat, useAppearance } from "../../useAppearance";
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
  type PinnedHealth,
  type PinnedPost,
  type ScoredNews,
  type UsMajorResult,
  type EvaluatedTheme,
  type MarketPulse,
} from "../../api";
import { CandleChart } from "../CandleChart";
import { TradeChart, type TradeMonth } from "../TradePanel";
import { SectorStocks } from "../SectorFlowPanel";
import { useSection } from "../../useSection";
import { useWatchGroupTiles } from "../../useWatchGroupTiles";
import { ConstituentSheet, type ConstituentTarget } from "../overview/ConstituentSheet";
import { YahooChartSheet, type ChartTarget } from "../overview/YahooChartSheet";

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
      {/*
        봉차트다. 종가만 이으면 **꼬리가 안 보인다** — 아래로 길게 찔렀다 올라온 날과
        그냥 오른 날은 완전히 다른 뜻인데 선차트에서는 똑같이 생긴다.
        리포트는 좁으니 기간 최고/최저 말풍선은 끈다.
      */}
      <CandleChart
        name={label}
        showExtremes={false}
        candles={candles.map((c) => ({
          time: {
            year: Number(c.dt.slice(0, 4)),
            month: Number(c.dt.slice(4, 6)),
            day: Number(c.dt.slice(6, 8)),
          },
          open: c.open,
          high: c.high,
          low: c.low,
          close: c.close,
          volume: c.tradeValue,
        }))}
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
export function MoneyFlowSection({
  onSelectStock,
}: {
  onSelectStock?: (code: string, name: string) => void;
}) {
  const [d, setD] = useState<SectorFlowResult | null>(null);
  const [subject, setSubject] = useState("foreign");
  /** 펼친 업종 — 누르면 그 자리에서 구성종목 (자금 흐름 화면과 같은 목록) */
  const [open, setOpen] = useState<string | null>(null);

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
          {[
            { h: "들어온 곳", cls: "positive", rows: inflow },
            { h: "빠져나간 곳", cls: "negative", rows: outflow },
          ].map((col) => (
            <div key={col.h}>
              <div className={`rp-flow-h ${col.cls}`}>{col.h}</div>
              {col.rows.map((s) => (
                <div key={s.code}>
                  {/* 업종을 누르면 구성종목이 그 자리에서 (2026-08-25 — 자금 흐름 화면과 같은 목록) */}
                  <button
                    className="rp-flow-row rp-flow-click"
                    onClick={() => setOpen(open === s.code ? null : s.code)}
                    title="누르면 구성종목이 펼쳐집니다"
                  >
                    <span>
                      <i className="sf-caret">{open === s.code ? "▾" : "▸"}</i> {s.label}
                    </span>
                    <b className={col.cls}>
                      {s.sum > 0 ? "+" : ""}
                      {fmtNum(Math.round(s.sum))}
                    </b>
                  </button>
                  {open === s.code && (
                    <SectorStocks market={s.market} code={s.code} onSelectStock={onSelectStock} />
                  )}
                </div>
              ))}
            </div>
          ))}
        </div>
      )}

      <div className="table-note">
        총액이 아니라 <b>어디서 빼서 어디로 넣었나</b>를 봅니다. 같은 +800억이라도 반도체에서
        빼서 방산으로 옮긴 날과 전 업종을 고르게 산 날은 완전히 다른 장입니다. 업종을 누르면
        구성종목이 펼쳐집니다.
      </div>
    </>
  );
}

/* ───────────────────────────────── D6·D7. 테마 MAP */



interface MiniTile {
  key: string;
  name: string;
  rate: number;
  sub?: string;
  /** 눌렀을 때 열 구성종목. 없으면 못 누르는 타일이다 */
  open?: ConstituentTarget;
}

/**
 * 테마 판.
 *
 * **누르면 그 안에 뭐가 들었는지 보여야 한다.** 「반도체 +2.9%」만 보고 끝나면
 * 그래서 무엇을 봐야 하는지 모른 채 다른 화면을 열게 된다.
 */
function MapMini({
  tiles,
  empty,
  onOpen,
}: {
  tiles: MiniTile[];
  empty: string;
  onOpen?: (t: ConstituentTarget) => void;
}) {
  const { theme } = useAppearance();
  if (tiles.length === 0) return <div className="empty">{empty}</div>;
  return (
    <div className="rp-map">
      {tiles.map((t) =>
        t.open && onOpen ? (
          <button
            className="rp-map-tile clickable"
            style={tileHeat(t.rate, theme)}
            key={t.key}
            title={`${t.name} — 눌러서 구성종목 보기`}
            onClick={() => onOpen(t.open!)}
          >
            <span className="rp-map-name">{t.name}</span>
            <span className="rp-map-pct num">{pct(t.rate)}</span>
            {t.sub && <span className="rp-map-sub">{t.sub}</span>}
          </button>
        ) : (
          <div className="rp-map-tile" style={tileHeat(t.rate, theme)} key={t.key} title={t.name}>
            <span className="rp-map-name">{t.name}</span>
            <span className="rp-map-pct num">{pct(t.rate)}</span>
            {t.sub && <span className="rp-map-sub">{t.sub}</span>}
          </div>
        ),
      )}
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
 * 내가 짜 둔 해외 관심종목 그룹을 그대로 쓴다. 남의 분류가 아니라 **내 분류**여야
 * 국내 종목과 머릿속에서 이어진다.
 */
export function UsThemeMapSection({
  onSelectStock,
}: {
  onSelectStock?: (code: string, name: string) => void;
} = {}) {
  const { tiles, loading } = useWatchGroupTiles("watchUs");
  const [target, setTarget] = useState<ConstituentTarget | null>(null);
  /*
   * 여기 종목은 **해외 티커**다.
   * 국내 상세로 보내면 `NVDA` 를 종목코드로 찾다가 아무것도 못 찾는다.
   */
  const [usDetail, setUsDetail] = useState<ChartTarget | null>(null);

  if (loading) return <div className="page-note">불러오는 중…</div>;
  return (
    <>
      <MapMini
        tiles={tiles.map((t) => ({
          key: t.id,
          name: t.name,
          rate: t.changeRate,
          sub: `▲${t.risingCount}/▼${t.fallingCount}`,
          /*
           * 구성종목을 **그대로 넘긴다.**
           *
           * 국내 테마는 코드로 조회하지만 여기 타일은 내 해외 관심종목 그룹이라
           * 「구성종목 엔드포인트」가 따로 없다. 그런데 종목 목록은 그리려고 이미 받아 놨다 —
           * 있는 걸 다시 부를 이유가 없다.
           */
          open: {
            kind: "custom" as const,
            code: t.id,
            name: t.name,
            label: "관심종목 그룹",
            stocks: t.stocks,
          },
        }))}
        empty="해외 관심종목 그룹이 없습니다."
        onOpen={setTarget}
      />
      {target && (
        <ConstituentSheet
          target={target}
          onClose={() => setTarget(null)}
          onSelectStock={(c, n) => {
            setTarget(null);
            setUsDetail({ kind: "usStock", symbol: c, label: n || c });
          }}
        />
      )}
      {usDetail && <YahooChartSheet target={usDetail} onClose={() => setUsDetail(null)} />}
      <div className="table-note">
        내 <b>해외 관심종목</b> 그룹입니다. <b>밤사이 무엇이 돌았나</b>가 오늘 국내 무엇이 도는지를
        상당 부분 정합니다. ▲/▼ 는 그 그룹에서 오른/내린 종목 수입니다.
        칸을 누르면 그 그룹의 종목이 보입니다.
      </div>
    </>
  );
}

/**
 * 국내 테마 MAP — **내 테마 기준.**
 *
 * 예전엔 키움 테마 순위를 썼다. 그런데 **증권사가 나눠 준 테마와 실제로 시장이 도는
 * 묶음은 다르다.** 키움 분류는 「반도체_후공정」·「휴대폰_RF부품」처럼 잘게 쪼개져 있어서,
 * 바로 위 미국 MAP 의 「원자력SMR」·「양자」와 **짝을 지어 볼 수가 없었다.**
 *
 * 이 두 판을 나란히 놓는 목적이 그것이다 — **밤사이 미국에서 돈 것이 오늘 국내 어디로
 * 오는가.** 견주려면 양쪽이 같은 언어로 묶여 있어야 하고, 그 언어는 내가 정한 것이어야 한다.
 *
 * 상승·하락을 **한 판에 같이** 놓는 건 그대로다 — 오른 것만 보면 "장이 좋다"고 착각하는데,
 * 실제로는 돈이 옮겨 다닌 것뿐인 날이 많다.
 *
 * **키움 테마를 버린 게 아니다.** 바로 아래 「특징 테마(상승 이유 포함)」가 그걸 쓴다.
 */
export function KrThemeMapSection({
  onSelectStock,
}: {
  onSelectStock?: (code: string, name: string) => void;
} = {}) {
  const [target, setTarget] = useState<ConstituentTarget | null>(null);
  const [themes, setThemes] = useState<EvaluatedTheme[] | null>(null);

  useEffect(() => {
    let alive = true;
    api
      .customThemes()
      .then((r) => {
        if (alive) setThemes(r.themes);
      })
      .catch(() => {
        if (alive) setThemes([]);
      });
    return () => {
      alive = false;
    };
  }, []);

  if (themes === null) return <div className="page-note">불러오는 중…</div>;

  /*
   * 종목이 하나도 안 잡힌 테마는 뺀다 — 등락률이 null 이라 칸만 차지한다.
   * 정렬은 등락률 내림차순: 오른 것이 왼쪽, 내린 것이 오른쪽으로 한 판에 늘어선다.
   */
  const usable = themes
    .filter((t) => t.changeRate !== null && t.stocks.length > 0)
    .sort((a, b) => (b.changeRate ?? 0) - (a.changeRate ?? 0));

  return (
    <>
      <MapMini
        tiles={usable.map((t) => ({
          key: t.id,
          name: t.name,
          rate: t.changeRate ?? 0,
          sub: `▲${t.risingCount}/▼${t.fallingCount}`,
          /*
           * 구성종목은 이미 손에 있다 — 다시 조회할 이유가 없다.
           * 다만 테마 평가가 주는 모양엔 현재가·전일대비가 없어서(등락률만 쓴다)
           * 0 으로 채운다. 「내 테마」 화면도 같은 방식이다.
           */
          open: {
            kind: "custom" as const,
            code: t.id,
            name: t.name,
            stocks: t.stocks
              .filter((x) => x.found)
              .map((x) => ({
                code: x.code,
                name: x.name,
                price: 0,
                change: 0,
                changeRate: x.changeRate,
                marketCap: x.marketCap,
              })),
          },
        }))}
        empty="「내 태그」가 없습니다. 마이페이지 > 내 태그에서 만들어 주세요."
        onOpen={setTarget}
      />
      {target && (
        <ConstituentSheet
          target={target}
          onClose={() => setTarget(null)}
          onSelectStock={(c, n) => {
            setTarget(null);
            onSelectStock?.(c, n);
          }}
        />
      )}
      <div className="table-note">
        <b>내가 정한 테마</b>입니다 — 증권사가 나눠 준 분류와 실제로 시장이 도는 묶음은
        다릅니다. 바로 위 <b>미국 테마 MAP</b> 과 같은 언어로 묶여 있어야
        「밤사이 돈 것이 오늘 어디로 오는가」를 견줄 수 있습니다.
        오른 것과 내린 것을 <b>한 판에 같이</b> 놓았습니다 — 오른 것만 보면 장이 좋다고
        착각하는데, 돈이 옮겨 다닌 것뿐인 날이 많습니다.
        칸을 누르면 구성종목이 보입니다. (키움 테마는 아래 <b>특징 테마</b>에 그대로 있습니다)
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

  /* key 에 자리 번호를 섞는다 — 한 종목이 여러 그룹에 담기면 code 만으로는 겹친다 */
  const line = (key: string, code: string, name: string, price: number, rate: number, extra?: string) => (
    <button className="ov-li" key={key} onClick={() => onSelectStock(code, name)}>
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
            관심종목 (VNTG)
            {mine && <span className="pt-n"> · {mine.length}종목</span>}
          </div>
          {mine === null && <div className="page-note">불러오는 중…</div>}
          {mine?.length === 0 && <div className="empty">담은 종목이 없습니다.</div>}
          {sorted
            .slice(0, 12)
            .map((s, i) =>
              line(`${s.code}-${i}`, s.code, s.name, s.price, s.changeRate, `${s.passCount}/${s.passTotal}`),
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
            .map((s, i) => line(`k-${s.code}-${i}`, s.code, s.name, s.price, s.changeRate))}
        </div>
      </div>

      <div className="table-note">
        많이 <b>움직인 순</b>입니다 — 안 움직인 종목을 위에 둘 이유가 없습니다. VNTG 옆 숫자는
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

      {/*
        요약을 구조로 그린다 (2026-08-26 — 「문장 나열식이라 보기 힘들다」).
        AI 요약은 "## 제목" 과 불릿으로 오는데 통짜 텍스트로 흘려서 벽이 됐다.
        제목은 제목답게 세우고, 불릿은 줄마다 끊고, 등락률 숫자에 색을 입힌다 —
        글자는 하나도 안 바꾼다.
      */}
      {report.summary && <div className="rp-digest">{renderDigest(report.summary)}</div>}

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

/** 채널 요약 본문 — ## 제목 / 불릿 / 숫자 색까지. 글자는 그대로 */
function renderDigest(text: string) {
  return text
    .split(/\r?\n/)
    .map((raw, i) => {
      const line = raw.trim();
      if (!line) return null;
      if (line.startsWith("## ")) {
        return (
          <h4 className="rp-digest-h" key={i}>
            {line.slice(3)}
          </h4>
        );
      }
      const isBullet = /^[-•·*▶]/.test(line);
      const body = line.replace(/^[-•·*▶]\s*/, "").replace(/\*\*([^*]+)\*\*/g, "$1");
      return (
        <div className={isBullet ? "rp-digest-li" : "rp-digest-p"} key={i}>
          {isBullet && <i>·</i>} {emphasize(body)}
        </div>
      );
    })
    .filter(Boolean);
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

/* ───────────────────────────────── D1. 고정 채널 원문 */

/**
 * 고정 채널의 그 시간대 글 — **원문 그대로**.
 *
 * 새벽에 전일 미장 시황을, 장중에 브리핑을 올리는 채널이 있다. 이런 글은 다른 채널의
 * 조각 정보와 성격이 다르다 — **이미 한 편으로 정리돼 있다.** 선별에 넣으면 점수 싸움에
 * 밀려 잘려 나가고, AI 로 다시 요약하면 그 정리가 사라진다.
 *
 * 그래서 맨 위에 원문 그대로 놓는다. 리포트를 여는 이유가 대개 이 글이다.
 */
export function PinnedChannelSection({ edition }: { edition: string }) {
  const [posts, setPosts] = useState<PinnedPost[] | null>(null);
  const [summary, setSummary] = useState<string | null>(null);
  const [health, setHealth] = useState<PinnedHealth | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  /** 오래 걸리는가 — 20초가 넘으면 화면에 말한다 */
  const [slow, setSlow] = useState(false);

  const load = useCallback(
    (force: boolean) => {
      setBusy(true);
      setError(null);
      setSlow(false);
      const slowTimer = setTimeout(() => setSlow(true), 20_000);
      if (force) setPosts(null);
      api
        .channelPinned(edition, 3, force)
        .then((r) => {
          setPosts(r.posts);
          setSummary(r.summary ?? null);
          setHealth(r.health ?? null);
        })
        .catch((e: Error) => {
          /*
           * **실패를 말한다.**
           * 예전엔 조용히 빈 목록을 넣어서, 못 받은 건지 원래 글이 없는 건지 알 수 없었다.
           */
          setError(e.message || "불러오지 못했습니다");
          setPosts([]);
        })
        .finally(() => {
          clearTimeout(slowTimer);
          setBusy(false);
        });
    },
    [edition],
  );

  useEffect(() => {
    setPosts(null);
    load(false);
  }, [load]);

  /*
   * ⚠️ **「불러오는 중」에서 안 끝나는 화면이 있었다.**
   *
   * 고정 채널은 텔레그램에 직접 물어보는 조회라 세션이 느리거나 붙는 중이면 응답이
   * 한참 안 온다. 그동안 화면에는 「불러오는 중」 넉 자뿐이어서, 기다리면 되는 건지
   * 고장인지 알 수가 없었다 — 실제로 「여전히 못 읽어온다」는 말이 나왔다.
   *
   * 오래 걸리면 **오래 걸린다고 말한다.** 그리고 다시 받을 길을 준다.
   */
  if (posts === null) {
    return (
      <div className="page-note">
        불러오는 중…
        {slow && (
          <>
            {" "}
            <b>20초가 넘었습니다</b> — 텔레그램 세션이 붙는 중이거나 응답이 느립니다.
            <button className="filter-btn" onClick={() => load(true)} disabled={busy}>
              ↻ 다시
            </button>
          </>
        )}
      </div>
    );
  }

  if (error) {
    return (
      <div className="error-banner">
        {error}
        <button className="filter-btn" onClick={() => load(true)} disabled={busy}>
          다시 받기
        </button>
      </div>
    );
  }

  if (posts.length === 0) {
    /*
     * **어디서 막혔는지 말한다.**
     * 예전엔 늘 「글이 없습니다」였다 — 채널을 안 걸었을 때도, 세션이 끊겼을 때도,
     * 진짜로 글이 없을 때도 같은 문장이라 무엇을 고쳐야 할지 알 수가 없었다.
     */
    return (
      <div className="empty">
        <b>{health?.stage ?? "고정한 채널의 글이 없습니다"}</b>
        {health?.detail && <div className="pt-n">{health.detail}</div>}
        <div className="pt-n">
          {health?.okAt
            ? `마지막으로 읽은 때: ${new Date(health.okAt).toLocaleString("ko-KR")} (${health.okCount}건)`
            : "이번 서버가 뜬 뒤로 한 번도 못 읽었습니다"}
          {health?.triedAt &&
            ` · 마지막 시도: ${new Date(health.triedAt).toLocaleTimeString("ko-KR")}`}
        </div>
        <button className="filter-btn" onClick={() => load(true)} disabled={busy}>
          다시 받기
        </button>
      </div>
    );
  }

  return (
    <>
      {/*
        AI 세 줄 요약이 맨 위 (2026-08-25) — 원문이 길어서 안 읽고 넘기는 날이 생겼다.
        요약이라도 읽으면 원문을 읽을지 말지 고를 수 있다. 원문은 그대로 아래 있다.
      */}
      {summary && (
        <div className="rp-pin-sum">
          <div className="rp-pin-sum-h">⚡ 요약 <i>AI — 원문에서 뽑았습니다</i></div>
          {summary
            .split(/\r?\n/)
            .filter((l) => l.trim())
            .map((l, i) => (
              <div className="rp-pin-sum-line" key={i}>
                {emphasize(l.replace(/^[·•\-]\s*/, "· "))}
              </div>
            ))}
        </div>
      )}
      {/*
        원문은 접어 둔다 (2026-08-26 — 「원문이 너무 길다」).
        본체는 위의 요약이고, 각 글은 출처·시각·원문 링크 한 줄만 보인다.
        더 읽고 싶은 날만 「원문 펼치기」 — 원문 자체는 그대로 보존한다(그게 이 섹션의 존재 이유).
      */}
      {posts.map((p) => (
        <div className="rp-pinned" key={`${p.at}-${p.link}`}>
          {/* 누가 언제 쓴 글인지가 머리에 또렷이 — 출처 없는 시황은 무게를 잴 수 없다 */}
          <div className="rp-pinned-h">
            <b className="rp-pin-who">✍ {p.channelName}</b>
            <span className="rp-pin-when">{postedLabel(p.at)}</span>
            {p.link && (
              <a href={p.link} target="_blank" rel="noreferrer" className="pt-n">
                텔레그램 원문 →
              </a>
            )}
          </div>
          <details className="rp-pin-fold">
            <summary>원문 펼치기 ({p.text.length.toLocaleString("ko-KR")}자)</summary>
            {/* 원문이라 줄바꿈을 그대로 살린다 — 문단이 무너지면 읽기가 어려워진다 */}
            <div className="rp-pinned-body">{renderPinned(p.text)}</div>
          </details>
        </div>
      ))}
      <div className="table-note">
        위 요약은 AI 가 원문에서 뽑은 것이고, <b>원문은 접혀 있을 뿐 그대로</b>입니다 —
        펼치거나 텔레그램 링크로 봅니다. 한 번 받은 판은 <b>그날치로 저장</b>되어, 나중에
        열어도 아침에 본 그 글이 그대로 있습니다.
        <button className="filter-btn" onClick={() => load(true)} disabled={busy}>
          {busy ? "…" : "다시 받기"}
        </button>
      </div>
    </>
  );
}


/**
 * 원문을 **줄 단위로** 그린다.
 *
 * 글자는 하나도 안 바꾼다 — 요약도 재작성도 아니다. `◎` 로 시작하는 줄만 큰 묶음 제목으로
 * 세워서 **어디서 화제가 바뀌는지** 보이게 한다.
 *
 * 채널 글은 원래 층이 있다.
 *   ◎ 해외 증시            ← 큰 묶음
 *   국채 금리 하락에 반등    ← 요지
 *     LPL. 반창고 역할      ← 근거·인용 (들여쓰기)
 * 그 층을 살리는 것만으로 「나열식이라 중요도를 모르겠다」가 상당히 풀린다.
 * 없는 중요도를 만들어 내는 게 아니라, **원문에 이미 있는 것을 안 지우는** 것이다.
 */
/** 「8/25 (월) 07:12 발행」 — 언제 쓴 글인지가 이 섹션 신뢰의 절반이다 */
function postedLabel(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const day = ["일", "월", "화", "수", "목", "금", "토"][d.getDay()];
  const two = (n: number) => String(n).padStart(2, "0");
  return `${d.getMonth() + 1}/${d.getDate()} (${day}) ${two(d.getHours())}:${two(d.getMinutes())} 발행`;
}

/**
 * 등락률·숫자에 색을 입힌다 (2026-08-25 — 「너무 텍스트라 눈에 안 들어온다」).
 * 글자는 하나도 안 바꾼다 — `+1.2%` 는 빨갛게, `-0.8%` 는 파랗게 칠하는 것뿐이다.
 * 시황 글에서 눈이 찾는 건 대부분 이 숫자들이다.
 */
function emphasize(line: string) {
  const parts = line.split(/([+▲]\s?\d+(?:[.,]\d+)?%?|[-▼]\s?\d+(?:[.,]\d+)?%)/g);
  return parts.map((p, i) => {
    if (/^[+▲]/.test(p)) return <b className="positive" key={i}>{p}</b>;
    if (/^[-▼]/.test(p)) return <b className="negative" key={i}>{p}</b>;
    return <span key={i}>{p}</span>;
  });
}

function renderPinned(text: string) {
  return text.split(/\r?\n/).map((line, i) => {
    const t = line.trim();
    if (t.startsWith("◎") || t.startsWith("■") || t.startsWith("【")) {
      return (
        <b className="rp-pinned-sec" key={i}>
          {t}
        </b>
      );
    }
    /* 불릿 줄은 조금 들여쓰고 표식을 흐리게 — 층이 눈에 보여야 훑어진다 */
    if (/^[▶▷•●\-–·*]/.test(t) && t.length > 1) {
      return (
        <span className="rp-pin-li" key={i}>
          {emphasize(line)}
          {"\n"}
        </span>
      );
    }
    // 줄바꿈은 CSS(white-space: pre-wrap)가 살린다 — 여기서 <br> 을 넣으면 두 번 띄어진다
    return <span key={i}>{emphasize(line)}{"\n"}</span>;
  });
}

/* ------------------------------------------------------------------ */
/* 수출입 동향 (2026-08-26) — 리포트 끝에서 「실물이 어디로 가나」 한눈에    */
/* ------------------------------------------------------------------ */

/**
 * 관세청 월별 실측 중 **크게 움직인 품목만** 골라 카드 + 36개월 그래프로 보여준다.
 * 그래프는 수출 동향 탭과 같은 컴포넌트(TradeChart — 막대색이 전년동월 대비) —
 * 두 화면이 같은 값을 다르게 그리면 헷갈린다. 전체 표·나라별은 그 탭 몫이다.
 */
export function TradeTrendSection() {
  const [brief, setBrief] = useState<Awaited<ReturnType<typeof api.tradeBrief>> | null>(null);
  const [charts, setCharts] = useState<Record<string, TradeMonth[]>>({});
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    api
      .tradeBrief()
      .then(async (r) => {
        if (!alive) return;
        setBrief(r);
        /*
         * 그래프는 변화 상위 4품목만 — 서른 개를 다 그리면 아무것도 안 읽힌다.
         * 시계열은 서버가 24시간 캐시하므로 여기서 넷을 물어도 비용이 없다.
         */
        const picks = [...r.rows].sort((a, b) => b.top - a.top).slice(0, 4);
        for (const p of picks) {
          try {
            const h = await api.tradeHistory(p.key);
            if (!alive) return;
            setCharts((prev) => ({ ...prev, [p.key]: h.months }));
          } catch {
            /* 한 품목 실패는 그 그래프만 빈다 */
          }
        }
      })
      .catch((e: Error) => setError(e.message || "불러오지 못했습니다"));
    return () => {
      alive = false;
    };
  }, []);

  if (error) return <div className="error-banner">{error}</div>;
  if (!brief) return <div className="page-note">불러오는 중…</div>;
  if (brief.rows.length === 0) {
    return <div className="empty">수출입 데이터가 없습니다 — DATA_GO_KR_KEY 설정을 확인하세요.</div>;
  }

  const picks = [...brief.rows].sort((a, b) => b.top - a.top).slice(0, 4);
  const seg = (label: string, w: { rate: number | null } | null) =>
    w && w.rate !== null ? (
      <span className={`tb-seg ${w.rate >= 0 ? "positive" : "negative"}`}>
        {label} {w.rate > 0 ? "+" : ""}
        {w.rate.toFixed(0)}%
      </span>
    ) : null;

  return (
    <>
      <p className="page-note">
        관세청 월별 실측에서 <b>가장 크게 움직인 품목</b>입니다 — 막대색은 전년 같은 달
        대비(늘면 빨강). 실물이 좋아지는 업종은 시세보다 먼저 여기 나타날 때가 많습니다.
        전체 품목·나라별 상세는 시장흐름분석 &gt; 수출 동향에서.
      </p>
      <div className="rp-trade">
        {picks.map((r) => (
          <div className="rp-trade-item" key={r.key}>
            <div className="rp-trade-head">
              <b>
                {r.label}
                <i className="tb-dir">{r.watch === "import" ? "수입" : "수출"}</i>
              </b>
              <span className="tb-segs num">
                {seg("분기", r.quarter)}
                {seg("반기", r.half)}
                {seg("연간", r.year)}
              </span>
            </div>
            {charts[r.key] ? (
              <TradeChart months={charts[r.key]} watch={r.watch} />
            ) : (
              <div className="page-note">그래프 불러오는 중…</div>
            )}
          </div>
        ))}
      </div>
    </>
  );
}

/* ------------------------------------------------------------------ */
/* 뉴스 클리핑 콤팩트 (2026-08-26) — 「섹터와 제목만, 링크로 가면 되니까」   */
/* ------------------------------------------------------------------ */

/**
 * 뉴스·공시 탭의 큰 컴포넌트(SectorNews: 탭·브리핑·본문 미리보기) 대신, 리포트에서는
 * **분야 이름 + 제목 줄**만 늘어놓는다. 눌러 볼 기사만 링크로 나간다.
 * 중요한 것만 — 분야당 다섯 줄, 보도 매체 수가 붙은(=여러 곳이 다룬) 순서다.
 */
export function NewsClippingCompact({ onFetched }: { onFetched?: (iso: string) => void }) {
  const [sectors, setSectors] = useState<
    { key: string; label: string; items: ScoredNews[] }[] | null
  >(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api
      .newsSectors("major", 8, "importance")
      .then((r) => {
        setSectors(r.sectors);
        if (r.fetchedAt) onFetched?.(r.fetchedAt);
      })
      .catch((e: Error) => setError(e.message || "불러오지 못했습니다"));
    // onFetched 는 부모의 setState 라 참조가 바뀌어도 다시 부를 이유가 없다
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (error) return <div className="error-banner">{error}</div>;
  if (!sectors) return <div className="page-note">불러오는 중…</div>;

  const filled = sectors.filter((s) => s.items.length > 0);
  if (filled.length === 0) return <div className="empty">기사가 없습니다.</div>;

  return (
    <div className="rp-nc">
      {filled.map((s) => (
        <div className="rp-nc-sec" key={s.key}>
          <span className="rp-nc-label">{s.label}</span>
          <div className="rp-nc-list">
            {s.items.slice(0, 5).map((n) => (
              <a
                className="rp-nc-line"
                key={n.link}
                href={n.link}
                target="_blank"
                rel="noreferrer"
              >
                {n.title}
                {n.coverage > 1 && <i className="rp-nc-cov">{n.coverage}곳</i>}
              </a>
            ))}
          </div>
        </div>
      ))}
      <div className="table-note">
        분야마다 <b>여러 매체가 같이 다룬 순서</b>로 다섯 건 — 제목을 누르면 기사로 갑니다.
        본문 미리보기·검색은 뉴스·공시 메뉴에서.
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* 슈퍼신호등 (2026-08-26) — 리포트 본문판                                */
/* ------------------------------------------------------------------ */

/**
 * 대시보드(🌟 메뉴)의 축약판 — 리포트에서는 「지금 시스템이 어떤 종목을 가리키고
 * 있고, 그게 얼마나 벌고 있나」 한 표면 된다. 흐름 상세는 🌟 메뉴 몫이다.
 */
export function SuperSignalSection({
  onSelectStock,
}: {
  onSelectStock: (code: string, name: string) => void;
}) {
  const [data, setData] = useState<Awaited<ReturnType<typeof api.signalSuper>> | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api
      .signalSuper()
      .then(setData)
      .catch((e: Error) => setError(e.message || "불러오지 못했습니다"));
  }, []);

  if (error) return <div className="error-banner">{error}</div>;
  if (!data) return <div className="page-note">불러오는 중…</div>;

  /* 교차 전용 줄은 뺀다 — 리포트에선 바로 아래 「교차 신호」 섹션이 따로 맡는다 */
  const active = data.entries.filter(
    (e) => e.active !== false && (e.groupTags?.includes("super") ?? true),
  );
  const spct = (v: number | null | undefined) =>
    v === null || v === undefined ? "-" : `${v > 0 ? "+" : ""}${v.toFixed(1)}%`;
  const scls = (v: number | null | undefined) =>
    v === null || v === undefined ? "" : v >= 0 ? "positive" : "negative";

  if (active.length === 0) {
    return (
      <div className="empty">
        추적 중인 슈퍼신호등 종목이 없습니다 — 평일 15:45 에 일곱 목록 교집합에서
        자동으로 뽑습니다.
      </div>
    );
  }

  /*
   * 요약이 본체다 (2026-08-26 — 「종목 많아질 텐데 나열이 무슨 의미냐」).
   * 오늘 움직인 것(신규 편입·오늘 급변)과 잘된 것/망가진 것만 하이라이트로 올리고,
   * 전체 표는 접어 둔다. 다 보고 싶은 날만 편다.
   */
  const w5 = data.stats.win.d5;
  const today = new Date(Date.now() + 9 * 3600_000).toISOString().slice(0, 10);
  const newly = active.filter((e) => e.addedDate === today);
  const withReturn = active.filter((e) => e.sinceAdded !== null);
  const best = [...withReturn].sort((a, b) => (b.sinceAdded ?? 0) - (a.sinceAdded ?? 0)).slice(0, 3);
  const worst = [...withReturn].sort((a, b) => (a.sinceAdded ?? 0) - (b.sinceAdded ?? 0)).slice(0, 2);
  const chip = (e: (typeof active)[number], tag?: string) => (
    <button className="rp-ss-chip" key={`${e.code}-${tag ?? ""}`} onClick={() => onSelectStock(e.code, e.name)}>
      {tag && <em>{tag}</em>}
      <b>{e.name}</b>
      <span className={`num ${scls(e.sinceAdded)}`}>{spct(e.sinceAdded)}</span>
    </button>
  );

  return (
    <>
      <p className="page-note">
        일곱 목록의 <b>교집합에 걸린 초록 신호등</b> — 시스템이 기계적으로 골라 따라가는
        목록입니다. 추적 <b>{data.stats.activeCount}종목</b>
        {data.stats.todayAdded > 0 && <> · 오늘 신규 {data.stats.todayAdded}</>}
        {data.stats.exitedCount > 0 && <> · 이탈 {data.stats.exitedCount}</>}
        {w5.rate !== null && (
          <>
            {" "}
            · 편입 5일 뒤 승률 <b>{w5.rate.toFixed(0)}%</b> ({w5.n}건)
          </>
        )}{" "}
        — 흐름 상세는 🌟 슈퍼신호등 메뉴에서.
      </p>

      <div className="rp-ss-chips">
        {newly.map((e) => chip(e, "신규"))}
        {best.filter((e) => !newly.includes(e)).map((e) => chip(e, "잘됨"))}
        {worst.filter((e) => !newly.includes(e) && !best.includes(e)).map((e) => chip(e, "부진"))}
      </div>

      <details className="rp-pin-fold">
        <summary>전체 {active.length}종목 표 펼치기</summary>
        <div className="data-table-wrap">
          <table className="data-table">
            <thead>
              <tr>
                <th className="sticky-col">종목</th>
                <th>편입일</th>
                <th>점수</th>
                <th>목록</th>
                <th>반복</th>
                <th>편입 대비</th>
                <th>+5일</th>
              </tr>
            </thead>
            <tbody>
              {active.map((e) => {
                const daily = e.daily ?? [];
                const now = daily.length > 0 ? daily[daily.length - 1].score : null;
                return (
                  <tr key={e.code}>
                    <td className="sticky-col">
                      <button className="report-line rl-inline" onClick={() => onSelectStock(e.code, e.name)}>
                        <b>{e.name}</b>
                      </button>
                    </td>
                    <td>{e.addedDate.slice(5)}</td>
                    <td className="num">
                      {e.score}
                      {now !== null && now !== e.score && (
                        <i className={now > e.score ? "positive" : "negative"}> →{now}</i>
                      )}
                    </td>
                    <td className="num">{e.lists.length}곳</td>
                    <td className="num">{e.seenCount}일</td>
                    <td className={`num strong-col ${scls(e.sinceAdded)}`}>{spct(e.sinceAdded)}</td>
                    <td className={`num ${scls(e.returns?.d5)}`}>{spct(e.returns?.d5)}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </details>
    </>
  );
}

/**
 * 교차 신호 — 시장 흐름 분석(맥박)의 「주도주 태그 ∩ 슈퍼신호등」을 리포트에도 (2026-08-27).
 * 두 체계가 **동시에** 가리키는 종목은 드물고, 드문 게 신호다. 걸리면 관심 그룹
 * 「슈퍼신호등+교차」에 자동 편입되어 추적된다 — 여기는 오늘 교집합의 스냅샷이다.
 */
export function CrossSignalSection({
  onSelectStock,
}: {
  onSelectStock: (code: string, name: string) => void;
}) {
  const [cross, setCross] = useState<MarketPulse["cross"] | null | undefined>(undefined);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api
      .pulse()
      .then((p) => setCross(p.cross))
      .catch((e: Error) => setError(e.message || "불러오지 못했습니다"));
  }, []);

  if (error) return <div className="error-banner">{error}</div>;
  if (cross === undefined) return <div className="page-note">불러오는 중…</div>;
  if (cross === null || cross.stocks.length === 0) {
    return (
      <div className="empty">
        오늘은 교차 신호가 없습니다 — 주도주 스캔과 슈퍼신호등이 같은 종목을 가리킬 때만
        나타납니다. 걸린 종목은 관심 그룹 「슈퍼신호등+교차」로 자동 편입됩니다.
      </div>
    );
  }

  return (
    <>
      <p className="page-note">{cross.note}</p>
      <div className="rp-ss-chips">
        {cross.stocks.map((s) => (
          <button
            className="rp-ss-chip"
            key={s.code}
            onClick={() => onSelectStock(s.code, s.name)}
            title={`${s.sector}${s.tags.length > 0 ? ` · ${s.tags.join(" · ")}` : ""}`}
          >
            <em>{s.sectorInflow ? "⚡자금" : "⚡"}</em>
            <b>{s.name}</b>
            <span className={`num ${s.changeRate >= 0 ? "positive" : "negative"}`}>
              {s.changeRate > 0 ? "+" : ""}
              {s.changeRate.toFixed(2)}%
            </span>
          </button>
        ))}
      </div>
      <p className="table-note">
        ⚡자금 = 업종에도 5일 외국인+기관 순매수가 붙어 있음 · 종목을 누르면 상세로 갑니다.
      </p>
    </>
  );
}
