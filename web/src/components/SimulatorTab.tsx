import { useCallback, useEffect, useState } from "react";
import {
  api,
  type SimCond,
  type SimCondMetric,
  type SimCondOp,
  type SimAnalysis,
  type SimResult,
  type SimRule,
  type SimSeriesDef,
} from "../api";
import { StockSearchBox } from "./StockSearchBox";
import { SimAnalysisView } from "./SimAnalysisView";

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

const METRICS: { key: SimCondMetric; label: string; needsN: boolean }[] = [
  { key: "chg1", label: "전일 대비", needsN: false },
  { key: "chgN", label: "N일 전 대비", needsN: true },
  { key: "vsMa", label: "N일 이동평균 대비", needsN: true },
  { key: "close", label: "값 자체", needsN: false },
];

/**
 * 부등호를 **말로 적는다** (2026-09-05).
 *
 * 벤티지: "기호만 있어서 전일 대비 상승에 거는 건지 하락에 거는 건지도 모르겠고."
 * 맞다 — `<` 는 왼쪽에 무엇이 오느냐에 따라 뜻이 뒤집히는데, 화면에서 그 왼쪽은
 * 세 칸 앞에 있다. 화살표를 붙여 방향이 눈에 먼저 걸리게 한다.
 *
 * 그리고 **값이 부등호보다 앞에 온다.** 한국어 어순이 그렇다 —
 * 「0% 미만이면」이지 「미만 0%」가 아니다.
 */
const OPS: { key: SimCondOp; label: string; say: string }[] = [
  { key: "lt", label: "▼ 미만이면", say: "미만" },
  { key: "lte", label: "▼ 이하면", say: "이하" },
  { key: "gt", label: "▲ 초과면", say: "초과" },
  { key: "gte", label: "▲ 이상이면", say: "이상" },
  { key: "absLte", label: "± 이내면", say: "이내" },
  { key: "absGt", label: "± 밖이면", say: "밖" },
];

/* ── 조건을 한국어 문장으로 ───────────────────────────────────────────
   같은 조건이 세 곳에 나온다 — 편집기 밑줄, 규칙 카드 요약, 빈 규칙 안내.
   문장을 만드는 곳은 **하나**여야 한다. 세 곳이 따로 적으면 한 곳만 고쳐지는 날이 온다. */

/** 「가/이」. S&P 500 처럼 숫자로 끝나는 이름이 있어서 숫자도 본다 */
const DIGIT_JONG = [true, true, false, true, false, false, true, true, true, false]; // 영일이삼사오육칠팔구
function ga(w: string): string {
  const last = w.trim().slice(-1);
  const c = last.charCodeAt(0);
  if (c >= 0xac00 && c <= 0xd7a3) return (c - 0xac00) % 28 === 0 ? "가" : "이";
  if (last >= "0" && last <= "9") return DIGIT_JONG[Number(last)] ? "이" : "가";
  return "가";
}

type Way = "up" | "down" | "flat" | "raw";

/**
 * 지금 이 조건이 **세 갈래 중 무엇인가.** 저장하는 값에 모드를 따로 두지 않고
 * 부등호와 값에서 읽어 낸다 — 모드를 따로 저장하면 값과 어긋나는 날이 오고,
 * 그러면 화면이 「상승」이라 적어 두고 실제로는 하락을 재게 된다.
 */
function wayOf(c: SimCond): Way {
  if (c.op === "absLte") return "flat";
  if (c.value === 0 && (c.op === "gt" || c.op === "gte")) return "up";
  if (c.value === 0 && (c.op === "lt" || c.op === "lte")) return "down";
  return "raw";
}

interface WayWord {
  btn: string;
  say: string;
}

/**
 * 세 갈래의 말. **지표마다 다르다** — 등락률은 「상승/하락」, 이평 이격은 「위/아래」,
 * 프리장 봉은 「양봉/음봉」이다. 한 벌로 뭉뚱그리면 「이동평균 대비 상승」 같은
 * 말이 나오는데, 그건 뜻이 다른 말이다.
 *
 * `null` 이면 세 갈래를 안 내놓는다 — VIX·금리의 「값 자체」는 늘 양수라
 * 「상승/하락」이라는 물음 자체가 성립하지 않는다.
 */
