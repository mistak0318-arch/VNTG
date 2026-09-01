import type { useCardOrder } from "../useCardOrder";

/**
 * **「기본 순서로」 단추** (2026-09-01).
 *
 * 벤티지: "각 표에 열을 내가 드래그해서 바꿀수 있게 해달라고 했잖아. 이거 모든
 * 표에 표순서 기본값 이런거 놔둬주라. 지금 마우스 잘못 해서 순서 바꿨는데
 * 초기값이 기억이 안난다."
 *
 * ## 왜 이게 문제인가
 *
 * 드래그로 순서를 바꾸는 자리를 열두 곳 넘게 만들어 뒀는데, **되돌리는 단추는
 * 네 곳에만 있었다.** 나머지 여덟 곳은 한 번 흐트러지면 되돌릴 방법이 없다 —
 * 기본 순서는 코드에만 적혀 있으니까.
 *
 * 그건 **실수를 되돌릴 수 없게 만든 것**이다. 드래그는 손이 미끄러지기 쉬운
 * 조작이라 더 그렇다. 바꿀 수 있게 만들었으면 되돌릴 수도 있어야 한다.
 *
 * ## 왜 컴포넌트로 빼나
 *
 * 곳마다 따로 적으면 또 빠뜨린다 — 실제로 그렇게 여덟 곳이 빠졌다.
 * 한 줄이면 붙일 수 있어야 안 빠뜨린다.
 *
 * `customized` 가 false 면 **아무것도 안 그린다.** 기본 순서일 때 「기본 순서로」가
 * 떠 있으면 누를 게 있는 줄 알고 누르게 되고, 눌러도 아무 일이 없어 혼란만 준다.
 */
export function OrderResetButton({
  order,
  what = "순서",
  className = "filter-btn dt-reset",
}: {
  order: ReturnType<typeof useCardOrder>;
  /** 무엇의 순서인지 — 「열 순서를 기본으로」처럼 읽히게 */
  what?: string;
  className?: string;
}) {
  if (!order.customized) return null;
  return (
    <button
      className={className}
      onClick={order.reset}
      title={`직접 옮긴 ${what}를 버리고 코드에 적힌 기본 순서로 되돌립니다`}
    >
      ↺ 기본 {what}
    </button>
  );
}
