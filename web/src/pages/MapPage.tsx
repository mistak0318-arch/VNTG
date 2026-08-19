import { useEffect, useState } from "react";
import { useWatchGroupTiles, type GroupSource } from "../useWatchGroupTiles";
import { api, type EvaluatedTheme, type SectorRow, type ThemeRow } from "../api";
import { ConstituentSheet, type ConstituentTarget } from "../components/overview/ConstituentSheet";
import { RefreshBar } from "../components/RefreshBar";
import { useSection } from "../useSection";

/**
 * 테마/업종 MAP.
 *
 * 기본을 **내 테마**로 바꿨다. 키움 분류는 시장이 실제로 묶어 부르는 판과 잘 안 맞는다 —
 * 반도체 장비와 HBM 이 한 덩어리로 들어가 있고, 지금 돈이 도는 축은 그보다 잘게 갈린다.
 * 내가 손으로 짠 테마가 그 판을 그대로 담고 있으므로, **원래 편성된 조들 중에서 오늘
 * 누가 주목받고 있는가**를 보려면 이쪽이 맞다.
 *
 * 키움 테마·업종도 그대로 남겨 둔다 — 내가 안 만든 판이 뜨는 날을 놓치면 안 되니까.
 */
/*
 * MAP 이 하는 일은 **"어느 묶음이 오늘 도는가"** 를 한 눈에 보는 것이다.
 * 그 묶음이 꼭 테마일 이유가 없다 — 내가 짜 둔 관심종목 그룹이야말로 내가 실제로
 * 보고 있는 묶음인데, 그건 표로만 볼 수 있었다. 그래서 세 개를 모드로 올린다.
 *
 * 「내가 만든 것만 / 옮겨온 것 포함」 토글은 그대로 둔다 — 인포스탁 테마를 「내 테마」
 * 안에 그대로 두기로 했으니, 그걸 걸러 볼 수단이 없으면 지도가 인포스탁으로 뒤덮인다.
 */
type Mode = "mine" | "watchAi" | "watchKiwoom" | "watchUs" | "theme" | "sector";

const WATCH_MODES: { key: Mode; label: string; source: GroupSource }[] = [
  { key: "watchAi", label: "관심종목 (AI_HTS)", source: "watchAi" },
  { key: "watchKiwoom", label: "관심종목 (키움_HTS)", source: "watchKiwoom" },
  { key: "watchUs", label: "관심종목 (미국)", source: "watchUs" },
];

/** 등락률에 따라 타일 배경색 강도를 정한다 (한국식: 상승 빨강 / 하락 파랑) */
function tileStyle(rate: number): React.CSSProperties {
  const capped = Math.min(Math.abs(rate), 5) / 5; // 5% 이상은 최대 강도
  const alpha = 0.12 + capped * 0.55;
  if (rate > 0) return { background: `rgba(240, 85, 95, ${alpha})` };
  if (rate < 0) return { background: `rgba(74, 139, 245, ${alpha})` };
  return { background: "rgba(139, 150, 165, 0.12)" };
}

function fmtPct(v: number): string {
  return `${v > 0 ? "+" : ""}${v.toFixed(2)}%`;
}

