import { useEffect, useMemo, useState } from "react";
import { api, signClass, type NaverThemeStore, type ThemeStrength } from "../api";
import { useCardOrder } from "../useCardOrder";
import { TabScroller } from "../components/TabScroller";
import { tileHeat, useAppearance } from "../useAppearance";

/**
 * 테마 DB — **네이버 테마를 우리 눈금으로 다시 그린다.**
 *
 * ## 무엇이 어디서 오나
 *
 * 네이버에서 오는 것은 **분류뿐**이다: 테마명·구성종목·종목별 편입 사유.
 * 주 1회 파일로 받아 두고, 화면은 그 파일만 읽는다(조회 0회).
 *
 * 움직이는 숫자 — 등락률·상승비율·연속성 — 는 **전부 우리가 낸다.** 키움 전종목
 * 스냅샷으로 매일 계산하므로, 파일이 며칠 낡아도 화면의 값은 늘 오늘 것이다.
 * 네이버 화면을 베끼는 게 아니라 우리 데이터로 다시 그리는 것이라, 국내·미국·ETF 가
 * **같은 자로 재진다** — 그래야 셋을 나란히 놓고 견줄 수 있다.
 *
 * ## 왜 MAP 인가
 *
 * 테마가 266개다. 표로 늘어놓으면 스크롤만 하다 끝난다. 색과 크기로 **한눈에**
 * 강한 곳을 찾고, 눌러서 안으로 들어가는 구조가 이 수에 맞다.
 */

type ThemeTab = "kr" | "etf" | "us" | "briefing" | "period";

export const THEME_TABS: { key: ThemeTab; label: string }[] = [
  { key: "kr", label: "국내 테마" },
  { key: "etf", label: "ETF 테마" },
  { key: "us", label: "미국 테마" },
  { key: "briefing", label: "테마 브리핑" },
  { key: "period", label: "일간·주간·월간" },
];

/** 정렬 기준 — 「무엇이 강한가」를 무엇으로 볼 것인가 */
type SortKey = "rate" | "breadth" | "streak" | "size";
const SORTS: { key: SortKey; label: string; hint: string }[] = [
  { key: "rate", label: "등락률", hint: "오늘 평균 등락률이 높은 순" },
  { key: "breadth", label: "상승비율", hint: "테마 안에서 오른 종목 비율 — 몇몇이 끄는지 다 같이 가는지" },
  { key: "streak", label: "연속성", hint: "며칠째 이어지는가 — 하루 반짝과 사흘째를 가른다" },
  { key: "size", label: "종목수", hint: "묶음이 큰 순" },
];

export function ThemeDbPage({ onSelectStock }: { onSelectStock: (code: string, name: string) => void }) {
  const [tab, setTab] = useState<ThemeTab>("kr");
  const tabOrder = useCardOrder(
    "themeDb.tabs",
    THEME_TABS.map((t) => t.key),
  );

  return (
    <div>
      <TabScroller className="detail-tabs" activeKey={tab}>
        {THEME_TABS.map((t) => (
          <button
            key={t.key}
            className={`detail-tab${tab === t.key ? " active" : ""}`}
            style={{ order: tabOrder.orderOf(t.key) }}
            onClick={() => setTab(t.key)}
          >
            {t.label}
          </button>
        ))}
      </TabScroller>

      {(tab === "kr" || tab === "etf" || tab === "us") && (
        <ThemeMap market={tab} onSelectStock={onSelectStock} />
      )}
      {tab === "briefing" && <ThemeBriefing onSelectStock={onSelectStock} />}
      {tab === "period" && <PeriodBoard onSelectStock={onSelectStock} />}
    </div>
  );
}

/* ================================================================== */
/* MAP                                                                */
/* ================================================================== */

