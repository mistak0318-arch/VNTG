import { useEffect, useState } from "react";
import { api, signClass, type EtfFlowRow, type EtfListRow, type EtfSentimentSide, type UsEtfRow } from "../../api";
import { YahooChartSheet, type ChartTarget } from "./YahooChartSheet";
import { useCardRefresh } from "./OverviewCard";

/**
 * **돈의 방향 — 한미 ETF** (2026-09-17, 벤티지: "어젯밤 미국 ↔ 국내 테마 짝이 안 맞는다, 효용이 없다.
 * 어제 만든 해외·국내 ETF 메뉴에서 인사이트 될 만한 걸 시황에").
 *
 * 「어젯밤 미국 → 국내 테마」(themeBridge)를 갈아끼운 카드다. 그 다리는 *이름*으로 잇는 것이라 얇았다 —
 * 네이버 테마 300개 ↔ 미국 업종 하나, 미국 업종 하루 등락은 종목 몇 개에 흔들린다. 여기는 **돈이 실제로 오간
 * 자리끼리** 잇는다: 미국 섹터 ETF(SMH·XLK…) ↔ 국내 대표 ETF(KODEX 반도체…), 등락이 아니라 **거래대금 배수**
 * (돈이 몰리나)를 같이 본다.
 *
 * 네 줄: ① 심리 한 줄(인버스÷레버리지) ② 두 열(어젯밤 미국 섹터 · 오늘 국내 테마, 상·하위 셋) ③ 같이 가는 짝
 * ④ 20일 최고·최저 + 국내 ETF 순위 튀는 것 칩. 재료는 전부 ETF 메뉴 넷의 API(캐시) — 새 조회 없다.
 * 신호등 점수엔 안 들어간다.
 */
const PAIRS: { us: string; kr: string }[] = [
  { us: "SMH", kr: "반도체" },
  { us: "XLK", kr: "소프트웨어·AI" },
  { us: "XLF", kr: "은행" },
  { us: "XLE", kr: "원유" },
  { us: "XLV", kr: "바이오" },
  { us: "XLY", kr: "자동차" },
  { us: "XLB", kr: "화학" },
  { us: "XLU", kr: "원전·전력" },
  { us: "XLI", kr: "조선" },
  { us: "XLRE", kr: "리츠" },
  { us: "GLD", kr: "금" },
  { us: "TLT", kr: "미국 장기채" },
  { us: "UUP", kr: "달러" },
  { us: "QQQ", kr: "나스닥100" },
];

const pct = (v: number | null) => (v === null ? "–" : `${v > 0 ? "+" : ""}${v.toFixed(1)}%`);
const mult = (v: number | null) => (v === null ? "" : `${v.toFixed(1)}배`);

function verdictOf(s: EtfSentimentSide): { t: string; c: string } {
  const cur = s.today ?? s.days[s.days.length - 1];
  if (!cur || cur.ratio === null || s.avg20 === null) return { t: "–", c: "" };
  const x = cur.ratio / s.avg20;
  if (x >= 1.4) return { t: "하락 베팅 과열", c: "up" };
  if (x <= 0.65) return { t: "상승 추격 과열", c: "down" };
  return { t: "평소 범위", c: "" };
}

