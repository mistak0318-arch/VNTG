import { useEffect, useState } from "react";
import { api, signClass, type MoodResult } from "../api";
import { ConstituentSheet, type ConstituentTarget } from "./overview/ConstituentSheet";

/**
 * 이 종목이 속한 업종·테마가 오늘 오르는 중인지 보여준다.
 * 종목 혼자 오르는 건지, 섹터 전체가 밀려 올라가는 건지 구분하려는 용도.
 * 업종/테마를 누르면 테마맵과 똑같이 구성종목 목록을 띄운다.
 */

function pct(v: number): string {
  return `${v > 0 ? "+" : ""}${v.toFixed(2)}%`;
}

/** 테마 안에서 오른 종목 비율로 분위기를 한 줄로 요약 */
function moodLabel(rising: number, falling: number): string {
  const total = rising + falling;
  if (total === 0) return "보합";
  const ratio = rising / total;
  if (ratio >= 0.8) return "전반 강세";
  if (ratio >= 0.6) return "강세 우위";
  if (ratio > 0.4) return "혼조";
  if (ratio > 0.2) return "약세 우위";
  return "전반 약세";
}

export function SectorMoodPanel({
  code,
  onSelectStock,
}: {
  code: string;
  /** 구성종목을 눌렀을 때 이동 (없으면 목록만 보여주고 클릭 불가) */
  onSelectStock?: (code: string, name: string) => void;
}) {
  const [data, setData] = useState<MoodResult | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [target, setTarget] = useState<ConstituentTarget | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    setTarget(null);
    api
      .sectorMood(code)
      .then((res) => {
        if (!cancelled) setData(res);
      })
      .catch((err: Error) => {
        if (!cancelled) setError(err.message);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [code]);

  if (loading) return <div className="empty">업종·테마 분위기 불러오는 중...</div>;
  if (error) return <div className="error-banner">{error}</div>;
  if (!data) return null;

  const sector = data.sector;
  // 업종지수 코드를 못 찾았으면 구성종목 조회가 불가능하므로 버튼으로 만들지 않는다
  const sectorClickable = Boolean(sector?.code);

  return (
    <div className="mood-panel">
      {/*
        표준산업분류(한투). 키움 업종은 「전기/전자」 하나로 삼성전자·SK하이닉스·포스코퓨처엠을
        같이 묶는데, 이건 통신방송장비 / 반도체 / 이차전지로 갈린다.
        **등락률은 없다** — 지수가 없는 분류라 이름만 쓴다. 그래서 업종을 대체하지 않고 옆에 붙인다.
      */}
      {data.industry && (
        <div className="mood-industry">
          <span className="mood-tag">산업분류</span>
          <span>{data.industry}</span>
        </div>
      )}
      {sector && (
        <button
          className={`mood-sector${sectorClickable ? " clickable" : ""}`}
          disabled={!sectorClickable}
          onClick={() =>
            setTarget({
              kind: "sector",
              code: sector.code,
              name: sector.name,
              market: sector.marketKey,
            })
          }
        >
          <div className="mood-sector-head">
            <span className="mood-tag">{sector.market} 업종</span>
            <span className="mood-name">{sector.name}</span>
            <span className={`mood-rate ${signClass(sector.changeRate)}`}>{pct(sector.changeRate)}</span>
          </div>
          {sector.rank !== null && sector.total !== null && (
            <div className="mood-sub">
              {sector.market} 전체 {sector.total}개 업종 중 <strong>{sector.rank}위</strong>
              {sector.rank <= 5 ? " · 오늘 시장을 이끄는 업종입니다" : ""}
              {sectorClickable ? " · 눌러서 구성종목 보기" : ""}
            </div>
          )}
        </button>
      )}

      {data.themes.length > 0 ? (
        <div className="mood-themes">
          <div className="mood-themes-title">편입 테마 {data.themes.length}개 · 눌러서 구성종목 보기</div>
          {data.themes.map((t) => (
            <button
              key={t.code}
              className="mood-theme-row"
              onClick={() => setTarget({ kind: "theme", code: t.code, name: t.name })}
            >
              <span className="mood-theme-name">{t.name}</span>
              <span className={`mood-theme-rate ${signClass(t.changeRate)}`}>{pct(t.changeRate)}</span>
              <span className="mood-theme-breadth">
                <span className="positive">▲{t.risingCount}</span>
                <span className="negative">▼{t.fallingCount}</span>
                <span className="mood-theme-mood">{moodLabel(t.risingCount, t.fallingCount)}</span>
              </span>
            </button>
          ))}
          <div className="table-note">
            테마별 등락률은 편입 종목의 평균 · 괄호 안은 상승/하락 종목 수 · 키움 테마 분류 기준
          </div>
        </div>
      ) : (
        <div className="page-note">{data.note ?? "편입된 테마가 없습니다."}</div>
      )}

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
    </div>
  );
}
