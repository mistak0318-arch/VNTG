import { useCallback, useEffect, useState } from "react";
import {
  api,
  fmtNum,
  type RateRow,
  type UsBoardSignal,
  type UsMajorResult,
  type UsQuoteRow,
  type UsWatchGroup,
  type UsSearchResult,
} from "../../api";
import { useSection } from "../../useSection";
import { YahooChartSheet, type ChartTarget } from "./YahooChartSheet";
import { UsSpark } from "./UsSpark";
import { sideQuote } from "../../usSession";
import { useWatchGroupTiles } from "../../useWatchGroupTiles";
import { ConstituentSheet, type ConstituentTarget } from "./ConstituentSheet";

/**
 * 미국 전광판.
 *
 * 미국장이 열려 있는 동안 보는 자리다. 국내 시황 카드들 사이에 흩어져 있던 미국 값을
 * **한 화면에 세로로 쌓아** 위에서 아래로 훑게 한다 —
 *
 *   지수 넉 장 → 국채금리 → 코스피 야간선물 → 내 관심종목
 *
 * ## 새로 받는 게 없다
 *
 * 지수·금리·야간선물은 시황이 이미 받는 `usMajor`·`rates` 섹션 그대로다.
 * 관심종목은 「관심종목(해외)」가 쓰는 그 저장소를 그대로 쓴다 — 여기서 넣고 빼면
 * 그 화면에서도 같이 바뀐다. **같은 목록을 두 곳에서 따로 관리하게 만들지 않는다.**
 */

/** 위에 큰 상자로 세울 지수 — 국내 지수 카드와 같은 모양 */
/*
 * VIX 를 지수와 같은 줄에 둔다.
 *
 * 지수 넷만 보면 「올랐다/내렸다」는 알아도 **그게 편안한 상승인지 불안한 상승인지**를
 * 모른다. VIX 는 그 한 칸을 채운다. 값이 오르는 게 나쁜 쪽이라 색은 거꾸로 읽어야 하는데,
 * 그건 서버가 붙여 주는 판정 줄(why)이 말해 준다.
 */
const BOX_KEYS = ["gspc", "ndx", "rut", "sox", "vix"] as const;
/** 원자재 — 국채금리 아래 따로. 지수와 단위가 달라 같은 줄에 섞으면 못 읽는다 */
const COMMODITY_KEYS = ["wti", "brent", "gold"] as const;

function pct(v: number | null): string {
  if (v === null || !Number.isFinite(v)) return "-";
  return `${v > 0 ? "+" : ""}${v.toFixed(2)}%`;
}

function cls(v: number | null): string {
  if (v === null || !Number.isFinite(v) || v === 0) return "";
  return v > 0 ? "positive" : "negative";
}

/**
 * 지수·원자재 상자 — **국내 코스피/코스닥 카드와 같은 모양.**
 *
 * ## 왜 바꿨나
 *
 * 예전에는 한 줄에 이름·값·등락률을 몰아넣었다. 자리는 아꼈지만 **옆으로 길쭉한
 * 띠**가 되어 한눈에 안 들어왔고, 무엇보다 바로 위 국내 지수 카드와 모양이 달라서
 * 같은 화면 안에서 눈이 두 번 적응해야 했다.
 *
 * 국내 카드는 이미 답을 갖고 있다 — **두 칸씩, 값은 크게, 그 아래 하루치 선.**
 * 그래서 CSS 를 새로 만들지 않고 그 클래스(`ov-idx-*`)를 그대로 쓴다.
 * 나중에 국내 카드 모양을 고치면 여기도 같이 따라간다.
 *
 * 신호 테두리와 판정 한 줄은 이 화면에만 있는 것이라 `usb-` 클래스로 덧붙인다.
 */
