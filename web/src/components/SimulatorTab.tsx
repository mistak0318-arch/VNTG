import { useCallback, useEffect, useState } from "react";
import {
  api,
  type SimCond,
  type SimCondMetric,
  type SimCondOp,
  type SimResult,
  type SimRule,
  type SimSeriesDef,
} from "../api";
import { StockSearchBox } from "./StockSearchBox";

/**
 * **시뮬레이터** — 조건을 걸어 종목 하나를 굴려 본다 (2026-09-04).
 *
 * 벤티지: "특정 조건에 어떤 종목을 계속 굴려볼 수 있는 거지. 예를 들어 코스피 지수가
 * 빠지면 KODEX 200을 매수한다, 1억씩. 그리고 그다음 날 코스피가 올라갈 때 매도한다는
 * 매도 규칙도 만드는 거야. … 백테스트해서 돌려보고 실제 시장 흐름에서도 돌려보는
 * 실전 테스트 같은 거야."
 *
 * ## 이 화면이 지키는 것 셋
 *
 * ① **백테스트와 실전은 같은 엔진을 지난다**(서버 `simEngine.step`). 두 길로 만들면
 *    「과거에 이랬으면 이랬다」가 거짓이 되고, 그게 이 도구의 존재 이유다.
 * ② **그냥 들고 있었다면**을 늘 같이 보여 준다. 규칙이 +20% 를 냈어도 그 종목이
 *    +60% 였으면 그 규칙은 진 것이다 — 이 자가 없으면 성적이 좋아 보이기만 한다.
 * ③ **수수료·거래세를 넣는다.** 왕복 0.21%. 하루짜리 규칙에서는 이게 성적의 대부분을
 *    먹는데, 안 넣으면 그 사실이 안 보인다.
 */

const METRICS: { key: SimCondMetric; label: string; needsN: boolean; unit: string }[] = [
  { key: "chg1", label: "전일 대비", needsN: false, unit: "%" },
  { key: "chgN", label: "N일 전 대비", needsN: true, unit: "%" },
  { key: "vsMa", label: "N일 이동평균 대비", needsN: true, unit: "%" },
  { key: "close", label: "값 그 자체", needsN: false, unit: "" },
];

const OPS: { key: SimCondOp; label: string }[] = [
  { key: "lt", label: "<" },
  { key: "lte", label: "≤" },
  { key: "gt", label: ">" },
  { key: "gte", label: "≥" },
];

const won = (n: number) => `${Math.round(n).toLocaleString("ko-KR")}원`;
const 억 = (n: number) =>
  n >= 100_000_000
    ? `${(n / 100_000_000).toFixed(n % 100_000_000 === 0 ? 0 : 1)}억`
    : `${Math.round(n / 10_000).toLocaleString("ko-KR")}만`;
const pct = (n: number | null) => (n === null ? "-" : `${n > 0 ? "+" : ""}${n.toFixed(2)}%`);
const cls = (n: number | null) => (n === null ? "" : n > 0 ? "positive" : n < 0 ? "negative" : "");
const dt = (d: string) => (d.length === 8 ? `${d.slice(4, 6)}/${d.slice(6)}` : d);

const EMPTY: Partial<SimRule> = {
  name: "",
  code: "",
  stockName: "",
  seed: 100_000_000,
  buyAmount: 100_000_000,
  buy: [],
  sell: [],
  addOn: false,
  enabled: false,
};

