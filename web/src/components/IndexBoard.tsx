import { useState } from "react";
import { type IndexCard, type MarketFlow } from "../api";
import { useSection } from "../useSection";
import {
  DomesticIndexGrid,
  UpDownTable,
  useFutFlow,
} from "./overview/DomesticIndexGrid";
import { FuturesDetailSheet, type FuturesDetailTarget } from "./overview/FuturesDetailSheet";
import { IndexDetailSheet } from "./overview/IndexDetailSheet";
import { TurnoverPanel } from "./overview/TurnoverPanel";

/**
 * 지수판 — **HTS [0200] 시장종합 자리.**
 *
 * (2026-08-26) 시황 대시보드의 세 카드 — **국내 지수 · 종목등락현황 · 거래대금
 * 현황** — 를 한 판에 **옆으로 쭉 붙인 것**으로 바꿨다(사용자 지정: "일자로 쭉").
 * 본문은 시황과 같은 컴포넌트(DomesticIndexGrid·UpDownTable·TurnoverPanel)를
 * 그대로 쓴다 — 같은 값을 두 번 그리면 언젠가 반드시 갈라진다.
 *
 * 예전엔 여기 전용의 작은 타일 + 환율·미국 지수선물 줄이 있었는데, 그건 시황
 * 카드와 모양이 달라 두 벌 관리가 됐고 수급도 없었다. 환율·글로벌은 시황의
 * 글로벌 카드와 브리핑 온도계가 이미 맡고 있다.
 *
 * ## 종목과 무관하다 — 보드에서 종목을 바꿔도 이 칸은 안 바뀐다.
 * ## 새로 받는 게 없다 — 시황이 이미 받는 `indices`·`flow` 섹션 그대로다.
 * ## 눌러서 상세 — 코스피·코스닥·선물 타일은 시황과 같은 시트가 열린다.
 */
export function IndexBoard() {
  const indices = useSection<IndexCard[]>("indices", 5_000);
  const flow = useSection<MarketFlow>("flow", 20_000);
  const futFlow = useFutFlow();
  const [indexDetail, setIndexDetail] = useState<string | null>(null);
  const [futDetail, setFutDetail] = useState<FuturesDetailTarget | null>(null);

  const idx = indices.data ?? [];
  if (idx.length === 0) return <div className="empty">불러오는 중…</div>;

  const kospiCard = idx.find((i) => i.code === "001");
  const kosdaqCard = idx.find((i) => i.code === "101");

  return (
    <div className="ib">
      {/* 시황의 세 카드를 한 줄로 — 좁아지면 CSS 가 아래로 접는다 */}
      <div className="ib-row3">
        <div className="ib-sec ib-sec-idx">
          <div className="ib-sec-t">국내 지수</div>
          <DomesticIndexGrid
            idx={idx}
            flow={flow.data}
            futFlow={futFlow}
            onOpenIndex={setIndexDetail}
            onOpenFutures={setFutDetail}
          />
        </div>
        <div className="ib-sec">
          <div className="ib-sec-t">종목등락현황</div>
          <UpDownTable cards={[kospiCard, kosdaqCard]} />
        </div>
        <div className="ib-sec">
          <div className="ib-sec-t">거래대금 현황</div>
          <TurnoverPanel />
        </div>
      </div>

      {indexDetail && <IndexDetailSheet code={indexDetail} onClose={() => setIndexDetail(null)} />}
      {futDetail && <FuturesDetailSheet target={futDetail} onClose={() => setFutDetail(null)} />}
    </div>
  );
}
