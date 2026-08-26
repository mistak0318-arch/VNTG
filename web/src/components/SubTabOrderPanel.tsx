import { useCardOrder } from "../useCardOrder";
import { DETAIL_TABS } from "./StockDetail";
import { ANALYSIS_TABS } from "../pages/StockAnalysisPage";
import { SCREENER_TABS } from "../pages/ScreenerPage";
import { SCREEN_TABS } from "../pages/ScreenPage";
import { FLOW_TABS } from "../pages/MarketFlowPage";
import { TELEGRAM_TABS } from "../pages/TelegramPage";

/**
 * 서브탭 순서 (2026-08-26) — **모든 메뉴의 서브탭 순서를 한 자리에서.**
 *
 * 종목 상세·개별종목분석에는 화면 안에 「↔ 순서」가 있었지만, 나머지 메뉴는
 * 순서를 바꿀 방법이 없었다. 저장은 카드 배치와 같은 훅(useCardOrder, 서버 저장) —
 * 기기가 달라도 같은 순서고, 화면 안 「↔ 순서」와 같은 저장분을 읽고 쓴다.
 *
 * 새 페이지에 서브탭 순서를 붙일 때: 페이지에서 useCardOrder("<scope>", keys) 를
 * 쓰고, 여기 PAGES 에 한 줄 더하면 끝이다.
 */

interface PageDef {
  scope: string;
  label: string;
  tabs: { key: string; label: string }[];
}

const PAGES: PageDef[] = [
  { scope: "stockDetail.tabs", label: "종목 상세 시트", tabs: DETAIL_TABS },
  { scope: "stockAnalysis.tabs", label: "개별종목분석", tabs: ANALYSIS_TABS },
  { scope: "screener.tabs", label: "시세분석", tabs: SCREENER_TABS },
  { scope: "screen.tabs", label: "신호등 찾기", tabs: SCREEN_TABS },
  { scope: "marketflow.tabs", label: "시장흐름분석", tabs: FLOW_TABS },
  { scope: "telegram.tabs", label: "텔레그램 동향", tabs: TELEGRAM_TABS },
];

function PageRow({ page }: { page: PageDef }) {
  const order = useCardOrder(
    page.scope,
    page.tabs.map((t) => t.key),
  );
  const sorted = [...page.tabs].sort((a, b) => order.orderOf(a.key) - order.orderOf(b.key));

  return (
    <div className="sto-row">
      <div className="sto-head">
        <b>{page.label}</b>
        {order.customized && (
          <button className="filter-btn" onClick={order.reset} title="코드에 적힌 기본 순서로">
            기본 순서로
          </button>
        )}
      </div>
      <div className="sto-tabs">
        {sorted.map((t, i) => (
          <span className="sto-tab" key={t.key}>
            <button
              className="sto-move"
              disabled={i === 0}
              title="앞으로"
              onClick={() => order.move(t.key, -1)}
            >
              ◀
            </button>
            {t.label}
            <button
              className="sto-move"
              disabled={i === sorted.length - 1}
              title="뒤로"
              onClick={() => order.move(t.key, 1)}
            >
              ▶
            </button>
          </span>
        ))}
      </div>
    </div>
  );
}

export function SubTabOrderPanel() {
  return (
    <div>
      <p className="page-note">
        각 메뉴 상단의 서브탭이 여기 적힌 차례대로 놓입니다. <b>◀ ▶</b> 로 한 칸씩
        옮기면 바로 저장됩니다(서버 저장 — 다른 기기에서도 같은 순서). 뉴스 탭 순서는
        뉴스 화면에서 직접 끌어서 바꿉니다.
      </p>
      {PAGES.map((p) => (
        <PageRow key={p.scope} page={p} />
      ))}
    </div>
  );
}
