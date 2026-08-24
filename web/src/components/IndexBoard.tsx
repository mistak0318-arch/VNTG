import { useState } from "react";
import { fmtNum, type GlobalQuote, type IndexCard } from "../api";
import { useSection } from "../useSection";
import { IndexDetailSheet } from "./overview/IndexDetailSheet";
import { Sparkline } from "./overview/Sparkline";

/**
 * 지수판 — **HTS [0200] 시장종합 자리.**
 *
 * ## 왜 한 판에 모으나
 *
 * 시황 대시보드는 지수·환율·선물이 카드마다 흩어져 있어서, 「지금 판이 어떤가」를
 * 알려면 화면을 굴리며 세 군데를 봐야 한다. HTS 1번 모니터가 저 목록을 **한 판에
 * 붙여 두는** 이유가 그것이다 — 개별 값이 아니라 **동시에 보는 것**이 정보다.
 *
 * 코스피가 오르는데 환율도 오르면 외국인이 파는 중일 수 있고, 선물이 현물보다 세면
 * 프로그램이 들어오는 자리다. 그 판단은 **나란히 놓아야** 나온다.
 *
 * ## 종목과 무관하다
 *
 * 보드에서 종목을 바꿔도 이 칸은 안 바뀐다. 시장 신호등·VI 와 같은 층이다.
 *
 * ## 새로 받는 게 없다
 *
 * 시황이 이미 받는 `indices`·`global` 섹션 그대로다. 같은 값을 두 번 부르지 않는다.
 *
 * ## 눌러서 일봉
 *
 * 코스피·코스닥 칸은 누르면 일·주·월봉과 일별 수급이 열린다. 시황 대시보드가 쓰던
 * 시트를 그대로 쓴다 — 같은 것을 두 번 만들면 언젠가 갈라진다.
 *
 * 그림이 여기 있는데 정작 「그래서 며칠째 이러는 건가」를 물으면 다른 화면으로 가야
 * 했다. 판을 보다가 뭔가 눈에 걸렸을 때 **그 자리에서** 파고들 수 있어야 판이다.
 */

function pct(v: number | null | undefined): string {
  if (v === null || v === undefined || !Number.isFinite(v)) return "-";
  return `${v > 0 ? "+" : ""}${v.toFixed(2)}%`;
}

function cls(v: number | null | undefined): string {
  if (v === null || v === undefined || !Number.isFinite(v) || v === 0) return "";
  return v > 0 ? "positive" : "negative";
}

export function IndexBoard() {
  const indices = useSection<IndexCard[]>("indices", 5_000);
  const global = useSection<GlobalQuote[]>("global", 15_000);
  const [detail, setDetail] = useState<string | null>(null);

  const kr = indices.data ?? [];
  const gl = global.data ?? [];

  if (kr.length === 0 && gl.length === 0) return <div className="empty">불러오는 중…</div>;

  /*
   * 글로벌은 묶음별로 나눈다. 환율과 미국 지수선물을 한 줄에 섞으면
   * 단위가 달라 읽는 눈이 매번 다시 맞춰야 한다.
   */
  const groups = new Map<string, GlobalQuote[]>();
  for (const g of gl) {
    if (!g.label) continue;
    const arr = groups.get(g.group) ?? [];
    arr.push(g);
    groups.set(g.group, arr);
  }

  return (
    <div className="ib">
      {/* 국내 지수는 그림까지 — 오늘 어떻게 왔는지가 값보다 먼저 읽힌다 */}
      <div className="ib-grid">
        {kr.map((c) => {
          /*
            코스피·코스닥만 상세가 있다. 코스피200·선물은 아직 없으므로 누르는 시늉을
            하지 않는다 — 눌러도 아무 일이 없으면 고장으로 읽힌다.
          */
          const openable = c.code === "001" || c.code === "101";
          const Cell = openable ? "button" : "div";
          return (
            <Cell
              className={`ib-cell${openable ? " clickable" : ""}`}
              key={c.name}
              onClick={openable ? () => setDetail(c.code) : undefined}
              title={openable ? `${c.name} — 눌러서 일·주·월봉과 일별 수급` : undefined}
            >
              <div className="ib-nm">
                {c.name}
                {openable && <span className="ib-more">›</span>}
              </div>
              <div className={`ib-v num ${cls(c.changeRate)}`}>{fmtNum(c.price)}</div>
              <div className={`ib-r num ${cls(c.changeRate)}`}>
                {c.change > 0 ? "+" : ""}
                {fmtNum(c.change)} {pct(c.changeRate)}
              </div>
              {c.sparkline && c.sparkline.length > 1 && (
                <Sparkline values={c.sparkline} up={c.changeRate >= 0} />
              )}
            </Cell>
          );
        })}
      </div>

      {[...groups.entries()].map(([name, rows]) => (
        <div className="ib-group" key={name}>
          <div className="ib-group-nm">{name}</div>
          <div className="ib-rows">
            {rows.map((g) => (
              <div className="ib-row" key={g.key}>
                <span className="ib-row-nm">{g.label}</span>
                <span className="ib-row-v num">{fmtNum(g.price)}</span>
                <span className={`ib-row-r num ${cls(g.changeRate)}`}>{pct(g.changeRate)}</span>
              </div>
            ))}
          </div>
        </div>
      ))}

      <div className="table-note">
        개별 값이 아니라 <b>같이 보는 것</b>이 정보입니다 — 코스피가 오르는데 환율도 오르면
        외국인이 파는 중일 수 있고, 선물이 현물보다 세면 프로그램이 들어오는 자리입니다.
        <b> 코스피·코스닥은 눌러서</b> 일·주·월봉과 일별 수급을 봅니다.
      </div>

      {detail && <IndexDetailSheet code={detail} onClose={() => setDetail(null)} />}
    </div>
  );
}
