import { useEffect, useState } from "react";
import { api, signClass, type MoodResult, type EvaluatedTheme } from "../api";
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
  /**
   * **내가 만든 테마** 중 이 종목이 든 것.
   *
   * 위쪽 「편입 테마」는 **키움 분류**다. 그건 그것대로 쓸모가 있지만, 내가 직접 묶어
   * 둔 테마와 다르다 — 키움에 없는 묶음을 만들려고 내 테마가 있는 것이다.
   * 종목을 보다가 「아 이거 내가 원전 바구니에 넣어 뒀지」가 여기서 나와야 한다.
   *
   * 목록은 한 번만 받아 두고 종목이 바뀌면 코드로 걸러 쓴다 — 종목마다 다시 받으면
   * 넘겨 볼 때마다 스물여덟 테마를 새로 평가하게 된다.
   */
  const [mine, setMine] = useState<EvaluatedTheme[]>([]);

  useEffect(() => {
    let alive = true;
    api
      .customThemes()
      .then((r) => alive && setMine(r.themes ?? []))
      .catch(() => {
        /* 내 테마를 못 받아도 업종·테마는 그대로 나와야 한다 */
      });
    return () => {
      alive = false;
    };
  }, []);

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

  /* 이 종목이 든 내 테마 — 코드로 거른다 */
  const myThemes = mine.filter((t) => t.codes.includes(code));

  if (loading) return <div className="empty">테마 분위기 불러오는 중...</div>;
  if (error) return <div className="error-banner">{error}</div>;
  if (!data) return null;

  return (
    <div className="mood-panel">
      {/*
        ⚠️ **산업분류와 거래소 업종은 안 그린다** (2026-08-27).

        「화학」 한 칸에 화장품·이차전지·정유가 같이 들어간다. 업종이 +0.18% 라는 게
        이 종목에 대해 아무 말도 못 하는데, 맨 위에 크게 있으니 읽을 때마다 뜻을
        찾게 됐다. **눈금이 안 맞는 값은 옆에 붙여 두는 것도 방해다.**
        판정에서도 뺐다(signalLight 의 `sectorStrength`).

        남는 것은 **테마 둘**이다 — 내가 묶은 것이 먼저, 그다음이 키움 분류.
      */}

      {/*
        내 테마 — 키움 분류 **위**에 둔다. 내가 묶은 것이 먼저 눈에 들어와야 한다.
        든 게 없으면 줄 자체를 안 그린다(빈 줄이 「없음」보다 조용하다).
      */}
      {myThemes.length > 0 && (
        <div className="mood-mine">
          <span className="mood-mine-k">내 테마</span>
          {myThemes.map((t) => (
            <button
              key={t.id}
              className="mood-mine-tag"
              style={{ borderColor: t.color }}
              onClick={() =>
                setTarget({
                  kind: "custom",
                  code: t.id,
                  name: t.name,
                  label: "내 테마",
                  /* 이미 받아온 구성종목을 그대로 넘긴다 — 다시 조회할 이유가 없다 */
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
              title={`${t.name} — 눌러서 구성종목 (${t.codes.length}종목)`}
            >
              {t.name}
              <em className={signClass(t.changeRate ?? 0)}>{pct(t.changeRate ?? 0)}</em>
            </button>
          ))}
        </div>
      )}

      {/*
        네이버 테마 (2026-08-28) — **왜 이 테마에 묶였는지가 적혀 있다.**
        키움 테마는 이름만 주는데, 이건 종목마다 한 줄 설명이 붙는다. 종목을 처음 볼 때
        「이 회사가 이 테마에서 무슨 역할인가」가 여기서 풀린다. 그래서 키움 테마 위에 둔다.
      */}
      {(data.naverThemes ?? []).length > 0 && (
        <div className="nvt">
          <div className="nvt-head">
            <b>네이버 테마 {data.naverThemes!.length}</b>
            <span className="pt-n">종목마다 편입 사유가 붙습니다</span>
          </div>
          {data.naverThemes!.map((t) => (
            <div className="nvt-row" key={t.no}>
              <div className="nvt-name">{t.name}</div>
              {t.desc && <div className="nvt-desc">{t.desc}</div>}
            </div>
          ))}
        </div>
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
