import { useState } from "react";
import type { SignalResult } from "../api";
import { SignalDot, SignalPanel, useSignals } from "./SignalLight";

/**
 * 목록에 붙이는 **신호등 열** — 점 하나, 누르면 왜 그런지가 열린다.
 *
 * ## 왜 목록에 필요한가
 *
 * 거래대금 상위를 훑을 때 실제로 하는 일은 「이 중 볼 만한 게 뭔가」다. 그런데 지금까지는
 * 종목을 하나씩 눌러 들어가 봐야 알 수 있었다 — 백 종목을 그렇게 볼 수는 없다.
 * 점 하나가 붙으면 **훑는 단계에서 걸러진다.**
 *
 * ## ⚠️ 켤 때만, 보는 쪽만
 *
 * 신호등은 종목마다 차트·수급·재무를 받아 계산한다. **백 종목이면 서버가 한참 걸린다** —
 * 종목발굴에서 앞의 마흔 개로 묶어 둔 이유가 그것이다.
 *
 * 그래서 두 가지를 지킨다.
 *   · **기본은 꺼 둔다.** 목록을 여는 것만으로 평가가 돌면 안 된다
 *   · **지금 쪽만 평가한다.** 삼백 건을 받아 놨어도 눈에 보이는 오십 개만 본다.
 *     쪽을 넘기면 그 쪽을 평가한다 — 안 볼 것을 미리 계산할 이유가 없다
 */

export function useSignalColumn(codes: string[], on: boolean): Record<string, SignalResult> {
  /* 꺼져 있으면 빈 배열을 넘긴다 — 훅 안에서 빈 키는 조회를 안 한다 */
  return useSignals(on ? codes : []);
}

/**
 * 점 하나. 누르면 시트가 열린다.
 *
 * 마우스를 올리면 뜨는 `title` 로도 요약이 보이지만, **폰에는 hover 가 없다.**
 * 눌러서 여는 길이 따로 있어야 한다.
 */
export function SignalCell({
  code,
  name,
  signal,
  onSelectStock,
}: {
  code: string;
  name: string;
  signal?: SignalResult;
  onSelectStock?: (code: string, name: string) => void;
}) {
  const [open, setOpen] = useState(false);

  return (
    <>
      <button
        className="sig-cell"
        onClick={(e) => {
          // 줄 전체가 눌리는 표가 많다 — 점은 점의 일만 한다
          e.stopPropagation();
          setOpen(true);
        }}
        title={signal ? "눌러서 근거 보기" : "평가 중"}
      >
        <SignalDot signal={signal} />
      </button>

      {open && (
        <div className="overlay" onClick={() => setOpen(false)}>
          <div className="sheet sig-sheet" onClick={(e) => e.stopPropagation()}>
            <div className="sheet-header">
              <h2>
                {name}
                <span className="pt-n"> ({code})</span>
              </h2>
              <button className="close-btn" onClick={() => setOpen(false)}>
                ✕
              </button>
            </div>
            {/* 종목 상세와 **같은 판**을 쓴다 — 같은 값을 두 번 그리면 언젠가 갈라진다 */}
            <SignalPanel code={code} onSelectStock={onSelectStock} />
          </div>
        </div>
      )}
    </>
  );
}
