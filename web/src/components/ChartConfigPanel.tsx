import { useState } from "react";
import { TIP_FIELDS, useChartPrefs, type TipField } from "../useChartPrefs";

/**
 * 차트 설정.
 *
 * 이동평균을 무엇무엇 그릴지, 볼린저를 쓸지, 매물대를 띄울지, 봉을 눌렀을 때 무엇을 볼지.
 * 전부 보는 사람마다 다르다 — 13일선을 쓰는 사람이 있고 볼린저를 안 보는 사람이 있다.
 *
 * 값은 기기별(localStorage)이다. 폰에서는 선을 줄이고 PC 에서는 늘리고 싶을 수 있다.
 */

/** 매물대를 몇 거래일치로 볼지 — 자주 쓰는 값만 */
const PROFILE_DAYS = [60, 120, 250];

export function ChartConfigPanel() {
  const { prefs, set, reset } = useChartPrefs();
  const [adding, setAdding] = useState("");

  function toggleMa(period: number) {
    set({ ...prefs, ma: prefs.ma.map((m) => (m.period === period ? { ...m, on: !m.on } : m)) });
  }

  function setColor(period: number, color: string) {
    set({ ...prefs, ma: prefs.ma.map((m) => (m.period === period ? { ...m, color } : m)) });
  }

  function removeMa(period: number) {
    set({ ...prefs, ma: prefs.ma.filter((m) => m.period !== period) });
  }

  function addMa() {
    const n = Number(adding);
    if (!Number.isFinite(n) || n < 2 || n > 480) return;
    if (prefs.ma.some((m) => m.period === n)) return;
    set({
      ...prefs,
      ma: [...prefs.ma, { period: n, color: "#e0a0ff", on: true }].sort(
        (a, b) => a.period - b.period,
      ),
    });
    setAdding("");
  }

  function toggleTip(key: TipField) {
    const on = prefs.tip.includes(key);
    set({ ...prefs, tip: on ? prefs.tip.filter((t) => t !== key) : [...prefs.tip, key] });
  }

  const onCount = prefs.ma.filter((m) => m.on).length;

  return (
    <div className="cc-config">
      {/* ---------------- 이동평균 ---------------- */}
      <section className="cc-group">
        <div className="cc-title">
          <b>이동평균선</b>
          <small>켠 것만 그립니다 ({onCount}개). 색을 누르면 바꿀 수 있습니다</small>
        </div>
        <div className="cc-ma-rows">
          {prefs.ma.map((m) => (
            <div className={`cc-ma-row${m.on ? "" : " off"}`} key={m.period}>
              <label className="cc-ma-name">
                <input type="checkbox" checked={m.on} onChange={() => toggleMa(m.period)} />
                <span>{m.period}일선</span>
              </label>
              <input
                type="color"
                className="cc-color"
                value={m.color}
                disabled={!m.on}
                onChange={(e) => setColor(m.period, e.target.value)}
                title="선 색"
              />
              {/* 기본 일곱 개는 지우지 못하게 — 지우면 되살릴 방법이 화면에 없다 */}
              {![5, 10, 13, 20, 60, 120, 240].includes(m.period) && (
                <button className="cc-del" onClick={() => removeMa(m.period)} title="이 선 삭제">
                  ✕
                </button>
              )}
            </div>
          ))}
        </div>
        <div className="cc-add">
          <input
            type="number"
            min={2}
            max={480}
            placeholder="직접 추가 (예: 33)"
            value={adding}
            onChange={(e) => setAdding(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && addMa()}
          />
          <button className="filter-btn" onClick={addMa}>
            추가
          </button>
        </div>
      </section>

      {/* ---------------- 볼린저 ---------------- */}
      <section className="cc-group">
        <div className="cc-title">
          <b>볼린저 밴드</b>
          <small>
            이동평균 ± 표준편차×배수. <b>가운데 선은 그리지 않습니다</b> — 이평선과 겹칩니다
          </small>
        </div>
        <div className="cc-inline">
          <label>
            <input
              type="checkbox"
              checked={prefs.bbOn}
              onChange={(e) => set({ ...prefs, bbOn: e.target.checked })}
            />
            사용
          </label>
          <label>
            기간
            <input
              type="number"
              min={2}
              max={200}
              value={prefs.bbPeriod}
              disabled={!prefs.bbOn}
              onChange={(e) => set({ ...prefs, bbPeriod: Math.max(2, Number(e.target.value) || 20) })}
            />
          </label>
          <label>
            표준편차
            <input
              type="number"
              min={0.5}
              max={4}
              step={0.5}
              value={prefs.bbStdDev}
              disabled={!prefs.bbOn}
              onChange={(e) => set({ ...prefs, bbStdDev: Number(e.target.value) || 2 })}
            />
            배
          </label>
        </div>
      </section>

      {/* ---------------- 판독 줄 ---------------- */}
      <section className="cc-group">
        <div className="cc-title">
          <b>차트 위 판독 줄</b>
          <small>정배열 여부·이동평균값·52주 자리·거래량 배수·매물대. 추가 조회는 없습니다</small>
        </div>
        <div className="cc-inline">
          <label>
            <input
              type="checkbox"
              checked={prefs.insightsOn}
              onChange={(e) => set({ ...prefs, insightsOn: e.target.checked })}
            />
            사용
          </label>
          <label>
            <input
              type="checkbox"
              checked={prefs.profileOn}
              disabled={!prefs.insightsOn}
              onChange={(e) => set({ ...prefs, profileOn: e.target.checked })}
            />
            매물대 표시
          </label>
          <label>
            매물대 기간
            <select
              value={prefs.profileDays}
              disabled={!prefs.insightsOn || !prefs.profileOn}
              onChange={(e) => set({ ...prefs, profileDays: Number(e.target.value) })}
            >
              {PROFILE_DAYS.map((d) => (
                <option key={d} value={d}>
                  {d}일
                </option>
              ))}
            </select>
          </label>
        </div>
      </section>

      {/* ---------------- 말풍선 ---------------- */}
      <section className="cc-group">
        <div className="cc-title">
          <b>봉을 눌렀을 때</b>
          <small>다 켜면 열 줄이 넘어 봉을 가립니다. 종가는 늘 표시됩니다</small>
        </div>
        <div className="mg-picker">
          {TIP_FIELDS.map((f) => {
            const on = prefs.tip.includes(f.key);
            return (
              <button
                key={f.key}
                className={`mg-chip${on ? " on" : ""}`}
                title={f.hint}
                onClick={() => toggleTip(f.key)}
              >
                {on ? "☑" : "☐"} {f.label}
              </button>
            );
          })}
        </div>
      </section>

      <div className="filter-row">
        <button className="filter-btn" onClick={reset}>
          기본값으로
        </button>
        <span className="pt-n">바꾸면 바로 적용됩니다 — 저장 버튼이 없습니다</span>
      </div>
    </div>
  );
}
