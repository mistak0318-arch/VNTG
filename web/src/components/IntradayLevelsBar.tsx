import { useEffect, useState } from "react";
import { api, fmtNum, type IntradayLevels } from "../api";

/**
 * 장중 기준선 — **VWAP · 시가갭 · 전일고저 · 장초반 30분.**
 *
 * ## 왜 필요했나
 *
 * 이 화면은 호가·거래원·체결·분봉을 다 갖고 있는데 **가격을 견줄 선이 없었다.**
 * 체결강도에는 100 기준선까지 그려 놓고 정작 가격 쪽이 비어 있었다. 값이 아무리
 * 많아도 견줄 선이 없으면 「지금 비싼가 싼가」를 못 판단한다.
 *
 * ## 왜 이 다섯인가
 *
 * 데이트레이더가 화면에서 제일 먼저 찾는 것들이다. 더 넣을 수 있지만 넣을수록
 * **아무것도 안 보인다** — 한 줄에 다 들어와야 곁눈으로 읽힌다.
 *
 * ## 색의 뜻
 *
 * 오르내림이 아니라 **「기준선 위인가 아래인가」**를 칠한다. VWAP 위면 오늘 산
 * 사람들이 이기고 있는 것이고, 전일 고가를 넘었으면 어제의 싸움을 이긴 것이다.
 * 그래서 **하락 중이어도 VWAP 위면 초록**이다 — 그게 이 줄이 말하려는 것이다.
 */

function pct(n: number | null): string {
  if (n === null || !Number.isFinite(n)) return "-";
  return `${n > 0 ? "+" : ""}${n.toFixed(2)}%`;
}

/** 기준선 하나 — 값과 「지금이 그 위냐 아래냐」 */
function Level({
  label,
  value,
  above,
  extra,
  title,
}: {
  label: string;
  value: number | null;
  /** 지금 값이 이 선 위인가. `null` 이면 색을 안 칠한다 */
  above: boolean | null;
  extra?: string;
  title?: string;
}) {
  if (value === null) return null;
  return (
    <span className="idl-item" title={title}>
      <em>{label}</em>
      <b className={above === null ? "" : above ? "positive" : "negative"}>
        {fmtNum(Math.round(value))}
      </b>
      {extra && <i>{extra}</i>}
    </span>
  );
}

export function IntradayLevelsBar({ code }: { code: string }) {
  const [lv, setLv] = useState<IntradayLevels | null>(null);

  useEffect(() => {
    if (!code) return;
    let alive = true;
    setLv(null);
    api
      .intraday(code)
      .then((r) => alive && setLv(r.levels))
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, [code]);

  /*
   * 장 시작 전이면 오늘 분봉이 아예 없다. 그때는 **아무것도 안 그린다** —
   * 빈 칸을 「-」로 채워 두면 값이 있는 줄 알고 자리만 차지한다.
   */
  if (!lv) return null;

  const p = lv.price;

  return (
    <div className="idl">
      <Level
        label="VWAP"
        value={lv.vwap}
        above={lv.vwap === null ? null : p >= lv.vwap}
        extra={lv.vsVwap === null ? undefined : pct(lv.vsVwap)}
        title="거래량가중평균가 — 오늘 산 사람들의 평균 매입가입니다. 위면 그들이 이기고 있습니다. ⚠️ 분봉 전형가로 낸 어림값입니다"
      />
      <Level
        label="시가"
        value={lv.open}
        above={p >= lv.open}
        extra={
          lv.gapPct === null
            ? undefined
            : `갭 ${pct(lv.gapPct)}${lv.gapFilled === null ? "" : lv.gapFilled ? " · 메움" : " · 안 메움"}`
        }
        title="오늘 시가와 전일 종가 대비 갭. 「메움」은 전일 종가까지 되돌아왔다는 뜻입니다"
      />
      <Level
        label="전일고"
        value={lv.prevHigh}
        above={lv.prevHigh === null ? null : p > lv.prevHigh}
        title="어제 고가 — 넘었으면 어제의 싸움을 이긴 것입니다"
      />
      <Level
        label="전일저"
        value={lv.prevLow}
        above={lv.prevLow === null ? null : p > lv.prevLow}
        title="어제 저가 — 깨졌으면 어제 산 사람이 전부 물린 것입니다"
      />
      {/*
        장초반 30분은 **두 값이 짝**이라 하나로 묶는다. 고·저를 떼어 놓으면
        「레인지」라는 뜻이 사라진다 — 그 사이에 있는지가 핵심이다.
      */}
      {lv.or30High !== null && lv.or30Low !== null && (
        <span
          className="idl-item"
          title="09:00~09:30 의 고·저. 그날의 1차 지지·저항입니다. 위로 뚫으면 추세, 안에 갇히면 눈치보기입니다"
        >
          <em>장초반30</em>
          <b
            className={
              p > lv.or30High ? "positive" : p < lv.or30Low ? "negative" : ""
            }
          >
            {fmtNum(Math.round(lv.or30Low))}~{fmtNum(Math.round(lv.or30High))}
          </b>
          <i>{p > lv.or30High ? "위로 뚫음" : p < lv.or30Low ? "아래로 이탈" : "안에 있음"}</i>
        </span>
      )}
      <span className="idl-note" title={`${lv.date} · 5분봉 ${lv.bars}개로 냈습니다`}>
        5분봉 {lv.bars}개 · VWAP 은 어림값
      </span>
    </div>
  );
}