function ThemeMap({
  market,
  onSelectStock,
}: {
  market: "kr" | "etf" | "us";
  onSelectStock: (code: string, name: string) => void;
}) {
  const [rows, setRows] = useState<ThemeStrength[] | null>(null);
  const [warming, setWarming] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sort, setSort] = useState<SortKey>("rate");
  const [open, setOpen] = useState<string | null>(null);
  const [q, setQ] = useState("");
  /** ETF 는 분류가 있어 그걸로 좁혀 본다 */
  const [group, setGroup] = useState<string>("");
  const { theme } = useAppearance();

  useEffect(() => {
    let alive = true;
    setRows(null);
    setError(null);
    setOpen(null);
    setGroup("");
    api
      .themeStrength(market)
      .then((r) => {
        if (!alive) return;
        setRows(r.themes);
        setWarming(Boolean(r.warming));
      })
      .catch((e: Error) => alive && setError(e.message));
    return () => {
      alive = false;
    };
  }, [market]);

  /** ETF 분류 목록 — 개수까지 보여야 어디를 볼지 정해진다 */
  const groups = useMemo(() => {
    const m = new Map<string, number>();
    for (const t of rows ?? []) if (t.group) m.set(t.group, (m.get(t.group) ?? 0) + 1);
    return [...m.entries()].sort((a, b) => b[1] - a[1]);
  }, [rows]);

  const sorted = useMemo(() => {
    if (!rows) return [];
    const key = q.trim().toLowerCase();
    const base = group ? rows.filter((t) => t.group === group) : rows;
    const hit = key
      ? base.filter(
          (t) =>
            t.name.toLowerCase().includes(key) ||
            t.stocks.some((s) => s.name.toLowerCase().includes(key)),
        )
      : base;
    const by: Record<SortKey, (a: ThemeStrength, b: ThemeStrength) => number> = {
      rate: (a, b) => b.changeRate - a.changeRate,
      breadth: (a, b) => b.breadth - a.breadth,
      streak: (a, b) => b.streak - a.streak || b.changeRate - a.changeRate,
      size: (a, b) => b.stocks.length - a.stocks.length,
    };
    return [...hit].sort(by[sort]);
  }, [rows, sort, q, group]);

  if (error) return <div className="error-banner">{error}</div>;
  if (!rows) return <div className="empty">테마 불러오는 중…</div>;
  if (rows.length === 0) {
    /*
     * **왜 비었는지가 경우마다 다르다.** 「받아 주세요」로 뭉뚱그리면 원인이 다른
     * 상태들이 같은 화면으로 보여서, 사람이 엉뚱한 데를 고치러 간다.
     * 특히 `warming` 은 분류가 멀쩡히 있는데 시세만 아직 없는 상태다.
     */
    return (
      <div className="page-note">
        {warming ? (
          <>
            분류는 받아 두었는데 <b>시세를 아직 못 불러왔습니다.</b> 서버를 막 켰을 때
            그렇습니다 — 키움 전종목을 한 바퀴 받는 데 십몇 초 걸립니다. 잠시 뒤 다시
            열어 주세요.
          </>
        ) : market === "etf" ? (
          <>
            ETF 목록을 아직 못 받았습니다. 장 마감 뒤(16시)에 자동으로 받습니다 —
            지금 받으려면 <b>설정 &gt; 분석 기준</b>에서 눌러 주세요(요청 한 번이라 바로 끝납니다).
          </>
        ) : market === "us" ? (
          <>
            미국 테마를 아직 못 받았습니다. 매일 아침 7시에 자동으로 받습니다 —
            지금 바로 받으려면 <b>설정 &gt; 분석 기준</b>에서 눌러 주세요(2분 걸립니다).
          </>
        ) : (
          <>
            국내 테마를 아직 못 받았습니다. <b>설정 &gt; 분석 기준</b>에서 한 번 받아
            주세요(10분 걸립니다). 이후 주 1회 자동으로 갱신됩니다.
          </>
        )}
      </div>
    );
  }

  const cur = open ? rows.find((t) => t.key === open) ?? null : null;

  return (
    <>
      {/* ETF 분류 — 「국내 업종/테마」만 보고 싶은 때가 대부분이라 앞에 둔다 */}
      {groups.length > 0 && (
        <div className="filter-row">
          <button className={`filter-btn ${group === "" ? "active" : ""}`} onClick={() => setGroup("")}>
            전체 <span className="gt-n">{rows.length}</span>
          </button>
          {groups.map(([g, n]) => (
            <button
              key={g}
              className={`filter-btn ${group === g ? "active" : ""}`}
              onClick={() => setGroup(g)}
            >
              {g} <span className="gt-n">{n}</span>
            </button>
          ))}
        </div>
      )}

      <div className="filter-row tdb-bar">
        {SORTS.map((s) => (
          <button
            key={s.key}
            className={`filter-btn ${sort === s.key ? "active" : ""}`}
            onClick={() => setSort(s.key)}
            title={s.hint}
          >
            {s.label}
          </button>
        ))}
        <input
          className="search-input tdb-search"
          placeholder="테마·종목 이름으로 좁히기"
          value={q}
          onChange={(e) => setQ(e.target.value)}
        />
        <span className="pt-n">{sorted.length}개</span>
      </div>

      {/*
        타일 하나 = 테마 하나. 색은 등락률, 아래 두 줄은 상승비율과 연속성이다.
        「몇 %」만으로는 부족하다 — 열 종목 중 하나가 상한가라 평균이 오른 것과
        전부 고르게 오른 것은 **다음 날이 다르다.**
      */}
      <div className="map-grid dense tdb-grid">
        {sorted.map((t) => (
          <button
            key={t.key}
            className={`map-tile tdb-tile${open === t.key ? " on" : ""}`}
            /* 테마 평균은 개별 종목보다 진폭이 작다 — ±3% 를 최대로 잡아야 강약이 보인다 */
            style={tileHeat(t.changeRate, theme, 3)}
            onClick={() => setOpen(open === t.key ? null : t.key)}
            title={`${t.name} — ${t.stocks.length}종목 · 상승 ${t.up}/${t.stocks.length}${
              t.streak > 1 ? ` · ${t.streak}일째` : ""
            }`}
          >
            <span className="map-tile-name">{t.name}</span>
            <span className="map-tile-pct">
              {t.changeRate > 0 ? "+" : ""}
              {t.changeRate.toFixed(2)}%
            </span>
            <span className="map-tile-sub">
              {t.up}/{t.stocks.length}
              {t.streak > 1 && ` · ${t.streak}일`}
            </span>
          </button>
        ))}
      </div>

      {cur && <ThemeDetail t={cur} onSelectStock={onSelectStock} />}

      <div className="table-note">
        분류는 <b>네이버</b>에서 주 1회 받아 둔 것이고, <b>등락률·상승비율·연속성은
        우리가 오늘 값으로 계산</b>합니다 — 국내·ETF·미국이 같은 자로 재집니다.
        <b>상승비율</b>은 테마 안에서 오른 종목의 비율입니다(몇몇이 끄는지 다 같이 가는지).
        <b>연속성</b>은 그 테마가 며칠째 오르고 있는가입니다.
      </div>
    </>
  );
}

