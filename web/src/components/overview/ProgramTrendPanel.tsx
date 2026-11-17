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
  /** 일별 추이 — **오래된 것이 앞**. 펼쳤을 때 그린다 */
  series: { day: string; nonArb: number; arb: number }[];
}

/**
 * **일별 추이** (2026-11-17 — 벤티지: "동향 볼 수 있게 그래프로도 표현해주면 안되나?
 * 시황카드들처럼 말야 클릭하면 차트도 나오고 동향도 나오고 일별로").
 *
 * 거래대금 카드(`TurnoverPanel`)와 **같은 꼴**로 그린다 — 줄을 누르면 아래로 펼쳐지는
 * 막대 그래프. 같은 화면의 카드가 저마다 다른 모양이면 읽는 법을 매번 새로 배워야 한다.
 *
 * ## 무엇을 그리나
 *
 *   막대   **비차익** 일별 순매수. 0 선 위아래로 갈린다 — 실제 자금의 방향
 *   선     **비차익 누적**. 하루치는 우연이라 「며칠째 어느 쪽인가」가 진짜 신호다
 *   회색   차익 — 참고로만 흐리게. 선물 가격차 정리라 방향성 베팅이 아니다
 *
 * 누적선은 **창 안에서만** 더한다(40일). 전체 누적이 아니라 「요즘 흐름」이다.
 *
 * 조회는 0회다 — 일자별 응답이 **이미 시계열 전체**를 준다. 위에서 최신 한 줄만 쓰고
 * 나머지를 버리고 있었을 뿐이다.
 */
function TrendChart({ rows }: { rows: { day: string; nonArb: number; arb: number }[] }) {
  const win = rows.slice(-40);
  if (win.length < 2) return <div className="empty">추이를 그릴 만큼 쌓이지 않았습니다.</div>;

  const W = 640;
  const H = 130;
  const PAD = { l: 4, r: 56, t: 10, b: 16 };
  /** 억 단위로 — 백만원을 그대로 그리면 눈금이 못 읽는 수가 된다 */
  const e = (v: number) => v / 100;
  const vals = win.flatMap((r) => [e(r.nonArb), e(r.arb)]);
  const span = Math.max(1, ...vals.map(Math.abs));
  const bw = (W - PAD.l - PAD.r) / win.length;
  /** 0 선을 가운데 두고 위아래로 */
  const mid = PAD.t + (H - PAD.t - PAD.b) / 2;
  const yOf = (v: number) => mid - ((H - PAD.t - PAD.b) / 2) * (v / span);

  /* 누적 — 창 안에서만. 오른쪽 축은 따로 잰다(일별과 자릿수가 다르다) */
  let acc = 0;
  const cum = win.map((r) => {
    acc += e(r.nonArb);
    return acc;
  });
  const cSpan = Math.max(1, ...cum.map(Math.abs));
  const cY = (v: number) => mid - ((H - PAD.t - PAD.b) / 2) * (v / cSpan);
  const path = cum.map((v, i) => `${i === 0 ? "M" : "L"}${PAD.l + i * bw + bw / 2},${cY(v)}`).join(" ");
  const n0 = (v: number) => `${v > 0 ? "+" : ""}${Math.round(v).toLocaleString("ko-KR")}`;

  return (
    <div className="to-chart">
      <svg viewBox={`0 0 ${W} ${H}`} role="img">
        {/* 0 선 — 이 그래프에서 제일 중요한 선이다. 위아래가 곧 뜻이다 */}
        <line className="tc-grid" x1={PAD.l} x2={W - PAD.r} y1={mid} y2={mid} />
        <text className="tc-tick" x={W - PAD.r + 4} y={yOf(span) + 3}>
          {n0(span)}억
        </text>
        <text className="tc-tick" x={W - PAD.r + 4} y={mid + 3}>
          0
        </text>
        <text className="tc-tick" x={W - PAD.r + 4} y={yOf(-span) + 3}>
          {n0(-span)}억
        </text>
        {win.map((r, i) => {
          const v = e(r.nonArb);
          const a = e(r.arb);
          const x = PAD.l + i * bw;
          return (
            <g key={r.day}>
              {/* 차익은 뒤에 흐리게 — 참고일 뿐이라 비차익을 가리면 안 된다 */}
              <rect
                className="pgt-arb"
                x={x + bw * 0.1}
                y={Math.min(mid, yOf(a))}
                width={bw * 0.8}
                height={Math.max(0.5, Math.abs(mid - yOf(a)))}
              />
              <rect
                className={`pgt-bar ${v >= 0 ? "up" : "down"}${i === win.length - 1 ? " today" : ""}`}
                x={x + bw * 0.25}
                y={Math.min(mid, yOf(v))}
                width={bw * 0.5}
                height={Math.max(1, Math.abs(mid - yOf(v)))}
              >
                <title>
                  {r.day.slice(4, 6)}/{r.day.slice(6, 8)} · 비차익 {n0(v)}억 · 차익 {n0(a)}억
                </title>
              </rect>
            </g>
          );
        })}
        <path className="pgt-cum" d={path} />
        {/* 달 경계 — 거래대금 차트와 같은 눈금 */}
        {win.map((r, i) =>
          i > 0 && r.day.slice(4, 6) !== win[i - 1].day.slice(4, 6) ? (
            <text key={`m${r.day}`} className="tc-tick" x={PAD.l + i * bw} y={H - 4}>
              {Number(r.day.slice(4, 6))}월
            </text>
          ) : null,
        )}
      </svg>
      <div className="pulse-foot pt-n">
        막대 = <b>비차익</b> 일별(0 선 위아래) · 흐린 막대 = 차익 · 선 = 비차익 <b>{win.length}일 누적</b>.
        누적이 꾸준히 오르면 실제 자금이 들어오는 중입니다. 막대에 손을 올리면 그날 값이 나옵니다.
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
  /** 펼친 시장 — 한 번에 하나만. 둘 다 펼치면 카드가 요약이 아니게 된다 */
  const [open, setOpen] = useState<Market | null>(null);
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
          {/* 누르면 추이가 펼쳐진다 — 거래대금 카드와 같은 조작 (2026-11-17) */}
          <button
            type="button"
            className="pgt-head"
            onClick={() => setOpen(open === s.market ? null : s.market)}
            title="누르면 일별 추이가 펼쳐집니다"
          >
            <i className="sf-caret">{open === s.market ? "▾" : "▸"}</i>
            <b>{s.label}</b>
            <span className="pt-n">{s.at}</span>
          </button>
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
          {open === s.market && <TrendChart rows={s.series} />}
        </div>
      ))}
      <div className="pulse-foot pt-n">
        단위 억 · <b>비차익</b>이 실제 자금 유입이고 차익은 선물과의 가격차 정리입니다 — 선물 만기 주간(분기 마지막
        목요일 부근)엔 차익이 왜곡되니 비차익만 보세요. 시간대별·종목별은 「프로그램 매매」 메뉴에.
      </div>
    </div>
  );
}
