import { fmtNum, type GlobalQuote, type IndexCard } from "../api";
import { useSection } from "../useSection";
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
        {kr.map((c) => (
          <div className="ib-cell" key={c.name}>
            <div className="ib-nm">{c.name}</div>
            <div className={`ib-v num ${cls(c.changeRate)}`}>{fmtNum(c.price)}</div>
            <div className={`ib-r num ${cls(c.changeRate)}`}>{pct(c.changeRate)}</div>
            {c.sparkline && c.sparkline.length > 1 && (
              <Sparkline values={c.sparkline} up={c.changeRate >= 0} />
            )}
          </div>
        ))}
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
      </div>
    </div>
  );
}
