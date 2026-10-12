import { useEffect, useRef, useState } from "react";
import { useSheetBack } from "../useSheetBack";
import { api, pick, stockNameOf, type RawRecord } from "../api";
import { StatusMark, StockStatusBanner, useStockStatus } from "./StockStatusBanner";
import { InvestorEstimate } from "./InvestorEstimate";
import { WatchAddSheet, type WatchAddTarget } from "./WatchAddSheet";
import { IntradayLevelsBar } from "./IntradayLevelsBar";
import { IntradayFlow } from "./IntradayPanels";
import { PriceHeader } from "./PriceHeader";
import type { LastSession } from "./PeriodReturns";
import { krPhase } from "../marketSession";
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
  wide = false,
}: {
  code: string;
  name: string;
  onClose: () => void;
  /** 검색·최근 목록까지 있는 개별종목분석 페이지로 이동 */
  onOpenAnalysis?: (code: string, name: string) => void;
  /** 업종·테마 구성종목에서 다른 종목으로 갈아타기 */
  onSelectStock?: (code: string, name: string) => void;
  /**
   * 「종목상세 넓게」가 켜져 있나 (2026-10-12).
   *
   * 화면이 아니라 **차림이 달라진다** — 당일 흐름을 머리줄의 가격 옆으로 올린다.
   * 속성(`data-widestock`)을 직접 읽지 않고 prop 으로 받는 까닭은, 그 속성이 렌더 **뒤에**
   * 붙어서 켠 그 순간의 렌더가 한 박자 늦기 때문이다. 값은 App 이 들고 있으니 그냥 내려받는다.
   */
  wide?: boolean;
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
  /** 머리줄 단추 펼침 — 넓게 보기에서만 쓴다 (2026-10-12) */
  const [moreOpen, setMoreOpen] = useState(false);
  /** 마지막 거래일 일봉 한 줄 — 새벽(키움이 날짜를 넘긴 뒤) 머리가 어제 값을 쓰려고 (2026-09-15) */
  const [lastSession, setLastSession] = useState<LastSession | null>(null);
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

  /*
   * **곁가지는 한 박자 늦게** (2026-09-23 — 벤티지: "각 종목 눌렀을때 뜨는게 많아서 그런가 약간 로딩이 있는데").
   * 시트가 열리며 키움 TR 이 22개쯤 한꺼번에 나간다 — 통(8개)을 넘긴 나머지는 4.5/s 로 줄을 선다. 신용(4 TR)·
   * 추정(3 TR)은 머리·종합·당일 흐름보다 뒤에 봐도 되는 값이라 1.2초 뒤에 부른다. 총량은 같고 **먼저 보이는 것이
   * 먼저** 온다. 서버(`kiwoomClient.request`)는 같은 TR 이 겹치면 한 번만 부르게 따로 고쳤다.
   */
  const [late, setLate] = useState(false);
  useEffect(() => {
    setLate(false);
    const t = setTimeout(() => setLate(true), 1200);
    return () => clearTimeout(t);
  }, [code]);
  /* 신용 칩 — 개별종목분석과 **같은 것** (2026-09-08, 벤티지 "클릭하고 나오는 창에는 안 뜨는구나") */
  const credit = useStockCredit(late ? code : null);
  /*
   * 종목 상태 배너 (2026-09-10 — 벤티지 "종목 열면 종목 상단에 표시를 해주거나 … 증권플러스에서
   * 하고 있는 거 보이지?"). 한투 시세2(당일 낮 반영) + 키움 auditInfo + KIND 공시를 서버가 합친다.
   */
  const { flags } = useStockStatus(code);
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
          {/*
            **감싸는 칸만 더한다** (2026-10-12 — 「넓게 보기」 2/4).
            증권플러스는 배지를 이름 아래 한 줄로 모아 둔다. 그러려면 둘을 따로 잡을 수
            있어야 하는데 여태 이름이 **맨 글자**라 CSS 로 집을 수가 없었다.
            칸을 둘러 주기만 하고 차례·크기는 CSS 가 정한다 — 예전 모양에서는 이 칸들이
            아무 일도 안 하므로 한 픽셀도 안 달라진다.
          */}
          <h2>
            <span className="sd-badges">
              {/* 코스피/코스닥 — 같은 +5% 라도 판이 다르다. 서버가 전종목 캐시에서 붙여 준다 */}
              {info && String(info._market ?? "") && (
                <span className={`mkt-badge ${String(info._market).includes("코스닥") ? "kq" : "ks"}`}>
                  {String(info._market).includes("코스닥") ? "코스닥" : "코스피"}
                </span>
              )}
              <CreditChip credit={credit} />
              {/* 상태 한 글자 — 배너까지 안 내려가도 이름 옆에서 「주의」가 보인다 (2026-09-10) */}
              <StatusMark flags={flags} />
            </span>
            <span className="sd-name">
              {name} ({code})
            </span>
          </h2>
          {/*
            헤더에 현재가 상시 — 값은 **새로 받는 게 아니다.** 위 `useLive`(1초)가 이미
            들고 있는 `info` 를 sticky 헤더에도 그릴 뿐이다.
          */}
          {info && Math.abs(Number(info.cur_prc)) > 0 && (() => {
            /*
             * **정규장과 장외를 나눠 적는다** (2026-09-14 — 벤티지: "종목상세에 정규장 종가 애프터장 종가를 구분해서
             * 표시해야겠다. 지금 계속 애프터장 시세가 최신 시세로만 보이니까 얘가 정규장에서 어땠는지를 모르네").
             *
             * 16:00 뒤로 현재가는 애프터 체결가다. 그것 하나만 보이면 「정규장에서 +3% 로 마감하고 장 뒤에 밀린 것」과
             * 「정규장부터 약했던 것」이 구별이 안 된다. 서버가 15:40 에 KRX 로 찍은 정규장 종가를 `_regular` 로 주면
             * 두 칸으로 그린다 — **정규장 종가(전일 대비)** 와 **지금 값(정규장 대비)**. 둘을 합치면 하루 전체다.
             * 정규장 중이거나 종가를 아직 못 찍었으면 서버가 안 준다 — 그땐 예전처럼 한 칸.
             */
            /*
             * 새벽엔 키움이 이미 새 날이라 현재가 = 어제 정규장 종가, 등락률 0 이다(2026-09-15 06:17 실측).
             * 07:50 전이고 오늘 거래가 0 이면 **어제 일봉의 마지막 값**을 쓴다 — 가격 칸(PriceHeader)과 같은 판정.
             */
            const rolled =
              krPhase() === "closed" &&
              Math.abs(Number(info.open_pric)) === 0 &&
              !(Math.abs(Number(info.trde_qty)) > 0) &&
              (lastSession?.close ?? 0) > 0;
            const cur = rolled ? lastSession!.close! : Math.abs(Number(info.cur_prc));
            const sign = (v: number | null) => (v === null ? "" : v > 0 ? "positive" : v < 0 ? "negative" : "");
            const pct = (v: number | null) => (v === null ? "" : `${v > 0 ? "+" : ""}${v.toFixed(2)}%`);
            /* flu_rt 가 비면 「NaN%」가 찍히던 것 — 모르면 null 로 두고 칸을 비운다 (2026-09-18 전수검증 D14) */
            const fluRt = (() => {
              if (info.flu_rt == null || String(info.flu_rt) === "") return null;
              const n = Number(String(info.flu_rt).replace(/\+/g, ""));
              return Number.isFinite(n) ? n : null;
            })();
            const reg = (info._regular ?? null) as {
              date: string;
              close: number;
              prevClose: number | null;
              liveLabel: string;
            } | null;
            if (!reg || !(reg.close > 0)) {
              const r0 = rolled && lastSession?.base ? ((cur - lastSession.base) / lastSession.base) * 100 : fluRt;
              return (
                <span className={`sheet-live num ${sign(r0)}`}>
                  <b>{cur.toLocaleString("ko-KR")}</b>
                  <i>{pct(r0)}</i>
                </span>
              );
            }
            const todayKst = new Date(Date.now() + 9 * 3600_000).toISOString().slice(0, 10);
            /* 정규장이 전일보다 몇 % — 앞 장 파일이 있으면 그것, 오늘 장이면 키움 기준가(전일 종가)로 */
            const base = Math.abs(Number(info.base_pric)) || 0;
            /* 일봉 날짜는 YYYYMMDD — 정규장 파일 날짜(YYYY-MM-DD)와 같은 날이면 그날의 전일종가를 기준으로 */
            const lastSameDay = lastSession && lastSession.date === reg.date.replace(/-/g, "") ? lastSession.base : null;
            const prev =
              reg.prevClose && reg.prevClose > 0
                ? reg.prevClose
                : lastSameDay && lastSameDay > 0
                  ? lastSameDay
                  : reg.date === todayKst && base > 0
                    ? base
                    : null;
            const regRate = prev ? ((reg.close - prev) / prev) * 100 : null;
            /*
             * 권리락·배당락 날엔 거래소 기준가가 어제 종가와 다르다 (2026-09-17 퓨쳐켐 — 기준가 8,100 → 6,750, 거래소 +23.56%
             * 인데 우리는 +2.96%). 새 날의 장외 값은 **기준가로** 나눈다 — PriceHeader 와 같은 판정.
             */
            const exBase = reg.date !== todayKst && base > 0 && Math.abs(base - reg.close) / reg.close > 0.001 ? base : null;
            const liveDenom = exBase ?? reg.close;
            const liveRate = ((cur - liveDenom) / liveDenom) * 100;
            const md = `${Number(reg.date.slice(5, 7))}/${Number(reg.date.slice(8, 10))}`;
            return (
              <>
                <span
                  className={`sheet-live sheet-reg num ${sign(regRate)}`}
                  title={`${reg.date} 정규장(09:00~15:30) 종가 — 15:40 에 KRX 로 찍은 값${regRate === null ? "" : ` · 전일 대비 ${pct(regRate)}`}`}
                >
                  <em>{reg.date === todayKst ? "정규장" : `${md} 정규장`}</em>
                  <b>{reg.close.toLocaleString("ko-KR")}</b>
                  {regRate !== null && <i>{pct(regRate)}</i>}
                </span>
                <span
                  className={`sheet-live num ${sign(liveRate)}`}
                  title={
                    exBase
                      ? `지금 ${reg.liveLabel} 값 — 기준가 ${exBase.toLocaleString("ko-KR")} 대비 ${pct(liveRate)} (권리락·배당락 등으로 기준가가 어제 종가와 다릅니다 — 거래소 등락률과 같은 기준)`
                      : `지금 ${reg.liveLabel} 값 — 정규장 종가 대비 ${pct(liveRate)}${fluRt === null ? "" : ` · 전일 대비 ${pct(fluRt)}`}`
                  }
                >
                  <em>{reg.liveLabel}{exBase ? "·락" : ""}</em>
                  <b>{cur.toLocaleString("ko-KR")}</b>
                  <i>{pct(liveRate)}</i>
                </span>
              </>
            );
          })()}
          {/*
            **단추는 ⋯ 뒤로** (2026-10-12 — 벤티지: "뒤로가기는 이미 먹히니깐 펼치기
            이런 메뉴 같은 거 만들어서 접었다 폈다? 이러면 칸 두 칸 정도밖에 안 먹지 않을까
            x버튼은 보이긴 해야 되니깐").

            맞는 셈이다. 머리줄에 늘 있어야 하는 것은 **닫기 하나**다 — 나머지(관심·주문·
            보드·새로고침·설정·넓게)는 생각하고 누르는 것이라 한 번 더 눌러도 손해가 없다.
            여섯을 늘 펼쳐 두느라 이름과 가격이 자리를 잃는 쪽이 훨씬 비싸다.
            뒤로가기가 이미 닫기 노릇을 하지만 ✕ 는 남긴다 — 폰이 아닌 데서는 그 길이 없다.
          */}
          {wide && (
            <button
              className={`watch-btn sd-more${moreOpen ? " on" : ""}`}
              onClick={() => setMoreOpen((v) => !v)}
              title={moreOpen ? "접기" : "관심·주문·보드·새로고침·설정"}
              aria-expanded={moreOpen}
            >
              ⋯
            </button>
          )}
          <div className={`sd-acts${wide && !moreOpen ? " folded" : ""}`}>
          <button
            className={`watch-btn${watched ? " on" : ""}`}
            onClick={toggleWatch}
            disabled={watchBusy}
            title={watched ? "그룹 고치기 (담긴 그룹 확인·추가·제거)" : "관심종목에 추가"}
          >
            {watched ? "★" : "☆"}
          </button>
          {/*
            **주문하기** (2026-09-10 — 벤티지: "종목 클릭하면 나오는 여기에 주문하기 아이콘도 넣어서
            연결해줘"). 현미경 표의 「🛒 주문으로」와 같은 길 — 주문 화면에 종목만 채워 간다.
            차례도 그때 정해졌다: 관심종목 · 주문 · 미니창 · 새로고침 · 톱니(차례) · 닫기.
          */}
          <a
            className="watch-btn"
            href={`#/order?stk=${code}&name=${encodeURIComponent(name)}&side=buy`}
            onClick={() => onClose()}
            title="주문 화면으로 — 종목이 채워져 갑니다. 주문은 거기서 냅니다"
          >
            🛒
          </a>
          {/*
            **독립창으로** (2026-09-09 밤 — 벤티지 "종목 클릭하면 나오는 이 부분에서 저 위치에
            독립창으로 띄우는 아이콘 버튼 하나 만들자 … 클릭하면 미니창 뜨고 해당 종목 상세
            화면으로 넘어가게끔"). 미니창(vntg-mini)을 종목검색 화면으로 열고 이 종목을
            넘긴다 — 이미 떠 있으면 그 창의 종목만 바뀐다. 미니창 안에서는 뜻이 없어 숨긴다.
          */}
          {!window.location.hash.startsWith("#/mini") && (
            <button
              className="watch-btn"
              onClick={() =>
                window.open(
                  `${window.location.pathname}#/mini?screen=stock&${new URLSearchParams({ code, name }).toString()}`,
                  "vntg-mini",
                  "width=560,height=880,resizable=yes,scrollbars=yes",
                )
              }
              title="이 종목을 미니창(독립창)으로 띄우기"
            >
              🪟
            </button>
          )}
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
          {/*
            차례 고치기 (2026-09-09) — 닫기 바로 앞 (2026-09-10 "톱니바퀴가 x 앞에 와야겠다").
            켜 두면 남지 않는다: 차례는 한 번 정하면 끝나는 값이라 늘 펼쳐 둘 이유가 없다.
          */}
          <button
            className={`watch-btn${orderOpen ? " on" : ""}`}
            onClick={() => setOrderOpen((v) => !v)}
            title="이 시트에 나오는 것들의 차례 바꾸기"
          >
            ⚙
          </button>
          {wide && onOpenAnalysis && (
            <button
              className="watch-btn"
              onClick={() => onOpenAnalysis(code, name)}
              title="검색·최근 목록까지 있는 넓은 화면(개별종목분석)으로 갑니다"
            >
              ↗
            </button>
          )}
          </div>
          <button className="close-btn" onClick={onClose}>
            ✕
          </button>
          {/*
            ⚠️ 당일 흐름을 여기(가격 옆)에 올렸다가 **걷었다** (2026-10-12).
            `IntradayFlow` 는 제목·VWAP 줄까지 있는 한 장짜리 카드라, 머리줄에 맞추려고
            72px 로 자르니 글자 줄만 남고 그림은 안 보였다 — 자리에 안 맞는 부품을 억지로
            밀어 넣은 것이다. 머리줄에 쓸 작은 선은 **그 용도로 따로** 그려야 한다.
            그때까지는 종합 탭의 제자리에 둔다.
          */}
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
        {/*
          **뼈대 먼저, 한 번에 펼치기** (2026-09-23 — 벤티지: "화면에 다다닥 표시되는게 좀 부자연스러운데").
          패널 대부분이 값이 오기 전엔 null 을 그려서, 도착 순서대로 툭툭 나타나며 아래를 밀어냈다.
          시세 머리(`info`, 첫 조회)가 올 때까지는 회색 뼈대를 보여 주고, 오면 몸통을 한 번에 페이드로 편다.
          그 뒤에 오는 것(신용·추정·탭 안쪽)은 `.sd-blk > *` 의 떠오르는 페이드가 받는다(styles.css).
        */}
        {!info && !error && (
          <div className="sd-skel" aria-hidden="true">
            <i style={{ height: 22, width: "55%" }} />
            <i style={{ height: 56 }} />
            <i style={{ height: 180 }} />
            <i style={{ height: 40 }} />
            <i style={{ height: 120 }} />
          </div>
        )}
        <div className={`sheet-body${info ? " sd-ready" : " sd-wait"}`}>
          {/*
            **넓게 보기에서는 가격 덩이도 탭 안으로** (2026-10-12).

            앞 커밋에서 기준선·요약만 옮기고 **제일 큰 덩이를 안 옮겼다.** 가격 카드는
            종가·시가·고가·저가·정규장종가·애프터·회전율·거래대금·시총까지 든 한 화면짜리라,
            그것이 탭 위에 남아 있으면 구조를 바꾼 뜻이 없다 — 여전히 탭까지 한참 내려야 한다.
            머리줄에 이미 현재가가 크게 있으므로 위에 또 둘 까닭도 없다.
          */}
          {!wide && (
            <div className="sd-blk" style={{ order: cards.orderOf("price") }}>
              {/* 상태 배너 + 예탁원 이벤트 — 개별종목분석·보드·종목발굴과 같은 컴포넌트 (2026-09-10) */}
              <StockStatusBanner code={code} />
              <PriceHeader info={info} code={code} onLastSession={setLastSession} />
            </div>
          )}
          {/*
            값이 있어야 그린다 — 기준가가 0 이면 등락률 축이 안 선다.
            **넓게 보기에서는 머리줄로 올라간다**(가격 옆) — 아래에 또 그리면 두 벌이 된다.
          */}
          {basePrice > 0 && !wide && (
            <div className="sd-blk" style={{ order: cards.orderOf("intraday") }}>
              <IntradayFlow code={code} basePrice={basePrice} />
            </div>
          )}
          {/*
            **넓게 보기에서는 이 둘이 종합 탭 안으로 들어간다** (2026-10-12).

            벤티지: "내가 원하는 건 증권플러스와 같은 구조인데 우리의 데이터를 잘 보여주는 거야"
            맞다. 여태 나는 쌓는 구조를 그대로 두고 CSS 로 밀어만 놨다. 증권플러스가 넓어
            보이는 까닭은 모양이 아니라 **한 번에 하나만 보여 주기** 때문이다 — 머리줄 바로
            아래가 탭 줄이고, 그 아래는 고른 탭 하나뿐이다.
            우리는 탭 **위에** 네 덩이를 쌓아 둬서 탭까지 가는 데만 한참 걸렸다. 그 넷을
            종합 탭 안으로 옮긴다. 버리는 것은 없다 — 자리만 바뀐다.
          */}
          {!wide && (
            <>
              <div className="sd-blk" style={{ order: cards.orderOf("levels") }}>
                <IntradayLevelsBar code={code} />
              </div>
              {/* 한 장 요약 — 탭을 고르기 전에 「지금 어떤가」가 먼저 보여야 한다 */}
              <div className="sd-blk" style={{ order: cards.orderOf("summary") }}>
                {late && <InvestorEstimate code={code} />}
                <StockSummaryPanel code={code} onSelectStock={onSelectStock} />
              </div>
            </>
          )}

          {/*
            **넓게 보기에서는 머리줄 단추로** (2026-10-12).
            이 단추는 머리줄과 탭 줄 사이, 화면에서 제일 비싼 자리를 줄 하나로 통째로
            먹고 있었다. 하루에 몇 번 누르는 길이 늘 보이는 자리를 차지할 까닭이 없다 —
            단추 줄에 아이콘 하나로 옮긴다.
          */}
          {onOpenAnalysis && !wide && (
            <div className="sd-blk" style={{ order: cards.orderOf("analysis") }}>
              {/* 폰에서 긴 문구가 두 줄이 되며 앞 줄이 잘려 「종목분석) →」만 보였다 (2026-09-17 캡처) — 한 줄로 */}
              <button className="analysis-link" onClick={() => onOpenAnalysis(code, name)} title="검색·최근 목록까지 있는 넓은 화면(개별종목분석)으로 갑니다">
                넓은 화면으로 보기 (개별종목분석) →
              </button>
            </div>
          )}

          {/* 탭 안쪽은 개별종목분석과 같은 모듈이다 */}
          <div className="sd-blk" style={{ order: cards.orderOf("tabs") }}>
            <StockTabsSection
              code={code}
              name={name}
              info={info}
              onSelectStock={onSelectStock}
              summaryTop={
                wide ? (
                  <>
                    <StockStatusBanner code={code} />
                    <PriceHeader info={info} code={code} onLastSession={setLastSession} />
                    {basePrice > 0 && <IntradayFlow code={code} basePrice={basePrice} />}
                    <IntradayLevelsBar code={code} />
                    {late && <InvestorEstimate code={code} />}
                    <StockSummaryPanel code={code} onSelectStock={onSelectStock} />
                  </>
                ) : undefined
              }
            />
          </div>
        </div>
      </div>

      {/* 그룹을 고르고 담는다. 담기 전엔 별이 안 켜진다 */}
      {addTarget && <WatchAddSheet target={addTarget} onClose={() => setAddTarget(null)} />}
    </div>
  );
}
