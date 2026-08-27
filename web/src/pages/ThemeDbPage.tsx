import { useEffect, useMemo, useState } from "react";
import { api, signClass, type ThemeStrength } from "../api";
import { useCardOrder } from "../useCardOrder";
import { TabScroller } from "../components/TabScroller";
import { SortableTh, useSortableTable } from "../useSortableTable";
import { useTabActive } from "../tabActive";
import { useMarketOpen } from "../useLive";

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

/**
 * 규모 문턱 — **시장마다 자가 다르다.**
 *
 * 국내는 거래대금(억원), ETF 는 순자산(억원), 미국은 시가총액(억원 환산)이다.
 * 같은 숫자를 쓰면 미국은 종목 하나가 1,900조라 아무것도 안 걸러진다.
 */
const MIN_VALUES: Record<"kr" | "etf" | "us", readonly number[]> = {
  kr: [0, 100, 500, 1000, 3000],
  etf: [0, 100, 500, 1000, 3000],
  /* 미국은 시총 합이라 단위가 조 단위다 — 10조·50조·100조·300조 */
  us: [0, 100_000, 500_000, 1_000_000, 3_000_000],
};

/**
 * 처음 열었을 때의 문턱.
 *
 * 국내 265개·ETF 864개는 **처음부터 걸러야** 화면이 쓸모 있다. 미국은 134개뿐이라
 * 거를 이유가 없다 — 적은 목록에까지 문턱을 걸면 볼 것을 못 보게 만든다.
 */
const DEFAULT_MIN: Record<"kr" | "etf" | "us", number> = { kr: 100, etf: 100, us: 0 };

const VALUE_LABEL: Record<"kr" | "etf" | "us", string> = {
  kr: "거래대금",
  etf: "순자산",
  us: "시가총액",
};

/** 억원을 짧게 — 1.2조 / 3,400억 */
function money(v: number): string {
  if (v >= 10_000) return `${(v / 10_000).toFixed(1)}조`;
  return `${Math.round(v).toLocaleString("ko-KR")}억`;
}

