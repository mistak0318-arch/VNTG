import { useEffect, useRef, useState } from "react";
import { useSheetBack } from "../useSheetBack";
import { api, pick, stockNameOf, type RawRecord } from "../api";
import { WatchAddSheet, type WatchAddTarget } from "./WatchAddSheet";
import { IntradayLevelsBar } from "./IntradayLevelsBar";
import { IntradayFlow } from "./IntradayPanels";
import { PriceHeader } from "./PriceHeader";
import { StockSummaryPanel } from "./StockSummaryPanel";
import { StockTabsSection } from "./StockTabsSection";
import { useLive } from "../useLive";
import { useWatchedCodes } from "../useWatchedCodes";
import { CreditChip, useStockCredit } from "./CreditChip";
import { useCardOrder } from "../useCardOrder";
import { CardOrderList } from "./CardOrderList";

/**
 * 종목 상세 시트.
 *
 * 탭 안쪽은 개별종목분석 페이지와 **같은 모듈**(`StockTabsSection`)이다.
 * 예전엔 각자 탭 목록을 들고 있어서 한쪽에만 기능이 생기는 일이 반복됐다 —
 * 새 탭은 이제 그 모듈 한 곳에만 넣으면 두 화면에 같이 생긴다.
 *
 * 여기 남는 것은 **시트의 껍데기**다: 헤더(시장 배지·현재가·별·닫기)와
 * 값을 여는 순간 늘 보여야 하는 줄(가격·기준선·한 장 요약).
 *
 * ## ⚠️ 안 뜨는 자리 (2026-09-01)
 *
 * **종목발굴**에서는 이 시트를 띄우지 않는다. 그 화면은 이미 상세를 인라인으로
 * 펼쳐 놓은 자리라, 방향키로 넘길 때마다 시트가 앞으로 튀어나오면 훑기를 막는다.
 * (개별종목분석 탭도 같은 이유로 예외다 — 종목을 페이지 안에서 직접 보여준다.)
 *
 * 그 밖의 자리에서는 **시트가 맞다.** 시세분석·순위·관심종목·테마는 **목록을 훑는**
 * 화면이라 하나 보고 목록으로 돌아와야 하는데, 탭을 옮겨 버리면 돌아오는 데
 * 뒤로가기가 필요하다. 시트는 닫는 순간 보던 목록이 그대로 있다.
 * ETF 구성종목 팝업(8/25)을 남긴 이유도 정확히 같다.
 */

const CUR_PRICE_KEYS = ["cur_prc"];

/**
 * 시트 안의 **자리를 바꿀 수 있는 덩어리들** (2026-09-09).
 *
 * 벤티지: "최상단에 톱니바퀴 설정 모양 하나 넣고, 아래 나오는 것들 순서 좀 변경하게 할 수
 * 있겠어? 현재가 나오고 당일흐름 나오게 하고 이런식으로. 중간에 서브메뉴 나오는 부분도
 * 위치 조정하고 싶고."
 *
 * 무엇을 먼저 보는지는 사람마다·날마다 다르다. 여태 이 차례는 코드에 박혀 있어서 바꾸려면
 * 나를 불러야 했다 — 그런 값은 설정이어야 한다.
 *
 * **탭 줄은 탭 내용과 한 덩어리다.** 「서브메뉴만」 위로 올리면 무엇을 고르는 줄인지 알 수
 * 없어진다 — 고르는 것과 보이는 것은 붙어 있어야 한다. 그래서 통째로 옮긴다.
 *
 * 순서는 `useCardOrder` 가 **서버에 저장**하므로 폰에서 바꾸면 미니PC 에서도 그 차례다.
 */
const SHEET_CARDS: { key: string; label: string }[] = [
  { key: "price", label: "현재가 (시·고·저·거래대금)" },
  /*
   * 당일 흐름 그래프 (2026-09-09 — 벤티지 "저 빨간색 친 부분에 당일흐름 그래프 좀 넣어줄래?").
   *
   * 종합 탭에만 있던 것이다. 그런데 시트를 여는 이유가 대개 「지금 어떻게 가고 있나」라,
   * 그걸 보려고 탭을 한 번 더 눌러야 했다. 아래 기준선 줄(VWAP·시가갭)과 짝이라 붙여 둔다 —
   * 그림이 모양을 보여 주고 그 줄이 숫자를 보여 준다.
   */
  { key: "intraday", label: "당일 흐름 그래프" },
  { key: "levels", label: "기준선 (VWAP·시가갭·전일고저)" },
  { key: "summary", label: "한 장 요약 (수급 흐름)" },
  { key: "analysis", label: "넓은 화면으로 보기" },
  { key: "tabs", label: "탭 (호가·거래원·종목토론…)" },
];

