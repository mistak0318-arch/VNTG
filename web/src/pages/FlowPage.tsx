import { useState } from "react";
import { EtfFlowPage } from "./EtfFlowPage";
import { ThemeFlowPage } from "./ThemeFlowPage";

/**
 * **테마·ETF 자금흐름** (2026-10-12) — 한 메뉴 안의 두 탭.
 *
 * 벤티지: "ETF 자금 흐름 자체를 테마/ETF 자금흐름으로 바꾸고 메뉴 안에 2개의 탭으로 구성.
 * 네이버 테마/ETF 이렇게 하고 각각 메뉴에 진입해서 테마흐름 ETF 흐름 볼 수 있게"
 *
 * 둘을 **한 메뉴에 둔 까닭**은 같은 물음에 답하기 때문이다 — 돈이 어디로 가나.
 * 다만 보는 창이 다르다. ETF 는 **실제로 담을 수 있는 그릇**이고(살 수 있다), 테마는
 * **더 촘촘한 지도**다(ETF 가 없는 테마도 보인다). 따로 두면 둘을 견주지 않게 되고,
 * 견주지 않으면 「ETF 로는 안 보이는 쏠림」을 영영 못 본다.
 *
 * 테마를 **먼저** 둔다. 넓은 쪽에서 좁은 쪽으로 가는 것이 읽는 차례다.
 */
export function FlowPage({ onSelectStock }: { onSelectStock: (code: string, name: string) => void }) {
  const [tab, setTab] = useState<"theme" | "etf">("theme");
  return (
    <div>
      <div className="ov-seg" style={{ padding: 0, marginBottom: 8, maxWidth: 280 }}>
        <button type="button" className={tab === "theme" ? "on" : ""} onClick={() => setTab("theme")}>
          네이버 테마
        </button>
        <button type="button" className={tab === "etf" ? "on" : ""} onClick={() => setTab("etf")}>
          ETF
        </button>
      </div>
      {tab === "theme" ? <ThemeFlowPage onSelectStock={onSelectStock} /> : <EtfFlowPage onSelectStock={onSelectStock} />}
    </div>
  );
}