function IndexBoxes({
  boxes,
  onPick,
}: {
  boxes: { key: string; label: string; symbol: string; digits: number; price: number | null; changeRate: number | null; signal?: { level: string; why: string } | null }[];
  onPick: (t: ChartTarget) => void;
}) {
  return (
    <div className="ov-idx-grid usb-idx-grid">
      {boxes.map((b) => (
        <button
          type="button"
          className={`ov-idx clickable usb-idx${b.signal ? ` sig-${b.signal.level}` : ""}`}
          key={b.key}
          onClick={() => onPick({ symbol: b.symbol, label: b.label, digits: b.digits })}
          title="눌러서 차트 보기"
        >
          <div className="ov-idx-name">{b.label}</div>
          <div className={`ov-idx-val num ${cls(b.changeRate)}`}>
            {b.price === null ? "-" : fmtNum(Number(b.price.toFixed(b.digits)))}
          </div>
          <div className={`ov-idx-chg num ${cls(b.changeRate)}`}>{pct(b.changeRate)}</div>
          <UsSpark symbol={b.symbol} />
          {/* 왜 눈에 띄는지 한 줄. 색만 있으면 이유를 모른다 */}
          {b.signal && <div className="usb-box-why">{b.signal.why}</div>}
        </button>
      ))}
    </div>
  );
}

