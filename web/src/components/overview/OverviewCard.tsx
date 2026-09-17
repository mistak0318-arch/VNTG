import { createContext, Fragment, useContext, useState, type ReactNode } from "react";

function fmtTime(ts: number | null): string {
  if (!ts) return "";
  return new Date(ts).toLocaleTimeString("ko-KR", { hour12: false });
}

/**
 * 카드 옮기기 손잡이.
 *
 * 격자에서 카드는 왼쪽→오른쪽으로 흐르다 줄바꿈한다. 그래서 위/아래가 아니라
 * **앞/뒤**다 — ▲▼ 로 적으면 오른쪽 칸으로 가는 걸 「아래로」라고 부르게 된다.
 */
export interface CardMove {
  onBack: () => void;
  onFwd: () => void;
  onFront: () => void;
  first: boolean;
  last: boolean;
}

/**
 * **카드 ↻ 세대** (2026-09-17 — 벤티지: "시황 대시보드 각 카드에 새로고침 버튼. ETF 나 조회순위 갱신이 안 돼 불편하다").
 *
 * 카드마다 값을 받는 길이 다르다 — 섹션 훅(useSection)은 부모가 들고 있고, 돈의 방향·조회순위·거래대금 같은
 * 판은 제 안에서 받는다. 한 단추로 둘 다 되게: ① `onRefresh` 가 있으면 부른다(섹션 훅의 refresh — 서버 캐시도 건너뜀)
 * ② 세대 번호를 올려 **본문을 다시 마운트**한다 — 제 안에서 받는 판은 마운트 때 다시 받는다.
 * 세대 번호는 컨텍스트로도 내려보낸다 — 판이 「↻ 로 다시 마운트됐다」를 알고 서버 캐시를 건너뛰게(fresh=1).
 */
export const CardRefreshContext = createContext(0);
export function useCardRefresh(): number {
  return useContext(CardRefreshContext);
}

export function OverviewCard({
  title,
  badge,
  updatedAt,
  subtitle,
  loading,
  error,
  span2,
  tall,
  order,
  move,
  onRefresh,
  children,
}: {
  title: string;
  /** 제목 옆에 붙는 표 — 지금은 장중 여부(SessionBadge) 뿐이다 (2026-09-08) */
  badge?: ReactNode;
  updatedAt?: number | null;
  subtitle?: string;
  loading?: boolean;
  error?: string | null;
  span2?: boolean;
  /**
   * **세로로 긴 카드** (2026-09-10 — 벤티지: "PC에서 볼 때 이 구조 너무 이상한 거 아니야?").
   * 글로벌처럼 스무 줄짜리가 한 칸을 차지하면 그 줄의 다른 카드 밑이 통째로 비고, 다음 카드는
   * 다음 줄로 밀려 혼자 남았다. 세로로 여러 줄을 걸치게 해 두면(grid-row span) 옆 칸에 다음 카드들이
   * 채워 올라온다 — 격자에 `dense` 를 같이 준다.
   */
  tall?: boolean;
  /** 배치 순서. JSX 를 재배열하지 않고 CSS 로만 자리를 바꾼다 */
  order?: number;
  /** 배치 모드일 때만 넘어온다 */
  move?: CardMove;
  /** 섹션 훅의 refresh — 없으면 본문 다시 마운트만으로 새로 받는다 */
  onRefresh?: () => void | Promise<void>;
  children: ReactNode;
}) {
  const [gen, setGen] = useState(0);
  const [busy, setBusy] = useState(false);
  const doRefresh = async () => {
    if (busy) return;
    setBusy(true);
    try {
      await onRefresh?.();
    } catch {
      /* 실패해도 본문은 다시 마운트한다 */
    }
    setGen((g) => g + 1);
    window.setTimeout(() => setBusy(false), 700);
  };
  return (
    <div className={`ov-card${span2 ? " ov-span2" : ""}${tall ? " ov-tall" : ""}`} style={order === undefined ? undefined : { order }}>
      <div className="ov-card-h">
        <span className="ov-card-t">{title}</span>
        {badge}
        {move ? (
          <span className="ov-move">
            <button className="gt-move" onClick={move.onBack} disabled={move.first} title="앞으로">
              ◀
            </button>
            <button className="gt-move" onClick={move.onFwd} disabled={move.last} title="뒤로">
              ▶
            </button>
            {/* 여덟 번 누르게 만들지 않으려고 둔다 — 실제로 하려는 건 「맨 위에 두기」다 */}
            <button className="gt-move" onClick={move.onFront} disabled={move.first} title="맨 앞으로">
              ⤒
            </button>
          </span>
        ) : (
          <>
            <span className="ov-card-sub">{subtitle ?? fmtTime(updatedAt ?? null)}</span>
            <button type="button" className={`ov-refresh${busy ? " busy" : ""}`} onClick={() => void doRefresh()} title="이 카드만 지금 새로 받기" aria-label="새로고침">
              ↻
            </button>
          </>
        )}
      </div>
      {error ? (
        <div className="ov-card-b ov-error">{error}</div>
      ) : loading ? (
        <div className="ov-card-b">
          <div className="ov-skel" />
          <div className="ov-skel" />
          <div className="ov-skel" />
        </div>
      ) : (
        <CardRefreshContext.Provider value={gen}>
          <Fragment key={gen}>{children}</Fragment>
        </CardRefreshContext.Provider>
      )}
    </div>
  );
}
