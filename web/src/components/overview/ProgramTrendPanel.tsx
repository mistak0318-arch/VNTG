import { useEffect, useState } from "react";
import { api, type ProgramRow } from "../../api";
import { useTabActive } from "../../tabActive";

/**
 * **프로그램 동향 — 차익 / 비차익** (2026-11-17).
 *
 * 벤티지: "시황대시보드에 프로그램 동향 없어졌네? 차익거래 비차익거래 이렇게 표시하던게 잇엇잖아"
 *
 * ## 왜 돌려놓나 — 대시보드에 있던 것은 **종목별**이었다
 *
 * 지금 「주도주·급소」 카드에 「프로그램 매수/매도」가 있지만 그건 **종목 순위**다. 「돈의 흐름 ▸ 지금」
 * 의 「프로그램 30분」은 **합계 하나**뿐이다. 둘 다 벤티지가 찾던 것이 아니다 — 차익과 비차익을
 * **가른** 시장 전체 수급은 「프로그램 매매」 메뉴에만 있었다.
 *
 * ## 가르는 것이 요점이다
 *
 * **차익거래**는 선물·현물 가격차를 먹는 기계적 거래라 방향성 베팅이 아니다. 만기 주간엔 청산 때문에
 * 크게 출렁인다. **비차익거래**가 「한국 주식 비중을 늘리자/줄이자」는 실제 결정이다. 그래서 합계만
 * 보면 **차익의 잡음이 비차익의 신호를 덮는다** — 가르지 않으면 볼 뜻이 없다.
 *
 * ## 셈과 단위
 *
 * `amt_qty_tp=1` 이라 **백만원**이다. 억으로 고쳐 적는다(÷100).
 *
 * ⚠️ **순매수 칸이 0 으로 오는 날이 있다** — `ka90005` 가 그랬다(2026-09-17 실측). 매수·매도는
 * 들어오므로 순매수가 0 이면 **매수−매도**로 낸다(`moneyNow.ts` 와 같은 수법). 셋 다 0 이면 그건
 * 정말 0 이라 그대로 적는다.
 *
 * 일자별(`ka90010`)을 쓴다 — 장 전에도 **직전 거래일** 값이 있다. 시간대별은 장중에만 찬다.
 */

type Market = "kospi" | "kosdaq";
const MARKETS: { key: Market; label: string }[] = [
  { key: "kospi", label: "코스피" },
  { key: "kosdaq", label: "코스닥" },
];

/** 순매수 — 0 으로 오면 매수−매도로 (위 주석) */
function net(n: number, buy: number, sell: number): number {
  return n !== 0 ? n : buy - sell;
}

/** 백만원 → 억, 부호 붙여서 */
function eok(v: number): string {
  const e = v / 100;
  const s = Math.abs(e) >= 1000 ? Math.round(e).toLocaleString("ko-KR") : (Math.round(e * 10) / 10).toLocaleString("ko-KR");
  return `${e > 0 ? "+" : ""}${s}`;
}

function cls(v: number): string {
  return v > 0 ? "positive" : v < 0 ? "negative" : "";
}

/** YYYYMMDDHHmmss → 11/17 */
function day(t: string): string {
  return t.length >= 8 ? `${t.slice(4, 6)}/${t.slice(6, 8)}` : t;
}

interface Side {
  market: Market;
  label: string;
  /** 최신 거래일 */
  at: string;
  arb: number;
  nonArb: number;
  all: number;
  /** 비차익 5일 누적 — 하루치는 우연이다 */
  nonArb5: number;
  days5: number;
}

export function ProgramTrendPanel() {
  const [sides, setSides] = useState<Side[]>([]);
  const [err, setErr] = useState<string | null>(null);
  /* 숨은 탭에서는 안 돈다 — 카드마다 지켜야 하는 규칙이다(2026-09-23 전수검토) */
  const tabActive = useTabActive();

  useEffect(() => {
    if (!tabActive) return;
    let alive = true;
    const load = async () => {
      try {
        const got = await Promise.all(
          MARKETS.map(async (m) => {
            const res = await api.programTrades(m.key, "daily");
            /*
             * 일자별은 **최신이 앞**이다. 값이 통째로 0 인 날(휴장·집계 전)은 건너뛰고
             * 처음으로 숫자가 있는 날을 「오늘」로 삼는다 — 장 전에는 직전 거래일이 된다.
             */
            const rows = res.items.filter((r: ProgramRow) => r.allBuy !== 0 || r.allSell !== 0 || r.nonArbBuy !== 0);
            if (rows.length === 0) return null;
            const r0 = rows[0];
            const five = rows.slice(0, 5);
            const side: Side = {
              market: m.key,
              label: m.label,
              at: day(r0.time),
              arb: net(r0.arbNet, r0.arbBuy, r0.arbSell),
              nonArb: net(r0.nonArbNet, r0.nonArbBuy, r0.nonArbSell),
              all: net(r0.allNet, r0.allBuy, r0.allSell),
              nonArb5: five.reduce((a, r) => a + net(r.nonArbNet, r.nonArbBuy, r.nonArbSell), 0),
              days5: five.length,
            };
            return side;
          }),
        );
        if (!alive) return;
        setSides(got.filter((s): s is Side => s !== null));
        setErr(null);
      } catch (e) {
        if (alive) setErr(e instanceof Error ? e.message : "못 받음");
      }
    };
    void load();
    /* 일자별이라 장중에도 분 단위로 바뀌지 않는다 — 2분이면 충분하다(서버 캐시 1분) */
    const t = setInterval(() => void load(), 120_000);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, [tabActive]);

  if (err && sides.length === 0) return <div className="error-banner">{err}</div>;
  if (sides.length === 0) return <div className="empty">불러오는 중…</div>;

  return (
    <div className="pgt">
      {sides.map((s) => (
        <div className="pgt-row" key={s.market}>
          <div className="pgt-head">
            <b>{s.label}</b>
            <span className="pt-n">{s.at}</span>
          </div>
          <div className="pgt-nums">
            <div className="pgt-cell" title="선물과 무관하게 주식 바스켓 자체를 사고판 것 — 실제 자금의 방향">
              <span className="pgt-k">비차익</span>
              <span className={`pgt-v num ${cls(s.nonArb)}`}>{eok(s.nonArb)}</span>
            </div>
            <div className="pgt-cell" title="선물·현물 가격차를 먹는 기계적 거래 — 방향성 베팅이 아니다">
              <span className="pgt-k">차익</span>
              <span className={`pgt-v num ${cls(s.arb)}`}>{eok(s.arb)}</span>
            </div>
            <div className="pgt-cell">
              <span className="pgt-k">합계</span>
              <span className={`pgt-v num ${cls(s.all)}`}>{eok(s.all)}</span>
            </div>
            <div className="pgt-cell" title={`최근 ${s.days5}거래일 비차익 순매수 합 — 하루치는 우연일 수 있다`}>
              <span className="pgt-k">비차익 {s.days5}일</span>
              <span className={`pgt-v num ${cls(s.nonArb5)}`}>{eok(s.nonArb5)}</span>
            </div>
          </div>
        </div>
      ))}
      <div className="pulse-foot pt-n">
        단위 억 · <b>비차익</b>이 실제 자금 유입이고 차익은 선물과의 가격차 정리입니다 — 선물 만기 주간(분기 마지막
        목요일 부근)엔 차익이 왜곡되니 비차익만 보세요. 시간대별·종목별은 「프로그램 매매」 메뉴에.
      </div>
    </div>
  );
}