export function UsBoardPanel() {
  const usMajor = useSection<UsMajorResult>("usMajor", 15_000);
  const rates = useSection<RateRow[]>("rates", 30_000);

  const rows = usMajor.data?.rows ?? [];
  const boxes = BOX_KEYS.map((k) => rows.find((r) => r.key === k)).filter(
    (r): r is NonNullable<typeof r> => Boolean(r),
  );
  const night = usMajor.data?.nightFutures ?? null;
  const commodities = COMMODITY_KEYS.map((k) => rows.find((r) => r.key === k)).filter(
    (r): r is NonNullable<typeof r> => Boolean(r),
  );
  /* 눌러서 차트 — 숫자 한 줄만으로는 「어디쯤인가」를 모른다 */
  const [chart, setChart] = useState<ChartTarget | null>(null);
  const usRates = (rates.data ?? []).filter((r) => r.group === "해외");

  return (
    <div className="usb">
      {/*
        신호등이 맨 위다. 열 줄을 훑어서 「오늘 미국이 괜찮은가」를 세는 건 사람이 할 일이 아니다.
        판정은 서버가 한다 — 화면에서 굴리면 리포트가 같은 판정을 다시 짜야 한다.
      */}
      {usMajor.data?.boardSignal && <BoardLight sig={usMajor.data.boardSignal} />}

      {/* ---------------- 지수 ---------------- */}
      <section className="ov-card">
        <div className="ov-card-h">
          <span className="ov-card-t">미국 지수</span>
          <span className="ov-card-sub">
            {usMajor.data?.fetchedAt
              ? new Date(usMajor.data.fetchedAt).toLocaleTimeString("ko-KR", { hour12: false })
              : ""}
          </span>
        </div>
        <div className="ov-card-b">
          {boxes.length === 0 ? (
            <div className="empty">불러오는 중…</div>
          ) : (
            <IndexBoxes boxes={boxes} onPick={setChart} />
          )}
          {usMajor.data?.curveNote && (
            <div className="usb-curve">{usMajor.data.curveNote}</div>
          )}
        </div>
      </section>

      {/* ---------------- 국채금리 ---------------- */}
      <section className="ov-card">
        <div className="ov-card-h">
          <span className="ov-card-t">미국 국채금리</span>
          {/* 갱신 시각을 적어 둔다 — 안 적으면 「이거 살아 있나」를 매번 의심하게 된다 */}
          <span className="ov-card-sub">
            {rates.updatedAt
              ? new Date(rates.updatedAt).toLocaleTimeString("ko-KR", { hour12: false })
              : ""}
          </span>
        </div>
        <div className="ov-card-b">
          {usRates.length === 0 ? (
            <div className="empty">불러오는 중…</div>
          ) : (
            <div className="usb-rates">
              {usRates.map((r) => (
                <div className="usb-rate" key={r.code}>
                  <span className="usb-rate-nm">{r.name}</span>
                  <b className="usb-rate-v">{r.rate === null ? "-" : `${r.rate.toFixed(3)}%`}</b>
                  {/* 금리는 등락률이 아니라 %p 로 읽어야 한다 */}
                  <span className={`usb-rate-d ${cls(r.change)}`}>
                    {r.change === null
                      ? ""
                      : `${r.change > 0 ? "+" : ""}${r.change.toFixed(3)}%p`}
                  </span>
                </div>
              ))}
            </div>
          )}
          <div className="table-note">
            금리는 <b>%p(변화폭)</b> 로 읽습니다 — 4.71%가 4.72%로 가는 건 등락률로는 0.2%지만
            시장이 반응하는 건 0.01%p 라는 폭 자체입니다.
          </div>
        </div>
      </section>

      {/* ---------------- 원자재 ---------------- */}
      <section className="ov-card">
        <div className="ov-card-h">
          <span className="ov-card-t">원자재</span>
          <span className="ov-card-sub">
            {usMajor.data?.fetchedAt
              ? new Date(usMajor.data.fetchedAt).toLocaleTimeString("ko-KR", { hour12: false })
              : ""}
          </span>
        </div>
        <div className="ov-card-b">
          {commodities.length === 0 ? (
            <div className="empty">불러오는 중…</div>
          ) : (
            <IndexBoxes boxes={commodities} onPick={setChart} />
          )}
          <div className="table-note">
            유가는 <b>정유·화학·항공</b>에 바로 닿습니다. 금은 금리·달러의 반대편이라 같이 보면
            지금 시장이 <b>위험을 사는지 피하는지</b>가 읽힙니다. WTI·브렌트는 선물(근월물)입니다.
          </div>
        </div>
      </section>

      {/* ---------------- 야간선물 ---------------- */}
      <section className="ov-card">
        <div className="ov-card-h">
          <span className="ov-card-t">코스피 야간선물</span>
          <span className="ov-card-sub">
            {usMajor.data?.fetchedAt
              ? new Date(usMajor.data.fetchedAt).toLocaleTimeString("ko-KR", { hour12: false })
              : ""}
          </span>
        </div>
        <div className="ov-card-b">
          {!night ? (
            <div className="empty">야간선물 값이 아직 없습니다.</div>
          ) : (
            <button
              type="button"
              className="usb-night clickable"
              onClick={() =>
                setChart({
                  kind: "futures",
                  symbol: night.symbol,
                  label: "코스피 야간선물",
                  digits: night.digits,
                })
              }
              title="눌러서 차트 보기"
            >
              <div className={`usb-night-px ${cls(night.changeRate)}`}>
                {night.price === null ? "-" : fmtNum(Number(night.price.toFixed(night.digits)))}
              </div>
              <div className={`usb-night-chg ${cls(night.changeRate)}`}>
                {night.change === null
                  ? ""
                  : `${night.change > 0 ? "▲" : "▼"}${Math.abs(night.change).toFixed(night.digits)}`}{" "}
                {pct(night.changeRate)}
              </div>
            </button>
          )}
          <div className="table-note">
            미국장이 열려 있는 동안 움직이는 값이라 <b>내일 개장가의 예고편</b>입니다.
            눌러서 흐름을 볼 수 있습니다 — 월물은 3개월마다 바뀌므로 그 이전 구간은 없습니다.
          </div>
        </div>
      </section>

      {/* ---------------- 관심종목 MAP ---------------- */}
      <UsWatchMap onOpen={(symbol, label) => setChart({ kind: "usStock", symbol, label })} />

      {/* ---------------- 섹터 MAP ---------------- */}
      <UsSectorMap onOpen={(symbol, label) => setChart({ kind: "usStock", symbol, label })} />

      {/* ---------------- 관심종목 ---------------- */}
      <UsBoardWatch onOpen={(symbol, label) => setChart({ kind: "usStock", symbol, label })} />

      {chart && <YahooChartSheet target={chart} onClose={() => setChart(null)} />}
    </div>
  );
}

/**
 * 관심종목 MAP — **한눈에 어디가 도는지.**
 *
 * ## 왜 목록 위에 따로 두나
 *
 * 아래 목록은 종목마다 한 줄이라 스무 개가 넘으면 훑는 데 시간이 걸린다.
 * 밤에 미국장을 볼 때 알고 싶은 건 「어느 그룹이 도는가」와 「어디가 튀는가」인데,
 * 그건 숫자를 읽는 게 아니라 **색 덩어리를 보는 일**이다.
 *
 * ## 국내 MAP 과 같은 타일·같은 색
 *
 * 색 규칙을 따로 만들면 국내 화면과 나란히 못 견준다. `map-tile` 을 그대로 쓰고
 * 색도 같은 식(5% 를 최대 강도로)으로 칠한다.
 *
 * ## 크기는 다 같다
 *
 * 국내 테마 MAP 은 시가총액으로 크기를 줄 수 있지만 **해외는 시가총액을 안 받아온다.**
 * 없는 걸 있는 척 크기로 만들면 거짓말이 되므로 칸을 똑같이 두고 색만 쓴다.
 */
