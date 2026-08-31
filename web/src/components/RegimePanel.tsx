import { useCallback, useEffect, useState } from "react";
import { api, type RegimeConfig, type RegimeResult, type RegimeSnap } from "../api";

/**
 * 장세 점검 (2026-08-31 벤티지 요청).
 *
 * "신호등은 시장 색깔에 따라 매번 달라질 거야. 그럼 내가 그 시장의 중요한 변화의
 * 순간을 감지할 수 있는 어떤 그런 장치도 필요하다고 봐 … 그럼 내가 그걸 보고
 * 아 다시금 재정비해야겠구나, 그럼 어떻게 재정비해야 될지 백테스트 어떻게 해야
 * 될지 그런 장치를."
 *
 * ## 이 화면이 답하는 물음
 *
 * 「신호등을 지금 다시 손봐야 하나?」 하나다. 그래서 지표를 나열하는 데서 끝내지
 * 않고, 무엇이 걸렸을 때 **무엇을 하면 되는지**까지 적는다.
 *
 * ## 왜 이 지표들인가
 *
 * 아무 시장 지표나 고른 게 아니라 **지금 신호등이 실제로 먹고 사는 것**을 고른다.
 * 기본값의 추세 축은 「60일 신고가」 하나뿐이라, 신고가가 마르면 초록 자체가
 * 안 나온다 — 그건 시장 얘기가 아니라 **이 도구가 지금 할 일이 없다**는 얘기다.
 *
 * ## 조회 0회
 *
 * 일봉 캐시(2,300여 종목)로 계산한다. 비싸면 안 재게 되고, 안 재면 장치가 없는
 * 것과 같다.
 */

const N = (v: number | null | undefined, suffix = ""): string =>
  v === null || v === undefined || !Number.isFinite(v) ? "-" : `${v}${suffix}`;

/** 변화의 방향에 색을 준다 — 폭·신고가는 늘면 좋고, 변동성은 줄면 좋다 */
function delta(now: number | null, then: number | null, goodUp: boolean) {
  if (now === null || then === null || !Number.isFinite(now) || !Number.isFinite(then)) {
    return { text: "-", cls: "" };
  }
  const d = now - then;
  const good = goodUp ? d > 0 : d < 0;
  return {
    text: `${d > 0 ? "+" : ""}${Math.round(d * 10) / 10}`,
    cls: Math.abs(d) < 0.05 ? "" : good ? "positive" : "negative",
  };
}

const ROWS: {
  key: keyof RegimeSnap;
  label: string;
  suffix: string;
  goodUp: boolean;
  hint: string;
}[] = [
  {
    key: "breadth",
    label: "20일선 위 종목",
    suffix: "%",
    goodUp: true,
    hint: "장세의 방향 그 자체입니다. 크게 줄면 추세추종 기준이 먼저 무너집니다",
  },
  {
    key: "newHigh",
    label: "60일 신고가 근처",
    suffix: "%",
    goodUp: true,
    hint: "신호등의 밥줄입니다 — 추세 축이 「60일 신고가」 하나뿐이라 이게 마르면 초록이 안 나옵니다",
  },
  {
    key: "vol",
    label: "변동성 (등락 흩어짐)",
    suffix: "%",
    goodUp: false,
    hint: "전 종목 하루 등락률의 표준편차. 급증하면 규칙이 잘 안 먹는 장세입니다",
  },
  {
    key: "med",
    label: "등락 중앙값",
    suffix: "%",
    goodUp: true,
    hint: "그날 시장이 통째로 어느 쪽이었나",
  },
];