export function MapPage({ onSelectStock }: { onSelectStock: (code: string, name: string) => void }) {
  const [mode, setMode] = useState<Mode>("mine");
  const [sectorMarket, setSectorMarket] = useState<"kospi" | "kosdaq">("kospi");
  const [constituent, setConstituent] = useState<ConstituentTarget | null>(null);
  /** 옮겨온(인포스탁) 테마를 섞을지. 기본은 내가 만든 것만 */
  const [includeImported, setIncludeImported] = useState(false);

  const [mine, setMine] = useState<EvaluatedTheme[]>([]);
  const [mineLoading, setMineLoading] = useState(true);
  const [mineError, setMineError] = useState<string | null>(null);

  async function loadMine(force = false) {
    setMineLoading(true);
    setMineError(null);
    try {
      const r = await api.customThemes(force);
      setMine(r.themes);
    } catch (e) {
      setMineError(e instanceof Error ? e.message : "내 테마를 못 불러왔습니다");
    } finally {
      setMineLoading(false);
    }
  }

  useEffect(() => {
    void loadMine();
  }, []);

  const themes = useSection<{ top: ThemeRow[]; bottom: ThemeRow[] }>("themes", 180_000);
  const sectors = useSection<{ kospi: SectorRow[]; kosdaq: SectorRow[] }>("sectors", 180_000);

  // 등락률을 못 낸 테마(구성종목이 스냅샷에 없는 경우)는 타일로 만들 수 없다
  const mineTiles = mine
    .filter((t) => t.changeRate !== null && t.stocks.length > 0)
    .filter((t) => includeImported || (t.source ?? "manual") === "manual")
    .sort((a, b) => (b.changeRate ?? 0) - (a.changeRate ?? 0));

  // 테마는 상위/하위를 합쳐 등락률 순으로 한 화면에 배치 (코드 중복 제거)
  const themeTiles = (() => {
    const merged = new Map<string, ThemeRow>();
    for (const t of [...(themes.data?.top ?? []), ...(themes.data?.bottom ?? [])]) {
      merged.set(t.code, t);
    }
    return [...merged.values()].sort((a, b) => b.changeRate - a.changeRate);
  })();

  /** 관심종목 그룹 타일 — 세 출처가 같은 방식으로 계산돼야 견줄 수 있다 */
  const watchSource = WATCH_MODES.find((m) => m.key === mode)?.source ?? null;
  const watch = useWatchGroupTiles(watchSource);

  const sectorTiles = sectors.data?.[sectorMarket] ?? [];
  const loading = watchSource
    ? watch.loading
    : mode === "mine"
      ? mineLoading
      : mode === "theme"
        ? themes.loading
        : sectors.loading;
  const error = watchSource
    ? watch.error
    : mode === "mine"
      ? mineError
      : mode === "theme"
        ? themes.error
        : sectors.error;

  return (
    <div>
      <RefreshBar
        onRefresh={() => {
          void loadMine(true);
          themes.refresh();
          sectors.refresh();
        }}
        loading={loading}
        updatedAt={mode === "theme" ? themes.updatedAt : sectors.updatedAt}
      />
      <div className="filter-row">
        <button className={`filter-btn ${mode === "mine" ? "active" : ""}`} onClick={() => setMode("mine")}>
          내 테마
        </button>
        {WATCH_MODES.map((m) => (
          <button
            key={m.key}
            className={`filter-btn ${mode === m.key ? "active" : ""}`}
            onClick={() => setMode(m.key)}
          >
            {m.label}
          </button>
        ))}
        <button className={`filter-btn ${mode === "theme" ? "active" : ""}`} onClick={() => setMode("theme")}>
          키움 테마
        </button>
        <button className={`filter-btn ${mode === "sector" ? "active" : ""}`} onClick={() => setMode("sector")}>
          업종
        </button>
      </div>

      {mode === "mine" && (
        <div className="filter-row">
          <button
            className={`filter-btn ${!includeImported ? "active" : ""}`}
            onClick={() => setIncludeImported(false)}
            title="내가 직접 만든 테마만 봅니다"
          >
            내가 만든 것만
          </button>
          <button
            className={`filter-btn ${includeImported ? "active" : ""}`}
            onClick={() => setIncludeImported(true)}
            title="인포스탁에서 옮겨온 테마까지 함께 봅니다"
          >
            옮겨온 것 포함
          </button>
        </div>
      )}

      {mode === "sector" && (
        <div className="filter-row">
          <button
            className={`filter-btn ${sectorMarket === "kospi" ? "active" : ""}`}
            onClick={() => setSectorMarket("kospi")}
          >
            코스피
          </button>
          <button
            className={`filter-btn ${sectorMarket === "kosdaq" ? "active" : ""}`}
            onClick={() => setSectorMarket("kosdaq")}
          >
            코스닥
          </button>
        </div>
      )}

      {error && <div className="error-banner">{error}</div>}
      {loading && <div className="empty">불러오는 중...</div>}

      {!loading && !error && (
        <>
          <div className="map-grid">
            {/*
              관심종목 그룹 타일. 테마 타일과 같은 모양이라 나란히 견줄 수 있다 —
              "내 그룹이 테마보다 잘 도는가" 가 바로 읽힌다.
            */}
            {watchSource
              ? watch.tiles.map((t) => (
                  <button
                    key={t.id}
                    className="map-tile"
                    style={tileStyle(t.changeRate)}
                    onClick={() =>
                      setConstituent({
                        kind: "custom",
                        code: t.id,
                        name: t.name,
                        // 이미 손에 있는 구성종목을 그대로 넘긴다
                        stocks: t.stocks,
                      })
                    }
                    title={t.name}
                  >
                    <span className="map-tile-name">{t.name}</span>
                    <span className="map-tile-pct num">{fmtPct(t.changeRate)}</span>
                    <span className="map-tile-sub">
                      ▲{t.risingCount}/▼{t.fallingCount}
                    </span>
                  </button>
                ))
              : mode === "mine"
              ? mineTiles.map((t) => (
                  <button
                    key={t.id}
                    className="map-tile"
                    style={tileStyle(t.changeRate ?? 0)}
                    onClick={() =>
                      setConstituent({
                        kind: "custom",
                        code: t.id,
                        name: t.name,
                        // 이미 받아온 구성종목을 그대로 넘긴다 — 다시 조회할 이유가 없다
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
                      })
                    }
                    title={t.memo || t.name}
                  >
                    <span className="map-tile-name">{t.name}</span>
                    <span className="map-tile-pct num">{fmtPct(t.changeRate ?? 0)}</span>
                    {/*
                      ▲/▼ 를 같이 보여준다. 테마 등락률이 +2%여도 한 종목만 급등한
                      것이면 그건 테마가 도는 게 아니다 — 몇 개가 함께 올랐는지가
                      "주목받고 있는가"의 실제 근거다.
                    */}
                    <span className="map-tile-sub">
                      ▲{t.risingCount}/▼{t.fallingCount}
                      {(t.source ?? "manual") !== "manual" ? " · 옮김" : ""}
                    </span>
                  </button>
                ))
              : mode === "theme"
              ? themeTiles.map((t) => (
                  <button
                    key={t.code}
                    className="map-tile"
                    style={tileStyle(t.changeRate)}
                    onClick={() => setConstituent({ kind: "theme", code: t.code, name: t.name })}
                  >
                    <span className="map-tile-name">{t.name}</span>
                    <span className="map-tile-pct num">{fmtPct(t.changeRate)}</span>
                    <span className="map-tile-sub">{t.stockCount}종목</span>
                  </button>
                ))
              : sectorTiles.map((s) => (
                  <button
                    key={s.code}
                    className="map-tile"
                    style={tileStyle(s.changeRate)}
                    onClick={() =>
                      setConstituent({ kind: "sector", code: s.code, name: s.name, market: sectorMarket })
                    }
                  >
                    <span className="map-tile-name">{s.name}</span>
                    <span className="map-tile-pct num">{fmtPct(s.changeRate)}</span>
                  </button>
                ))}
          </div>
          <div className="table-note">
            색이 진할수록 등락폭이 큽니다 (5% 기준) · 타일을 누르면 구성종목이 열립니다
            {watchSource && ` · ${watch.tiles.length}개 그룹 · ▲/▼ 는 그 그룹에서 오른/내린 종목 수`}
            {mode === "mine" && ` · ${mineTiles.length}개 · ▲/▼ 는 그 테마에서 오른/내린 종목 수`}
            {mode === "theme" && ` · ${themeTiles.length}개 테마`}
          </div>
          {mode === "mine" && mineTiles.length === 0 && (
            <div className="empty">
              아직 만든 테마가 없습니다. <b>마이페이지 &gt; 내 테마</b>에서 먼저 만들어 주세요.
            </div>
          )}
        </>
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