/** 타일을 누르면 열리는 구성종목 — 편입 사유가 붙는다(국내만) */
function ThemeDetail({
  t,
  onSelectStock,
}: {
  t: ThemeStrength;
  onSelectStock: (code: string, name: string) => void;
}) {
  return (
    <section className="card tdb-detail">
      <div className="tdb-detail-h">
        <b>{t.name}</b>
        <span className={`num ${signClass(t.changeRate)}`}>
          {t.changeRate > 0 ? "+" : ""}
          {t.changeRate.toFixed(2)}%
        </span>
        <span className="pt-n">
          {t.stocks.length}종목 · 상승 {t.up} · 하락 {t.down}
          {t.streak > 1 && ` · ${t.streak}일째`}
        </span>
      </div>
      <div className="tdb-stocks">
        {t.stocks.map((s) => (
          <button
            key={s.code}
            className="tdb-stock"
            onClick={() => onSelectStock(s.code, s.name)}
            title={s.desc || undefined}
          >
            <span className="tdb-stock-h">
              <b>{s.name}</b>
              {s.changeRate !== null && (
                <em className={`num ${signClass(s.changeRate)}`}>
                  {s.changeRate > 0 ? "+" : ""}
                  {s.changeRate.toFixed(2)}%
                </em>
              )}
            </span>
            {/* 편입 사유 — 이 데이터의 값어치다. 없는 종목(미국·ETF)은 줄이 안 생긴다 */}
            {s.desc && <span className="tdb-why">{s.desc}</span>}
          </button>
        ))}
      </div>
    </section>
  );
}

