import { useEffect, useState } from "react";
import { useLive } from "../useLive";
import { api, fmtNum, pickList, type RawRecord } from "../api";
import { num, signOf } from "./SeriesTable";

/**
 * 당일 흐름 패널들.
 * 캔들차트만 보면 "오늘 장중에 어떻게 움직였는지"가 안 보여서,
 * 분봉을 라인으로 펴서 보여주고(증권플러스 미니 차트 형태) 프로그램 수급을 붙인다.
 */

// ---------------------------------------------------------------- 당일 흐름 라인

interface Point {
  time: string; // HHmm
  price: number;
  /** 전형가 (고+저+종)/3 — VWAP 을 내는 재료 */
  typical: number;
  volume: number;
}

/** 분봉 응답에서 "가장 최근 날짜" 것만 뽑아 시간순으로 정렬 */
function todayPoints(chart: RawRecord | null): Point[] {
  const rows = pickList(chart ?? undefined, ["stk_min_pole_chart_qry"]);
  if (rows.length === 0) return [];

  // cntr_tm: YYYYMMDDHHmmss (최신순으로 내려옴)
  const latestDay = String(rows[0].cntr_tm ?? "").slice(0, 8);
  const out: Point[] = [];
  for (const r of rows) {
    const tm = String(r.cntr_tm ?? "");
    if (tm.slice(0, 8) !== latestDay) break; // 최신순이라 날짜가 바뀌면 멈춰도 된다
    const price = Math.abs(num(r.cur_prc));
    const high = Math.abs(num(r.high_pric)) || price;
    const low = Math.abs(num(r.low_pric)) || price;
    if (price > 0) {
      out.push({
        time: tm.slice(8, 12),
        price,
        typical: (high + low + price) / 3,
        volume: Math.abs(num(r.trde_qty)),
      });
    }
  }
  return out.reverse();
}

/**
 * **누적 VWAP** — 정규장이 시작한 지점부터 한 봉씩 쌓아 간다.
 *
 * 요약줄의 VWAP 은 「지금 값 하나」인데, 선으로 그리면 **하루 종일 어느 쪽이
 * 이기고 있었는지**가 보인다. 아침에 VWAP 위에서 놀다가 오후에 밑으로 꺼진 날과
 * 계속 밑에 있다가 막판에 올라선 날은 완전히 다른 날인데, 숫자 하나로는 그게 안 보인다.
 *
 * ⚠️ **정규장만 센다.** 프리마켓을 섞으면 09:00 의 VWAP 이 이미 한참 어긋난 채로
 * 시작한다. 그래서 09:00 앞은 `null` 이고 선도 거기서부터 그려진다.
 *
 * ⚠️ 요약줄 값과 **몇 원 다를 수 있다.** 저기는 5분봉, 여기는 3분봉이다.
 * 둘 다 전형가로 낸 어림값이라 방향은 같고 자릿수만 다르다.
 */
function vwapSeries(points: Point[], openIdx: number): (number | null)[] {
  let pv = 0;
  let vol = 0;
  return points.map((p, i) => {
    if (openIdx >= 0 && i < openIdx) return null;
    pv += p.typical * p.volume;
    vol += p.volume;
    return vol > 0 ? pv / vol : null;
  });
}

function fmtHm(hhmm: string): string {
  return hhmm.length === 4 ? `${hhmm.slice(0, 2)}:${hhmm.slice(2)}` : hhmm;
}

/**
 * 당일 분봉을 라인+영역으로. 전일종가를 점선 기준선으로 깔아서
 * 그 위/아래 어디에 있었는지 한눈에 보이게 한다.
 */
