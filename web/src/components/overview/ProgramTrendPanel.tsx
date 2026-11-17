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
  /** 일별 추이 — **오래된 것이 앞**. 접지 않고 바로 그린다 */
  series: { day: string; nonArb: number; arb: number }[];
}

/**
 * **일별 추이** (2026-11-17 — 벤티지: "동향 볼 수 있게 그래프로도 표현해주면 안되나?").
 *
 * ## 처음 그린 것은 못 읽는 그림이었다
 *
 * 처음엔 거래대금 카드를 본떠 **한 그림에 셋**을 넣었다 — 일별 비차익 막대 · 흐린 차익
 * 막대 · 누적선. 폰에서 보니(벤티지 캡처) **셋 다 못 읽었다.**
 *
 *   · 눈금을 **큰 날 하나가 정했다.** ±27,011억이 되니 나머지 열아홉 날이 다 뭉갰다
 *   · 같은 자에 **일별과 누적**을 같이 얹었다. 자릿수가 다른 둘을 한 자로 재면 하나는
 *     납작해진다 — 여기서는 누적선이 거의 수평선이 됐다
 *   · 차익 막대가 뒤에 깔려 비차익을 가렸다. 그 값은 **이미 위 숫자 칸에 있다**
 *
 * ## 다시 — 자를 둘로 나누고, 한 그림에 하나씩
 *
 *   위(영역)   비차익 **20일 누적**. 0 선을 반드시 품는다 — 「0 위냐 아래냐」가 뜻이다.
 *              0 아래면 그동안 판 쪽이고, 선이 꺾여 오르면 사기 시작한 것이다
 *   아래(띠)   **일별** 비차익. 자가 따로라 큰 날이 있어도 위 흐름이 안 뭉개진다
 *
 * 차익은 그림에서 뺐다 — 참고 값은 위 숫자 칸으로 충분하고, 작은 화면에서 선 하나를
 * 더 그리는 값은 늘 **읽기 어려워지는 쪽**이었다.
 *
 * 눈금도 **끝 값 하나와 0 만** 적는다. 중간 눈금은 폰에서 읽히지도 않으면서 자리만 먹는다.
 *
 * 20일인 까닭은 폰 폭에서 **막대가 손가락만 해지는 수**가 그쯤이기 때문이다(40일은 실
 * 선처럼 보였다).
 *
 * **펼치지 않고 바로 보인다** (벤티지: "그냥 클릭말고 바로 보여주고"). 조회는 0회라
 * 접어 둘 이유가 애초에 없었다 — 일자별 응답이 이미 시계열 전체를 준다.
 */function TrendChart({ rows }: { rows: { day: string; nonArb: number; arb: number }[] }) {
  const win = rows.slice(-20);
  if (win.length < 2) return <div className="empty">추이를 그릴 만큼 쌓이지 않았습니다.</div>;

  /** 억 단위로 — 백만원을 그대로 그리면 눈금이 못 읽는 수가 된다 */
  const e = (v: number) => v / 100;
  /* 창 안에서만 더한다 — 전체 누적이 아니라 「요즘 흐름」이다 */
  let acc = 0;
  const cum = win.map((r) => {
    acc += e(r.nonArb);
    return acc;
  });

  const W = 320;
  const AH = 86; // 누적 영역
  const BH = 26; // 일별 띠
  const GAP = 8;
  const H = AH + GAP + BH + 12;
  const PAD = { l: 2, r: 44 };
  const iw = W - PAD.l - PAD.r;
  const bw = iw / win.length;

  /* ── 누적 — 0 을 반드시 품는다. 안 그러면 「0 위냐 아래냐」가 안 보인다 ── */
  const cHi = Math.max(0, ...cum);
  const cLo = Math.min(0, ...cum);
  const cSpan = Math.max(1, cHi - cLo);
  const cY = (v: number) => 2 + (AH - 4) * (1 - (v - cLo) / cSpan);
  const zero = cY(0);
  const pts = cum.map((v, i) => `${PAD.l + i * bw + bw / 2},${cY(v)}`);
  const line = `M${pts.join(" L")}`;
  const area = `M${PAD.l + bw / 2},${zero} L${pts.join(" L")} L${PAD.l + (win.length - 1) * bw + bw / 2},${zero} Z`;
  const last = cum[cum.length - 1];

  /* ── 일별 띠 — 누적과 **자를 따로 쓴다.** 큰 날 하나가 눈금을 정해도 누적은 안 뭉개진다 ── */
  const dTop = AH + GAP;
  const dSpan = Math.max(1, ...win.map((r) => Math.abs(e(r.nonArb))));
  const dMid = dTop + BH / 2;
  const dY = (v: number) => dMid - (BH / 2 - 1) * (v / dSpan);

  const n0 = (v: number) => `${v > 0 ? "+" : ""}${Math.round(v).toLocaleString("ko-KR")}`;
  /** 오른쪽 글자가 위아래로 안 잘리게 — 글자 기준선은 글자 높이만큼 안쪽에 있어야 한다 */
  const clampY = (y: number) => Math.min(AH - 2, Math.max(9, y + 3));

  return (
    <div className="pgt-chart">
      <svg viewBox={`0 0 ${W} ${H}`} role="img" preserveAspectRatio="none">
        {/* 누적 0 선 — 이 그림에서 제일 중요한 선이다. 위아래가 곧 뜻이다 */}
        <line className="tc-grid" x1={PAD.l} x2={W - PAD.r} y1={zero} y2={zero} />
        <path className={`pgt-area ${last >= 0 ? "up" : "down"}`} d={area} />
        <path className={`pgt-cum ${last >= 0 ? "up" : "down"}`} d={line} />
        {/*
          끝 값과 0 만 적는다 — 중간 눈금은 작은 화면에서 읽히지도 않으면서 자리만 먹는다.
          **글자를 그림 안쪽으로 물린다**: 누적이 내내 0 아래면 0 선이 맨 위에 붙어 글자가
          위로 잘렸다(폰 실측). 선이 아니라 글자만 물리므로 가리키는 자리는 안 틀어진다.
        */}
        <text className="pgt-end" x={W - PAD.r + 4} y={clampY(cY(last))}>
          {n0(last)}억
        </text>
        <text className="tc-tick" x={W - PAD.r + 4} y={clampY(zero)}>
          0
        </text>

        {/* 일별 띠 */}
        <line className="tc-grid" x1={PAD.l} x2={W - PAD.r} y1={dMid} y2={dMid} />
        {win.map((r, i) => {
          const v = e(r.nonArb);
          return (
            <rect
              key={r.day}
              className={`pgt-bar ${v >= 0 ? "up" : "down"}${i === win.length - 1 ? " today" : ""}`}
              x={PAD.l + i * bw + bw * 0.22}
              y={Math.min(dMid, dY(v))}
              width={bw * 0.56}
              height={Math.max(1, Math.abs(dMid - dY(v)))}
            >
              <title>
                {r.day.slice(4, 6)}/{r.day.slice(6, 8)} · 비차익 {n0(v)}억 · 차익 {n0(e(r.arb))}억
              </title>
            </rect>
          );
        })}
        <text className="tc-tick" x={PAD.l} y={H - 2}>
          {win[0].day.slice(4, 6)}/{win[0].day.slice(6, 8)}
        </text>
        <text className="tc-tick" x={W - PAD.r + 4} y={H - 2}>
          오늘
        </text>
      </svg>
      <div className="pulse-foot pt-n">
        위 = 비차익 <b>{win.length}일 누적</b>(0 아래면 그동안 판 쪽) · 아래 = 일별.
        <b>자를 따로 씁니다</b> — 큰 날 하나가 눈금을 정해도 누적 흐름이 안 뭉개지게.
      </div>
    </div>
  );
}

