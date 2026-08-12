import { useState } from "react";
import type { SectorRow, ThemeRow } from "../api";
import { ConstituentSheet, type ConstituentTarget } from "../components/overview/ConstituentSheet";
import { RefreshBar } from "../components/RefreshBar";
import { useSection } from "../useSection";

type Mode = "theme" | "sector";

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
  const [mode, setMode] = useState<Mode>("theme");
  const [sectorMarket, setSectorMarket] = useState<"kospi" | "kosdaq">("kospi");
  const [constituent, setConstituent] = useState<ConstituentTarget | null>(null);

  const themes = useSection<{ top: ThemeRow[]; bottom: ThemeRow[] }>("themes", 180_000);
  const sectors = useSection<{ kospi: SectorRow[]; kosdaq: SectorRow[] }>("sectors", 180_000);

  // 테마는 상위/하위를 합쳐 등락률 순으로 한 화면에 배치 (코드 중복 제거)
  const themeTiles = (() => {
    const merged = new Map<string, ThemeRow>();
    for (const t of [...(themes.data?.top ?? []), ...(themes.data?.bottom ?? [])]) {
      merged.set(t.code, t);
    }
    return [...merged.values()].sort((a, b) => b.changeRate - a.changeRate);
  })();

  const sectorTiles = sectors.data?.[sectorMarket] ?? [];
  const loading = mode === "theme" ? themes.loading : sectors.loading;
  const error = mode === "theme" ? themes.error : sectors.error;

  return (
    <div>
      <RefreshBar
        onRefresh={() => {
          themes.refresh();
          sectors.refresh();
        }}
        loading={loading}
        updatedAt={mode === "theme" ? themes.updatedAt : sectors.updatedAt}
      />
      <div className="filter-row">
        <button className={`filter-btn ${mode === "theme" ? "active" : ""}`} onClick={() => setMode("theme")}>
          테마
        </button>
        <button className={`filter-btn ${mode === "sector" ? "active" : ""}`} onClick={() => setMode("sector")}>
          업종
        </button>
      </div>

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
            {mode === "theme"
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
            {mode === "theme" && ` · ${themeTiles.length}개 테마`}
          </div>
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