/** 퍼센트 — 값이 없으면 「—」. 0 으로 채우면 거짓말이 된다 */
function pct(v: number | null): string {
  return v === null ? "—" : `${v > 0 ? "+" : ""}${v.toFixed(2)}%`;
}

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
  const [open, setOpen] = useState<string | null>(null);
  const [q, setQ] = useState("");
  /** ETF 는 분류가 있어 그걸로 좁혀 본다 */
  const [group, setGroup] = useState<string>("");
  /**
   * 거래대금 문턱(억원).
   *
   * 국내 266개·ETF 864개를 다 뿌리면 화면이 쓸모없는 타일로 덮인다 — 거래가 거의 없는
   * 묶음이 대부분이기 때문이다. **기본값을 0 이 아니라 100억으로 둔다**: 처음 열었을 때
   * 이미 볼 만한 것만 남아 있어야 「무엇을 볼까」가 바로 시작된다.
   */
  const [minValue, setMinValue] = useState(DEFAULT_MIN[market]);
  const tabActive = useTabActive();
  const marketOpen = useMarketOpen();

  useEffect(() => {
    let alive = true;
    setRows(null);
    setError(null);
    setOpen(null);
    setGroup("");
    setMinValue(DEFAULT_MIN[market]);

    const fetchOnce = (quiet: boolean) =>
      api
        .themeStrength(market)
        .then((r) => {
          if (!alive) return;
          setRows(r.themes);
          setWarming(Boolean(r.warming));
        })
        .catch((e: Error) => {
          if (alive && !quiet) setError(e.message);
        });

    void fetchOnce(false);

    /*
     * 시세 갱신 (2026-08-28) — **조회가 0회라 자주 불러도 된다.**
     * 분류는 파일에서, 시세는 이미 떠 있는 전종목 스냅샷에서 읽으므로 키움을
     * 새로 부르지 않는다. 서버가 하는 일은 265개 테마의 평균을 다시 내는 것뿐이다.
     * 장중 20초 · 장 밖 2분. 탭이 뒤에 있으면 쉰다.
     */
    const t = setInterval(
      () => {
        if (document.visibilityState !== "visible" || !tabActive) return;
        void fetchOnce(true);
      },
      marketOpen ? 20_000 : 120_000,
    );
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, [market, marketOpen, tabActive]);

  /** ETF 분류 목록 — 개수까지 보여야 어디를 볼지 정해진다 */
  const groups = useMemo(() => {
    const m = new Map<string, number>();
    for (const t of rows ?? []) if (t.group) m.set(t.group, (m.get(t.group) ?? 0) + 1);
    return [...m.entries()].sort((a, b) => b[1] - a[1]);
  }, [rows]);

  const sorted = useMemo(() => {
    if (!rows) return [];
    const key = q.trim().toLowerCase();
    let base = group ? rows.filter((t) => t.group === group) : rows;
    /* 거래대금 문턱 — 이게 「너무 많아서 못 보겠다」를 푸는 열쇠다 */
    if (minValue > 0) base = base.filter((t) => t.tradeValue >= minValue);
    const hit = key
      ? base.filter(
          (t) =>
            t.name.toLowerCase().includes(key) ||
            t.stocks.some((s) => s.name.toLowerCase().includes(key)),
        )
      : base;
    /* 기본은 오늘 등락률 순 — 칸을 누르면 그 아래 `useSortableTable` 이 다시 정렬한다 */
    return [...hit].sort((a, b) => b.changeRate - a.changeRate);
  }, [rows, q, group, minValue]);

  /* 표 정렬 — 시세분석과 같은 훅·같은 규칙(내림 → 오름 → 원래) */
  const sortT = useSortableTable<ThemeStrength>(sorted);

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
        {/* 규모 문턱 — 「너무 많다」를 푸는 자리라 맨 앞이다 */}
        {MIN_VALUES[market].map((v) => (
          <button
            key={v}
            className={`filter-btn ${minValue === v ? "active" : ""}`}
            onClick={() => setMinValue(v)}
            title={v === 0 ? "전부 보기" : `${VALUE_LABEL[market]} ${money(v)} 이상만`}
          >
            {v === 0 ? "전부" : `${money(v)}+`}
          </button>
        ))}
        <input
          className="search-input tdb-search"
          placeholder="테마·종목 이름으로 좁히기"
          value={q}
          onChange={(e) => setQ(e.target.value)}
        />
        <span className="pt-n">
          {sorted.length}개{rows.length !== sorted.length && ` / ${rows.length}`}
        </span>
      </div>

      {/*
        **표다.** 처음엔 MAP(타일)이었는데 266개를 색으로 늘어놓으니 이름이 잘리고
        지표는 한 번에 하나밖에 못 봤다 — 「5일 누적으로 정렬했는데 그 값이 안 보인다」.
        표는 여러 자를 나란히 놓고 견줄 수 있고, 칸을 눌러 정렬한다(시세분석과 같은 규칙).
      */}
      {/* ⚠️ 감싸개는 `data-table-wrap` 이다 — 시세분석과 같은 뼈대라야 폭·스크롤이 맞는다 */}
      <div className="data-table-wrap">
        <table className="data-table tdb-table">
          <thead>
            <tr>
              {/* `.data-table` 은 기본이 오른쪽 정렬이라 이름 칸만 왼쪽으로 되돌린다 */}
              <SortableTh
                columnKey="name"
                label="테마"
                accessor={(t) => t.name}
                sort={sortT}
                className="tdb-th-name"
              />
              <SortableTh
                columnKey="rate"
                label="오늘"
                accessor={(t) => t.changeRate}
                sort={sortT}
                className="num"
              />
              {/* ⚠️ 설명은 `thProps.title` 이다. `extra` 는 머리 칸 **안에 넣는 요소**라 글자를 주면 그대로 찍힌다 */}
              <SortableTh
                columnKey="w1"
                label="5일"
                accessor={(t) => t.w1 ?? -999}
                sort={sortT}
                className="num"
                thProps={{ title: "닷새 누적 — 하루 급등보다 흐름을 본다" }}
              />
              <SortableTh
                columnKey="m1"
                label={market === "etf" ? "3개월" : "20일"}
                accessor={(t) => (market === "etf" ? t.m3 : t.m1) ?? -999}
                sort={sortT}
                className="num"
              />
              {market !== "etf" && (
                <SortableTh
                  columnKey="m60"
                  label="60일"
                  accessor={(t) => t.m60 ?? -999}
                  sort={sortT}
                  className="num"
                  thProps={{ title: "60거래일 누적 — 이 테마가 원래 오던 자리인가" }}
                />
              )}
              {market !== "etf" && (
                <SortableTh
                  columnKey="breadth"
                  label="상승비율"
                  accessor={(t) => t.breadth}
                  sort={sortT}
                  className="num"
                  thProps={{ title: "테마 안에서 오른 종목 비율 — 몇몇이 끄는지 다 같이 가는지" }}
                />
              )}
              {market !== "etf" && (
                <SortableTh
                  columnKey="hit5"
                  label="5일 중"
                  accessor={(t) => t.hit5.n}
                  sort={sortT}
                  className="num"
                  thProps={{ title: "최근 닷새 중 오른 날 — 연속이 끊겨도 흐름은 남는다" }}
                />
              )}
              <SortableTh
                columnKey="value"
                label={VALUE_LABEL[market]}
                accessor={(t) => t.tradeValue}
                sort={sortT}
                className="num"
              />
              <th>주도주</th>
            </tr>
          </thead>
          <tbody>
            {sortT.sorted.map((t) => (
              /*
                `data-l` 은 **폰에서 쓰는 라벨**이다. 좁은 화면에서는 표 머리를 숨기고
                칸마다 이 이름을 앞에 붙여 카드처럼 편다 — 칸이 여덟이라 가로로는
                절대 안 들어간다(2026-08-28: "모바일에서 확인이 안 될 정도").
              */
              <tr key={t.key} className="tdb-tr" onClick={() => setOpen(t.key)}>
                <td className="tdb-td-name">
                  {t.name}
                  {t.stocks.length > 1 && <em className="pt-n"> {t.stocks.length}</em>}
                </td>
                <td className={`num ${signClass(t.changeRate)}`} data-l="오늘">
                  {pct(t.changeRate)}
                </td>
                <td className={`num ${t.w1 === null ? "" : signClass(t.w1)}`} data-l="5일">
                  {pct(t.w1)}
                </td>
                <td
                  className={`num ${
                    (market === "etf" ? t.m3 : t.m1) === null
                      ? ""
                      : signClass((market === "etf" ? t.m3 : t.m1)!)
                  }`}
                  data-l={market === "etf" ? "3개월" : "20일"}
                >
                  {pct(market === "etf" ? t.m3 : t.m1)}
                </td>
                {/* 60일 — 20일이 「이번 파동」이라면 이건 「원래 오던 자리인가」다 */}
                {market !== "etf" && (
                  <td className={`num ${t.m60 === null ? "" : signClass(t.m60)}`} data-l="60일">
                    {pct(t.m60)}
                  </td>
                )}
                {market !== "etf" && (
                  <td className="num" data-l="상승">
                    {t.up}/{t.stocks.length}
                    <em className="pt-n"> {t.breadth}%</em>
                  </td>
                )}
                {market !== "etf" && (
                  <td className="num" data-l="5일 중">
                    {t.hit5.of > 0 ? `${t.hit5.n}/${t.hit5.of}` : "—"}
                    {t.streak > 1 && <em className="pt-n"> 연속{t.streak}</em>}
                  </td>
                )}
                <td className="num" data-l={VALUE_LABEL[market]}>
                  {t.tradeValue > 0 ? money(t.tradeValue) : "—"}
                </td>
                <td className="tdb-td-tops">
                  {t.stocks.slice(0, 3).map((s) => (
                    <span key={s.code} className="tlk-chip">
                      {s.name}
                    </span>
                  ))}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/*
        구성종목은 **팝업으로 띄운다** (2026-08-28).
        처음엔 MAP 아래에 펼쳤는데, 타일이 265개라 그 아래까지 스크롤이 한참이었다 —
        누른 타일은 화면 위에 있고 내용은 저 밑에 열리니 무엇이 열렸는지도 안 보였다.
      */}
      {cur && <ThemeSheet t={cur} onClose={() => setOpen(null)} onSelectStock={onSelectStock} />}

      <div className="table-note">
        분류는 <b>네이버</b>에서 주 1회 받아 둔 것이고, <b>등락률·상승비율·연속성은
        우리가 오늘 값으로 계산</b>합니다 — 국내·ETF·미국이 같은 자로 재집니다.
        <b>상승비율</b>은 테마 안에서 오른 종목의 비율입니다(몇몇이 끄는지 다 같이 가는지).
        <b>연속성</b>은 그 테마가 며칠째 오르고 있는가입니다.
      </div>
    </>
  );
}

/**
 * 타일을 누르면 열리는 구성종목 — 편입 사유가 붙는다(국내만).
 *
 * 앱의 다른 시트와 같은 뼈대(`overlay` + `sheet`)를 쓴다. 바깥을 누르거나 ESC 로 닫힌다.
 */
function ThemeSheet({
  t,
  onClose,
  onSelectStock,
}: {
  t: ThemeStrength;
  onClose: () => void;
  onSelectStock: (code: string, name: string) => void;
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <div className="overlay" onClick={onClose}>
      <div className="sheet" onClick={(e) => e.stopPropagation()}>
        <div className="sheet-header">
          <h2>{t.name}</h2>
          <span className={`sheet-live num ${signClass(t.changeRate)}`}>
            <b>
              {t.changeRate > 0 ? "+" : ""}
              {t.changeRate.toFixed(2)}%
            </b>
          </span>
          <button className="close-btn" onClick={onClose}>
            ✕
          </button>
        </div>

        {/* 한 줄에 다 붙이면 안 읽힌다 — 칩으로 끊는다 */}
        <div className="tdb-chips">
          {t.stocks.length > 1 && (
            <span className="tdb-chip">
              상승 <b>{t.up}</b>/{t.stocks.length} · {t.breadth}%
            </span>
          )}
          {t.streak > 1 && (
            <span className="tdb-chip">
              <b>{t.streak}일</b> 연속
            </span>
          )}
          {t.hit5.of > 0 && (
            <span className="tdb-chip" title="최근 닷새 중 오른 날 — 연속이 끊겨도 흐름은 남는다">
              {t.hit5.of}일 중 <b>{t.hit5.n}일</b> 상승
            </span>
          )}
          {t.w1 !== null && (
            <span className="tdb-chip">
              5일 누적{" "}
              <b className={signClass(t.w1)}>
                {t.w1 > 0 ? "+" : ""}
                {t.w1.toFixed(1)}%
              </b>
            </span>
          )}
          {t.m1 !== null && (
            <span className="tdb-chip">
              20일 누적{" "}
              <b className={signClass(t.m1)}>
                {t.m1 > 0 ? "+" : ""}
                {t.m1.toFixed(1)}%
              </b>
            </span>
          )}
          {t.m3 !== null && (
            <span className="tdb-chip">
              3개월{" "}
              <b className={signClass(t.m3)}>
                {t.m3 > 0 ? "+" : ""}
                {t.m3.toFixed(1)}%
              </b>
            </span>
          )}
          {t.tradeValue > 0 && (
            <span className="tdb-chip">
              {t.group ? "순자산" : "거래대금"} <b>{money(t.tradeValue)}</b>
            </span>
          )}
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

        <div className="table-note">종목을 누르면 상세가 열립니다.</div>
      </div>
    </div>
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
  /* 여기서도 테마를 누르면 구성종목이 열려야 한다 — MAP 과 같은 시트를 쓴다 */
  const [open, setOpen] = useState<string | null>(null);

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

  /* ETF 는 20일 기록이 아직 없어도 네이버가 준 3개월이 있다 — 그때는 그걸 쓴다 */
  const val = (t: ThemeStrength): number | null =>
    span === "d1" ? t.changeRate : span === "w1" ? t.w1 : t.m1 ?? t.m3;

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

      {sorted.length === 0 && (
        <div className="page-note">
          {span === "d1"
            ? "값이 없습니다."
            : "기간 수익률은 하루 한 줄씩 쌓아 계산합니다 — 5일 누적은 닷새, 20일 누적은 스무 거래일 뒤부터 나옵니다."}
        </div>
      )}

      <div className="tpb-cols">
        <PeriodList title="강한 테마" rows={top} val={val} onOpen={setOpen} />
        <PeriodList title="약한 테마" rows={bottom} val={val} onOpen={setOpen} />
      </div>

      {open && (
        <ThemeSheet
          t={(rows ?? []).find((t) => t.key === open)!}
          onClose={() => setOpen(null)}
          onSelectStock={onSelectStock}
        />
      )}

      <div className="table-note">
        기간 수익률은 <b>구성종목의 단순평균</b>입니다 — 시가총액 가중으로 하면 큰 종목
        하나가 테마 전체를 대변해 버려서, 「이 묶음이 같이 가나」에 답을 못 합니다.
        테마를 누르면 구성종목이 열립니다.
      </div>
    </>
  );
}

function PeriodList({
  title,
  rows,
  val,
  onOpen,
}: {
  title: string;
  rows: ThemeStrength[];
  val: (t: ThemeStrength) => number | null;
  onOpen: (key: string) => void;
}) {
  return (
    <section className="card">
      <h2>{title}</h2>
      <div className="tpb-list">
        {rows.map((t) => {
          const v = val(t) ?? 0;
          return (
            /*
              **줄 전체가 버튼**이다. 예전엔 상위 종목 칩만 눌렸는데, 사람이 누르고 싶은
              것은 대개 「이 테마 안에 뭐가 있나」라 테마명을 눌렀다가 아무 일도 안 났다.
            */
            <button className="tpb-row" key={t.key} onClick={() => onOpen(t.key)}>
              <span className="tpb-name">{t.name}</span>
              <span className={`num ${signClass(v)}`}>
                {v > 0 ? "+" : ""}
                {v.toFixed(2)}%
              </span>
              <span className="tpb-tops">
                {t.stocks.slice(0, 3).map((s) => (
                  <span key={s.code} className="tlk-chip">
                    {s.name}
                  </span>
                ))}
              </span>
            </button>
          );
        })}
      </div>
    </section>
  );
}
