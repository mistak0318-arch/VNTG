import { useCardOrder } from "../useCardOrder";
import { STOCK_TABS } from "./StockTabsSection";
import { SCREENER_TABS } from "../pages/ScreenerPage";
import { SCREEN_TABS } from "../pages/ScreenPage";
import { FLOW_TABS } from "../pages/MarketFlowPage";
import { TELEGRAM_TABS } from "../pages/TelegramPage";
import { REPORT_SECTION_DEFS } from "../pages/DailyReportPage";
import { THEME_TABS } from "../pages/ThemeDbPage";
import { MAP_MODES } from "../pages/MapPage";

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
  /*
   * 종목 상세 시트와 개별종목분석은 **같은 탭 묶음**이라 줄도 하나다 (2026-08-27).
   * 예전엔 각자 탭 목록을 들고 있어서 순서도 따로 정해야 했다 — 같은 종목을 보는
   * 화면인데 한쪽에만 있는 탭이 생기는 원인이기도 했다.
   */
  { scope: "stockDetail.tabs", label: "종목 상세 · 개별종목분석", tabs: STOCK_TABS },
  { scope: "screener.tabs", label: "시세분석", tabs: SCREENER_TABS },
  { scope: "screen.tabs", label: "신호등 찾기", tabs: SCREEN_TABS },
  /* 마켓 브리핑과 합친 뒤에도 scope 는 그대로 — 저장된 순서가 이 이름을 기억한다 */
  { scope: "marketflow.tabs", label: "마켓 브리핑·흐름", tabs: FLOW_TABS },
  { scope: "themeDb.tabs", label: "테마 DB", tabs: THEME_TABS },
  /* MAP 은 탭이 아니라 모드 버튼이지만 같은 물음(무엇이 먼저 오나)이라 여기 있다 */
  { scope: "map.modes", label: "테마/업종 MAP 모드", tabs: MAP_MODES },
  { scope: "telegram.tabs", label: "텔레그램 동향", tabs: TELEGRAM_TABS },
  /* 리포트는 탭이 아니라 **섹션** 순서다 — 위에서 아래로 읽는 차례 (2026-08-26) */
  { scope: "report.sections", label: "데일리 리포트 섹션", tabs: REPORT_SECTION_DEFS },
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
      {/*
        세로 일렬 + 끌어서 옮기기 (2026-08-27 — "일자로 나열하고 드래그").
        가로 알약에 ◀▶ 였는데, 탭이 예닐곱이면 줄이 감겨 순서가 안 읽혔다.
        위에서 아래가 곧 화면의 왼쪽에서 오른쪽(리포트는 위에서 아래) 차례다.
      */}
      <div className="sto-list">
        {sorted.map((t, i) => (
          <div className={`sto-item${order.drag.cls(t.key)}`} key={t.key} {...order.drag.props(t.key)}>
            <span className="sto-no">{i + 1}</span>
            <span className="mo-grip" aria-hidden="true">
              ⠿
            </span>
            <span className="sto-name">{t.label}</span>
            <span className="mo-move">
              <button
                className="mo-arrow"
                disabled={i === 0}
                title="위로"
                onClick={() => order.move(t.key, -1)}
              >
                ▲
              </button>
              <button
                className="mo-arrow"
                disabled={i === sorted.length - 1}
                title="아래로"
                onClick={() => order.move(t.key, 1)}
              >
                ▼
              </button>
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}

export function SubTabOrderPanel() {
  return (
    <div>
      <p className="page-note">
        각 메뉴 상단의 서브탭이 여기 적힌 차례대로 놓입니다. <b>끌어서</b> 옮기거나
        <b> ▲▼</b> 로 한 칸씩 — 바꾸면 바로 저장되고 <b>열려 있는 화면에도 즉시</b>
        적용됩니다(서버 저장 — 다른 기기에서도 같은 순서). 뉴스 탭 순서는 뉴스 화면에서
        직접 끌어서 바꿉니다.
      </p>
      {PAGES.map((p) => (
        <PageRow key={p.scope} page={p} />
      ))}
    </div>
  );
}
