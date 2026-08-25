import { useEffect, useState } from "react";
import { api, fmtNum, type StockSummaryData } from "../api";

/**
 * **오늘 누가 샀나** — 장중 수급 요약.
 *
 * ## ⚠️ 지표는 여기 없다
 *
 * 처음엔 시총·회전율·체결강도까지 여기에 넣었다가 뺐다. 그 값들은 **요약줄
 * (`PriceHeader`)에 이미 있다** — 같은 값을 두 번 그린 것이다. 그러면 언젠가 한쪽만
 * 고쳐져서 같은 종목이 한 화면에서 다른 숫자를 말한다. 이 앱에서 여러 번 겪은 사고다.
 *
 * 그래서 **지표는 요약줄이 맡고**(회전율도 거기로 옮겼다), 여기는 수급만 한다.
 *
 * ## 기관은 반드시 쪼갠다
 *
 * 「기관 +127억」만 적으면 **누가 샀는지 모른다.** 연기금이 산 것과 투신이 산 것은
 * 다음 날 이어질 확률이 다르다. 실제로 오늘 삼성전자는 기관 전체로는 +127억인데
 * 안을 보면 **연기금 +234억, 투신 −108억**이었다 — 한 덩어리로는 안 보이는 이야기다.
 *
 * 0 인 창구는 안 그린다. 안 움직인 것을 늘어놓으면 움직인 게 묻힌다.
 */

function eok(millionWon: number): string {
  /* 키움은 백만원으로 준다. 100 백만원 = 1억 */
  const v = millionWon / 100;
  if (Math.abs(v) >= 10000) return `${(v / 10000).toFixed(2)}조`;
  return `${fmtNum(Math.round(v))}억`;
}

function cls(n: number): string {
  return n > 0 ? "positive" : n < 0 ? "negative" : "";
}

/** 순매수 한 줄 — 이름·금액·막대 */
function FlowRow({ label, amount, max }: { label: string; amount: number; max: number }) {
  const w = max > 0 ? Math.min(100, (Math.abs(amount) / max) * 100) : 0;
  return (
    <div className="ss-flow">
      <span className="ss-flow-k">{label}</span>
      {/*
        막대는 **가운데에서 좌우로** 뻗는다. 왼쪽 끝에서 시작하면 매수와 매도가
        같은 방향으로 자라서 부호를 숫자로만 읽어야 한다 — 그림의 뜻이 없어진다.
      */}
      <span className="ss-flow-bar">
        <i
          className={amount >= 0 ? "up" : "down"}
          style={{ width: `${w / 2}%`, [amount >= 0 ? "left" : "right"]: "50%" }}
        />
      </span>
      <b className={`num ${cls(amount)}`}>
        {amount > 0 ? "+" : ""}
        {eok(amount)}
      </b>
    </div>
  );
}

export function StockSummaryPanel({ code }: { code: string }) {
  const [d, setD] = useState<StockSummaryData | null>(null);

  useEffect(() => {
    if (!code) return;
    let alive = true;
    setD(null);
    const load = () =>
      api
        .stockSummary(code)
        .then((r) => alive && setD(r))
        .catch(() => undefined);
    void load();
    /* 장중에는 수급도 체결강도도 계속 바뀐다 — 첫 화면 값이 멈춰 있으면 안 된다 */
    const t = setInterval(() => void load(), 30_000);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, [code]);

  if (!d) return null;

  /* 막대 기준 — 그 표 안에서 제일 큰 것. 표마다 따로여야 작은 값이 안 사라진다 */
  const maxMain = Math.max(1, ...d.main.map((r) => Math.abs(r.amount)));
  const maxInst = Math.max(1, ...d.institution.map((r) => Math.abs(r.amount)));

  return (
    <div className="ss">
      <div className="ss-flows">
        <div className="ss-col">
          <div className="ss-sub">
            오늘 수급
            <i>순매수 · 금액</i>
          </div>
          {d.main.length === 0 ? (
            <div className="ss-none">아직 집계 전입니다.</div>
          ) : (
            d.main.map((r) => <FlowRow key={r.key} label={r.label} amount={r.amount} max={maxMain} />)
          )}
          {/*
            프로그램은 **개인·외국인·기관과 겹치는 값**이다(그 안에 섞여 있다).
            더하면 안 되므로 줄을 갈라 놓고 그렇다고 적는다.
          */}
          {d.program !== null && (
            <>
              <div className="ss-sep" />
              <FlowRow label="프로그램" amount={d.program} max={Math.abs(d.program) || 1} />
              <div className="ss-note">
                프로그램은 위 셋과 <b>겹치는 값</b>입니다 — 더하지 마세요.
              </div>
            </>
          )}
        </div>

        <div className="ss-col">
          <div className="ss-sub">
            기관 안쪽
            <i>움직인 창구만</i>
          </div>
          {d.institution.length === 0 ? (
            <div className="ss-none">기관 세부가 아직 없습니다.</div>
          ) : (
            d.institution.map((r) => (
              <FlowRow key={r.key} label={r.label} amount={r.amount} max={maxInst} />
            ))
          )}
        </div>
      </div>

      {/* 못 받은 조각은 **못 받았다고 적는다** — 0 으로 보이면 「안 움직였다」로 읽힌다 */}
      {d.missing.length > 0 && (
        <div className="ss-note">⚠️ {d.missing.join(" · ")} 을(를) 못 받았습니다.</div>
      )}
    </div>
  );
}
