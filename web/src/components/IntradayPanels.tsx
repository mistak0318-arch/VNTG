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
/**
 * **머리줄용 작은 선** (2026-10-12) — 같은 분봉으로 선만 그린다.
 *
 * 제목·VWAP·눈금은 없다. 머리줄에서는 「어떻게 와서 지금 얼마인가」의 **모양**만 보면 되고,
 * 숫자는 바로 옆에 이미 크게 있다. 자리에 안 맞는 부품을 잘라 쓰려다 글자 줄만 남은 적이
 * 있어(10/12) 그 용도로 새로 그린다.
 *
 * ⚠️ 데이터는 **받아서 쓴다.** 제가 또 불러오면 같은 분봉을 한 종목에 두 번 받는다 —
 * 그림 하나 더 그리자고 조회를 늘리지 않는다.
 */
/**
 * **장전·장중·장마감 뒤를 갈라 보인다** (2026-10-15 — 벤티지: "미니스파크 표시할 때
 * 장전 장중 장마감후 표시를 좀 할 수 있나?").
 *
 * 이 선은 `_AL`(통합) 분봉이라 **NXT 프리마켓(08:00~)과 애프터(~20:00)가 같이 들어 있다.**
 * 그래서 아침에 보면 왼쪽 끝이 이미 출렁이고, 저녁에 보면 오른쪽 끝이 더 붙는다 —
 * 그 구간이 정규장과 똑같이 생겨서 **어디부터가 오늘 본장인지**가 안 보였다.
 *
 * 88×34 짜리 그림이다. 세로선과 글자를 넣으면 선 자체를 덮어 버리므로 **옅은 음영**으로
 * 가른다 — 음영이 깔린 쪽이 정규장 **밖**이다. 모양을 읽는 데는 그 한 겹이면 된다.
 *
 * ⚠️ x 는 **봉 번호**로 잡는다(시간 비례가 아니다). 거래가 없어 빠진 분이 있으면 그만큼
 * 폭이 줄지만, 선 자체가 이미 그 규칙으로 그려져 있어 **음영과 선이 어긋나지 않는다.**
 * 여기서 시간 비례로 바꾸면 둘이 따로 논다.
 */
function sessionBands(points: Point[], W: number): { pre: number; post: number } {
  const n = points.length;
  const at = (i: number) => (i / (n - 1)) * W;
  /* 09:00 보다 앞 = 프리마켓 */
  const firstReg = points.findIndex((p) => p.time >= "0900");
  /* 15:30 을 넘어선 첫 봉 = 애프터 (정규장 마지막 봉까지는 본장이다) */
  const firstPost = points.findIndex((p) => p.time > "1530");
  return {
    /* 아직 09시 전이면(프리마켓만 있는 아침) **전부** 장전이다 — 못 찾은 것과 없는 것은 다르다 */
    pre: firstReg === -1 ? W : firstReg > 0 ? at(firstReg) : 0,
    post: firstPost === 0 ? W : firstPost > 0 ? W - at(firstPost) : 0,
  };
}

export function IntradaySpark({ chart, basePrice }: { chart: RawRecord | null; basePrice: number }) {
  const points = todayPoints(chart);
  if (points.length < 2) return null;
  const prices = points.map((p) => p.price);
  const base = basePrice > 0 ? basePrice : prices[0];
  const last = prices[prices.length - 1];
  const top = Math.max(...prices, base);
  const bottom = Math.min(...prices, base);
  const range = top - bottom || 1;
  const W = 100;
  const H = 30;
  const line = points
    .map((p, i) => `${((i / (points.length - 1)) * W).toFixed(2)},${(H - ((p.price - bottom) / range) * H).toFixed(2)}`)
    .join(" ");
  const up = last >= base;
  const band = sessionBands(points, W);
  const title = [
    band.pre > 0 ? "장전(NXT 프리)" : null,
    "정규장",
    band.post > 0 ? "장마감 뒤(애프터)" : null,
  ]
    .filter(Boolean)
    .join(" · ");
  return (
    <svg className="sd-spark" viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" role="img" aria-label={`당일 흐름 — ${title}`}>
      <title>{`${title} · 음영은 정규장 밖`}</title>
      {/* 음영 = 정규장 밖. 선보다 **먼저** 그려야 선을 안 덮는다 */}
      {band.pre > 0 && <rect x="0" y="0" width={band.pre} height={H} className="sd-spark-off" />}
      {band.post > 0 && <rect x={W - band.post} y="0" width={band.post} height={H} className="sd-spark-off" />}
      {/* 기준선(전일 종가) — 이 선 위냐 아래냐가 당일 흐름의 전부다 */}
      <line x1="0" x2={W} y1={H - ((base - bottom) / range) * H} y2={H - ((base - bottom) / range) * H} className="sd-spark-base" />
      <polyline points={line} className={`sd-spark-line ${up ? "up" : "down"}`} />
    </svg>
  );
}

