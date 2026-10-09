import { useEffect, useState } from "react";
import { api, pickList, type RawRecord } from "../api";
import { StrengthChart, type StrengthPoint } from "./StrengthChart";
import { useTabActive } from "../tabActive";

/**
 * 체결강도 **오늘 흐름** — 호가 화면의 강도 막대 바로 아래 (2026-10-08).
 *
 * 벤티지: "각 종목별로 체결강도 이렇게 보여주잖아. 이거 체결강도 그래프로 보여줄 수 있어?
 * 그래서 아, 장 초반엔 체결강을 셌다가 이게 체결강 좀 떨어지네? 이렇게 할 수 있도록."
 *
 * ## 왜 여기인가
 *
 * 그래프는 **이미 있었다**(`StrengthChart`). 다만 체결강도 **탭** 안에서만 그려졌다.
 * 사람이 강도를 보는 자리는 호가 화면의 그 막대인데 그래프가 다른 탭에 있으면 안 본다.
 * 같은 부품을 그 자리로 가져온다 — 두 벌로 그리면 언젠가 둘이 다른 말을 한다.
 *
 * ## 하루치 (2026-10-08 고침)
 *
 * 처음엔 `ka10046` 을 한 번만 불렀는데 **그건 최근 60분뿐**이었다(실측: 18:03 에 17:04~18:03).
 * 벤티지: "장 중에 어땠는지 알 수가 없네" — 맞다. 「장 초반엔 셌는데 식네」를 보라고 만든
 * 줄인데 한 시간짜리 창으로는 쓸모가 없었다. 서버(`strengthDay`)가 연속조회로 **08:00 까지
 * 뒤로 걸어가** 하루치를 모아 들고 있다가, 그 뒤로는 맨 앞 한 쪽만 덧댄다 — 프리장부터
 * 애프터까지가 한 줄에 들어온다.
 *
 * 우리가 1분마다 찍어 쌓는 길은 **버렸다** — 서버가 꺼져 있던 구간이 비기 때문이다.
 * 실시간(`0B` FID 228)으로 쌓는 틀도 이미 있지만 그건 **물고 있던 종목만** 남는다.
 * 오늘 처음 누른 종목에도 하루가 다 보여야 한다.
 *
 * ## 얼마나 자주 묻나
 *
 * 흐름은 **분 단위로 바뀌는 값**이라 막대(실시간)처럼 1초마다 물을 까닭이 없다. 1분이면 된다.
 * 숨은 탭에서는 아예 안 묻는다 — 탭은 `display:none` 이라 열어 둔 수만큼 조회가 배가된다.
 */

const REFRESH_MS = 60_000;
/**
 * 하루치가 **아직 덜 왔을 때**만 잠깐 자주 묻는다 (2026-10-10).
 *
 * 서버가 08:00 까지 뒤로 걷는 일을 요청 안에서 하다가 화면 전체를 멈춰 세웠다(최고 59초).
 * 이제 걷기는 뒤에서 돌고 첫 응답은 **최근 한 시간**만 담겨 온다. 그 상태로 60초를
 * 기다리면 사람 눈에는 「하루치가 안 나온다」로 보인다 — 채워지는 동안만 4초로 당긴다.
 * 서버는 20초 안의 재요청을 캐시로 돌려주므로 이 빠른 물음에 조회가 안 붙는다.
 */
const FILLING_MS = 4_000;
/** 아침이 들어왔으면 다 온 것으로 본다 — 09:00 전 점이 있으면 프리장까지 닿은 것 */
const MORNING = "0900";
/** 영영 안 차는 종목(거래가 뜸해 줄이 적은 날)에 4초마다 묻지 않게 */
const MAX_FAST_TRIES = 10;

function toPoints(rows: RawRecord[]): StrengthPoint[] {
  const n = (v: unknown) => Number(String(v ?? "").replace(/[+,\s]/g, "")) || 0;
  return rows
    .map((r) => ({
      t: String(r.cntr_tm ?? ""),
      strength: n(r.cntr_str),
      avg: n(r.cntr_str_20min),
      price: Math.abs(n(r.cur_prc)),
      rate: n(r.flu_rt),
    }))
    .filter((p) => p.t.length >= 4 && p.strength > 0)
    /* 키움은 최신순으로 준다 — 왼쪽이 과거가 되게 뒤집는다 */
    .reverse();
}

export function StrengthTrendLine({ code }: { code: string }) {
  const [points, setPoints] = useState<StrengthPoint[]>([]);
  const active = useTabActive();

  useEffect(() => {
    if (!code || !active) return;
    let alive = true;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let fast = 0;
    /*
     * `setInterval` 이 아니라 **한 번 받고 다음을 잡는다.** 하루치가 덜 왔는지 보고
     * 다음 간격을 정해야 하는데, 고정 간격으로는 그 판단을 끼워 넣을 자리가 없다.
     */
    const load = () => {
      void api
        .strength(code, "time")
        .then((d) => {
          if (!alive) return;
          const pts = toPoints(pickList(d as RawRecord, ["cntr_str_tm"]));
          setPoints(pts);
          const gotMorning = pts.length > 0 && pts[0].t.slice(0, 4) <= MORNING;
          const filling = !gotMorning && fast < MAX_FAST_TRIES;
          if (filling) fast += 1;
          timer = setTimeout(load, filling ? FILLING_MS : REFRESH_MS);
        })
        .catch(() => {
          /* 못 받으면 선을 안 그린다 — 막대는 그대로 보인다. 다음 차례는 그대로 잡는다 */
          if (alive) timer = setTimeout(load, REFRESH_MS);
        });
    };
    load();
    return () => {
      alive = false;
      if (timer) clearTimeout(timer);
    };
  }, [code, active]);

  /* 점이 둘 미만이면 `StrengthChart` 가 스스로 안 그린다 — 장 시작 직후가 그렇다 */
  if (points.length < 2) return null;
  const first = points[0].strength;
  const last = points[points.length - 1].strength;
  const diff = last - first;
  return (
    <div className="ob-str-trend">
      <div className="ob-str-trend-h">
        <span>오늘 흐름</span>
        {/*
          **말로 한 줄** — 선만 두면 「올랐나 내렸나」를 눈으로 가늠해야 한다.
          이 줄을 보는 까닭이 그것이라 먼저 적는다. 10 미만은 「비슷」으로 둔다 —
          잔물결에 이름을 붙이면 없는 흐름을 지어내는 것이다.
        */}
        <b className={diff >= 10 ? "positive" : diff <= -10 ? "negative" : ""}>
          {first.toFixed(0)} → {last.toFixed(0)}
          {diff >= 10 ? " · 세지는 중" : diff <= -10 ? " · 식는 중" : " · 비슷"}
        </b>
      </div>
      <StrengthChart points={points} />
    </div>
  );
}
