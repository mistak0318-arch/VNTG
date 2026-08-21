import { useEffect, useState } from "react";
import { api, fmtAbsNum, fmtNum, pickList, type RawRecord } from "../api";
import { fmtDt, fmtTm, num, SeriesTable, signOf, type SeriesColumn } from "./SeriesTable";
import { useLive } from "../useLive";
import { StrengthChart, type StrengthPoint } from "./StrengthChart";

/**
 * 키움 앱에서 개별 종목을 볼 때 자주 쓰는 화면들을 옮겨온 패널 모음.
 * 호가 / 거래원 / 프로그램매매 / 신용 / 체결강도 / 일별거래상세.
 */

/** 패널마다 반복되는 조회+로딩+에러 처리 */
function useFetch(fetcher: () => Promise<RawRecord>, deps: unknown[]) {
  const [data, setData] = useState<RawRecord | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    fetcher()
      .then((res) => {
        if (!cancelled) setData(res);
      })
      .catch((err: Error) => {
        if (!cancelled) setError(err.message);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);

  return { data, loading, error };
}

// ---------------------------------------------------------------- 호가

interface BidRow {
  side: "sell" | "buy";
  rank: number;
  price: number;
  qty: number;
}

/** ka10004의 호가 필드는 1호가만 이름이 다르다 (sel_fpr_bid / buy_fpr_bid) */
function bidField(side: "sel" | "buy", rank: number, kind: "bid" | "req"): string {
  if (rank === 1) return `${side}_fpr_${kind}`;
  return `${side}_${rank}th_pre_${kind}`;
}

/** 시가·고가·저가·거래대금·체결강도 요약. 차트 화면에서는 호가창 없이 이것만 쓴다 */
export function QuoteSummary({ code }: { code: string }) {
  const snap = useFetch(() => api.snapshot(code), [code]);
  const str = useFetch(() => api.strength(code, "time"), [code]);
  /*
   * 여기 시가·고가·저가는 KRX 기준이다. 같은 종목이라도 NXT에서 더 높이/낮게 찍히는 날이
   * 있어서 옆에 괄호로 같이 보여준다 — 표를 따로 두는 것보다 이 자리에서 바로 비교하는 게 낫다.
   * 장중에는 5초마다 조용히 갱신된다.
   */
  /*
   * **1초 갱신.**
   *
   * 키움 제한은 「전체 초당 몇 건」이 아니라 **TR 하나당 초당 5건**이다.
   * 종목 창은 한 번에 하나만 열리고, 이 패널이 부르는 TR 도 하나다 —
   * 1초에 한 번이면 한도의 20% 다. 5초로 잡아 둘 이유가 없었다.
   *
   * 분봉 차트는 그대로 30초다. 3분봉은 3분에 한 번 바뀌는데 1초로 당겨 봐야
   * **같은 값을 서른 번 더 받을 뿐**이다.
   */
  const ex = useLive(() => api.exchangeQuotes(code), [code], 1000);
  const nxt = (ex.data?.exchanges ?? []).find((x) => x.key === "nxt") ?? null;

  if (snap.loading) return <div className="empty">시세 불러오는 중...</div>;
  if (snap.error) return <div className="error-banner">{snap.error}</div>;
  if (!snap.data) return null;

  // ka10046은 최신순이라 첫 행이 가장 최근 체결강도
  const latest = pickList(str.data ?? undefined, ["cntr_str_tm"])[0];
  return (
    <SummaryGrid
      snap={snap.data}
      strength={latest ? String(latest.cntr_str ?? "") : ""}
      nxt={nxt}
    />
  );
}

function SummaryGrid({
  snap,
  strength,
  nxt,
}: {
  snap: RawRecord;
  strength?: string;
  nxt?: { open: number | null; high: number | null; low: number | null } | null;
}) {
  const base = Math.abs(num(snap.pred_close_pric));
  return (
    <div className="summary-grid quote-summary">
      {[
        { label: "시가", value: snap.open_pric, nxtValue: nxt?.open ?? null },
        { label: "고가", value: snap.high_pric, nxtValue: nxt?.high ?? null },
        { label: "저가", value: snap.low_pric, nxtValue: nxt?.low ?? null },
      ].map((it) => {
        const price = Math.abs(num(it.value));
        // 전일종가 대비 등락률을 같이 보여줘야 가격의 의미가 바로 읽힌다
        const rate = base > 0 && price > 0 ? ((price - base) / base) * 100 : null;
        /*
         * NXT 값은 **항상** 보여준다. 같은 날은 같다는 사실 자체가 정보이고,
         * 어떤 날은 나오고 어떤 날은 안 나오면 "저가는 왜 없지?"라고 헷갈린다.
         * 등락률은 KRX와 같은 기준(전일종가)으로 재야 두 값을 나란히 비교할 수 있다.
         */
        const nxtPrice = it.nxtValue;
        const showNxt = nxtPrice !== null && nxtPrice > 0;
        const nxtRate = showNxt && base > 0 ? ((nxtPrice - base) / base) * 100 : null;
        return (
          <div className="summary-item" key={it.label}>
            <div className="label">{it.label}</div>
            <div className={`value ${signOf(price - base)}`}>
              {fmtAbsNum(it.value)}
              {rate !== null && (
                <em className="ph-pct">
                  {rate > 0 ? "+" : ""}
                  {rate.toFixed(2)}%
                </em>
              )}
            </div>
            {showNxt && (
              <div className="qs-nxt" title="넥스트레이드(대체거래소) 기준">
                NXT {fmtNum(nxtPrice)}
                {nxtRate !== null && (
                  <em className={signOf(nxtPrice - base)}>
                    {" "}
                    {nxtRate > 0 ? "+" : ""}
                    {nxtRate.toFixed(2)}%
                  </em>
                )}
              </div>
            )}
          </div>
        );
      })}
      <div className="summary-item">
        <div className="label">거래대금</div>
        <div className="value">{fmtNum(Math.round(num(snap.trde_prica) / 100))}억</div>
      </div>
      {strength && (
        <div className="summary-item">
          <div className="label">체결강도</div>
          {/* 100 초과 = 시장가 매수 우위 */}
          <div className={`value ${signOf(num(strength) - 100)}`}>{strength}</div>
        </div>
      )}
    </div>
  );
}

/**
 * @deprecated **`OrderBookPanel` 로 옮겼다.** (2026-08-20)
 * 종목 상세와 종목분석이 각자 호가를 그려서 같은 종목이 화면마다 다르게 보였다.
 * 새 것에는 체결강도·회전율·KRX/NXT 고저가 들어 있다. 지금은 아무도 안 쓴다.
 */
export function QuoteBookPanel({ code }: { code: string }) {
  const { data, loading, error } = useFetch(() => api.quote(code), [code]);
  const snap = useFetch(() => api.snapshot(code), [code]);

  if (loading) return <div className="empty">호가 불러오는 중...</div>;
  if (error) return <div className="error-banner">{error}</div>;
  if (!data) return null;

  const base = Math.abs(num(snap.data?.pred_close_pric));

  const sells: BidRow[] = [];
  const buys: BidRow[] = [];
  for (let rank = 1; rank <= 10; rank += 1) {
    const sp = Math.abs(num(data[bidField("sel", rank, "bid")]));
    const sq = num(data[bidField("sel", rank, "req")]);
    if (sp > 0) sells.push({ side: "sell", rank, price: sp, qty: sq });
    const bp = Math.abs(num(data[bidField("buy", rank, "bid")]));
    const bq = num(data[bidField("buy", rank, "req")]);
    if (bp > 0) buys.push({ side: "buy", rank, price: bp, qty: bq });
  }
  // 매도는 높은 가격이 위로 오도록
  sells.reverse();

  const maxQty = Math.max(...sells.map((r) => r.qty), ...buys.map((r) => r.qty), 1);
  const totSell = num(data.tot_sel_req);
  const totBuy = num(data.tot_buy_req);
  const totalReq = totSell + totBuy;

  function row(r: BidRow) {
    const rate = base > 0 ? ((r.price - base) / base) * 100 : 0;
    const widthPct = (r.qty / maxQty) * 100;
    return (
      <div className={`bid-row ${r.side}`} key={`${r.side}-${r.rank}`}>
        <div className="bid-qty-cell">
          {r.side === "sell" && (
            <>
              <div className="bid-bar sell" style={{ width: `${widthPct}%` }} />
              <span className="bid-qty">{fmtNum(r.qty)}</span>
            </>
          )}
        </div>
        <div className="bid-price-cell">
          <span className={`bid-price ${signOf(rate)}`}>{fmtNum(r.price)}</span>
          <span className={`bid-rate ${signOf(rate)}`}>
            {rate > 0 ? "+" : ""}
            {rate.toFixed(2)}%
          </span>
        </div>
        <div className="bid-qty-cell">
          {r.side === "buy" && (
            <>
              <div className="bid-bar buy" style={{ width: `${widthPct}%` }} />
              <span className="bid-qty">{fmtNum(r.qty)}</span>
            </>
          )}
        </div>
      </div>
    );
  }

  return (
    <div>
      {snap.data && <SummaryGrid snap={snap.data} />}

      <div className="bid-book">
        <div className="bid-head">
          <span>매도잔량</span>
          <span>호가</span>
          <span>매수잔량</span>
        </div>
        {sells.map(row)}
        <div className="bid-divider" />
        {buys.map(row)}
      </div>

      <div className="bid-total">
        <div className="bid-total-bar">
          <div
            className="bid-total-fill sell"
            style={{ width: totalReq > 0 ? `${(totSell / totalReq) * 100}%` : "50%" }}
          />
          <div
            className="bid-total-fill buy"
            style={{ width: totalReq > 0 ? `${(totBuy / totalReq) * 100}%` : "50%" }}
          />
        </div>
        <div className="bid-total-nums">
          <span className="negative">매도 {fmtNum(totSell)}</span>
          <span className="positive">매수 {fmtNum(totBuy)}</span>
        </div>
      </div>

      <div className="table-note">
        호가 잔량은 조회 시점 기준 스냅샷입니다 (실시간 스트리밍 아님) · 기준시각{" "}
        {fmtTm(data.bid_req_base_tm)}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- 거래원

/** 이름에 이 조각이 들어가면 외국계 창구로 본다 */
const FOREIGN_BROKERS = [
  "모간",
  "모건",
  "골드만",
  "메릴린치",
  "BofA",
  "CS",
  "UBS",
  "노무라",
  "다이와",
  "CLSA",
  "맥쿼리",
  "HSBC",
  "BNP",
  "씨티",
  "도이치",
  "미즈호",
  "제이피",
  "JP",
  "홍콩",
  "싱가폴",
  "뉴엣지",
  "SG증권",
];

function isForeign(name: string): boolean {
  return FOREIGN_BROKERS.some((f) => name.toUpperCase().includes(f.toUpperCase()));
}

/** @deprecated **`BrokerFlowPanel` 로 옮겼다.** 증감·시간대별이 들어 있다 */
export function BrokerPanel({ code }: { code: string }) {
  const { data, loading, error } = useFetch(() => api.broker(code), [code]);

  if (loading) return <div className="empty">거래원 불러오는 중...</div>;
  if (error) return <div className="error-banner">{error}</div>;
  if (!data) return null;

  const rows = Array.from({ length: 5 }, (_, i) => {
    const n = i + 1;
    return {
      sellName: String(data[`sel_trde_ori_nm_${n}`] ?? "").trim(),
      sellQty: Math.abs(num(data[`sel_trde_qty_${n}`])),
      buyName: String(data[`buy_trde_ori_nm_${n}`] ?? "").trim(),
      buyQty: Math.abs(num(data[`buy_trde_qty_${n}`])),
    };
  }).filter((r) => r.sellName || r.buyName);

  const maxQty = Math.max(...rows.map((r) => Math.max(r.sellQty, r.buyQty)), 1);
  // 상위 5개 안에 든 외국계 창구만 합산한 값 (전체 외국계 합계가 아님)
  const foreignSell = rows.filter((r) => isForeign(r.sellName)).reduce((s, r) => s + r.sellQty, 0);
  const foreignBuy = rows.filter((r) => isForeign(r.buyName)).reduce((s, r) => s + r.buyQty, 0);
  const foreignNet = foreignBuy - foreignSell;

  return (
    <div>
      <div className="broker-table">
        <div className="broker-head">
          <span>매도상위</span>
          <span>매수상위</span>
        </div>
        {rows.map((r, i) => (
          <div className="broker-row" key={i}>
            <div className="broker-cell sell">
              <div className="broker-bar sell" style={{ width: `${(r.sellQty / maxQty) * 100}%` }} />
              <span className={`broker-name${isForeign(r.sellName) ? " foreign" : ""}`}>
                {r.sellName}
              </span>
              <span className="broker-qty">{fmtNum(r.sellQty)}</span>
            </div>
            <div className="broker-cell buy">
              <div className="broker-bar buy" style={{ width: `${(r.buyQty / maxQty) * 100}%` }} />
              <span className={`broker-name${isForeign(r.buyName) ? " foreign" : ""}`}>{r.buyName}</span>
              <span className="broker-qty">{fmtNum(r.buyQty)}</span>
            </div>
          </div>
        ))}
      </div>

      {(foreignSell > 0 || foreignBuy > 0) && (
        <div className="summary-grid">
          <div className="summary-item">
            <div className="label">외국계 창구 매수 (상위5 내)</div>
            <div className="value positive">{fmtNum(foreignBuy)}</div>
          </div>
          <div className="summary-item">
            <div className="label">외국계 창구 매도 (상위5 내)</div>
            <div className="value negative">{fmtNum(foreignSell)}</div>
          </div>
          <div className="summary-item">
            <div className="label">외국계 순매수 (상위5 내)</div>
            <div className={`value ${signOf(foreignNet)}`}>
              {foreignNet > 0 ? "+" : ""}
              {fmtNum(foreignNet)}
            </div>
          </div>
        </div>
      )}

      <div className="table-note">
        단위: 주 · 파란 이름은 외국계 창구 · 키움 API는 상위 5개 창구만 제공하므로 외국계 합계는
        상위 5개 안에 든 것만 더한 값입니다 (앱의 &apos;외국계합&apos;과 다를 수 있음)
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- 프로그램 매매

/** @deprecated **`ProgramFlowPanel` 로 옮겼다.** 0선 위아래 그래프가 들어 있다 */
export function StockProgramPanel({ code }: { code: string }) {
  const { data, loading, error } = useFetch(() => api.programTrend(code), [code]);

  if (loading) return <div className="empty">프로그램 매매 불러오는 중...</div>;
  if (error) return <div className="error-banner">{error}</div>;

  const rows = pickList(data ?? undefined, ["stk_daly_prm_trde_trnsn"]);
  const columns: SeriesColumn[] = [
    { key: "dt", label: "일자", get: (r) => String(r.dt ?? ""), render: (r) => fmtDt(r.dt), sticky: true },
    {
      key: "cur_prc",
      label: "종가",
      get: (r) => Math.abs(num(r.cur_prc)),
      render: (r) => fmtAbsNum(r.cur_prc),
    },
    { key: "flu_rt", label: "등락률", get: (r) => num(r.flu_rt), render: (r) => `${num(r.flu_rt).toFixed(2)}%`, sign: true },
    { key: "prm_buy_amt", label: "프로그램 매수", get: (r) => num(r.prm_buy_amt) },
    { key: "prm_sell_amt", label: "프로그램 매도", get: (r) => num(r.prm_sell_amt) },
    { key: "prm_netprps_amt", label: "순매수", get: (r) => num(r.prm_netprps_amt), sign: true },
    { key: "prm_netprps_qty", label: "순매수(주)", get: (r) => num(r.prm_netprps_qty), sign: true },
    { key: "trde_qty", label: "거래량", get: (r) => num(r.trde_qty) },
  ];

  return (
    <SeriesTable
      rows={rows}
      columns={columns}
      empty="프로그램 매매 데이터가 없습니다."
      note="금액 단위: 백만원 · 프로그램 순매수가 며칠 연속 (+)이면 기관·외국인 바스켓 유입이 이어지고 있다는 뜻입니다."
    />
  );
}

// ---------------------------------------------------------------- 신용

export function CreditPanel({ code }: { code: string }) {
  const { data, loading, error } = useFetch(() => api.credit(code), [code]);

  if (loading) return <div className="empty">신용 동향 불러오는 중...</div>;
  if (error) return <div className="error-banner">{error}</div>;

  const rows = pickList(data ?? undefined, ["crd_trde_trend"]);
  const columns: SeriesColumn[] = [
    { key: "dt", label: "일자", get: (r) => String(r.dt ?? ""), render: (r) => fmtDt(r.dt), sticky: true },
    {
      key: "cur_prc",
      label: "종가",
      get: (r) => Math.abs(num(r.cur_prc)),
      render: (r) => fmtAbsNum(r.cur_prc),
    },
    { key: "new", label: "신규", get: (r) => num(r.new) },
    { key: "rpya", label: "상환", get: (r) => num(r.rpya) },
    { key: "remn", label: "잔고", get: (r) => num(r.remn) },
    { key: "pre", label: "전일대비", get: (r) => num(r.pre), sign: true },
    { key: "remn_rt", label: "잔고율(%)", get: (r) => num(r.remn_rt), render: (r) => String(r.remn_rt ?? "-") },
    { key: "shr_rt", label: "공여율(%)", get: (r) => num(r.shr_rt), render: (r) => String(r.shr_rt ?? "-") },
  ];

  return (
    <SeriesTable
      rows={rows}
      columns={columns}
      empty="신용 융자 데이터가 없습니다."
      note="단위: 주 · 잔고율은 상장주식수 대비 신용잔고 비중. 잔고가 급증하면 향후 반대매매 부담이 커집니다."
    />
  );
}

// ---------------------------------------------------------------- 체결강도

/**
 * 표 위에 **그래프**를 얹는다.
 *
 * 숫자를 세로로 예순 줄 읽어서 「10시에 뒤집혔다」를 알아내는 사람은 없다.
 * 언제 뒤집혔나가 이 값의 쓸모라 선으로 봐야 한다 — 표는 정확한 값을 보려고 남긴다.
 */
function toPoints(rows: RawRecord[], mode: "daily" | "time"): StrengthPoint[] {
  return rows
    .map((r) => ({
      t: String((mode === "time" ? r.cntr_tm : r.dt) ?? "").trim(),
      strength: num(r.cntr_str),
      // 키움이 5·20·60분(일) 평균을 같이 준다. 20 을 쓴다 — 5 는 원선과 거의 겹친다
      avg: num(r.cntr_str_20min),
      price: Math.abs(num(r.cur_prc)),
      rate: num(r.flu_rt),
    }))
    .filter((p) => p.t.length >= 4 && p.strength > 0)
    // 키움은 최신순으로 준다 — 왼쪽이 과거가 되게 뒤집는다
    .reverse();
}

export function StrengthPanel({ code }: { code: string }) {
  const [mode, setMode] = useState<"daily" | "time">("daily");
  const { data, loading, error } = useFetch(() => api.strength(code, mode), [code, mode]);

  const rows = pickList(data ?? undefined, ["cntr_str_daly", "cntr_str_tm"]);

  const columns: SeriesColumn[] =
    mode === "daily"
      ? [
          { key: "dt", label: "일자", get: (r) => String(r.dt ?? ""), render: (r) => fmtDt(r.dt), sticky: true },
          { key: "cur_prc", label: "종가", get: (r) => Math.abs(num(r.cur_prc)), render: (r) => fmtAbsNum(r.cur_prc) },
          { key: "flu_rt", label: "등락률", get: (r) => num(r.flu_rt), render: (r) => `${num(r.flu_rt).toFixed(2)}%`, sign: true },
          { key: "cntr_str", label: "체결강도", get: (r) => num(r.cntr_str), render: (r) => String(r.cntr_str ?? "-") },
          { key: "s5", label: "5일평균", get: (r) => num(r.cntr_str_5min), render: (r) => String(r.cntr_str_5min ?? "-") },
          { key: "s20", label: "20일평균", get: (r) => num(r.cntr_str_20min), render: (r) => String(r.cntr_str_20min ?? "-") },
          { key: "prica", label: "거래대금", get: (r) => num(r.acc_trde_prica) },
        ]
      : [
          { key: "tm", label: "시각", get: (r) => String(r.cntr_tm ?? ""), render: (r) => fmtTm(r.cntr_tm), sticky: true },
          { key: "cur_prc", label: "현재가", get: (r) => Math.abs(num(r.cur_prc)), render: (r) => fmtAbsNum(r.cur_prc) },
          { key: "flu_rt", label: "등락률", get: (r) => num(r.flu_rt), render: (r) => `${num(r.flu_rt).toFixed(2)}%`, sign: true },
          { key: "cntr_str", label: "체결강도", get: (r) => num(r.cntr_str), render: (r) => String(r.cntr_str ?? "-") },
          { key: "s5", label: "5분평균", get: (r) => num(r.cntr_str_5min), render: (r) => String(r.cntr_str_5min ?? "-") },
          { key: "s20", label: "20분평균", get: (r) => num(r.cntr_str_20min), render: (r) => String(r.cntr_str_20min ?? "-") },
          { key: "qty", label: "누적거래량", get: (r) => num(r.acc_trde_qty) },
        ];

  return (
    <div>
      <div className="filter-row">
        <button className={`filter-btn ${mode === "daily" ? "active" : ""}`} onClick={() => setMode("daily")}>
          일별
        </button>
        <button className={`filter-btn ${mode === "time" ? "active" : ""}`} onClick={() => setMode("time")}>
          시간별
        </button>
      </div>
      {loading && <div className="empty">체결강도 불러오는 중...</div>}
      {error && <div className="error-banner">{error}</div>}
      {!loading && !error && <StrengthChart points={toPoints(rows, mode)} />}
      {!loading && !error && (
        <SeriesTable
          rows={rows}
          columns={columns}
          empty="체결강도 데이터가 없습니다."
          note="체결강도 = 매수체결량 ÷ 매도체결량 × 100. 100을 넘으면 시장가 매수(공격적 매수)가 우위입니다."
        />
      )}
    </div>
  );
}

// ---------------------------------------------------------------- 일별 거래상세

export function DailyDetailPanel({ code }: { code: string }) {
  const { data, loading, error } = useFetch(() => api.dailyDetail(code, 30), [code]);

  if (loading) return <div className="empty">일별 거래상세 불러오는 중...</div>;
  if (error) return <div className="error-banner">{error}</div>;

  const rows = pickList(data ?? undefined, ["daly_trde_dtl"]);
  const columns: SeriesColumn[] = [
    { key: "dt", label: "일자", get: (r) => String(r.dt ?? ""), render: (r) => fmtDt(r.dt), sticky: true },
    {
      key: "close_pric",
      label: "종가",
      get: (r) => Math.abs(num(r.close_pric)),
      render: (r) => fmtAbsNum(r.close_pric),
    },
    { key: "flu_rt", label: "등락률", get: (r) => num(r.flu_rt), render: (r) => `${num(r.flu_rt).toFixed(2)}%`, sign: true },
    { key: "trde_qty", label: "거래량", get: (r) => num(r.trde_qty) },
    { key: "trde_prica", label: "거래대금", get: (r) => num(r.trde_prica) },
    {
      key: "opmr_trde_wght",
      label: "장중비중(%)",
      get: (r) => num(r.opmr_trde_wght),
      render: (r) => String(r.opmr_trde_wght ?? "-"),
    },
    {
      key: "af_mkrt_trde_wght",
      label: "장후비중(%)",
      get: (r) => num(r.af_mkrt_trde_wght),
      render: (r) => String(r.af_mkrt_trde_wght ?? "-"),
    },
    { key: "for_wght", label: "외인비중(%)", get: (r) => num(r.for_wght), render: (r) => String(r.for_wght || "-") },
    { key: "for_netprps", label: "외인순매수", get: (r) => num(r.for_netprps), sign: true },
    { key: "orgn_netprps", label: "기관순매수", get: (r) => num(r.orgn_netprps), sign: true },
    { key: "ind_netprps", label: "개인순매수", get: (r) => num(r.ind_netprps), sign: true },
  ];

  return (
    <SeriesTable
      rows={rows}
      columns={columns}
      empty="일별 거래상세가 없습니다."
      note="거래대금 단위: 백만원 · 장후 비중이 유독 높은 날은 시간외 대량매매(블록딜)를 의심해볼 수 있습니다."
    />
  );
}
