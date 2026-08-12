import { fmtNum, type InvestorFlow } from "../../api";

interface FlowItem {
  label: string;
  value: number;
  sub?: boolean;
}

function buildItems(flow: InvestorFlow): FlowItem[] {
  return [
    { label: "개인", value: flow.individual },
    { label: "외국인", value: flow.foreign },
    { label: "기관 합계", value: flow.institution },
    { label: "금융투자", value: flow.financialInvestment, sub: true },
    { label: "투신", value: flow.investmentTrust, sub: true },
    { label: "연기금", value: flow.pensionFund, sub: true },
    { label: "사모펀드", value: flow.privateFund, sub: true },
    { label: "보험", value: flow.insurance, sub: true },
    { label: "은행", value: flow.bank, sub: true },
    { label: "기타법인", value: flow.otherCorp },
  ];
}

/** 중앙 기준 좌우 막대 — 매수는 오른쪽(빨강), 매도는 왼쪽(파랑) */
export function FlowBars({ flow }: { flow: InvestorFlow }) {
  const items = buildItems(flow);
  // 막대 길이는 항목 중 최대 절댓값 기준으로 정규화 (최대 50% = 중앙에서 끝까지)
  const maxAbs = Math.max(...items.map((i) => Math.abs(i.value)), 1);

  return (
    <div className="ov-card-b">
      {items.map((item, idx) => {
        const positive = item.value > 0;
        const width = (Math.abs(item.value) / maxAbs) * 50;
        const isGroupStart = item.label === "기관 합계" || item.label === "기타법인";
        return (
          <div key={item.label}>
            {isGroupStart && idx > 0 && <div className="ov-grp-line" />}
            <div className="ov-flow-row">
              <span className={`ov-flow-nm${item.sub ? " sub" : ""}`}>{item.label}</span>
              <span className="ov-bar">
                <span className="ov-bar-mid" />
                <i
                  style={{
                    background: positive ? "var(--up)" : "var(--down)",
                    opacity: item.sub ? 0.65 : 1,
                    ...(positive ? { left: "50%" } : { right: "50%" }),
                    width: `${width}%`,
                  }}
                />
              </span>
              <span className={`ov-flow-val num ${positive ? "up" : item.value < 0 ? "down" : "flat"}`}>
                {item.value > 0 ? "+" : ""}
                {fmtNum(item.value)}
              </span>
            </div>
          </div>
        );
      })}
    </div>
  );
}
