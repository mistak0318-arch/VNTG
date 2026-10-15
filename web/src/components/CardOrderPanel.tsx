import { OVERVIEW_CARDS, type OverviewSub } from "../overviewCards";
import { useCardOrder } from "../useCardOrder";
import { CardOrderList } from "./CardOrderList";

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
      {/*
        ⚠️ **화면에 있는 탭만 보인다** (2026-10-16). 「수급」·「순위」는 2026-08 에 대시보드에서
        숨겼는데(카드 구성은 되살릴 수 있게 남겨 뒀다) 설정에는 그대로 떠 있었다 —
        **갈 수 없는 탭의 차례를 정하는 칸**이라, 바꿔 봐야 아무 일도 안 일어난다.
      */}
      {VISIBLE.map((sub) => (
        <SubList key={sub} sub={sub} />
      ))}
    </div>
  );
}

/** 지금 대시보드에 실제로 떠 있는 탭 (`OverviewPage.SUBTABS` 와 맞춘다) */
const VISIBLE: OverviewSub[] = ["summary", "market"];

const SUB_LABEL: Record<OverviewSub, string> = {
  summary: "요약",
  /* 2026-10-15 — 요약에서 「골라 보는 카드」를 옮겨 받은 탭 */
  market: "시황",
  flow: "수급",
  rank: "순위",
};

function SubList({ sub }: { sub: OverviewSub }) {
  const defs = OVERVIEW_CARDS[sub];
  const keys = defs.map((d) => d.key);
  /* 대시보드와 같은 저장 자리 — overview2 (2026-09-10 기본 차례 개편 때 올림). 다르면 설정에서 바꾼 게 화면에 안 먹는다 */
  const cards = useCardOrder(`overview2.${sub}`, keys);

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
      {/* 목록은 `CardOrderList` 한 벌 — 종목 시트의 톱니바퀴도 같은 것을 쓴다 (2026-09-09) */}
      <CardOrderList items={defs.map((d) => ({ key: d.key, label: d.label }))} cards={cards} />
    </section>
  );
}
