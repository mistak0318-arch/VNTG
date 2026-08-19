import { useEffect, useState } from "react";
import {
  api,
  fmtNum,
  type GlobalQuote,
  type IndexDetailData,
  type ScreenHit,
  type SectorFlowResult,
  type StockRow,
  type UsMajorResult,
} from "../../api";
import { TrendLineChart } from "../TrendLineChart";

/**
 * 데일리 리포트에 새로 들어가는 네 섹션.
 *
 * 넷 다 **이미 있는 데이터**를 리포트 문맥으로 다시 놓은 것이다 — 새 API 는 없다.
 * 리포트는 "아침에 한 번 훑고 판단을 시작하는 자리"라, 대시보드에 흩어진 것 중
 * 그 시각에 꼭 필요한 것만 골라 순서대로 세운다.
 */

function pct(v: number | null | undefined): string {
  if (v == null || !Number.isFinite(v)) return "-";
  return `${v > 0 ? "+" : ""}${v.toFixed(2)}%`;
}

function cls(v: number | null | undefined): string {
  if (v == null) return "";
  return v > 0 ? "positive" : v < 0 ? "negative" : "";
}

/* ───────────────────────────────── D3. 코스피 야간선물 · 환율 */

/**
 * 밤사이 한국 지수가 어디로 갔는지.
 *
 * 조간에 가장 먼저 봐야 할 값이다. 미국 현물은 05:30 에 닫혀 이미 굳었지만
 * **야간선물은 그 결과를 한국 지수로 환산해 준다** — 오늘 개장가의 예고편이다.
 * 환율을 같이 두는 건 외국인 수급이 환율과 붙어 움직이기 때문이다.
 */