function CondEditor({
  list,
  series,
  onChange,
  label,
}: {
  list: SimCond[];
  series: SimSeriesDef[];
  onChange: (next: SimCond[]) => void;
  label: string;
}) {
  const set = (i: number, patch: Partial<SimCond>) =>
    onChange(list.map((c, j) => (i === j ? { ...c, ...patch } : c)));

  return (
    <div className="sim-conds">
      <div className="sim-conds-h">
        <b>{label}</b>
        <span className="pt-n">모두 맞아야 합니다 (그리고)</span>
        <button
          type="button"
          className="filter-btn"
          onClick={() =>
            onChange([...list, { src: "series", key: "KOSPI", metric: "chg1", op: "lt", value: 0 }])
          }
        >
          + 조건
        </button>
      </div>

      {list.length === 0 && (
        <p className="pt-n">
          조건이 없으면 <b>아무 일도 안 합니다</b> — 빈 조건을 「늘 참」으로 두면 매일 사는
          규칙이 되어 버립니다.
        </p>
      )}

      {list.map((c, i) => {
        const m = METRICS.find((x) => x.key === c.metric) ?? METRICS[0];
        return (
          <div className="sim-cond" key={i}>
            <select
              className="ord-in"
              value={c.src === "stock" ? "stock" : (c.key ?? "KOSPI")}
              onChange={(e) =>
                set(
                  i,
                  e.target.value === "stock"
                    ? { src: "stock", key: undefined }
                    : { src: "series", key: e.target.value },
                )
              }
            >
              <option value="stock">이 종목</option>
              {series.map((s) => (
                <option key={s.key} value={s.key}>
                  {s.label}
                </option>
              ))}
            </select>

            <select
              className="ord-in"
              value={c.metric}
              onChange={(e) => set(i, { metric: e.target.value as SimCondMetric })}
            >
              {METRICS.map((x) => (
                <option key={x.key} value={x.key}>
                  {x.label}
                </option>
              ))}
            </select>

            {m.needsN && (
              <input
                className="ord-in sim-n"
                type="number"
                min={1}
                max={250}
                value={c.n ?? 20}
                onChange={(e) => set(i, { n: Number(e.target.value) })}
                title="며칠"
              />
            )}

            <select
              className="ord-in sim-op"
              value={c.op}
              onChange={(e) => set(i, { op: e.target.value as SimCondOp })}
            >
              {OPS.map((x) => (
                <option key={x.key} value={x.key}>
                  {x.label}
                </option>
              ))}
            </select>

            <input
              className="ord-in sim-v"
              type="number"
              step="0.1"
              value={c.value}
              onChange={(e) => set(i, { value: Number(e.target.value) })}
            />
            <span className="pt-n">{m.unit}</span>

            <button
              type="button"
              className="sim-x"
              onClick={() => onChange(list.filter((_, j) => j !== i))}
              title="지우기"
            >
              ✕
            </button>
          </div>
        );
      })}
    </div>
  );
}

