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
 * ## 쌓을 필요가 없다
 *
 * 처음엔 실시간 값을 1분마다 적어 쌓으려 했는데, **키움이 `ka10046` 으로 시간별을 이미 준다**
 * (5·20분 평균까지). 우리가 쌓으면 서버가 꺼져 있던 구간이 비지만 이건 09:00부터 온전하다.
 * 안 쓰고 있던 길이 있었던 것이지 없던 길이 아니었다.
 *
 * ## 얼마나 자주 묻나
 *
 * 흐름은 **분 단위로 바뀌는 값**이라 막대(실시간)처럼 1초마다 물을 까닭이 없다. 1분이면 된다.
 * 숨은 탭에서는 아예 안 묻는다 — 탭은 `display:none` 이라 열어 둔 수만큼 조회가 배가된다.
 */

const REFRESH_MS = 60_000;

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
    const load = () => {
      void api
        .strength(code, "time")
        .then((d) => {
          if (alive) setPoints(toPoints(pickList(d as RawRecord, ["cntr_str_tm"])));
        })
        .catch(() => {
          /* 못 받으면 선을 안 그린다 — 막대는 그대로 보인다 */
        });
    };
    load();
    const t = setInterval(load, REFRESH_MS);
    return () => {
      alive = false;
      clearInterval(t);
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