/* ================================================================== */
/* 브리핑 — 국내·미국·ETF 연결고리                                      */
/* ================================================================== */

function ThemeBriefing({ onSelectStock }: { onSelectStock: (code: string, name: string) => void }) {
  const [data, setData] = useState<Awaited<ReturnType<typeof api.themeLinks>> | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    api
      .themeLinks()
      .then((r) => alive && setData(r))
      .catch((e: Error) => alive && setError(e.message));
    return () => {
      alive = false;
    };
  }, []);

  if (error) return <div className="error-banner">{error}</div>;
  if (!data) return <div className="empty">연결고리 찾는 중…</div>;

  return (
    <>
      <p className="page-note">
        <b>같은 이야기를 하는 국내·미국 테마를 짝지어</b> 어느 쪽이 먼저 갔는지 봅니다.
        미국이 먼저 오르고 국내가 따라가는 구간이 있는데, 그 시차가 며칠인지는 테마마다
        다릅니다. 짝은 테마 이름과 구성종목의 성격으로 맺습니다 — 국내와 미국은 종목이
        겹치지 않아 이름으로 이을 수밖에 없고, 그래서 <b>어림</b>입니다.
      </p>

      {data.pairs.length === 0 ? (
        <div className="page-note">
          아직 짝지을 수 있는 테마가 없습니다. 미국 테마를 받아 두면 여기가 채워집니다.
        </div>
      ) : (
        <div className="tlk-list">
          {data.pairs.map((p) => (
            <section className="card tlk" key={p.key}>
              <div className="tlk-h">
                <b>{p.label}</b>
                {p.lead && (
                  <span className={`tlk-lead ${p.lead === "us" ? "us" : "kr"}`}>
                    {p.lead === "us" ? "미국이 앞선다" : "국내가 앞선다"}
                  </span>
                )}
              </div>
              <div className="tlk-cols">
                <ThemeSide side="국내" t={p.kr} onSelectStock={onSelectStock} />
                <ThemeSide side="미국" t={p.us} />
                {p.etf && <ThemeSide side="ETF" t={p.etf} onSelectStock={onSelectStock} />}
              </div>
              {p.note && <div className="tlk-note">{p.note}</div>}
            </section>
          ))}
        </div>
      )}
    </>
  );
}

function ThemeSide({
  side,
  t,
  onSelectStock,
}: {
  side: string;
  t: ThemeStrength | null;
  onSelectStock?: (code: string, name: string) => void;
}) {
  if (!t) return null;
  return (
    <div className="tlk-side">
      <div className="tlk-side-h">
        <span className="tlk-tag">{side}</span>
        <span className="tlk-name">{t.name}</span>
        <span className={`num ${signClass(t.changeRate)}`}>
          {t.changeRate > 0 ? "+" : ""}
          {t.changeRate.toFixed(2)}%
        </span>
      </div>
      <div className="tlk-sub">
        상승 {t.up}/{t.stocks.length}
        {t.streak > 1 && ` · ${t.streak}일째`}
        {t.w1 !== null && ` · 주간 ${t.w1 > 0 ? "+" : ""}${t.w1.toFixed(1)}%`}
      </div>
      <div className="tlk-tops">
        {t.stocks.slice(0, 4).map((s) =>
          onSelectStock ? (
            <button key={s.code} className="tlk-chip" onClick={() => onSelectStock(s.code, s.name)}>
              {s.name}
            </button>
          ) : (
            <span key={s.code} className="tlk-chip">
              {s.name}
            </span>
          ),
        )}
      </div>
    </div>
  );
}

