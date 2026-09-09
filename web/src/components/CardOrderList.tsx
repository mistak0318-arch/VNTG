import type { useCardOrder } from "../useCardOrder";

/**
 * **순서를 고치는 목록 — 한 벌만.**
 *
 * 화살표 두 개와 「맨 앞으로」, 그리고 끌어 옮기기. 이 조합이 시황 대시보드 카드 설정에
 * 있었는데, 종목 시트에도 같은 것이 필요해졌다(2026-09-09 — 벤티지 "최상단에 톱니바퀴
 * 설정 모양 하나 넣고, 아래 나오는 것들 순서 좀 변경하게").
 *
 * 두 번 짜면 언젠가 한쪽만 고쳐진다 — 이 앱에서 이미 여러 번 그랬다. 그래서 목록은
 * 여기 하나뿐이고, 부르는 쪽은 **무엇을 어떤 이름으로 세울지**만 넘긴다.
 *
 * 순서 자체는 `useCardOrder` 가 들고 있다(서버 저장·전역 알림). 이 컴포넌트는 그 훅이
 * 돌려준 것을 **그리기만** 한다 — 훅을 안에서 부르지 않는 이유는, 부르는 쪽이 이미
 * 같은 훅으로 화면에 order 를 먹이고 있어서 두 번 부르면 두 벌이 되기 때문이다.
 */
export function CardOrderList({
  items,
  cards,
}: {
  /** 세울 것들 — 코드가 아는 원래 차례로 */
  items: { key: string; label: string }[];
  /** 부르는 쪽이 이미 쓰고 있는 그 훅의 결과 */
  cards: ReturnType<typeof useCardOrder>;
}) {
  if (items.length < 2) return <div className="page-note">하나뿐이라 바꿀 것이 없습니다.</div>;

  /* 화면에 보이는 차례대로 — 설정 목록이 실제 배치와 다르면 볼 이유가 없다 */
  const ordered = [...items].sort((a, b) => cards.orderOf(a.key) - cards.orderOf(b.key));

  return (
    <ol className="cop-list">
      {ordered.map((d) => (
        /* 끌어서도 옮긴다 — 화살표와 같은 저장. 폰은 화살표 그대로 */
        <li className={`cop-row${cards.drag.cls(d.key)}`} key={d.key} {...cards.drag.props(d.key)}>
          <span className="cop-nm">{d.label}</span>
          <span className="cop-move">
            <button className="gt-move" onClick={() => cards.move(d.key, -1)} disabled={cards.isFirst(d.key)} title="앞으로">
              ▲
            </button>
            <button className="gt-move" onClick={() => cards.move(d.key, 1)} disabled={cards.isLast(d.key)} title="뒤로">
              ▼
            </button>
            {/* 여덟 번 누르게 만들지 않으려고 둔다 — 실제로 하려는 건 「맨 위에 두기」다 */}
            <button className="gt-move" onClick={() => cards.toFront(d.key)} disabled={cards.isFirst(d.key)} title="맨 앞으로">
              ⤒
            </button>
          </span>
        </li>
      ))}
    </ol>
  );
}
