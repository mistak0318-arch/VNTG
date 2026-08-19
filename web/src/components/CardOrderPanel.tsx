import { OVERVIEW_CARDS, type OverviewSub } from "../overviewCards";
import { useCardOrder } from "../useCardOrder";

/**
 * 시황 대시보드 카드 순서 — **설정에 둔다.**
 *
 * 예전엔 대시보드 탭 바에 「배치」 버튼이 늘 붙어 있었다. 그런데 배치는 **한 번 정하면
 * 끝나는 값**이다. 매일 보는 화면의 맨 윗줄을, 일 년에 몇 번 누를 버튼이 차지하고 있을
 * 이유가 없다 — 테마·글꼴을 화면마다 띄워 두지 않는 것과 같은 이유다.
 *
 * 그래서 「메뉴 순서·표시」 바로 옆으로 옮겼다. 설정끼리 한자리에 있어야 찾는다.
 */
export function CardOrderPanel() {
  return (
    <div className="cop">
      <p className="page-note">
        시황 대시보드의 카드 순서입니다. 위에 있을수록 화면에서도 앞에 옵니다.
        <b> 서버에 저장</b>되어 미니PC·휴대폰 어디서 열어도 같은 배치입니다.
      </p>
      {(Object.keys(OVERVIEW_CARDS) as OverviewSub[]).map((sub) => (
        <SubList key={sub} sub={sub} />
      ))}
    </div>
  );
}

const SUB_LABEL: Record<OverviewSub, string> = {
  summary: "요약",
  flow: "수급",
  rank: "순위",
};

function SubList({ sub }: { sub: OverviewSub }) {
  const defs = OVERVIEW_CARDS[sub];
  const keys = defs.map((d) => d.key);
  const cards = useCardOrder(`overview.${sub}`, keys);

  // 화면에 보이는 차례대로 세운다 — 설정 목록이 실제 배치와 다르면 볼 이유가 없다
  const ordered = [...defs].sort((a, b) => cards.orderOf(a.key) - cards.orderOf(b.key));

  return (
    <section className="cop-sub">
      <h3>
        {SUB_LABEL[sub]} 탭
        {cards.customized && (
          <button className="filter-btn cop-reset" onClick={cards.reset}>
            원래대로
          </button>
        )}
      </h3>
      {defs.length < 2 ? (
        <div className="page-note">카드가 하나뿐이라 바꿀 것이 없습니다.</div>
      ) : (
        <ol className="cop-list">
          {ordered.map((d) => (
            <li className="cop-row" key={d.key}>
              <span className="cop-nm">{d.label}</span>
              <span className="cop-move">
                <button
                  className="gt-move"
                  onClick={() => cards.move(d.key, -1)}
                  disabled={cards.isFirst(d.key)}
                  title="앞으로"
                >
                  ▲
                </button>
                <button
                  className="gt-move"
                  onClick={() => cards.move(d.key, 1)}
                  disabled={cards.isLast(d.key)}
                  title="뒤로"
                >
                  ▼
                </button>
                {/* 여덟 번 누르게 만들지 않으려고 둔다 — 실제로 하려는 건 「맨 위에 두기」다 */}
                <button
                  className="gt-move"
                  onClick={() => cards.toFront(d.key)}
                  disabled={cards.isFirst(d.key)}
                  title="맨 앞으로"
                >
                  ⤒
                </button>
              </span>
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}