function ResultView({ r, title }: { r: SimResult; title: string }) {
  /* 곡선은 폴리라인 하나면 충분하다 — 여기서 알고 싶은 건 모양이지 눈금이 아니다 */
  const pts = r.curve;
  const lo = Math.min(...pts.map((p) => p.equity), r.seed);
  const hi = Math.max(...pts.map((p) => p.equity), r.seed);
  const y = (v: number) => (hi === lo ? 20 : (100 - ((v - lo) / (hi - lo)) * 100) * 0.4);
  const path =
    pts.length > 1
      ? pts
          .map((p, i) => `${i === 0 ? "M" : "L"}${((i / (pts.length - 1)) * 100).toFixed(2)},${y(p.equity).toFixed(2)}`)
          .join(" ")
      : "";
  const beat = r.buyHold !== null ? r.ret - r.buyHold : null;

  return (
    <div className="sim-res">
      <div className="sim-res-h">
        <b>{title}</b>
        <span className="pt-n">
          {dt(r.from)} ~ {dt(r.to)} · {r.days}거래일
        </span>
      </div>

      {r.note && <p className="sim-note">{r.note}</p>}

      <dl className="sim-kpis">
        <div>
          <dt>수익률</dt>
          <dd className={cls(r.ret)}>{pct(r.ret)}</dd>
        </div>
        <div title="같은 기간 그 종목을 그냥 들고 있었다면. 규칙이 값을 했는지는 이것과 견줘야 압니다">
          <dt>그냥 보유</dt>
          <dd className={cls(r.buyHold)}>{pct(r.buyHold)}</dd>
        </div>
        <div title="규칙 − 그냥 보유. 음수면 아무것도 안 하는 편이 나았다는 뜻입니다">
          <dt>차이</dt>
          <dd className={cls(beat)}>
            {beat === null ? "-" : `${beat > 0 ? "+" : ""}${beat.toFixed(2)}%p`}
          </dd>
        </div>
        <div title="곡선의 고점 대비 가장 크게 밀린 폭 — 견딜 수 있는 크기인지가 실전에서 갈립니다">
          <dt>최대낙폭</dt>
          <dd className="negative">{r.mdd.toFixed(2)}%</dd>
        </div>
        <div>
          <dt>평가액</dt>
          <dd>{억(r.equity)}</dd>
        </div>
        <div title="판 거래 중 이익으로 끝난 비율 — 승률만 높고 수익이 안 나는 규칙이 흔합니다">
          <dt>승률</dt>
          <dd>
            {r.closed > 0 ? `${Math.round((r.wins / r.closed) * 100)}%` : "-"}
            <span className="pt-n">
              {" "}
              ({r.wins}/{r.closed})
            </span>
          </dd>
        </div>
      </dl>

      {path && (
        <svg className="sim-curve" viewBox="0 0 100 40" preserveAspectRatio="none">
          {/* 시드선 — 이 위면 벌었고 아래면 잃었다 */}
          <line x1="0" x2="100" y1={y(r.seed)} y2={y(r.seed)} className="sim-seedline" />
          <path d={path} className={`sim-line ${r.ret >= 0 ? "up" : "down"}`} />
        </svg>
      )}

      {r.trades.length > 0 && (
        <details className="sim-trades">
          <summary>거래 {r.trades.length}건 보기</summary>
          <div className="data-table-wrap">
            <table className="data-table">
              <thead>
                <tr>
                  <th>날짜</th>
                  <th>매매</th>
                  <th className="num">수량</th>
                  <th className="num">가격</th>
                  <th className="num">손익</th>
                  <th>왜</th>
                </tr>
              </thead>
              <tbody>
                {[...r.trades]
                  .reverse()
                  .slice(0, 200)
                  .map((t, i) => (
                    <tr key={`${t.d}-${i}`}>
                      <td>{dt(t.d)}</td>
                      <td className={t.side === "buy" ? "positive" : "negative"}>
                        {t.side === "buy" ? "매수" : "매도"}
                      </td>
                      <td className="num">{t.qty.toLocaleString("ko-KR")}</td>
                      <td className="num">{won(t.price)}</td>
                      <td className={`num ${cls(t.pnl ?? null)}`}>
                        {t.pnl === undefined
                          ? "-"
                          : `${t.pnl > 0 ? "+" : ""}${t.pnl.toLocaleString("ko-KR")}`}
                      </td>
                      <td className="sim-why">{t.why}</td>
                    </tr>
                  ))}
              </tbody>
            </table>
          </div>
        </details>
      )}
    </div>
  );
}