export function ProgramTrendPanel() {
  const [sides, setSides] = useState<Side[]>([]);
  const [err, setErr] = useState<string | null>(null);
  /*
   * **한 번이라도 받아 봤나** (2026-11-17) — 처음엔 이 칸이 없었다.
   *
   * 그래서 응답이 **비어 있으면** `sides` 가 빈 채로 남고 화면은 영영 「불러오는 중…」
   * 이었다. 벤티지가 "프로그램 수급 현황 어디다 넣은거야? 안보이네" 라고 한 자리가 여기다 —
   * **카드는 있는데 아무 말도 안 하니 없는 것과 똑같았다.** 「아직 안 받음」과 「받았는데
   * 없음」은 다른 말이고, 화면이 그 둘을 가려야 한다.
   */
  const [tried, setTried] = useState(false);
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
              /* 일자별은 최신이 앞 — 그래프는 왼쪽이 과거라 뒤집는다 */
              series: [...rows]
                .slice(0, 60)
                .reverse()
                .map((r: ProgramRow) => ({
                  day: r.time.length >= 8 ? r.time.slice(0, 8) : r.time,
                  nonArb: net(r.nonArbNet, r.nonArbBuy, r.nonArbSell),
                  arb: net(r.arbNet, r.arbBuy, r.arbSell),
                })),
            };
            return side;
          }),
        );
        if (!alive) return;
        setSides(got.filter((s): s is Side => s !== null));
        setErr(null);
      } catch (e) {
        if (alive) setErr(e instanceof Error ? e.message : "못 받음");
      } finally {
        if (alive) setTried(true);
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
  if (sides.length === 0) {
    /* 받아 봤는데 비었으면 **그렇게 적는다** — 「불러오는 중」으로 두면 고장과 구별이 안 된다 */
    return tried ? (
      <div className="empty">
        프로그램 매매 자료가 비어 있습니다 — 키움 일자별(ka90010)이 빈 응답을 줬습니다. 장중이면
        잠시 뒤 다시 차고, 계속 비면 「프로그램 매매」 메뉴에서도 같은지 보세요.
      </div>
    ) : (
      <div className="empty">불러오는 중…</div>
    );
  }

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
          <TrendChart rows={s.series} />
        </div>
      ))}
      <div className="pulse-foot pt-n">
        단위 억 · <b>비차익</b>이 실제 자금 유입이고 차익은 선물과의 가격차 정리입니다 — 선물 만기 주간(분기 마지막
        목요일 부근)엔 차익이 왜곡되니 비차익만 보세요. 시간대별·종목별은 「프로그램 매매」 메뉴에.
      </div>
    </div>
  );
}