function tileStyle(rate: number | null): React.CSSProperties {
  if (rate === null || !Number.isFinite(rate)) return { background: "rgba(139,150,165,.12)" };
  const capped = Math.min(Math.abs(rate), 5) / 5; // 5% 이상은 최대 강도
  const alpha = 0.12 + capped * 0.55;
  if (rate > 0) return { background: `rgba(240, 85, 95, ${alpha})` };
  if (rate < 0) return { background: `rgba(74, 139, 245, ${alpha})` };
  return { background: "rgba(139, 150, 165, 0.12)" };
}

function UsWatchMap({ onOpen }: { onOpen: (symbol: string, label: string) => void }) {
  /*
   * 그룹 계산은 **국내 MAP 과 같은 것을 쓴다.**
   *
   * 처음엔 여기서 직접 평균을 냈는데, 그러면 「테마/업종 MAP」의 관심종목(해외) 탭과
   * 숫자가 어긋날 수 있다 — 같은 그룹인데 화면마다 등락률이 다르면 어느 쪽을 믿어야
   * 할지 알 수 없다. 타일을 만드는 자리를 하나로 둔다.
   */
  const { tiles, loading } = useWatchGroupTiles("watchUs");
  const [target, setTarget] = useState<ConstituentTarget | null>(null);

  if (loading || tiles.length === 0) return null;

  return (
    <section className="ov-card">
      <div className="ov-card-h">
        <span className="ov-card-t">관심종목 MAP</span>
        <span className="ov-card-sub">{tiles.length}개 그룹</span>
      </div>
      <div className="ov-card-b">
        {/*
          타일을 누르면 **구성종목 시트**가 열린다.
          예전엔 아래 종목 타일로 스크롤만 시켰는데, 「테마/업종 MAP」은 같은 자리에서
          시트를 여는지라 같은 모양의 타일이 화면마다 다르게 움직이는 셈이었다.
        */}
        <div className="map-grid uwm-top">
          {[...tiles]
            .sort((a, b) => b.changeRate - a.changeRate)
            .map((t) => (
              <button
                key={t.id}
                className="map-tile"
                style={tileStyle(t.changeRate)}
                onClick={() =>
                  setTarget({
                    kind: "custom",
                    code: t.id,
                    name: t.name,
                    label: "관심종목 그룹",
                    stocks: t.stocks,
                  })
                }
                title={t.name}
              >
                <span className="map-tile-name">{t.name}</span>
                <span className={`map-tile-pct num ${cls(t.changeRate)}`}>
                  {pct(t.changeRate)}
                </span>
                <span className="map-tile-sub">
                  ▲{t.risingCount}/▼{t.fallingCount}
                </span>
              </button>
            ))}
        </div>
        <div className="table-note">
          색이 진할수록 등락폭이 큽니다(5% 기준) · 타일을 누르면 <b>구성종목</b>이 열립니다 ·
          {tiles.length}개 그룹 · <b>▲/▼</b> 는 그 그룹에서 오른/내린 종목 수입니다 ·
          등락률은 <b>단순평균</b>입니다(해외는 시가총액을 안 받아옵니다)
        </div>
      </div>

      {target && (
        <ConstituentSheet
          target={target}
          onClose={() => setTarget(null)}
          /* 해외 티커라 국내 상세로 보내면 못 찾는다 — 차트 시트를 연다 */
          onSelectStock={(code, name) => {
            setTarget(null);
            onOpen(code, name);
          }}
        />
      )}
    </section>
  );
}