export function IntradayFlow({
  code,
  basePrice,
  chart: given,
}: {
  code: string;
  basePrice: number;
  /** 바깥이 이미 들고 있으면 그것을 쓴다 — 같은 분봉을 두 번 받지 않으려고 (2026-10-12) */
  chart?: RawRecord | null;
}) {
  /*
   * 3분봉이라 장중에는 계속 새 봉이 붙는다. 30초마다 조용히 갱신한다 —
   * 5초로 잡아봐야 3분봉은 그대로라 호출만 늘어난다.
   * _AL(통합)로 요청해야 NXT 프리마켓(08:00~)·애프터마켓(~20:00)까지 들어온다.
   */
  const bare = code.replace(/_(AL|NX)$/, "");
  /* 바깥이 주면 안 부른다 — 훅은 조건부로 못 부르므로 키를 비워 쉬게 한다 */
  const live = useLive<RawRecord>(
    () => (given !== undefined ? Promise.resolve(given as RawRecord) : (api.minuteChart(`${bare}_AL`, "3") as Promise<RawRecord>)),
    [bare, given],
    30_000,
  );
  const chart = given !== undefined ? given : live.data;
  const loading = given !== undefined ? false : live.loading;
  const error = given !== undefined ? null : live.error;

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

  /*
   * 정규장 시작(09:00)·종료(15:30) 지점을 찾아 세 구간으로 나눈다.
   * 앞뒤 어두운 구간은 **정규장 밖**이다 — 9/13 까지는 NXT 시간외뿐이고,
   * 9/14 부터는 16:00~20:00 KRX 애프터마켓도 여기 들어온다 (2026-09-12).
   * 봉이 실제로 있는 자리를 보고 가르므로 시각을 다시 셀 일은 없다.
   */
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
        3분봉 종가 기준 · 점선은 전일종가 · 어두운 구간은 정규장 밖(프리·애프터)
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
  /*
   * **오늘이 0 이면 지난 장을 적는다** (2026-10-13 — 벤티지: "아직도 0인데 얘네는").
   *
   * 새벽·장 전에는 키움이 이미 새 날이라 오늘 줄이 0 으로 온다. 그걸 「오늘 0」이라 적으면
   * 「프로그램이 오늘 아무것도 안 샀다」는 **사실처럼 보이는 거짓말**이 된다 —
   * 실제로는 아직 오늘이 시작되지 않았다. 값이 들어오면 저절로 오늘로 돌아간다.
   */
  const lastIdx = values.length - 1;
  const stale = values[lastIdx] === 0 && values.length >= 2;
  const shownIdx = stale ? lastIdx - 1 : lastIdx;
  const today = values[shownIdx];
  const shownDt = String(rows[shownIdx]?.dt ?? "");
  const whenLabel = stale ? `${shownDt.slice(4, 6)}/${shownDt.slice(6, 8)}` : "오늘";

  return (
    <div className="progflow">
      <div className="intraday-head">
        <span className="intraday-title">프로그램 순매수 (최근 {rows.length}일)</span>
        <span className={`intraday-rate ${signOf(today)}`}>
          {whenLabel} {today > 0 ? "+" : ""}
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