export function StockDetail({
  code,
  name: givenName,
  onClose,
  onOpenAnalysis,
  onSelectStock,
}: {
  code: string;
  name: string;
  onClose: () => void;
  /** 검색·최근 목록까지 있는 개별종목분석 페이지로 이동 */
  onOpenAnalysis?: (code: string, name: string) => void;
  /** 업종·테마 구성종목에서 다른 종목으로 갈아타기 */
  onSelectStock?: (code: string, name: string) => void;
}) {
  /* 뒤로가기로 닫힌다 — 폰에서 시트를 열고 뒤로 누르면 페이지가 넘어갔다 (2026-08-28) */
  useSheetBack(true, onClose);
  const [error, setError] = useState<string | null>(null);

  /*
   * **1초 갱신.**
   *
   * 키움 제한은 「전체 초당 몇 건」이 아니라 **TR 하나당 초당 5건**이다.
   * 종목 창은 한 번에 하나만 열리고, 이 패널이 부르는 TR 도 하나다 —
   * 1초에 한 번이면 한도의 20% 다.
   */
  const live = useLive(() => api.stockInfo(code), [code], 1000);
  const info = (live.data ?? null) as RawRecord | null;
  /* 넘어온 이름이 비었거나 코드면 서버가 준 `stk_nm` 으로 (2026-09-03) — `stockNameOf` 주석 참고 */
  const name = stockNameOf(info, code, givenName);
  const [watchBusy, setWatchBusy] = useState(false);
  const [addTarget, setAddTarget] = useState<WatchAddTarget | null>(null);

  /*
   * 종목이 바뀌면 **맨 위로 올린다.**
   * 종목발굴에서 화살표로 넘기면 모달은 그대로 두고 내용만 갈린다. 그때 스크롤이
   * 내려가 있던 자리에 남아서, 새 종목이 **중간부터** 보였다.
   */
  const sheetRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    sheetRef.current?.scrollTo({ top: 0 });
  }, [code]);

  /* 신용 칩 — 개별종목분석과 **같은 것** (2026-09-08, 벤티지 "클릭하고 나오는 창에는 안 뜨는구나") */
  const credit = useStockCredit(code);
  const watchedCodes = useWatchedCodes();
  /* 시트 안 덩어리들의 차례 — 서버에 저장된다(`stockSheet` 이름표로) */
  const cards = useCardOrder("stockSheet", SHEET_CARDS.map((c) => c.key));
  const [orderOpen, setOrderOpen] = useState(false);
  /* 당일 흐름 그래프의 기준선 — 종합 탭이 쓰는 것과 같은 값(전일 종가) */
  const basePrice = Math.abs(Number(info?.base_pric)) || 0;
  const watched = watchedCodes.isWatched(code);

  /**
   * 별을 누르면 **그룹 고르는 창**을 연다.
   *
   * 예전엔 이미 담긴 종목이면 곧바로 지웠다. 한 종목이 여러 그룹에 담기게 된 뒤로는
   * 그게 틀렸다 — **다른 그룹에 하나 더 담으려고 눌렀는데 있던 것까지 사라졌다.**
   * 그룹이 하나도 없을 때만 묻지 않고 바로 담는다 — 빈 창은 방해다.
   */
  async function toggleWatch() {
    if (watchBusy) return;
    setWatchBusy(true);
    try {
      // 등록 시점의 현재가를 편입가로 기록
      const price = Math.abs(Number(pick(info ?? undefined, CUR_PRICE_KEYS))) || 0;
      const { groups } = await api.watchGroups().catch(() => ({ groups: [] as string[] }));
      if (groups.length === 0 && !watched) {
        await api.watchlistAdd({ code, name, addedPrice: price });
        watchedCodes.markAdded(code);
      } else {
        setAddTarget({ code, name, addedPrice: price });
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "관심종목 처리 실패");
    } finally {
      setWatchBusy(false);
    }
  }

  return (
    <div className="overlay" onClick={onClose}>
      <div className="sheet" ref={sheetRef} onClick={(e) => e.stopPropagation()}>
        <div className="sheet-header">
          <h2>
            {/* 코스피/코스닥 — 같은 +5% 라도 판이 다르다. 서버가 전종목 캐시에서 붙여 준다 */}
            {info && String(info._market ?? "") && (
              <span className={`mkt-badge ${String(info._market).includes("코스닥") ? "kq" : "ks"}`}>
                {String(info._market).includes("코스닥") ? "코스닥" : "코스피"}
              </span>
            )}
            <CreditChip credit={credit} />
            {name} ({code})
          </h2>
          {/*
            헤더에 현재가 상시 — 값은 **새로 받는 게 아니다.** 위 `useLive`(1초)가 이미
            들고 있는 `info` 를 sticky 헤더에도 그릴 뿐이다.
          */}
          {info && Math.abs(Number(info.cur_prc)) > 0 && (
            <span
              className={`sheet-live num ${
                Number(info.flu_rt) > 0 ? "positive" : Number(info.flu_rt) < 0 ? "negative" : ""
              }`}
            >
              <b>{Math.abs(Number(info.cur_prc)).toLocaleString("ko-KR")}</b>
              <i>
                {Number(info.flu_rt) > 0 ? "+" : ""}
                {Number(info.flu_rt).toFixed(2)}%
              </i>
            </span>
          )}
          <button
            className={`watch-btn${watched ? " on" : ""}`}
            onClick={toggleWatch}
            disabled={watchBusy}
            title={watched ? "그룹 고치기 (담긴 그룹 확인·추가·제거)" : "관심종목에 추가"}
          >
            {watched ? "★" : "☆"}
          </button>
          {/*
            차례 고치기 (2026-09-09) — 별·새로고침과 같은 손이다. 켜 두면 남지 않는다:
            차례는 한 번 정하면 끝나는 값이라 늘 펼쳐 둘 이유가 없다.
          */}
          <button
            className={`watch-btn${orderOpen ? " on" : ""}`}
            onClick={() => setOrderOpen((v) => !v)}
            title="이 시트에 나오는 것들의 차례 바꾸기"
          >
            ⚙
          </button>
          <button
            className="watch-btn"
            onClick={() => live.refresh()}
            title={
              live.updatedAt
                ? `${new Date(live.updatedAt).toLocaleTimeString("ko-KR", { hour12: false })} 기준 · 장중에는 1초마다 자동 갱신됩니다`
                : "지금 시세를 다시 받아옵니다"
            }
          >
            ↻
          </button>
          <button className="close-btn" onClick={onClose}>
            ✕
          </button>
        </div>

        {error && <div className="error-banner">{error}</div>}

        {/* 톱니바퀴를 누르면 여기서 바로 차례를 고친다 — 설정 화면까지 갈 일이 아니다 */}
        {orderOpen && (
          <section className="sheet-order">
            <h3 className="section-heading">
              이 시트의 차례
              {cards.customized && (
                <button className="filter-btn cop-reset" onClick={cards.reset}>
                  원래대로
                </button>
              )}
            </h3>
            <CardOrderList items={SHEET_CARDS} cards={cards} />
            <p className="table-note">
              위에 있을수록 시트에서도 앞에 옵니다. <b>서버에 저장</b>되어 폰에서 바꾸면
              미니PC 에서도 같은 차례입니다.
            </p>
          </section>
        )}

        {/*
          자리를 바꿀 수 있게 **감싸는 상자 하나**를 둔다 (2026-09-09).
          CSS `order` 는 flex 자식에만 먹으므로 이 상자가 있어야 하고, 각 덩어리를 한 겹
          싸야 그 값을 줄 수 있다. JSX 를 재배열하지 않으므로 차례를 바꿔도 차트·스크롤
          자리가 살아 있다(카드가 다시 만들어지지 않는다).
        */}
        <div className="sheet-body">
          <div className="sd-blk" style={{ order: cards.orderOf("price") }}>
            <PriceHeader info={info} code={code} />
          </div>
          {/* 값이 있어야 그린다 — 기준가가 0 이면 등락률 축이 안 선다 */}
          {basePrice > 0 && (
            <div className="sd-blk" style={{ order: cards.orderOf("intraday") }}>
              <IntradayFlow code={code} basePrice={basePrice} />
            </div>
          )}
          <div className="sd-blk" style={{ order: cards.orderOf("levels") }}>
            <IntradayLevelsBar code={code} />
          </div>
          {/* 한 장 요약 — 탭을 고르기 전에 「지금 어떤가」가 먼저 보여야 한다 */}
          <div className="sd-blk" style={{ order: cards.orderOf("summary") }}>
            <StockSummaryPanel code={code} />
          </div>

          {onOpenAnalysis && (
            <div className="sd-blk" style={{ order: cards.orderOf("analysis") }}>
              <button className="analysis-link" onClick={() => onOpenAnalysis(code, name)}>
                검색·최근 목록까지 있는 넓은 화면으로 보기 (개별종목분석) →
              </button>
            </div>
          )}

          {/* 탭 안쪽은 개별종목분석과 같은 모듈이다 */}
          <div className="sd-blk" style={{ order: cards.orderOf("tabs") }}>
            <StockTabsSection code={code} name={name} info={info} onSelectStock={onSelectStock} />
          </div>
        </div>
      </div>

      {/* 그룹을 고르고 담는다. 담기 전엔 별이 안 켜진다 */}
      {addTarget && <WatchAddSheet target={addTarget} onClose={() => setAddTarget(null)} />}
    </div>
  );
}