function waysFor(
  c: SimCond,
  def: SimSeriesDef | undefined,
): { up: WayWord; down: WayWord; flat: WayWord } | null {
  if (c.metric === "close") {
    const z = def?.zero;
    return z
      ? {
          up: { btn: z.up, say: `${z.up}인` },
          down: { btn: z.down, say: `${z.down}인` },
          flat: { btn: z.flat, say: `${z.flat}인` },
        }
      : null;
  }
  if (c.metric === "vsMa") {
    return {
      up: { btn: "위", say: "위인" },
      down: { btn: "아래", say: "아래인" },
      flat: { btn: "비슷", say: "비슷한" },
    };
  }
  return {
    up: { btn: "상승", say: "오른" },
    down: { btn: "하락", say: "내린" },
    flat: { btn: "보합", say: "보합인" },
  };
}

/** 조건 한 줄을 사람 문장으로. 「이렇게 읽습니다」의 그 문장이다 */
export function condSay(c: SimCond, series: SimSeriesDef[]): string {
  const def = c.src === "series" ? series.find((x) => x.key === c.key) : undefined;
  const subj = c.src === "stock" ? "이 종목" : (def?.label ?? c.key ?? "?");
  const n = c.n ?? (c.metric === "chgN" ? 5 : 20);
  const unit = c.metric === "close" ? (def?.unit ?? "원") : "%";
  const meas =
    c.metric === "chg1"
      ? "전일 대비 "
      : c.metric === "chgN"
        ? `${n}일 전 대비 `
        : c.metric === "vsMa"
          ? `${n}일 이동평균 대비 `
          : "";
  const head = `${subj}${ga(subj)} ${meas}`;
  const w = waysFor(c, def);
  const way = wayOf(c);

  if (w && way !== "raw") {
    if (way === "flat") return `${head}${w.flat.say}(±${Math.abs(c.value)}${unit}) 날`;
    return `${head}${(way === "up" ? w.up : w.down).say} 날`;
  }
  const op = OPS.find((o) => o.key === c.op) ?? OPS[0];
  const bound =
    c.op === "absLte" || c.op === "absGt"
      ? `±${Math.abs(c.value)}${unit}`
      : `${c.value}${unit}`;
  return `${head}${bound} ${op.say}인 날`;
}

/** 여러 줄은 **모두** 맞아야 한다 — 그래서 「그리고」로 잇는다 */
export function condsSay(list: SimCond[], series: SimSeriesDef[]): string {
  return list.map((c) => condSay(c, series)).join(" 그리고 ");
}

const won = (n: number) => `${Math.round(n).toLocaleString("ko-KR")}원`;
const 억 = (n: number) =>
  n >= 100_000_000
    ? `${(n / 100_000_000).toFixed(n % 100_000_000 === 0 ? 0 : 1)}억`
    : `${Math.round(n / 10_000).toLocaleString("ko-KR")}만`;
const pct = (n: number | null) => (n === null ? "-" : `${n > 0 ? "+" : ""}${n.toFixed(2)}%`);
const cls = (n: number | null) => (n === null ? "" : n > 0 ? "positive" : n < 0 ? "negative" : "");
/**
 * 백테스트는 250일 — **해가 바뀐다** (2026-09-05).
 *
 * 여태 `09/03` 이라고만 적었다. 두 해에 걸친 구간에서 그건 두 날을 가리키는 말이다.
 * 표 안은 `26/09/03`, 구간 머리말은 `2026-09-03` 으로 적는다 — 표는 좁고 머리말은
 * 한 번만 나오므로 각자 감당할 수 있는 만큼 적는다.
 */
export const dtY = (d: string) =>
  d.length === 8 ? `${d.slice(2, 4)}/${d.slice(4, 6)}/${d.slice(6)}` : d;
export const dtFull = (d: string) =>
  d.length === 8 ? `${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6)}` : d;
