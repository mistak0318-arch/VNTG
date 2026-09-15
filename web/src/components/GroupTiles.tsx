import type { CSSProperties } from "react";

/**
 * **그룹 타일** (2026-09-15 — 벤티지: "저렇게 목록형 말고 한눈에 다 볼 수 있게 해줘. 시황에 있는 것처럼
 * 하든지 더 눈에 잘 보이는 구성으로" · "시황 대시보드 포도알처럼 되어 있는데 한눈에 보이는데 좀 이쁘게 할 순 없을까").
 *
 * 해외 관심종목은 폰에서 그룹을 **고르개(드롭다운)** 로 접었다 — 열세 개를 가로로 미는 칩보다 낫다고 봤는데,
 * 그러면 어느 판이 도는지가 **눌러서 펼치기 전엔 안 보인다.** 대시보드 카드는 칩을 흘려 놓아 한눈엔
 * 보이지만 길이가 제각각이라 포도송이처럼 엉겨 읽기 힘들다.
 *
 * 격자로 세운다. 칸마다 **이름 · 등락률 · 종목 수(▲▼)**. 바탕은 등락 방향으로 칠하고(국장 관습 — 오르면 붉게,
 * 내리면 푸르게) **많이 움직일수록 진하다** — 3% 에서 가장 진하고 그 위로는 같다. 그래서 글자를 읽기 전에
 * 「오늘 어느 판이 달아올랐나」가 먼저 보인다. 칸 폭이 같아 줄이 맞는다.
 *
 * 값이 없는 그룹(빈 그룹·시세 전)은 회색에 「–」 — 0% 로 칠하면 「안 움직였다」로 읽힌다.
 */
export interface TileGroup {
  id: string;
  name: string;
  /** 이름 앞 점 색 — 내 태그처럼 그룹마다 제 색이 있을 때 */
  color?: string;
  /** 그룹 평균 등락률(%). 모르면 null */
  rate: number | null;
  count: number;
  rising?: number;
  falling?: number;
  /** 말풍선 — 메모 등 */
  title?: string;
}

/** 등락 방향으로 칠하고 3% 에서 가장 진하다 — 한미 짝 타일도 같은 자로 칠한다 */
export function tint(rate: number | null): CSSProperties {
  if (rate === null || !Number.isFinite(rate) || rate === 0) return {};
  const k = Math.min(1, Math.abs(rate) / 3);
  const alpha = 0.08 + k * 0.32;
  const rgb = rate > 0 ? "255, 92, 92" : "76, 154, 255";
  return { background: `rgba(${rgb}, ${alpha.toFixed(3)})`, borderColor: `rgba(${rgb}, ${(alpha + 0.15).toFixed(3)})` };
}

export function GroupTiles({
  groups,
  activeId,
  onPick,
}: {
  groups: TileGroup[];
  activeId: string | null | undefined;
  onPick: (id: string) => void;
}) {
  return (
    <div className="gt-tiles" role="tablist" aria-label="그룹">
      {groups.map((g) => {
        const on = g.id === activeId;
        const r = g.rate;
        const dir = r === null || r === 0 ? "" : r > 0 ? "positive" : "negative";
        return (
          <button
            key={g.id}
            type="button"
            role="tab"
            aria-selected={on}
            className={`gt-tile${on ? " on" : ""}`}
            style={tint(r)}
            onClick={() => onPick(g.id)}
            title={`${g.name} · ${g.count}종목${(g.rising ?? 0) + (g.falling ?? 0) > 0 ? ` · ▲${g.rising ?? 0} ▼${g.falling ?? 0}` : ""}${g.title ? `
${g.title}` : ""}`}
          >
            {/*
              **두 줄로 얇게** (2026-09-15 — 벤티지: "박스 만든 거 좀 슬림하게 만들어 줘 봐 작게. 밑에 종목들 리스트
              보기가 힘들잖아"). 처음 판은 세 줄(이름·등락률·N종목 ▲▼)에 두 칸씩이라 그룹 열셋이 일곱 줄을 먹어
              정작 종목 표가 화면 밖으로 밀렸다. 윗줄 이름, 아랫줄 등락률과 ▲▼. 종목 수는 말풍선으로.
            */}
            <span className="gt-tile-name">
              {g.color && <i className="gt-dot" style={{ background: g.color }} />}
              {g.name}
            </span>
            <span className="gt-tile-line">
              <b className={`gt-tile-rate ${dir}`}>{r === null ? "–" : `${r > 0 ? "+" : ""}${r.toFixed(2)}%`}</b>
              {(g.rising ?? 0) + (g.falling ?? 0) > 0 && (
                <span className="gt-tile-meta">
                  <i className="positive">▲{g.rising ?? 0}</i>
                  <i className="negative">▼{g.falling ?? 0}</i>
                </span>
              )}
            </span>
          </button>
        );
      })}
    </div>
  );
}