/**
 * 섹터 MAP — **한 그룹의 종목을 타일로.**
 *
 * ## 왜 지수·ETF 인가
 *
 * 미국은 섹터가 ETF 로 거래된다 — `XLK`(기술) `XLF`(금융) `XLE`(에너지) 같은 것들이
 * 사실상 **섹터 그 자체**다. 국내 화면에서 업종 MAP 을 보는 것과 같은 일을 미국에서
 * 하려면 이 묶음을 타일로 펴 보는 게 가장 가깝다.
 *
 * 그룹 MAP 은 「어느 묶음이 도나」를 답하고, 여기는 **그 묶음 안에서 무엇이 끌었나**를
 * 답한다. 층이 다르므로 둘 다 있어야 한다.
 *
 * ## 그룹은 고를 수 있다
 *
 * 기본은 지수·ETF 지만 반도체나 바이오를 펴 보고 싶을 때가 있다. 고른 것은
 * 이 기기에 남는다 — 모니터마다 보는 자리가 다르다.
 */
const SECTOR_GROUP_KEY = "vntg.usboard.sectormap";
const SECTOR_DEFAULT = "지수·ETF";

function UsSectorMap({ onOpen }: { onOpen: (symbol: string, label: string) => void }) {
  const { tiles, loading } = useWatchGroupTiles("watchUs");
  const [picked, setPicked] = useState<string>(
    () => localStorage.getItem(SECTOR_GROUP_KEY) ?? SECTOR_DEFAULT,
  );

  if (loading || tiles.length === 0) return null;
  const group = tiles.find((t) => t.name === picked) ?? tiles.find((t) => t.name === SECTOR_DEFAULT) ?? tiles[0];
  if (!group || group.stocks.length === 0) return null;

  function choose(name: string) {
    setPicked(name);
    try {
      localStorage.setItem(SECTOR_GROUP_KEY, name);
    } catch {
      /* 저장 못 해도 이번 세션에는 바뀐다 */
    }
  }

  return (
    <section className="ov-card">
      <div className="ov-card-h">
        <span className="ov-card-t">섹터 MAP</span>
        <span className="ov-card-sub">
          {group.name} · {group.stocks.length}종목
        </span>
      </div>
      <div className="ov-card-b">
        <div className="filter-row">
          {tiles.map((t) => (
            <button
              key={t.id}
              className={`filter-btn ${t.name === group.name ? "active" : ""}`}
              onClick={() => choose(t.name)}
            >
              {t.name}
            </button>
          ))}
        </div>

        <div className="map-grid">
          {[...group.stocks]
            .sort((a, b) => (b.changeRate ?? 0) - (a.changeRate ?? 0))
            .map((s) => (
              <button
                key={s.code}
                className="map-tile"
                style={tileStyle(s.changeRate)}
                onClick={() => onOpen(s.code, s.name || s.code)}
                title={`${s.name} · ${s.code}`}
              >
                {/* 티커가 먼저 — 미국은 티커로 기억한다 */}
                <span className="map-tile-name">{s.code}</span>
                <span className={`map-tile-pct num ${cls(s.changeRate)}`}>{pct(s.changeRate)}</span>
                <span className="map-tile-sub">{s.name}</span>
              </button>
            ))}
        </div>

        <div className="table-note">
          <b>{group.name}</b> 안의 종목을 등락률 순으로 폅니다 — 그룹 MAP 이 「어느 묶음이
          도나」라면 여기는 <b>그 안에서 무엇이 끌었나</b>입니다. 미국은 섹터가 ETF 로
          거래되므로(XLK·XLF 같은) 이 묶음이 곧 업종 MAP 노릇을 합니다.
          칸 크기는 모두 같습니다 — 해외는 시가총액을 안 받아옵니다.
        </div>
      </div>
    </section>
  );
}

/**
 * 전광판 관심종목.
 *
 * 「관심종목(해외)」와 **같은 저장소**를 쓴다. 여기서 넣고 빼면 거기서도 바뀐다 —
 * 같은 목록을 두 곳에서 따로 관리하게 만들면 반드시 어긋난다.
 * 보여줄 그룹은 골라서 기억한다(기기별).
 */
const GROUP_KEY = "vntg.usboard.group";