const dt = dtY;

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
        const def = c.src === "series" ? series.find((x) => x.key === c.key) : undefined;
        /* 「값 자체」의 단위는 지표가 아니라 **그 변수**의 것이다 — VIX 는 p, 금리는 % */
        const unit = m.key === "close" ? (def?.unit ?? "원") : "%";
        const ways = waysFor(c, def);
        const way = wayOf(c);
        /* 세 갈래로 고른 뒤에는 숫자와 부등호를 감춘다 — 안 쓰는 칸이 남아 있으면
           사람은 그 칸이 뜻을 가진다고 믿는다. 「보합」만 문턱이 필요해서 남긴다 */
        const showRaw = !ways || way === "raw";

        const pick = (w: Way) =>
          set(
            i,
            w === "up"
              ? { op: "gt", value: 0 }
              : w === "down"
                ? { op: "lt", value: 0 }
                : w === "flat"
                  ? { op: "absLte", value: Math.abs(c.value) || 0.1 }
                  : /* 직접 — 세 갈래에서 빠져나올 땐 0 이 아닌 값을 줘야 다시 세 갈래로 안 읽힌다 */
                    { op: "lt", value: c.value || -1 },
          );

        return (
          <div className="sim-cond-wrap" key={i}>
          <div className="sim-cond">
            <select
              className="ord-in"
              value={c.src === "stock" ? "stock" : (c.key ?? "KOSPI")}
              title={def?.hint}
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
              {/* 묶어서 보여 준다 — 열넷을 한 줄로 늘어놓으면 무엇이 무엇인지 안 보인다 */}
              {[...new Set(series.map((x) => x.group))].map((g) => (
                <optgroup key={g} label={g}>
                  {series
                    .filter((x) => x.group === g)
                    .map((x) => (
                      <option key={x.key} value={x.key}>
                        {x.label}
                      </option>
                    ))}
                </optgroup>
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

            {/*
              세 갈래 단추 — 벤티지: "봉 기준이면 양봉인지 음봉인지 보합인지 물어봐야
              되는데." 대부분의 조건은 결국 이 셋 중 하나인데, 그걸 「> 0」으로 적게
              하면 만드는 사람이 매번 머리로 번역해야 한다. 번역은 화면이 한다.
            */}
            {ways && (
              <span className="sim-way">
                {(["up", "down", "flat"] as const).map((w) => (
                  <button
                    type="button"
                    key={w}
                    className={`sim-way-b ${way === w ? "on" : ""} sim-way-${w}`}
                    onClick={() => pick(w)}
                  >
                    {ways[w].btn}
                  </button>
                ))}
                <button
                  type="button"
                  className={`sim-way-b ${way === "raw" ? "on" : ""}`}
                  onClick={() => pick("raw")}
                  title="숫자로 직접 문턱을 정합니다"
                >
                  직접
                </button>
              </span>
            )}

            {/* 「보합」은 문턱이 있어야 뜻이 정해진다 — ±얼마까지가 보합인지 */}
            {(showRaw || way === "flat") && (
              <>
                <input
                  className="ord-in sim-v"
                  type="number"
                  step="0.1"
                  value={c.value}
                  onChange={(e) => set(i, { value: Number(e.target.value) })}
                />
                <span className="pt-n">
                  {way === "flat" ? `${unit} 이내` : unit}
                </span>
              </>
            )}

            {/* 값이 부등호보다 **앞**이다 — 「0% 미만이면」이지 「미만 0%」가 아니다 */}
            {showRaw && (
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
            )}

            <button
              type="button"
              className="sim-x"
              onClick={() => onChange(list.filter((_, j) => j !== i))}
              title="지우기"
            >
              ✕
            </button>
          </div>

          {/*
            **이렇게 읽습니다.** 칸을 아무리 잘 줄 세워도 조건 한 줄은 결국 문장으로
            읽히는 것이고, 사람이 머릿속에서 그 문장을 만들게 두면 틀린 문장을 만든다.
            만들어서 보여 준다 — 이게 틀렸으면 조건이 틀린 것이다.
          */}
          <p className="sim-cond-say">{condSay(c, series)}</p>

          {def && (
            <p className="sim-cond-hint">
              {def.hint}
              {def.clock === "us" && (
                <>
                  {" · "}
                  <b className="sim-lag">한국 종가엔 전날 값</b>
                </>
              )}
              {" · 뒤로 "}
              {def.span}
            </p>
          )}
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
          {dtFull(r.from)} ~ {dtFull(r.to)} · {r.days}거래일
        </span>
      </div>

      {r.note && <p className="sim-note">{r.note}</p>}

      {/*
        빈 성적이 규칙 탓인지 **자료 탓인지**를 가른다. 프리장처럼 뒤로 60일뿐인 변수를
        250일 구간에 쓰면 앞의 190일은 「못 잼」이라 안 맞은 것으로 세어지는데,
        그 사실이 안 적히면 멀쩡한 규칙이 나쁜 규칙으로 보인다.
      */}
      {(r.limits ?? []).length > 0 && (
        <ul className="sim-limits">
          {(r.limits ?? []).map((t, i) => (
            <li key={i}>{t}</li>
          ))}
        </ul>
      )}

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
  const [deep, setDeep] = useState<SimAnalysis | null>(null);

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
      setDeep(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : "실패");
    } finally {
      setBusy(false);
    }
  }

  /* 초안도 분석은 된다 — 저장하지 않고 본문으로 규칙을 보낸다. 새 창만 못 연다(주소에 못 담는다) */
  async function tryDeep() {
    setBusy(true);
    setError(null);
    try {
      const r = await api.simAnalyze({ rule: d, days });
      setDeep(r.analysis);
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
        <button
          className={`filter-btn ${deep ? "active" : ""}`}
          onClick={() => (deep ? setDeep(null) : void tryDeep())}
          disabled={busy || !d.code}
          title="조건 하나하나가 성적에 무엇을 했는지까지"
        >
          자세히
        </button>
        <button className="ord-go" onClick={() => void save()} disabled={busy || !d.code || !d.name}>
          저장
        </button>
        <button className="filter-btn" onClick={onCancel} disabled={busy}>
          그만
        </button>
      </div>

      {test && <ResultView r={test} title={`시험 ${days}일`} />}
      {deep && <SimAnalysisView a={deep} series={series} />}
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
  const [deep, setDeep] = useState<Record<string, SimAnalysis>>({});
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

  /**
   * 상세 분석 — 조건을 하나씩 빼고 다시 돌리므로 **몇 초 걸린다.**
   * 그래서 눌러야 돈다. 백테스트를 누를 때마다 같이 돌리면 규칙 목록이 무거워진다.
   */
  async function deepen(rule: SimRule) {
    if (deep[rule.id]) {
      setDeep((p) => {
        const n = { ...p };
        delete n[rule.id];
        return n;
      });
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const r = await api.simAnalyze({ id: rule.id, days });
      setDeep((p) => ({ ...p, [rule.id]: r.analysis }));
    } catch (e) {
      setError(e instanceof Error ? e.message : "실패");
    } finally {
      setBusy(false);
    }
  }

  /**
   * **새 창** — 옆 모니터에 띄워 두고 규칙을 고치라고 만든 창이다.
   * 규칙마다 창 이름이 달라 여러 규칙을 나란히 놓고 견줄 수 있다.
   */
  function openWin(rule: SimRule) {
    window.open(
      `${window.location.pathname}#/simwin?rule=${encodeURIComponent(rule.id)}&days=${days}`,
      `vntg-sim-${rule.id}`,
      "width=1280,height=940,resizable=yes,scrollbars=yes",
    );
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
            예: <b>코스피가 전일 대비 내린 날</b> KODEX 200 을 1억 사고,{" "}
            <b>코스피가 전일 대비 오른 날</b> 판다.
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
              <button
                className={`filter-btn ${deep[r.id] ? "active" : ""}`}
                onClick={() => void deepen(r)}
                disabled={busy}
                title="조건 하나하나가 성적에 무엇을 했는지, 달마다 어떻게 흘렀는지"
              >
                자세히
              </button>
              <button
                className="filter-btn"
                onClick={() => openWin(r)}
                title="새 창으로 — 옆에 띄워 두고 규칙을 고칠 수 있습니다"
              >
                🗔 새 창
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

          {/*
            카드에 「매수 3조건」이라고만 적혀 있었다. 그건 **개수**지 규칙이 아니다 —
            무엇을 재는 규칙인지 보려면 매번 「고치기」를 눌러 들어가야 했다.
            편집기가 쓰는 것과 **같은 문장 만들기**(`condsSay`)를 쓴다.
          */}
          <div className="sim-rule-cond">
            <span>
              <b className="positive">매수</b>{" "}
              {r.buy.length === 0 ? (
                <i className="pt-n">조건 없음 — 사지 않습니다</i>
              ) : (
                condsSay(r.buy, series)
              )}
            </span>
            <span>
              <b className="negative">매도</b>{" "}
              {r.sell.length === 0 ? (
                <i className="pt-n">조건 없음 — 팔지 않습니다</i>
              ) : (
                condsSay(r.sell, series)
              )}
            </span>
          </div>

          {back[r.id] && <ResultView r={back[r.id]} title={`백테스트 ${days}일`} />}
          {deep[r.id] && <SimAnalysisView a={deep[r.id]} series={series} />}
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