/* ================================================================== */
/* 일간·주간·월간                                                       */
/* ================================================================== */

function PeriodBoard({ onSelectStock }: { onSelectStock: (code: string, name: string) => void }) {
  const [market, setMarket] = useState<"kr" | "etf" | "us">("kr");
  const [rows, setRows] = useState<ThemeStrength[] | null>(null);
  const [span, setSpan] = useState<"d1" | "w1" | "m1">("d1");

  useEffect(() => {
    let alive = true;
    setRows(null);
    api
      .themeStrength(market)
      .then((r) => alive && setRows(r.themes))
      .catch(() => alive && setRows([]));
    return () => {
      alive = false;
    };
  }, [market]);

  const val = (t: ThemeStrength): number | null =>
    span === "d1" ? t.changeRate : span === "w1" ? t.w1 : t.m1;

  const sorted = useMemo(
    () =>
      (rows ?? [])
        .filter((t) => val(t) !== null)
        .sort((a, b) => (val(b) ?? 0) - (val(a) ?? 0)),
    [rows, span],
  );

  if (!rows) return <div className="empty">불러오는 중…</div>;

  const top = sorted.slice(0, 20);
  const bottom = sorted.slice(-20).reverse();

  return (
    <>
      <div className="filter-row">
        {(["kr", "etf", "us"] as const).map((m) => (
          <button
            key={m}
            className={`filter-btn ${market === m ? "active" : ""}`}
            onClick={() => setMarket(m)}
          >
            {m === "kr" ? "국내" : m === "etf" ? "ETF" : "미국"}
          </button>
        ))}
        <span className="news-scope-sep" />
        {([
          { k: "d1" as const, l: "일간" },
          { k: "w1" as const, l: "주간" },
          { k: "m1" as const, l: "월간" },
        ]).map((s) => (
          <button
            key={s.k}
            className={`filter-btn ${span === s.k ? "active" : ""}`}
            onClick={() => setSpan(s.k)}
          >
            {s.l}
          </button>
        ))}
      </div>

      <div className="tpb-cols">
        <PeriodList title="강한 테마" rows={top} val={val} onSelectStock={onSelectStock} />
        <PeriodList title="약한 테마" rows={bottom} val={val} onSelectStock={onSelectStock} />
      </div>

      <div className="table-note">
        기간 수익률은 <b>구성종목의 단순평균</b>입니다 — 시가총액 가중으로 하면 큰 종목
        하나가 테마 전체를 대변해 버려서, 「이 묶음이 같이 가나」에 답을 못 합니다.
      </div>
    </>
  );
}

function PeriodList({
  title,
  rows,
  val,
  onSelectStock,
}: {
  title: string;
  rows: ThemeStrength[];
  val: (t: ThemeStrength) => number | null;
  onSelectStock: (code: string, name: string) => void;
}) {
  return (
    <section className="card">
      <h2>{title}</h2>
      <div className="tpb-list">
        {rows.map((t) => {
          const v = val(t) ?? 0;
          return (
            <div className="tpb-row" key={t.key}>
              <span className="tpb-name">{t.name}</span>
              <span className={`num ${signClass(v)}`}>
                {v > 0 ? "+" : ""}
                {v.toFixed(2)}%
              </span>
              <span className="tpb-tops">
                {t.stocks.slice(0, 3).map((s) => (
                  <button
                    key={s.code}
                    className="tlk-chip"
                    onClick={() => onSelectStock(s.code, s.name)}
                  >
                    {s.name}
                  </button>
                ))}
              </span>
            </div>
          );
        })}
      </div>
    </section>
  );
}