export function IntradayFlow({ code, basePrice }: { code: string; basePrice: number }) {
  /*
   * 3분봉이라 장중에는 계속 새 봉이 붙는다. 30초마다 조용히 갱신한다 —
   * 5초로 잡아봐야 3분봉은 그대로라 호출만 늘어난다.
   * _AL(통합)로 요청해야 NXT 프리마켓(08:00~)·애프터마켓(~20:00)까지 들어온다.
   */
  const bare = code.replace(/_(AL|NX)$/, "");
  const { data: chart, loading, error } = useLive<RawRecord>(
    () => api.minuteChart(`${bare}_AL`, "3") as Promise<RawRecord>,
    [bare],
    30_000,
  );

  if (loading && !chart) return <div className="empty">당일 흐름 불러오는 중...</div>;
  if (error && !chart) return <div className="error-banner">{error}</div>;

  const points = todayPoints(chart);
  if (points.length < 2) return <div className="empty">당일 분봉 데이터가 없습니다.</div>;

  const prices = points.map((p) => p.price);
  const open = prices[0];
  const last = prices[prices.length - 1];
  const high = Math.max(...prices);
  const low = Math.min(...prices);

  // 기준선(전일종가)이 화면 밖으로 나가지 않도록 범위에 포함시킨다
  const base = basePrice > 0 ? basePrice : open;
  const top = Math.max(high, base);
  const bottom = Math.min(low, base);
  const range = top - bottom || 1;

  const W = 100;
  const H = 40;
  const x = (i: number) => (i / (points.length - 1)) * W;
  const y = (v: number) => H - ((v - bottom) / range) * H;

  const line = points.map((p, i) => `${x(i).toFixed(2)},${y(p.price).toFixed(2)}`).join(" ");
  const area = `0,${H} ${line} ${W},${H}`;
  const up = last >= base;
  const color = up ? "var(--red)" : "var(--blue)";

  const rate = base > 0 ? ((last - base) / base) * 100 : 0;

  // 정규장 시작(09:00)·종료(15:30) 지점을 찾아 세 구간으로 나눈다
  const openIdx = points.findIndex((p) => p.time >= "0900");
  const closeIdx = points.findIndex((p) => p.time > "1530");

  /* VWAP 선 — 정규장이 시작한 자리부터 */
  const vwaps = vwapSeries(points, openIdx);
  const vwapLine = vwaps
    .map((v, i) => (v === null ? null : `${x(i).toFixed(2)},${y(v).toFixed(2)}`))
    .filter((s): s is string => s !== null)
    .join(" ");
  const vwapNow = vwaps[vwaps.length - 1];
  /** 지금 값이 VWAP 위인가 — 색이 아니라 **이 한 줄**이 판을 가른다 */
  const vsVwap = vwapNow && vwapNow > 0 ? ((last - vwapNow) / vwapNow) * 100 : null;
  const regularStart = openIdx < 0 ? 0 : x(openIdx);
  const regularEnd = closeIdx < 0 ? W : x(closeIdx);
  const hasPre = openIdx > 0;
  const hasAfter = closeIdx > 0;

  return (
    <div className="intraday">
      <div className="intraday-head">
        <span className="intraday-title">당일 흐름</span>
        <span className="intraday-time">
          {fmtHm(points[0].time)} ~ {fmtHm(points[points.length - 1].time)}
        </span>
        <span className={`intraday-rate ${signOf(rate)}`}>
          {rate > 0 ? "+" : ""}
          {rate.toFixed(2)}%
        </span>
        {/* 선만 그려 놓으면 무슨 선인지 모른다 — 이름과 지금 값을 같이 적는다 */}
        {vwapNow !== null && vwapNow !== undefined && (
          <span
            className="intraday-vwap"
            title="거래량가중평균가 — 오늘 산 사람들의 평균 매입가입니다. 정규장만 셉니다. ⚠️ 3분봉 전형가로 낸 어림값"
          >
            VWAP <b>{fmtNum(Math.round(vwapNow))}</b>
            {vsVwap !== null && (
              <i className={signOf(vsVwap)}>
                {" "}
                {vsVwap > 0 ? "+" : ""}
                {vsVwap.toFixed(2)}%
              </i>
            )}
          </span>
        )}
      </div>

      <svg className="intraday-svg" viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none">
        {/* NXT 시간외 구간은 배경을 어둡게 깔아 정규장과 구분한다 */}
        {hasPre && <rect x="0" y="0" width={regularStart} height={H} className="intraday-off" />}
        {hasAfter && (
          <rect x={regularEnd} y="0" width={W - regularEnd} height={H} className="intraday-off" />
        )}
        {hasPre && <line x1={regularStart} x2={regularStart} y1="0" y2={H} className="intraday-div" />}
        {hasAfter && <line x1={regularEnd} x2={regularEnd} y1="0" y2={H} className="intraday-div" />}

        <polygon points={area} fill={color} opacity={0.16} />
        <polyline points={line} fill="none" stroke={color} strokeWidth={0.5} vectorEffect="non-scaling-stroke" />
        {/* 전일종가 기준선 */}
        <line
          x1="0"
          x2={W}
          y1={y(base)}
          y2={y(base)}
          stroke="var(--muted)"
          strokeWidth={0.4}
          strokeDasharray="2 2"
          vectorEffect="non-scaling-stroke"
        />
        {/*
          **VWAP** — 오늘 산 사람들의 평균 매입가. 선 위에 있으면 그들이 이기고 있다.
          가격선과 헷갈리지 않게 **점선에 다른 색**으로 둔다. 전일종가선(회색 점선)과도
          갈려야 해서 주황 계열이다.
        */}
        {vwapLine && (
          <polyline
            points={vwapLine}
            fill="none"
            stroke="var(--amber, #f5c542)"
            strokeWidth={0.45}
            strokeDasharray="3 2"
            vectorEffect="non-scaling-stroke"
          />
        )}
      </svg>

      {/* 구간 라벨 — 그래프 폭에 맞춰 비율로 배치 */}
      <div className="intraday-sessions">
        {hasPre && (
          <span className="intraday-session pre" style={{ width: `${regularStart}%` }}>
            프리마켓
          </span>
        )}
        <span className="intraday-session main" style={{ width: `${regularEnd - regularStart}%` }}>
          정규장
        </span>
        {hasAfter && (
          <span className="intraday-session after" style={{ width: `${W - regularEnd}%` }}>
            애프터마켓
          </span>
        )}
      </div>

      <div className="intraday-legend">
        {[
          { label: "시가", value: open },
          { label: "고가", value: high },
          { label: "저가", value: low },
        ].map((it) => {
          // 가격만으로는 몇 % 움직인 자리인지 감이 안 오므로 괄호로 등락률을 붙인다
          const r = base > 0 ? ((it.value - base) / base) * 100 : null;
          return (
            <span key={it.label}>
              {it.label}{" "}
              <strong className={signOf(it.value - base)}>
                {fmtNum(it.value)}
                {r !== null && ` (${r > 0 ? "+" : ""}${r.toFixed(2)}%)`}
              </strong>
            </span>
          );
        })}
        <span className="intraday-base">
          전일종가 <strong>{fmtNum(base)}</strong>
        </span>
      </div>
      <div className="table-note">
        3분봉 종가 기준 · 점선은 전일종가 · 어두운 구간은 NXT(넥스트레이드) 시간외
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- 프로그램 수급 막대

/**
 * 프로그램 순매수 일별 막대.
 * 키움 API는 종목별 "장중 시간대별" 프로그램 매매를 제공하지 않아
 * (ka90013은 일자별만) 최근 흐름을 일별로 보여주고 오늘 값을 강조한다.
 */
export function ProgramFlowBars({ code }: { code: string }) {
  const [data, setData] = useState<RawRecord | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    api
      .programTrend(code)
      .then((res) => {
        if (!cancelled) setData(res as RawRecord);
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
  }, [code]);

  if (loading) return <div className="empty">프로그램 수급 불러오는 중...</div>;
  if (error) return <div className="error-banner">{error}</div>;

  // 최신순으로 오므로 뒤집어서 과거→오늘 순으로
  const rows = pickList(data ?? undefined, ["stk_daly_prm_trde_trnsn"]).slice(0, 20).reverse();
  if (rows.length === 0) return <div className="empty">프로그램 매매 데이터가 없습니다.</div>;

  const values = rows.map((r) => num(r.prm_netprps_amt));
  const maxAbs = Math.max(...values.map(Math.abs), 1);
  const today = values[values.length - 1];

  return (
    <div className="progflow">
      <div className="intraday-head">
        <span className="intraday-title">프로그램 순매수 (최근 {rows.length}일)</span>
        <span className={`intraday-rate ${signOf(today)}`}>
          오늘 {today > 0 ? "+" : ""}
          {fmtNum(today)}
        </span>
      </div>

      <div className="progflow-bars">
        {rows.map((r, i) => {
          const v = values[i];
          const h = (Math.abs(v) / maxAbs) * 50; // 0선 기준 위/아래 최대 50%
          const isToday = i === rows.length - 1;
          const dt = String(r.dt ?? "");
          return (
            <div className="progflow-col" key={dt || i} title={`${dt} · ${fmtNum(v)}백만원`}>
              <div className="progflow-slot">
                <div
                  className={`progflow-bar ${v >= 0 ? "up" : "down"}${isToday ? " today" : ""}`}
                  style={v >= 0 ? { height: `${h}%`, bottom: "50%" } : { height: `${h}%`, top: "50%" }}
                />
                <div className="progflow-zero" />
              </div>
              <div className="progflow-label">{dt.slice(6, 8)}</div>
            </div>
          );
        })}
      </div>
      <div className="table-note">
        단위: 백만원 · 위(빨강)가 프로그램 순매수 · 맨 오른쪽 진한 막대가 오늘 ·
        키움 API는 종목별 장중 시간대 프로그램 데이터를 제공하지 않아 일별로 표시합니다
      </div>
    </div>
  );
}