export function MoneyFlowPanel({ onSelectStock }: { onSelectStock: (code: string, name: string) => void }) {
  const [us, setUs] = useState<UsEtfRow[] | null>(null);
  const [kr, setKr] = useState<EtfFlowRow[] | null>(null);
  const [krAsOf, setKrAsOf] = useState<"오늘" | "어제">("오늘");
  const [sides, setSides] = useState<EtfSentimentSide[] | null>(null);
  const [list, setList] = useState<EtfListRow[] | null>(null);
  const [errors, setErrors] = useState<string[]>([]);
  const [chart, setChart] = useState<ChartTarget | null>(null);
  /** 네 조합(미국 ETF·국내 ETF·심리·순위)을 마지막으로 받은 시각 — 서버는 5분 캐시라 값은 그보다 옛것일 수 있다 */
  const [pulledAt, setPulledAt] = useState<number | null>(null);

  /* 카드 ↻ 로 다시 마운트됐으면(세대 > 0) 첫 조회는 서버 캐시를 건너뛴다 — 주기 갱신은 캐시 그대로 */
  const gen = useCardRefresh();
  useEffect(() => {
    let alive = true;
    let first = true;
    const pull = () => {
      const fresh = gen > 0 && first;
      first = false;
      const errs: string[] = [];
      void Promise.all([
        api.usEtfFlow(fresh).then((r) => alive && setUs(r.rows)).catch(() => errs.push("미국 ETF")),
        api.etfFlow(fresh).then((r) => alive && (setKr(r.rows), setKrAsOf(r.asOf))).catch(() => errs.push("국내 ETF")),
        api.etfSentiment(fresh).then((r) => alive && setSides(r.sides)).catch(() => errs.push("심리")),
        api.etfList(fresh).then((r) => alive && setList(r.rows)).catch(() => errs.push("ETF 순위")),
      ]).then(() => {
        if (!alive) return;
        setErrors(errs);
        setPulledAt(Date.now()); // 기준 시각 (2026-09-18 전수검증 D10) — 서버가 asOf 를 안 주는 조합이라 받은 시각을 적는다
      });
    };
    pull();
    const t = window.setInterval(pull, 5 * 60_000);
    return () => {
      alive = false;
      window.clearInterval(t);
    };
  }, [gen]);

  if (!us && !kr && !sides && errors.length === 0) return <div className="ov-card-b empty">불러오는 중…</div>;

  const usSec = (us ?? []).filter((r) => r.group === "섹터" && r.d1 !== null).sort((a, b) => (b.d1 ?? 0) - (a.d1 ?? 0));
  const krTheme = (kr ?? []).filter((r) => r.group === "테마·업종" && r.d1 !== null).sort((a, b) => (b.d1 ?? 0) - (a.d1 ?? 0));
  const ends = <T,>(rows: T[]) => (rows.length <= 6 ? rows : [...rows.slice(0, 3), ...rows.slice(-3)]);

  const usBy = new Map((us ?? []).map((r) => [r.symbol, r]));
  const krBy = new Map((kr ?? []).map((r) => [r.label, r]));
  const pairs = PAIRS.map((p) => ({ p, u: usBy.get(p.us), k: krBy.get(p.kr) }))
    .filter((x): x is { p: { us: string; kr: string }; u: UsEtfRow; k: EtfFlowRow } => Boolean(x.u && x.k && x.u.d1 !== null && x.k.d1 !== null))
    .sort((a, b) => Math.abs(b.u.d1 ?? 0) - Math.abs(a.u.d1 ?? 0))
    .slice(0, 8);
  const together = pairs.filter((x) => Math.sign(x.u.d1 ?? 0) === Math.sign(x.k.d1 ?? 0) && (x.u.d1 ?? 0) !== 0);

  const us20 = (us ?? []).filter((r) => r.group === "섹터" && r.d20 !== null).sort((a, b) => (b.d20 ?? 0) - (a.d20 ?? 0));
  const liquid = (list ?? []).filter((r) => r.tradeValue >= 10 && r.deviation !== null);
  const prem = [...liquid].sort((a, b) => (b.deviation ?? 0) - (a.deviation ?? 0))[0];
  const disc = [...liquid].sort((a, b) => (a.deviation ?? 0) - (b.deviation ?? 0))[0];
  const hot = [...(kr ?? [])].filter((r) => r.volRatio !== null).sort((a, b) => (b.volRatio ?? 0) - (a.volRatio ?? 0))[0];

  const usRow = (r: UsEtfRow) => (
    <button type="button" key={r.symbol} className="mfp-row" onClick={() => setChart({ kind: "yahoo", symbol: r.symbol, label: `${r.name} (${r.symbol})`, digits: 2 })}>
      <span className="mfp-nm">
        {r.name} <i>{r.symbol}</i>
      </span>
      <em className={`num ${signClass(r.d1 ?? 0)}`}>{pct(r.d1)}</em>
      <i className={`mfp-mult${r.volRatio !== null && r.volRatio >= 1.5 ? " hot" : ""}`}>{mult(r.volRatio)}</i>
    </button>
  );
  const krRow = (r: EtfFlowRow) => (
    <button type="button" key={r.code} className="mfp-row" onClick={() => onSelectStock(r.code, r.name)} title={r.name}>
      <span className="mfp-nm">
        {r.label} <i>{r.name.replace(/^(KODEX|TIGER|SOL|ACE|PLUS|KoAct|KIWOOM|HANARO|RISE)\s*/, "")}</i>
      </span>
      <em className={`num ${signClass(r.d1 ?? 0)}`}>{pct(r.d1)}</em>
      <i className={`mfp-mult${r.volRatio !== null && r.volRatio >= 1.5 ? " hot" : ""}`}>{mult(r.volRatio)}</i>
    </button>
  );

  return (
    <div className="ov-card-b mfp">
      {errors.length > 0 && <div className="mfp-err">못 받음: {errors.join(" · ")}</div>}
      {pulledAt !== null && (
        <div className="mfp-stamp" title="네 조합(미국 ETF·국내 ETF·심리·ETF 순위)을 받은 시각 — 서버는 5분 캐시라 값은 그보다 옛것일 수 있습니다">
          {new Date(pulledAt).toLocaleTimeString("ko-KR", { hour: "2-digit", minute: "2-digit" })} 기준
          {krAsOf ? ` · 국내 ETF ${krAsOf}` : ""}
        </div>
      )}
      {sides && sides.length > 0 && (
        <div className="mfp-sent">
          <span className="mfp-k">⚖️ 심리</span>
          {sides.map((s) => {
            const cur = s.today ?? s.days[s.days.length - 1];
            const v = verdictOf(s);
            return (
              <span key={s.market} className="mfp-sent-item" title={`${s.names.inv.join("+")} ÷ ${s.names.lev} 거래대금 · 20일 평균 ${s.avg20 ?? "-"}`}>
                {s.market} <b>{cur?.ratio === null || cur?.ratio === undefined ? "–" : cur.ratio.toFixed(2)}</b>
                <i className={v.c}>{v.t}</i>
              </span>
            );
          })}
        </div>
      )}
      <div className="mfp-cols">
        <div className="mfp-col">
          <div className="mfp-h">🇺🇸 어젯밤 섹터 ETF <i>등락 · 거래대금 배수</i></div>
          {usSec.length === 0 ? <div className="empty">미국 ETF 를 못 받았습니다</div> : ends(usSec).map(usRow)}
        </div>
        <div className="mfp-col">
          <div className="mfp-h">🇰🇷 {krAsOf} 테마 ETF <i>등락 · 거래대금 배수{krAsOf === "어제" ? " · 장 전이라 어제" : ""}</i></div>
          {krTheme.length === 0 ? <div className="empty">국내 ETF 를 못 받았습니다</div> : ends(krTheme).map(krRow)}
        </div>
      </div>
      {pairs.length > 0 && (
        <div className="mfp-line">
          <span className="mfp-k">{together.length > 0 ? "같이 가는 짝" : "짝"}</span>
          {pairs.map((x) => {
            const same = Math.sign(x.u.d1 ?? 0) === Math.sign(x.k.d1 ?? 0);
            return (
              <button type="button" key={x.p.us} className={`mfp-pair${same ? " same" : " diff"}`} onClick={() => onSelectStock(x.k.code, x.k.name)} title={`${x.u.name}(${x.u.symbol}) ↔ ${x.k.name}`}>
                {x.p.kr} <em className={`num ${signClass(x.u.d1 ?? 0)}`}>🇺🇸{pct(x.u.d1)}</em> <em className={`num ${signClass(x.k.d1 ?? 0)}`}>🇰🇷{pct(x.k.d1)}</em>
              </button>
            );
          })}
        </div>
      )}
      {us20.length > 1 && (
        <div className="mfp-line">
          <span className="mfp-k">🇺🇸 20일</span>
          <span>
            최고 <b>{us20[0].name}</b> <em className={`num ${signClass(us20[0].d20 ?? 0)}`}>{pct(us20[0].d20)}</em>
          </span>
          <span>
            최저 <b>{us20[us20.length - 1].name}</b> <em className={`num ${signClass(us20[us20.length - 1].d20 ?? 0)}`}>{pct(us20[us20.length - 1].d20)}</em>
          </span>
        </div>
      )}
      {(prem || disc || hot) && (
        <div className="mfp-line">
          <span className="mfp-k">🇰🇷 튀는 ETF</span>
          {hot && (
            <button type="button" className="mfp-chip" onClick={() => onSelectStock(hot.code, hot.name)} title={hot.name}>
              돈 몰림 <b>{hot.label}</b> <em>{mult(hot.volRatio)}</em>
            </button>
          )}
          {prem && (
            <button type="button" className="mfp-chip" onClick={() => onSelectStock(prem.code, prem.name)}>
              프리미엄 <b>{prem.name}</b> <em className="num up">{pct(prem.deviation)}</em>
            </button>
          )}
          {disc && (
            <button type="button" className="mfp-chip" onClick={() => onSelectStock(disc.code, disc.name)}>
              디스카운트 <b>{disc.name}</b> <em className="num down">{pct(disc.deviation)}</em>
            </button>
          )}
        </div>
      )}
      <div className="mfp-note">배수 = 최근 5일 평균 거래대금 ÷ 그 앞 20일(1.5↑ 돈 몰림). 짝은 같은 이름의 대표 ETF 끼리 — 미국을 따라간다는 뜻은 아닙니다. 자세히는 ETF 분석·종목분석(해외) 메뉴.</div>
      {chart && <YahooChartSheet target={chart} onClose={() => setChart(null)} />}
    </div>
  );
}