export function RegimePanel() {
  const [cfg, setCfg] = useState<RegimeConfig | null>(null);
  const [res, setRes] = useState<RegimeResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const check = useCallback(() => {
    setBusy(true);
    setErr(null);
    api
      .regimeCheck(false)
      .then(setRes)
      .catch((e: unknown) => setErr(e instanceof Error ? e.message : String(e)))
      .finally(() => setBusy(false));
  }, []);

  useEffect(() => {
    api
      .regimeConfig()
      .then((r) => setCfg(r.config))
      .catch(() => undefined);
    check();
  }, [check]);

  const patch = (next: Partial<RegimeConfig>) => {
    if (!cfg) return;
    const merged = { ...cfg, ...next };
    setCfg(merged);
    setSaving(true);
    api
      .regimeConfigSave(next)
      .then((r) => setCfg(r.config))
      .catch((e: unknown) => setErr(e instanceof Error ? e.message : String(e)))
      .finally(() => setSaving(false));
  };

  return (
    <section className="card rg-card">
      <h3>장세 점검 — 신호등을 다시 손볼 때가 됐나</h3>
      <p className="pt-n">
        신호등 기준은 <b>어떤 장세에서 검증된 값</b>입니다. 장세가 바뀌면 그 검증이
        낡습니다 — 실제로 같은 기준이 120거래일 표본에서는 뒤쪽 <b>-19%p</b>, 400거래일
        표본에서는 <b>+3.39%p</b> 였습니다. 기준이 변한 게 아니라 <b>장세가</b> 변한
        것입니다. 그래서 「한 번 정하고 끝」이 아니라 <b>다시 재야 할 때</b>를 알려 주는
        자리를 둡니다.
      </p>
      <p className="pt-n">
        일봉 캐시로 계산하므로 <b>조회가 나가지 않습니다.</b> 아무 때나 눌러 보세요.
      </p>

      {err && <p className="sim-err">{err}</p>}

      <div className="sim-actions">
        <button className="primary-btn" onClick={check} disabled={busy}>
          {busy ? "재는 중…" : "지금 재보기"}
        </button>
        {cfg && (
          <label className="sim-toggle">
            <input
              type="checkbox"
              checked={cfg.enabled}
              onChange={(e) => patch({ enabled: e.target.checked })}
              disabled={saving}
            />
            <span>매일 저절로 재고, 걸리면 🔔 알림 보내기</span>
          </label>
        )}
      </div>

      {res && (
        <>
          {/* 판정이 먼저다 — 지표는 그 근거로 아래 있다 */}
          {res.findings.length === 0 ? (
            <p className="rg-ok">
              ✅ <b>지금은 걸린 항목이 없습니다.</b> 아래 문턱을 넘은 변화가 없다는 뜻이지,
              「신호등이 잘 맞고 있다」는 증명은 아닙니다 — 그건 설정 &gt; 시뮬레이터에서
              직접 재야 알 수 있습니다.
            </p>
          ) : (
            <div className="rg-findings">
              {res.findings.map((f) => (
                <div key={f.key} className={`rg-find lv-${f.level}`}>
                  <b>{f.title}</b>
                  <span>{f.detail}</span>
                </div>
              ))}
            </div>
          )}

          <h4>지표 — 지금과 {res.lookbackDays}거래일 전</h4>
          <div className="table-wrap">
            <table className="sim-table">
              <thead>
                <tr>
                  <th>지표</th>
                  <th className="num">지금</th>
                  <th className="num">{res.lookbackDays}일 전</th>
                  <th className="num">변화</th>
                </tr>
              </thead>
              <tbody>
                {ROWS.map((r) => {
                  const now = res.today[r.key] as number | null;
                  const then = (res.past?.[r.key] ?? null) as number | null;
                  const d = delta(now, then, r.goodUp);
                  return (
                    <tr key={r.key} title={r.hint}>
                      <td>
                        {r.label}
                        <span className="pt-n"> · {r.hint.split("—")[0].trim().slice(0, 28)}</span>
                      </td>
                      <td className="num">{N(now, r.suffix)}</td>
                      <td className="num">{N(then, r.suffix)}</td>
                      <td className={`num sim-edge ${d.cls}`}>{d.text}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          <p className="pt-n">
            종목 {res.today.n.toLocaleString("ko-KR")}개 기준 · 캐시{" "}
            {res.cacheBuiltAt.slice(0, 16).replace("T", " ")}
            {res.pastFrom === "cache" && (
              <>
                {" "}
                · 견줄 대상을 <b>캐시에서 되짚어</b> 냈습니다. 캐시가 70거래일치라{" "}
                <b>「{res.lookbackDays}일 전의 60일 신고가」는 낼 수 없어</b> 그 칸이 비어
                있습니다 — 이 화면을 며칠 켜 두면 실제 관측이 쌓여 채워집니다.
              </>
            )}
            {res.pastFrom === "history" && " · 견줄 대상은 그날 실제로 잰 값입니다."}
          </p>

          {res.sample.has && (
            <p className="pt-n">
              검증 표본: {res.sample.codeCount}종목 · {res.sample.obs?.toLocaleString("ko-KR")}건 ·{" "}
              <b>{res.sample.ageDays}일 전</b> 수집
            </p>
          )}

          <h4>걸렸을 때 무엇을 하나</h4>
          <ol className="rg-steps">
            <li>
              <b>신호등 찾기 &gt; 백테스트를 다시 돌립니다.</b> 표본이 새로 모입니다 —
              500종목 × 400거래일이면 20분쯤 걸리고 <b>백그라운드로 돕니다.</b>
            </li>
            <li>
              <b>설정 &gt; 시뮬레이터에서 「돌려보기」.</b> 지금 설정이 새 표본에서도
              통하는지 봅니다. <b>점수 구간이 단조 증가</b>인지가 제일 중요합니다 —
              90~100이 70~79보다 나쁘면 점수가 고장 난 것입니다.
            </li>
            <li>
              <b>「모든 조합 훑기」.</b> 순위는 <b>뒤쪽 절반</b> 성적으로 매겨집니다.
              앞에서만 좋은 조합은 그 기간에 맞춘 것입니다.
            </li>
            <li>
              <b>바꿀 이유를 댈 수 있는 것만 옮깁니다.</b> 「가르는 힘이 음수다(거꾸로
              걸렸다)」, 「다른 기준과 겹쳐서 아무 일도 안 한다」처럼 방향이 뚜렷한 것만요.
              1등을 그대로 고르는 것은 과최적화입니다.
            </li>
          </ol>
          <p className="sim-warn">
            ⚠️ <b>변동성 급증에는 문턱을 손대지 마세요.</b> 규칙이 안 먹는 장세에서
            기준을 다시 맞추면 <b>그 혼란에 맞춰진 기준</b>이 나옵니다. 그때 할 일은
            비중을 줄이고 지나가길 기다리는 것입니다.
          </p>
        </>
      )}

      {cfg && (
        <>
          <h4>문턱 — 언제 알릴까</h4>
          <p className="pt-n">
            <b>「지금 값」이 아니라 「변화」로 잡습니다.</b> 「신고가가 3% 미만이면 경고」
            같은 절대 문턱은 장세마다 다시 정해야 하지만, <b>며칠 전 대비 얼마나
            변했나</b>는 장세가 달라도 뜻이 같습니다.
          </p>
          <div className="rg-knobs">
            <label>
              <span>폭이 이만큼 떨어지면</span>
              <input
                type="number"
                min={3}
                max={60}
                step={1}
                value={cfg.breadthDropPp}
                onChange={(e) => patch({ breadthDropPp: Number(e.target.value) })}
              />
              <small>%p — 20일선 위 비율</small>
            </label>
            <label>
              <span>신고가가 이만큼 마르면</span>
              <input
                type="number"
                min={10}
                max={95}
                step={5}
                value={cfg.newHighDropPct}
                onChange={(e) => patch({ newHighDropPct: Number(e.target.value) })}
              />
              <small>% 감소 — 절반이면 50</small>
            </label>
            <label>
              <span>변동성이 이만큼 뛰면</span>
              <input
                type="number"
                min={1.1}
                max={5}
                step={0.1}
                value={cfg.volSpikeX}
                onChange={(e) => patch({ volSpikeX: Number(e.target.value) })}
              />
              <small>배</small>
            </label>
            <label>
              <span>며칠 전과 견줄까</span>
              <input
                type="number"
                min={5}
                max={60}
                step={5}
                value={cfg.lookbackDays}
                onChange={(e) => patch({ lookbackDays: Number(e.target.value) })}
              />
              <small>거래일</small>
            </label>
            <label>
              <span>표본이 이만큼 지나면</span>
              <input
                type="number"
                min={7}
                max={180}
                step={7}
                value={cfg.sampleStaleDays}
                onChange={(e) => patch({ sampleStaleDays: Number(e.target.value) })}
              />
              <small>일 — 「다시 모으세요」</small>
            </label>
          </div>
          <p className="pt-n">
            {saving ? "저장 중…" : "바꾸면 바로 저장됩니다."} 문턱을 너무 낮게 두면{" "}
            <b>매일 울려서 곧 안 보게 됩니다</b> — 그게 알림이 죽는 방식입니다.
          </p>
        </>
      )}
    </section>
  );
}
