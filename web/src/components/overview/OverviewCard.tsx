import type { ReactNode } from "react";

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

export function OverviewCard({
  title,
  updatedAt,
  subtitle,
  loading,
  error,
  span2,
  order,
  move,
  children,
}: {
  title: string;
  updatedAt?: number | null;
  subtitle?: string;
  loading?: boolean;
  error?: string | null;
  span2?: boolean;
  /** 배치 순서. JSX 를 재배열하지 않고 CSS 로만 자리를 바꾼다 */
  order?: number;
  /** 배치 모드일 때만 넘어온다 */
  move?: CardMove;
  children: ReactNode;
}) {
  return (
    <div className={`ov-card${span2 ? " ov-span2" : ""}`} style={order === undefined ? undefined : { order }}>
      <div className="ov-card-h">
        <span className="ov-card-t">{title}</span>
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
          <span className="ov-card-sub">{subtitle ?? fmtTime(updatedAt ?? null)}</span>
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
        children
      )}
    </div>
  );
}