function RuleForm({
  draft,
  series,
  onCancel,
  onSaved,
  days,
}: {
  draft: Partial<SimRule>;
  series: SimSeriesDef[];
  onCancel: () => void;
  onSaved: () => void;
  days: number;
}) {
  const [d, setD] = useState<Partial<SimRule>>(draft);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [test, setTest] = useState<SimResult | null>(null);

  const set = (patch: Partial<SimRule>) => setD((p) => ({ ...p, ...patch }));

  async function save() {
    setBusy(true);
    setError(null);
    try {
      await api.simSaveRule(d);
      onSaved();
    } catch (e) {
      setError(e instanceof Error ? e.message : "저장 실패");
    } finally {
      setBusy(false);
    }
  }

  async function tryIt() {
    setBusy(true);
    setError(null);
    try {
      /* 저장하지 않고 시험한다 — 시험한 것이 다 목록에 쌓이면 「진행 중」이 뭔지 흐려진다 */
      const r = await api.simBacktest({ rule: d, days });
      setTest(r.result);
    } catch (e) {
      setError(e instanceof Error ? e.message : "실패");
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="card sim-form">
      <div className="sim-form-row">
        <input
          className="ord-in sim-name"
          placeholder="규칙 이름 (예: 코스피 빠지면 KODEX200)"
          value={d.name ?? ""}
          onChange={(e) => set({ name: e.target.value })}
        />
      </div>

      <div className="sim-form-row">
        <StockSearchBox
          placeholder="굴릴 종목 — 이름 또는 6자리 코드"
          onPick={(code, name) => set({ code, stockName: name })}
        />
        {d.code && (
          <span className="sim-picked">
            {d.stockName} <span className="pt-n">{d.code}</span>
          </span>
        )}
      </div>

      <div className="sim-form-row">
        <label>
          시드
          <input
            className="ord-in"
            type="number"
            step={10_000_000}
            value={d.seed ?? 100_000_000}
            onChange={(e) => set({ seed: Number(e.target.value) })}
          />
        </label>
        <label>
          한 번 살 금액
          <input
            className="ord-in"
            type="number"
            step={10_000_000}
            value={d.buyAmount ?? 100_000_000}
            onChange={(e) => set({ buyAmount: Number(e.target.value) })}
          />
        </label>
        <label
          className="sim-check"
          title="켜면 들고 있어도 조건이 맞을 때마다 또 삽니다 — 「빠지면 산다」류는 계속 물타기가 됩니다"
        >
          <input
            type="checkbox"
            checked={Boolean(d.addOn)}
            onChange={(e) => set({ addOn: e.target.checked })}
          />
          이미 들고 있어도 추가매수
        </label>
      </div>

      <CondEditor label="매수 조건" list={d.buy ?? []} series={series} onChange={(buy) => set({ buy })} />
      <CondEditor label="매도 조건" list={d.sell ?? []} series={series} onChange={(sell) => set({ sell })} />

      {error && <p className="ord-err">{error}</p>}

      <div className="sim-form-row">
        <button className="filter-btn" onClick={() => void tryIt()} disabled={busy || !d.code}>
          {busy ? "돌리는 중…" : `저장 없이 ${days}일 시험`}
        </button>
        <button className="ord-go" onClick={() => void save()} disabled={busy || !d.code || !d.name}>
          저장
        </button>
        <button className="filter-btn" onClick={onCancel} disabled={busy}>
          그만
        </button>
      </div>

      {test && <ResultView r={test} title={`시험 ${days}일`} />}
    </section>
  );
}

export function SimulatorTab() {
  const [rules, setRules] = useState<SimRule[]>([]);
  const [series, setSeries] = useState<SimSeriesDef[]>([]);
  const [draft, setDraft] = useState<Partial<SimRule> | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [back, setBack] = useState<Record<string, SimResult>>({});
  const [live, setLive] = useState<Record<string, SimResult | null>>({});
  const [days, setDays] = useState(250);

  const load = useCallback(() => {
    api
      .simRules()
      .then((r) => setRules(r.rules))
      .catch((e: Error) => setError(e.message));
  }, []);

  useEffect(() => {
    load();
    api
      .simSeries()
      .then((r) => setSeries(r.series))
      .catch(() => undefined);
  }, [load]);

  async function run(rule: SimRule) {
    setBusy(true);
    setError(null);
    try {
      const r = await api.simBacktest({ id: rule.id, days });
      setBack((p) => ({ ...p, [rule.id]: r.result }));
    } catch (e) {
      setError(e instanceof Error ? e.message : "실패");
    } finally {
      setBusy(false);
    }
  }

  async function toggle(rule: SimRule) {
    setBusy(true);
    try {
      await api.simSaveRule({ ...rule, enabled: !rule.enabled });
      load();
    } finally {
      setBusy(false);
    }
  }

  async function showLive(rule: SimRule) {
    const r = await api.simLiveStep(rule.id).catch(() => null);
    setLive((p) => ({ ...p, [rule.id]: r?.result ?? null }));
  }

  return (
    <div className="sim-page">
      {error && <div className="error-banner">{error}</div>}

      <p className="table-note">
        조건을 걸어 종목 하나를 굴려 봅니다. <b>백테스트</b>는 창고에 받아 둔 일봉(최대 500일)으로
        과거를 다시 사고, <b>실전 진행</b>은 켠 날부터 하루씩 따라갑니다 —{" "}
        <b>둘이 같은 엔진을 지납니다.</b> 매수·매도 모두 <b>종가</b>에 체결한 것으로 적고,
        수수료 0.015%와 매도 거래세 0.18%를 뺍니다.
      </p>
      <p className="pt-n sim-warn-line">
        ⚠️ 종가를 보고 그 종가에 사는 것은 실제로는 동시호가 안에서만 가능하고 늘 되지도 않습니다.
        그래도 이렇게 두는 이유는 <b>판정과 체결이 같은 값이라야 성적이 규칙을 재는 것</b>이 되기
        때문입니다. 다른 값에 체결시키면 규칙이 좋은 건지 슬리피지 추정이 좋은 건지 못 가릅니다.
        <b> 그리고 이 화면은 주문을 내지 않습니다.</b>
      </p>

      <div className="sim-top">
        <button className="filter-btn active" onClick={() => setDraft({ ...EMPTY })} disabled={busy}>
          + 규칙 만들기
        </button>
        <span className="cis-slot-hint">백테스트 구간</span>
        {[60, 120, 250, 500].map((v) => (
          <button
            key={v}
            className={`filter-btn ${days === v ? "active" : ""}`}
            onClick={() => setDays(v)}
          >
            {v}일
          </button>
        ))}
      </div>

      {draft && (
        <RuleForm
          draft={draft}
          series={series}
          days={days}
          onCancel={() => setDraft(null)}
          onSaved={() => {
            setDraft(null);
            load();
          }}
        />
      )}

      {rules.length === 0 && !draft && (
        <div className="card sim-empty">
          <b>아직 규칙이 없습니다.</b>
          <p className="pt-n">
            예: <b>코스피가 전일 대비 &lt; 0</b> 이면 KODEX 200 을 1억 사고,{" "}
            <b>코스피가 &gt; 0</b> 이면 판다.
          </p>
        </div>
      )}

      {rules.map((r) => (
        <section className="card sim-rule" key={r.id}>
          <div className="sim-rule-h">
            <span className={`sim-dot ${r.enabled ? "on" : ""}`} />
            <b>{r.name}</b>
            <span className="pt-n">
              {r.stockName} {r.code} · 시드 {억(r.seed)} · 한 번 {억(r.buyAmount)}
              {r.addOn ? " · 추가매수" : ""}
            </span>
            <span className="sim-rule-btns">
              <button
                className={`filter-btn ${r.enabled ? "active" : ""}`}
                onClick={() => void toggle(r)}
                disabled={busy}
              >
                {r.enabled ? "진행 중" : "정지"}
              </button>
              <button className="filter-btn" onClick={() => void run(r)} disabled={busy}>
                백테스트
              </button>
              <button className="filter-btn" onClick={() => void showLive(r)} disabled={busy}>
                실전 성적
              </button>
              <button className="filter-btn" onClick={() => setDraft(r)} disabled={busy}>
                고치기
              </button>
              <button
                className="filter-btn"
                onClick={() => {
                  if (!confirm(`「${r.name}」 규칙과 실전 장부를 지웁니다. 되돌릴 수 없습니다.`)) return;
                  void api.simDeleteRule(r.id).then(load);
                }}
                disabled={busy}
              >
                지우기
              </button>
            </span>
          </div>

          <div className="sim-rule-cond">
            <span>
              <b className="positive">매수</b> {r.buy.length}조건
            </span>
            <span>
              <b className="negative">매도</b> {r.sell.length}조건
            </span>
          </div>

          {back[r.id] && <ResultView r={back[r.id]} title={`백테스트 ${days}일`} />}
          {live[r.id] !== undefined &&
            (live[r.id] ? (
              <ResultView r={live[r.id] as SimResult} title="실전 진행" />
            ) : (
              <p className="pt-n">
                아직 한 걸음도 안 갔습니다 — <b>진행</b>으로 켜면 다음 일봉부터 따라갑니다.
                (켠 날 이전은 채우지 않습니다. 나중에 알고 채우면 미래를 본 성적이 됩니다.)
              </p>
            ))}
        </section>
      ))}
    </div>
  );
}