export function NightFuturesSection() {
  const [us, setUs] = useState<UsMajorResult | null>(null);
  const [fx, setFx] = useState<GlobalQuote[]>([]);

  useEffect(() => {
    let alive = true;
    api
      .overviewSection<UsMajorResult>("usMajor")
      .then((r) => alive && setUs(r.data))
      .catch(() => undefined);
    api
      .overviewSection<GlobalQuote[]>("global")
      .then((r) => alive && setFx(r.data ?? []))
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, []);

  const night = us?.nightFutures ?? null;
  // 환율은 원/달러가 본체다. 엔·유로는 곁가지라 여기선 안 쓴다
  const usdkrw = fx.find((q) => q.symbol === "KRW=X") ?? null;

  if (!night && !usdkrw) return <div className="empty">아직 값이 없습니다.</div>;

  return (
    <div className="rp-kv">
      {night && (
        <div className="rp-kv-item">
          <span className="rp-kv-label">코스피 야간선물</span>
          <b className={`rp-kv-val ${cls(night.changeRate)}`}>{night.price?.toFixed(2)}</b>
          <span className={cls(night.changeRate)}>{pct(night.changeRate)}</span>
          <span className="pt-n">{night.symbol}</span>
        </div>
      )}
      {usdkrw && (
        <div className="rp-kv-item">
          <span className="rp-kv-label">원/달러</span>
          <b className={`rp-kv-val ${cls(usdkrw.changeRate)}`}>{usdkrw.price?.toFixed(2)}</b>
          <span className={cls(usdkrw.changeRate)}>{pct(usdkrw.changeRate)}</span>
        </div>
      )}
      <div className="table-note">
        야간선물은 미국장이 열려 있는 동안 움직인 값이라 <b>오늘 개장가의 예고편</b>입니다.
        환율을 같이 두는 건 외국인 수급이 환율과 붙어 움직이기 때문입니다.
      </div>
    </div>
  );
}

/* ───────────────────────────────── D4. 코스피·코스닥 추이 */

function IndexChart({ code, label }: { code: string; label: string }) {
  const [d, setD] = useState<IndexDetailData | null>(null);
  useEffect(() => {
    let alive = true;
    api
      .indexDetail(code, "day")
      .then((r) => alive && setD(r))
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, [code]);

  // 60거래일이면 석 달이다 — 리포트에서는 이 정도가 "요즘 흐름"이다
  const candles = (d?.candles ?? []).slice(-60);
  if (candles.length < 2) return null;

  return (
    <div className="rp-chart">
      <div className="rp-chart-title">
        {label}
        <b className="pt-n"> {candles[candles.length - 1].close.toFixed(2)}</b>
      </div>
      <TrendLineChart
        height={150}
        series={[
          {
            label,
            color: code === "101" ? "#f5c542" : "#4c8dff",
            axis: "right",
            data: candles.map((c) => ({
              time: {
                year: Number(c.dt.slice(0, 4)),
                month: Number(c.dt.slice(4, 6)),
                day: Number(c.dt.slice(6, 8)),
              },
              value: c.close,
            })),
          },
        ]}
      />
    </div>
  );
}

/**
 * 코스피·코스닥 60거래일 추이.
 *
 * 숫자만으로는 "오늘 −1.5%" 가 어디쯤에서 난 하락인지 모른다.
 * 고점에서 흘러내리는 중인지 바닥에서 튀는 중인지가 판단을 가른다.
 */
export function IndexTrendSection() {
  return (
    <div className="rp-charts">
      <IndexChart code="001" label="코스피" />
      <IndexChart code="101" label="코스닥" />
    </div>
  );
}

/* ───────────────────────────────── D5. 시장 자금 흐름 */

/**
 * 업종별로 돈이 어디서 빠져 어디로 갔나.
 *
 * "오늘 외국인 +800억" 같은 총액은 방향을 못 말해 준다. **같은 총액이라도**
 * 반도체에서 빼서 방산으로 옮긴 날과 전 업종을 고르게 산 날은 완전히 다른 장이다.
 * 5일 누적으로 보는 건 하루치는 노이즈가 크기 때문이다.
 */
export function MoneyFlowSection() {
  const [d, setD] = useState<SectorFlowResult | null>(null);
  const [subject, setSubject] = useState("foreign");

  useEffect(() => {
    let alive = true;
    setD(null);
    api
      .sectorFlow(subject, 5)
      .then((r) => alive && setD(r))
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, [subject]);

  const stats = d?.stats ?? [];
  const inflow = stats.slice(0, 5);
  const outflow = [...stats].reverse().slice(0, 5);

  return (
    <>
      <div className="filter-row">
        {[
          { k: "foreign", l: "외국인" },
          { k: "institution", l: "기관" },
          { k: "pension", l: "연기금" },
        ].map((s) => (
          <button
            key={s.k}
            className={`filter-btn ${subject === s.k ? "active" : ""}`}
            onClick={() => setSubject(s.k)}
          >
            {s.l}
          </button>
        ))}
        {d && <span className="pt-n">5일 누적 · 억원</span>}
      </div>

      {!d && <div className="page-note">불러오는 중…</div>}

      {d && (
        <div className="rp-flow">
          <div>
            <div className="rp-flow-h positive">들어온 곳</div>
            {inflow.map((s) => (
              <div className="rp-flow-row" key={s.code}>
                <span>{s.label}</span>
                <b className="positive">+{fmtNum(Math.round(s.sum))}</b>
              </div>
            ))}
          </div>
          <div>
            <div className="rp-flow-h negative">빠져나간 곳</div>
            {outflow.map((s) => (
              <div className="rp-flow-row" key={s.code}>
                <span>{s.label}</span>
                <b className="negative">{fmtNum(Math.round(s.sum))}</b>
              </div>
            ))}
          </div>
        </div>
      )}

      <div className="table-note">
        총액이 아니라 <b>어디서 빼서 어디로 넣었나</b>를 봅니다. 같은 +800억이라도 반도체에서
        빼서 방산으로 옮긴 날과 전 업종을 고르게 산 날은 완전히 다른 장입니다.
      </div>
    </>
  );
}

/* ───────────────────────────────── D11. 특징주 */

/**
 * 오늘 볼 만한 종목.
 *
 * 세 갈래로 모은다 — **신호등이 높은 것**, **52주 신고가**, **급등**.
 * 셋은 성격이 다르다. 신호등은 조건을 갖춘 것이고, 신고가는 이미 올라간 것이고,
 * 급등은 오늘 움직인 것이다. 섞어 놓으면 무엇을 보고 있는지 모르게 되므로 나눠 둔다.
 *
 * 신호등은 **마지막으로 돌린 스캔 결과**를 그대로 쓴다 — 리포트를 열 때마다
 * 전종목 스캔을 돌리면 몇 분이 걸리고 API 한도를 먹는다.
 */
export function FeaturedSection({
  onSelectStock,
}: {
  onSelectStock: (code: string, name: string) => void;
}) {
  const [hits, setHits] = useState<ScreenHit[] | null>(null);
  const [scanAt, setScanAt] = useState<string | null>(null);
  const [high, setHigh] = useState<StockRow[]>([]);
  const [rising, setRising] = useState<StockRow[]>([]);

  useEffect(() => {
    let alive = true;
    api
      .signalScreenRuns()
      .then(async (r) => {
        const latest = r.runs[0];
        if (!latest || !alive) return;
        const run = await api.signalScreenRun(latest.id);
        if (!alive) return;
        setScanAt(latest.at);
        // 점수 높은 것부터. 80점 미만은 "볼 만하다"고 하기 어렵다
        setHits(run.results.filter((h) => h.score >= 80).slice(0, 8));
      })
      .catch(() => alive && setHits([]));

    api
      .overviewSection<{ high: StockRow[]; low: StockRow[] }>("highLow")
      .then((r) => alive && setHigh((r.data?.high ?? []).slice(0, 8)))
      .catch(() => undefined);
    api
      .overviewSection<{ rising: StockRow[]; falling: StockRow[] }>("movers")
      .then((r) => alive && setRising((r.data?.rising ?? []).slice(0, 8)))
      .catch(() => undefined);

    return () => {
      alive = false;
    };
  }, []);

  const row = (code: string, name: string, price: number, rate: number, extra?: string) => (
    <button className="ov-li" key={`${code}-${name}`} onClick={() => onSelectStock(code, name)}>
      <span className="ov-nm">{name}</span>
      <span className={`ov-px num ${cls(rate)}`}>{fmtNum(price)}</span>
      <span className={`ov-pct num ${cls(rate)}`}>{pct(rate)}</span>
      {extra && <span className="pt-n">{extra}</span>}
    </button>
  );

  return (
    <div className="rp-featured">
      <div>
        <div className="rp-flow-h">
          신호등 80점 이상
          {scanAt && (
            <span className="pt-n"> · {new Date(scanAt).toLocaleString("ko-KR").slice(5, 16)} 스캔</span>
          )}
        </div>
        {hits === null && <div className="page-note">불러오는 중…</div>}
        {hits?.length === 0 && (
          <div className="empty">
            아직 스캔 결과가 없습니다. 「신호등 찾기」에서 한 번 돌리면 여기에 뜹니다.
          </div>
        )}
        {hits?.map((h) => row(h.code, h.name, h.price, h.changeRate, `${h.score}점`))}
      </div>

      <div>
        <div className="rp-flow-h">52주 신고가</div>
        {high.length === 0 && <div className="empty">없음</div>}
        {high.map((s) => row(s.code, s.name, s.price, s.changeRate))}
      </div>

      <div>
        <div className="rp-flow-h">오늘 급등</div>
        {rising.length === 0 && <div className="empty">없음</div>}
        {rising.map((s) => row(s.code, s.name, s.price, s.changeRate))}
      </div>
    </div>
  );
}