function UsBoardWatch({ onOpen }: { onOpen: (symbol: string, label: string) => void }) {
  const [groups, setGroups] = useState<UsWatchGroup[]>([]);
  const [openId, setOpenId] = useState<string>(() => localStorage.getItem(GROUP_KEY) ?? "");
  const [editing, setEditing] = useState(false);
  const [query, setQuery] = useState("");
  const [found, setFound] = useState<UsSearchResult[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  /** 마지막으로 값을 받은 시각 — 안 적어 두면 살아 있는지 의심하게 된다 */
  const [at, setAt] = useState<number | null>(null);

  const load = useCallback(async (quiet = false) => {
    try {
      const r = await api.usWatch();
      setGroups(r.groups);
      setAt(Date.now());
      setError(null);
    } catch (e) {
      if (!quiet) setError(e instanceof Error ? e.message : "불러오지 못했습니다");
    }
  }, []);

  useEffect(() => {
    void load();
    // 미국장이 도는 동안 값이 움직인다. 20초면 전광판으로 충분하다
    const t = setInterval(() => void load(true), 20_000);
    return () => clearInterval(t);
  }, [load]);

  // 종목 검색
  useEffect(() => {
    const q = query.trim();
    if (!q) {
      setFound([]);
      return;
    }
    const t = setTimeout(() => {
      api
        .usWatchSearch(q)
        .then((r) => setFound(r.results))
        .catch(() => setFound([]));
    }, 300);
    return () => clearTimeout(t);
  }, [query]);

  const current = groups.find((g) => g.id === openId) ?? groups[0] ?? null;

  function pickGroup(id: string) {
    setOpenId(id);
    localStorage.setItem(GROUP_KEY, id);
  }

  async function run(fn: () => Promise<{ groups: UsWatchGroup[] }>) {
    setBusy(true);
    setError(null);
    try {
      setGroups((await fn()).groups);
    } catch (e) {
      setError(e instanceof Error ? e.message : "실패");
    } finally {
      setBusy(false);
    }
  }

  /** 한 칸 위·아래로. 화면을 먼저 바꾸고 서버에 보낸다 */
  async function move(symbol: string, delta: -1 | 1) {
    if (!current) return;
    const order = current.stocks.map((s) => s.symbol);
    const at = order.indexOf(symbol);
    const to = at + delta;
    if (at < 0 || to < 0 || to >= order.length) return;
    [order[at], order[to]] = [order[to], order[at]];
    setGroups((prev) =>
      prev.map((g) =>
        g.id === current.id
          ? { ...g, stocks: order.map((sym) => g.stocks.find((s) => s.symbol === sym)!) }
          : g,
      ),
    );
    await run(() => api.usWatchStockOrder(current.id, order));
  }

  return (
    <section className="ov-card">
      <div className="ov-card-h">
        <span className="ov-card-t">관심종목</span>
        <span className="ov-card-sub">
          {current ? `${current.stocks.length}종목` : ""}
          {at && ` · ${new Date(at).toLocaleTimeString("ko-KR", { hour12: false })}`}
        </span>
      </div>
      <div className="ov-card-b">
        {error && <div className="error-banner">{error}</div>}

        <div className="filter-row">
          {groups.map((g) => (
            <button
              key={g.id}
              className={`filter-btn ${current?.id === g.id ? "active" : ""}`}
              onClick={() => pickGroup(g.id)}
            >
              {g.name}
              <span className={`uw-grate ${cls(g.changeRate)}`}> {pct(g.changeRate)}</span>
            </button>
          ))}
          <button
            className={`filter-btn ${editing ? "active" : ""}`}
            onClick={() => setEditing((v) => !v)}
          >
            {editing ? "편집 끝" : "✏ 편집"}
          </button>
        </div>

        {editing && current && (
          <div className="search-box usb-add">
            <input
              className="search-input"
              placeholder={`「${current.name}」에 넣을 종목 — 티커나 이름으로`}
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
            {query.trim() && found.length > 0 && (
              <div className="search-dropdown">
                {found.map((f) => (
                  <button
                    key={f.symbol}
                    className="search-result-row"
                    disabled={busy}
                    onClick={() => {
                      setQuery("");
                      setFound([]);
                      void run(() => api.usWatchStockAdd(current.id, f.symbol, f.name));
                    }}
                  >
                    <span className="name">{f.symbol}</span>
                    <span className="sub">
                      {f.name}
                      {f.exchange ? ` · ${f.exchange}` : ""}
                    </span>
                  </button>
                ))}
              </div>
            )}
          </div>
        )}

        {!current ? (
          <div className="page-note">
            그룹이 없습니다. <b>관심종목(해외)</b> 메뉴에서 먼저 만들어 주세요.
          </div>
        ) : current.stocks.length === 0 ? (
          <div className="page-note">
            담긴 종목이 없습니다. <b>✏ 편집</b>을 켜고 검색해서 넣으세요.
          </div>
        ) : (
          <div className="usb-list">
            {current.stocks.map((s, i) => (
              <UsBoardRow
                key={s.symbol}
                row={s}
                editing={editing}
                first={i === 0}
                last={i === current.stocks.length - 1}
                onMove={(d) => void move(s.symbol, d)}
                onRemove={() => void run(() => api.usWatchStockRemove(current.id, s.symbol))}
                onOpen={() => onOpen(s.symbol, s.name || s.symbol)}
              />
            ))}
          </div>
        )}

        <div className="table-note">
          <b>관심종목(해외)</b> 와 같은 목록입니다 — 여기서 넣고 빼면 거기서도 바뀝니다.
          종목을 누르면 <b>상세</b>가 열립니다.
          괄호는 <b>지금 도는 다른 세션</b>입니다 — 정규장 마감 후엔 <b>애프터장</b>,
          한국 낮엔 <b>주간거래</b>. 정규장 중에는 사라집니다(그때는 지금 값이 곧 정규장입니다).
        </div>
      </div>
    </section>
  );
}

function UsBoardRow({
  row,
  editing,
  first,
  last,
  onMove,
  onRemove,
  onOpen,
}: {
  row: UsQuoteRow;
  editing: boolean;
  first: boolean;
  last: boolean;
  onMove: (d: -1 | 1) => void;
  onRemove: () => void;
  onOpen: () => void;
}) {
  const side = sideQuote(row);
  return (
    <div className="usb-row">
      {editing && (
        <span className="usb-move">
          <button className="gt-move" onClick={() => onMove(-1)} disabled={first} title="위로">
            ▲
          </button>
          <button className="gt-move" onClick={() => onMove(1)} disabled={last} title="아래로">
            ▼
          </button>
        </span>
      )}
      {/* 종목을 누르면 상세가 열린다 — 예전엔 표에서 끊겼다 */}
      <button type="button" className="usb-sym usb-open" onClick={onOpen} title="눌러서 상세 보기">
        {row.flag} {row.symbol}
        <span className="usb-nm">{row.name}</span>
      </button>
      <span className="usb-px">
        {row.price === null ? "-" : row.price.toFixed(2)}
        {/* 괄호는 지금 도는 다른 세션 — 마감 후엔 애프터장, 한국 낮엔 주간거래 */}
        {side && (
          <span className="uw-day" title={side.label}>
            {" "}
            ({side.price.toFixed(2)})
          </span>
        )}
      </span>
      <span className={`usb-rt ${cls(row.changeRate)}`}>
        {pct(row.changeRate)}
        {side && (
          <span className={`uw-day ${cls(side.changeRate)}`} title={side.label}>
            {" "}
            ({pct(side.changeRate)})
          </span>
        )}
      </span>
      {editing && (
        <button className="row-del-btn" onClick={onRemove} title="빼기">
          ✕
        </button>
      )}
    </div>
  );
}

/**
 * 전광판 맨 위 신호등.
 *
 * 색 하나로 끝내지 않고 **왜 그런지**를 같이 낸다. 「빨강」만 있으면 무엇을 봐야 할지 모른다.
 */
function BoardLight({ sig }: { sig: UsBoardSignal }) {
  const label = sig.level === "red" ? "주의" : sig.level === "yellow" ? "보통" : "무난";
  return (
    <section className={`ov-card usb-light ${sig.level}`}>
      <div className="ov-card-b usb-light-b">
        <span className={`sig-dot big ${sig.level}`} />
        <span className="usb-light-lv">{label}</span>
        <span className="usb-light-sum">{sig.summary}</span>
        {sig.reasons.length > 0 && (
          <details className="usb-light-why">
            <summary>이유 {sig.reasons.length}</summary>
            <ul>
              {sig.reasons.map((w) => (
                <li key={w}>{w}</li>
              ))}
            </ul>
          </details>
        )}
      </div>
    </section>
  );
}
