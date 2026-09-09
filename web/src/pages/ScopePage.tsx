import { useCallback, useEffect, useMemo, useState } from "react";
import { api, type ScopeDetail, type ScopeFlow, type ScopeRow } from "../api";
import { MiniLine } from "../components/MiniLine";
import { SortableTh, useSortableTable } from "../useSortableTable";
import { useWatchedCodes } from "../useWatchedCodes";
import { fid, useRealtime } from "../useRealtime";
import { SuperMark } from "../useSuperMarks";
import { useBuzz } from "../components/BuzzBadge";

/**
 * **매수직전** — 현미경 그룹의 관리 화면 (2026-09-07).
 *
 * 벤티지: "매수 직전의 그룹이니만큼 관리 그룹이 될 수 있게 하자. 정밀한 세부 현미경처럼.
 * 그래서 매수 직전의 종목들 중에서 뭘 매수할지 내가 바로 고를 수 있도록."
 *
 * ## 이 화면의 물음은 하나다 — **이 중에서 무엇을 사나**
 *
 * 그래서 첫 화면은 **비교표**다. 종목 하나를 깊게 보는 화면은 이미 있다(종목 상세).
 * 여기가 그걸 또 하면 뜻이 없다. 여기서는 **같은 잣대로 나란히** 놓아서 어느 것이
 * 앞서는지가 보여야 한다 — 외국인이 며칠째 사고 있나, 3대장은 어느 쪽인가, 공매도가
 * 붙었나, 20일선 위인가. 열이 많지만 그게 이 표의 일이다. 정렬로 줄을 세운다.
 *
 * 한 종목을 누르면 그 밑에 **현미경**이 펼쳐진다 — 60일 수급 누적선, 3대장, 공매도·
 * 대차, 오늘 장중, 뉴스·텔레그램, 메모. 다른 종목을 누르면 그쪽으로 옮겨 간다.
 *
 * ## 「오늘」과 「어제까지」를 가른다
 *
 * 수급·공매도·대차 원장은 **마감 뒤**에 채워진다. 장중에 이 화면을 열면 5일·20일은
 * 어제까지의 5일·20일이다. 그 사실을 표 위에 적고, 「오늘」 칸만 따로 둔다 — 오늘 칸은
 * 키움에서 지금 받은 값이다. 둘을 섞어 적으면 어느 날까지인지 매번 계산해야 한다.
 *
 * ## 주문은 여기서 안 나간다
 *
 * 「뭘 살지 고르는」 화면이지 사는 화면이 아니다. 고르고 나면 주문 화면으로 **넘긴다**
 * (종목이 채워진 채로). 주문의 겹 일곱은 그쪽에 있다.
 */

/** 순매수 — 부호가 뜻이라 +를 붙인다 */
const 억 = (v: number | null | undefined, digits = 0): string => {
  if (v === null || v === undefined) return "-";
  const a = Math.abs(v);
  const s = a >= 10_000 ? `${(v / 10_000).toFixed(2)}조` : `${v.toFixed(a < 10 ? 1 : digits)}억`;
  return v > 0 ? `+${s}` : s;
};
/** 크기 — 시총·거래대금처럼 방향이 없는 값. +를 붙이면 「늘었다」로 읽힌다 */
const 억크기 = (v: number | null | undefined): string =>
  v === null || v === undefined ? "-" : v >= 10_000 ? `${(v / 10_000).toFixed(2)}조` : `${Math.round(v).toLocaleString("ko-KR")}억`;
const pct = (v: number | null | undefined, d = 1, sign = true): string =>
  v === null || v === undefined ? "-" : `${sign && v > 0 ? "+" : ""}${v.toFixed(d)}%`;
/**
 * **이동평균·고점은 「몇 %」만으로는 못 읽는다** (2026-09-09).
 *
 * 벤티지: "이게 5일선 아래라는거야 위라는거야? 헷갈려."
 *
 * 「5일선 −1.8%」는 종가가 5일선보다 1.8% **아래**라는 뜻인데, 라벨이 그걸 안 말한다.
 * 부호만 놓고 「5일선이 −1.8%」로 읽으면 정반대로 이해된다 — 실제로 그렇게 읽혔다.
 * 툴팁을 달아 뒀던 자리도 있지만 폰에서는 손이 닿지 않는다. **글자로 적는다.**
 */
const gapWord = (v: number | null | undefined): string =>
  v === null || v === undefined ? "" : v > 0 ? "위" : v < 0 ? "아래" : "일치";

const cls = (v: number | null | undefined): string =>
  v === null || v === undefined || v === 0 ? "" : v > 0 ? "positive" : "negative";
const won = (v: number | null | undefined) =>
  v === null || v === undefined ? "-" : `${Math.round(v).toLocaleString("ko-KR")}`;
const dt = (d: string) => (d.length === 8 ? `${d.slice(4, 6)}/${d.slice(6)}` : d.slice(5, 10));
const low = (v: number | null | undefined) => (v === null || v === undefined ? -Infinity : v);

/** 담은 지 며칠 */
function daysSince(iso: string): number {
  return Math.max(0, Math.floor((Date.now() - new Date(iso).getTime()) / 86400_000));
}

/** 연속 순매수 배지 — 「5일째」가 「5일 합 +30억」보다 먼저 눈에 걸린다 */
function Streak({ f }: { f: ScopeFlow }) {
  if (Math.abs(f.streak) < 2) return null;
  return (
    <span className={`sc-streak ${f.streak > 0 ? "up" : "down"}`} title="연속 순매수(빨강)·순매도(파랑) 일수">
      {Math.abs(f.streak)}일째
    </span>
  );
}

/** 60일 종가 작은 선 — 모양만 본다 */
function Spark({ closes }: { closes: number[] }) {
  if (closes.length < 2) return <span className="pt-n">-</span>;
  const lo = Math.min(...closes);
  const hi = Math.max(...closes);
  const y = (v: number) => (hi === lo ? 10 : 20 - ((v - lo) / (hi - lo)) * 20);
  const d = closes
    .map((v, i) => `${i === 0 ? "M" : "L"}${((i / (closes.length - 1)) * 100).toFixed(1)},${y(v).toFixed(1)}`)
    .join(" ");
  const up = closes[closes.length - 1] >= closes[0];
  return (
    <svg className="sc-spark" viewBox="0 -1 100 22" preserveAspectRatio="none">
      <path d={d} className={up ? "up" : "down"} />
    </svg>
  );
}

/* ── 현미경 (한 종목 상세) ────────────────────────────────────────── */

/** 누적선 재료 — 원장 줄(백만원)을 억으로, 처음부터 더해 간다 */
function cumul(rows: { d: string }[], pick: (r: any) => number | null): (number | null)[] {
  let s = 0;
  let seen = false;
  return rows.map((r) => {
    const v = pick(r);
    if (typeof v !== "number") return seen ? s / 100 : null;
    s += v;
    seen = true;
    return s / 100;
  });
}

function Detail({
  code,
  live,
  onSelectStock,
  onRemoved,
  onNote,
}: {
  code: string;
  /**
   * 실시간이 준 지금 값 — 표와 **같은 값**을 보게 한다 (2026-09-09).
   * 이 카드는 열 때 한 번만 받으므로, 안 넘기면 표는 움직이는데 카드만 멈춰 있다.
   */
  live?: { price: number; rate: number | null } | null;
  onSelectStock: (code: string, name: string) => void;
  onRemoved: () => void;
  onNote: (code: string, note: string) => void;
}) {
  const [d, setD] = useState<ScopeDetail | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [note, setNote] = useState("");
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState<string | null>(null);

  useEffect(() => {
    setD(null);
    setErr(null);
    api
      .scopeDetail(code)
      .then((r) => {
        setD(r);
        setNote(r.row.note);
      })
      .catch((e: Error) => setErr(e.message));
  }, [code]);

  const labels = useMemo(() => (d?.flow ?? []).map((r) => dt(r.d)), [d]);
  const sinceIdx = useMemo(() => {
    if (!d) return undefined;
    const s = d.row.since.slice(0, 10).replace(/-/g, "");
    const i = d.flow.findIndex((r) => r.d >= s);
    return i >= 0 ? i : undefined;
  }, [d]);

  async function saveNote() {
    setSaving(true);
    try {
      await api.scopeNote(code, note);
      onNote(code, note);
      setSaved("저장했습니다");
      setTimeout(() => setSaved(null), 1500);
    } catch (e) {
      setSaved(e instanceof Error ? e.message : "실패");
    } finally {
      setSaving(false);
    }
  }

  if (err) return <div className="error-banner">{err}</div>;
  if (!d) return <p className="pt-n sc-wait">현미경을 맞추는 중… 원장·오늘 수급·뉴스·텔레그램을 모읍니다.</p>;

  const r = d.row;
  const t = d.today;
  const barLabels = d.bars.map((b) => dt(b.d));
  const shortLabels = d.short.map((x) => dt(x.d));
  const loanLabels = d.loan.map((x) => dt(x.d));
  const intr = t?.intraday ?? [];

  const inst = (t?.institution ?? []).slice(0, 7);

  return (
    <div className="sc-detail">
      <div className="sc-detail-h">
        <b>🧨 {r.name}</b>
        <span className="pt-n">{r.code}{r.sector ? ` · ${r.sector}` : ""}{r.marketCap ? ` · 시총 ${억크기(r.marketCap)}` : ""}</span>
        {/* 실시간이 있으면 그것 — 표와 어긋나면 어느 쪽이 맞는지 알 수 없다 */}
        <span className={`sc-price ${cls(live?.rate ?? r.changeRate)}`}>
          <span
            className={`uw-live-dot${live ? " rt" : " off"}`}
            title={live ? "실시간 체결 — 값이 오는 대로 갱신됩니다" : "실시간 값이 아직 없습니다 — 60초 조회로 채웁니다"}
          />
          {won(live?.price ?? r.price)}원 {pct(live?.rate ?? r.changeRate, 2)}
        </span>
        <span className="sc-detail-btns">
          <button className="filter-btn" onClick={() => onSelectStock(r.code, r.name)}>
            📈 종목 상세
          </button>
          <a
            className="filter-btn sc-order"
            href={`#/order?stk=${r.code}&name=${encodeURIComponent(r.name)}&side=buy`}
            title="주문 화면으로 — 종목이 채워져 갑니다. 주문은 거기서 냅니다"
          >
            🛒 주문으로
          </a>
          <button
            className="filter-btn"
            onClick={() => {
              if (!confirm(`「${r.name}」을 현미경에서 뺍니다. 관심종목에는 남습니다.`)) return;
              void api.scopeRemove(r.code).then(onRemoved);
            }}
          >
            현미경에서 빼기
          </button>
        </span>
      </div>

      {/* 메모 — 왜 매수 직전인가, 무엇을 기다리나. 맨 위에 둔다: 다시 열었을 때 제일 먼저 읽을 것 */}
      <div className="sc-note">
        <textarea
          className="sc-note-in"
          placeholder="왜 매수 직전인가 · 무엇을 기다리나 · 진입가/손절선 — 다음에 열었을 때 나에게"
          value={note}
          onChange={(e) => setNote(e.target.value)}
          rows={2}
        />
        <button className="filter-btn" onClick={() => void saveNote()} disabled={saving || note === r.note}>
          {saving ? "…" : "메모 저장"}
        </button>
        {saved && <span className="pt-n">{saved}</span>}
      </div>

      <div className="sc-grid">
        {/* ① 가격 60일 + 담은 날 */}
        <section className="sc-card">
          <h4>
            차트 흐름 <span className="pt-n">최근 {d.bars.slice(-60).length}일 · 종가</span>
          </h4>
          <MiniLine
            height={130}
            labels={barLabels.slice(-60)}
            series={[{ label: "종가", color: "var(--red)", values: d.bars.slice(-60).map((b) => b.c) }]}
            yFmt={(v) => Math.round(v).toLocaleString("ko-KR")}
            markX={(() => {
              const s = r.since.slice(0, 10).replace(/-/g, "");
              const i = d.bars.slice(-60).findIndex((b) => b.d >= s);
              return i >= 0 ? i : undefined;
            })()}
            markXLabel="담은 날"
          />
          <dl className="sc-kv">
            {/* 「5일선 대비」로 적어야 무엇과 견준 값인지 라벨만 보고 안다 */}
            <div title="종가가 5일 이동평균보다 위인가 아래인가"><dt>5일선 대비</dt>
              <dd className={cls(r.chart.ma5Gap)}>{pct(r.chart.ma5Gap)} <span className="sc-gap-w">{gapWord(r.chart.ma5Gap)}</span></dd></div>
            <div title="종가가 20일 이동평균보다 위인가 아래인가"><dt>20일선 대비</dt>
              <dd className={cls(r.chart.ma20Gap)}>{pct(r.chart.ma20Gap)} <span className="sc-gap-w">{gapWord(r.chart.ma20Gap)}</span></dd></div>
            <div title="종가가 60일 이동평균보다 위인가 아래인가"><dt>60일선 대비</dt>
              <dd className={cls(r.chart.ma60Gap)}>{pct(r.chart.ma60Gap)} <span className="sc-gap-w">{gapWord(r.chart.ma60Gap)}</span></dd></div>
            {/* 고점은 위로 갈 수 없다 — 0 이면 신고가고, 음수면 그만큼 내려와 있다 */}
            <div title="최근 20일 종가 고점에서 얼마나 내려와 있나. 0 이면 신고가 자리"><dt>20일 고점 대비</dt>
              <dd className={cls(r.chart.hi20Gap)}>{pct(r.chart.hi20Gap)} <span className="sc-gap-w">{r.chart.hi20Gap === 0 ? "신고가" : gapWord(r.chart.hi20Gap)}</span></dd></div>
            <div><dt>5일</dt><dd className={cls(r.chart.ret5)}>{pct(r.chart.ret5)}</dd></div>
            <div><dt>20일</dt><dd className={cls(r.chart.ret20)}>{pct(r.chart.ret20)}</dd></div>
            <div><dt>거래량</dt><dd>{r.chart.volRatio === null ? "-" : `${r.chart.volRatio}배`}</dd></div>
          </dl>
          {/*
            **표를 읽는 법을 표 밑에 적는다** (2026-09-09 — 벤티지 "설명 좀 붙이자").

            바로 앞에서 「5일선 −1.8% 가 위냐 아래냐」가 나왔다. 라벨에 「대비」와
            「위/아래」를 붙여 그 줄은 풀렸지만, **무엇을 무엇과 견줬는지**는 여전히
            표 밖의 지식이다. 「5일」과 「5일선」이 다른 값이라는 것도 그렇다 —
            하나는 닷새 전 종가와의 등락이고 하나는 이동평균과의 거리다.
          */}
          <p className="table-note">
            <b>「대비」는 지금 종가가 그 선에서 얼마나 떨어져 있나</b>입니다 — <b>+면 위</b>,
            <b>−면 아래</b>. 「20일 고점 대비」는 위로 갈 수 없어 늘 0 이하이고, <b>0 이면
            신고가</b> 자리입니다.
            <br />
            <b>「5일」·「20일」은 그때와 견준 등락률</b>입니다(닷새 전·스무 날 전 종가 대비) —
            <b>「5일선」과는 다른 값</b>입니다. 거래량은 <b>어제까지 20일 평균의 몇 배</b>로,
            1배면 평소만큼입니다.
          </p>
        </section>

        {/* ② 외국인·기관·개인 60일 누적 */}
        <section className="sc-card">
          <h4>
            수급 흐름 <span className="pt-n">60일 누적 · 억원</span>
          </h4>
          <MiniLine
            height={130}
            labels={labels}
            refY={0}
            series={[
              { label: "외국인", color: "var(--red)", values: cumul(d.flow, (x) => x.fgn) },
              { label: "기관", color: "var(--blue)", values: cumul(d.flow, (x) => x.org) },
              { label: "개인", color: "var(--muted)", values: cumul(d.flow, (x) => x.ind), dash: true },
            ]}
            yFmt={(v) => v.toFixed(0)}
            markX={sinceIdx}
            markXLabel="담은 날"
          />
          <dl className="sc-kv">
            <div><dt>외인 5일</dt><dd className={cls(r.fgn.d5)}>{억(r.fgn.d5)} <Streak f={r.fgn} /></dd></div>
            <div><dt>외인 20일</dt><dd className={cls(r.fgn.d20)}>{억(r.fgn.d20)}</dd></div>
            <div><dt>기관 5일</dt><dd className={cls(r.org.d5)}>{억(r.org.d5)} <Streak f={r.org} /></dd></div>
            <div><dt>기관 20일</dt><dd className={cls(r.org.d20)}>{억(r.org.d20)}</dd></div>
            <div><dt>지분율</dt><dd>{r.fgnRatio.now === null ? "-" : `${r.fgnRatio.now.toFixed(2)}%`}
              {r.fgnRatio.chg20 !== null && <span className={`pt-n ${cls(r.fgnRatio.chg20)}`}> {r.fgnRatio.chg20 > 0 ? "+" : ""}{r.fgnRatio.chg20}%p</span>}
            </dd></div>
          </dl>
        </section>

        {/* ③ 기관 3대장 */}
        <section className="sc-card">
          <h4>
            기관 3대장 <span className="pt-n">연기금 · 투신 · 사모 · 60일 누적</span>
          </h4>
          <MiniLine
            height={130}
            labels={labels}
            refY={0}
            series={[
              { label: "연기금", color: "#f59e0b", values: cumul(d.flow, (x) => x.pen) },
              { label: "투신", color: "#22c55e", values: cumul(d.flow, (x) => x.trust) },
              { label: "사모", color: "#a855f7", values: cumul(d.flow, (x) => x.samo) },
            ]}
            yFmt={(v) => v.toFixed(0)}
            markX={sinceIdx}
          />
          <dl className="sc-kv">
            <div><dt>연기금 5/20</dt><dd><span className={cls(r.pen.d5)}>{억(r.pen.d5)}</span> / <span className={cls(r.pen.d20)}>{억(r.pen.d20)}</span> <Streak f={r.pen} /></dd></div>
            <div><dt>투신 5/20</dt><dd><span className={cls(r.trust.d5)}>{억(r.trust.d5)}</span> / <span className={cls(r.trust.d20)}>{억(r.trust.d20)}</span> <Streak f={r.trust} /></dd></div>
            <div><dt>사모 5/20</dt><dd><span className={cls(r.samo.d5)}>{억(r.samo.d5)}</span> / <span className={cls(r.samo.d20)}>{억(r.samo.d20)}</span> <Streak f={r.samo} /></dd></div>
            <div><dt>셋 합 5/20</dt><dd><b className={cls(r.big3.d5)}>{억(r.big3.d5)}</b> / <b className={cls(r.big3.d20)}>{억(r.big3.d20)}</b></dd></div>
          </dl>
        </section>

        {/* ④ 공매도·대차 */}
        <section className="sc-card">
          <h4>
            공매도 · 대차잔고 <span className="pt-n">60일</span>
          </h4>
          {d.short.length > 1 ? (
            <MiniLine
              height={100}
              labels={shortLabels}
              series={[{ label: "공매도 비중(%)", color: "#f97316", values: d.short.map((x) => x.ratio) }]}
              yFmt={(v) => `${v.toFixed(1)}%`}
            />
          ) : (
            <p className="pt-n">공매도 원장이 아직 없습니다</p>
          )}
          {d.loan.length > 1 ? (
            <MiniLine
              height={100}
              labels={loanLabels}
              series={[{ label: "대차잔고(만주)", color: "#0ea5e9", values: d.loan.map((x) => (x.rmnd === null ? null : x.rmnd / 10_000)) }]}
              yFmt={(v) => v.toFixed(0)}
            />
          ) : (
            <p className="pt-n">대차잔고 원장이 아직 없습니다</p>
          )}
          <dl className="sc-kv">
            <div><dt>공매도 비중</dt><dd>{r.short.ratio === null ? "-" : `${r.short.ratio.toFixed(2)}%`}
              <span className="pt-n"> 20일 평균 {r.short.ratio20 === null ? "-" : `${r.short.ratio20.toFixed(2)}%`}</span></dd></div>
            <div><dt>대차잔고</dt><dd>{r.loan.rmnd === null ? "-" : `${Math.round(r.loan.rmnd / 10_000).toLocaleString("ko-KR")}만주`}
              <span className={`pt-n ${cls(r.loan.chg20 === null ? null : -r.loan.chg20)}`}> 20일 {pct(r.loan.chg20)}</span></dd></div>
          </dl>
          <p className="pt-n sc-hint">
            공매도 비중이 20일 평균보다 뛰고 대차잔고가 느는 조합이면 누군가 내려가는 데 걸고 있다 —
            매수 직전이라면 그 이유를 먼저 알아야 합니다.
          </p>
        </section>

        {/* ⑤ 오늘 */}
        <section className="sc-card">
          <h4>
            오늘 수급 <span className="pt-n">{t ? `${t.date.slice(4, 6)}/${t.date.slice(6)} · 억원` : ""}</span>
          </h4>
          {!t ? (
            <p className="pt-n">오늘 수급을 못 받았습니다</p>
          ) : (
            <>
              <dl className="sc-kv sc-today">
                {t.main.map((m) => (
                  <div key={m.key}>
                    <dt>{m.label}</dt>
                    <dd className={cls(m.amount)}>{억(m.amount / 100)}</dd>
                  </div>
                ))}
                {t.program !== null && (
                  <div>
                    <dt>프로그램</dt>
                    <dd className={cls(t.program)}>{억(t.program / 100)}</dd>
                  </div>
                )}
                {t.facts.strength !== null && (
                  <div title="100 보다 크면 사는 쪽이 세다">
                    <dt>체결강도</dt>
                    <dd className={t.facts.strength >= 100 ? "positive" : "negative"}>{t.facts.strength.toFixed(0)}</dd>
                  </div>
                )}
                {t.facts.tradeValue !== null && (
                  <div>
                    <dt>거래대금</dt>
                    <dd>{억크기(t.facts.tradeValue)}</dd>
                  </div>
                )}
              </dl>
              {inst.length > 0 && (
                <div className="sc-inst">
                  {inst.map((m) => (
                    <span key={m.key} className={cls(m.amount)}>
                      {m.label} {억(m.amount / 100)}
                    </span>
                  ))}
                </div>
              )}
              {intr.length > 1 ? (
                <MiniLine
                  height={100}
                  labels={intr.map((p) => p.t)}
                  refY={0}
                  series={[
                    { label: "외국인", color: "var(--red)", values: intr.map((p) => p.frgn / 100) },
                    { label: "기관", color: "var(--blue)", values: intr.map((p) => p.orgn / 100) },
                    { label: "개인", color: "var(--muted)", values: intr.map((p) => p.ind / 100), dash: true },
                  ]}
                  yFmt={(v) => v.toFixed(0)}
                />
              ) : (
                <p className="pt-n sc-hint">
                  장중 누적선은 <b>보고 있는 동안만</b> 쌓입니다 — 이 화면이나 종목 상세를 열어 둔 시간의 흐름입니다.
                </p>
              )}
            </>
          )}
        </section>

        {/* ⑥ 뉴스 · 텔레그램 */}
        <section className="sc-card sc-feed">
          <h4>
            뉴스 <span className="pt-n">{d.news.length}건</span>
          </h4>
          {d.news.length === 0 ? (
            <p className="pt-n">최근 뉴스가 없습니다</p>
          ) : (
            <ul className="sc-list">
              {d.news.map((n) => (
                <li key={n.link}>
                  <a href={n.link} target="_blank" rel="noreferrer">{n.title}</a>
                  <span className="pt-n"> {n.press} · {n.publishedAt.slice(5, 16).replace("T", " ")}</span>
                </li>
              ))}
            </ul>
          )}
          <h4>
            텔레그램 <span className="pt-n">사흘 · {d.telegram.length}건</span>
          </h4>
          {d.telegram.length === 0 ? (
            <p className="pt-n">
              채널 글 창고에 언급이 없습니다
              {d.telegramOldest ? ` (창고는 ${d.telegramOldest.slice(5, 10)} 부터)` : ""}
            </p>
          ) : (
            <ul className="sc-list">
              {d.telegram.map((m) => (
                <li key={`${m.channelId}:${m.messageId}`}>
                  {m.link ? (
                    <a href={m.link} target="_blank" rel="noreferrer">{m.text.slice(0, 140)}</a>
                  ) : (
                    <span>{m.text.slice(0, 140)}</span>
                  )}
                  <span className="pt-n"> {m.channelName} · {m.at.slice(5, 16).replace("T", " ")}</span>
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>
    </div>
  );
}

/* ── 페이지 ──────────────────────────────────────────────────────── */

export function ScopePage({ onSelectStock }: { onSelectStock: (code: string, name: string) => void }) {
  const [rows, setRows] = useState<ScopeRow[]>([]);
  const [ledgerNote, setLedgerNote] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  const [at, setAt] = useState<Date | null>(null);
  const watched = useWatchedCodes();

  /*
   * **실시간을 얹는다** (2026-09-09 — 벤티지 "매수직전 메뉴에서 각 종목들의 현재가가
   * 실시간으로 반영이 안 되는 것 같거든").
   *
   * 맞다. 이 화면은 **60초 폴링뿐**이었다 — 시세분석·관심종목은 실시간을 얹는데 여기만
   * 빠져 있었다. 매수 직전에 보는 화면이 제일 늦게 움직이고 있었던 셈이다.
   *
   * **읽기 전용**이다(`sub=0`). 여기 종목은 관심종목 「현미경」 그룹이고, 스케줄러가
   * 관심종목을 맨 먼저 걸어 두므로(`targets`) 값은 이미 와 있다 — 새로 구독을 걸어
   * 정원(200)을 먹을 이유가 없다. 값이 없으면 그냥 폴링 값이 그대로 보인다.
   */
  const rt = useRealtime(
    rows.map((r) => `0B:${r.code}`),
    2000,
    { readOnly: true },
  );
  /*
   * 마크·뉴스·텔레그램 (2026-09-09 밤 — 벤티지 "현미경에는 텔레그램/뉴스, 그리고 각종 마크
   * 표시가 안 되어 있네 표시하자고"). 시세분석 표와 같은 훅·같은 팝업이다.
   */
  const buzz = useBuzz(rows.map((r) => r.code));
  /** 실시간이 준 현재가·등락률 — 없으면 null 이고, 그때는 폴링 값을 쓴다 */
  const liveOf = (code: string): { price: number; rate: number | null } | null => {
    const v = rt.values[`0B:${code}`];
    if (!v) return null;
    const price = fid(v, "10");
    if (price === null || price === 0) return null;
    return { price: Math.abs(price), rate: fid(v, "12") };
  };
  /* 정렬·표시는 실시간이 얹힌 값으로 — 안 그러면 값만 바뀌고 순서가 옛날 것으로 남는다 */
  const shown = useMemo(
    () =>
      rows.map((r) => {
        const lv = liveOf(r.code);
        return lv ? { ...r, price: lv.price, changeRate: lv.rate ?? r.changeRate } : r;
      }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [rows, rt.values],
  );
  const sort = useSortableTable(shown);

  const load = useCallback(async () => {
    setError(null);
    try {
      const r = await api.scopeList();
      setRows(r.rows);
      setLedgerNote(r.ledgerNote);
      setAt(new Date());
    } catch (e) {
      setError(e instanceof Error ? e.message : "불러오기 실패");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
    /* 현재가와 오늘 수급만 바뀐다 — 1분이면 된다(오늘 수급은 서버가 1분 캐시) */
    const t = setInterval(() => void load(), 60_000);
    return () => clearInterval(t);
  }, [load]);

  /* 어느 화면에서든 담기 시트에서 「현미경」에 체크하면 여기도 바로 */
  useEffect(() => {
    if (watched.version === 0) return;
    void load();
  }, [watched.version, load]);

  /* 표 위 요약 — 오늘 외국인·기관이 이 바구니를 통째로 어떻게 대했나 */
  const sumToday = (k: "fgn" | "org") =>
    rows.reduce<number | null>((s, r) => (r.today && r.today[k] !== null ? (s ?? 0) + (r.today[k] as number) : s), null);
  const fgnBuying = rows.filter((r) => r.fgn.streak >= 3).length;

  return (
    <div className="scope-page">
      <div className="page-header">
        <h2>🔎 매수직전</h2>
        <p className="page-sub">
          관심종목 <b className="gt-scope-inline">🧨 현미경</b> 그룹의 종목을 같은 잣대로 나란히 놓습니다 — 이 중에서 무엇을 사나.
          담는 것은 관심종목 담기 시트에서 「현미경」에 체크하면 됩니다. <b>여기서 주문은 안 나갑니다.</b>
        </p>
      </div>

      {error && <div className="error-banner">{error}</div>}

      {ledgerNote && <p className="sc-ledger-note">⏱ {ledgerNote}</p>}

      {rows.length > 0 && (
        <div className="sc-strip">
          <span><b>{rows.length}</b>종목</span>
          <span>오늘 외국인 <b className={cls(sumToday("fgn"))}>{억(sumToday("fgn"))}</b></span>
          <span>오늘 기관 <b className={cls(sumToday("org"))}>{억(sumToday("org"))}</b></span>
          <span>외국인 3일↑ 연속 매수 <b>{fgnBuying}</b>종목</span>
          <span className="pt-n sc-at">{at ? `${at.toLocaleTimeString("ko-KR", { hour: "2-digit", minute: "2-digit" })} 기준` : ""}</span>
          <button className="refresh-btn" onClick={() => void load()}>새로고침</button>
        </div>
      )}

      {loading ? (
        <div className="empty">현미경을 맞추는 중…</div>
      ) : rows.length === 0 ? (
        <div className="card sc-empty">
          <b>현미경에 담긴 종목이 없습니다.</b>
          <p className="pt-n">
            슈퍼신호등·교차·점수대 등 모든 그룹과 지표를 보고 <b>매수 직전</b>으로 좁힌 종목을 담는 자리입니다.
            어느 화면에서든 관심종목 담기 시트에서 <b>🧨 현미경</b>에 체크하세요.
          </p>
        </div>
      ) : (
        <div className="data-table-wrap">
          <table className="data-table sc-table">
            <thead>
              <tr>
                <SortableTh columnKey="name" label="종목" accessor={(r) => r.name} sort={sort} />
                <SortableTh columnKey="chg" label="현재가" accessor={(r) => low(r.changeRate)} sort={sort} className="num" />
                <SortableTh columnKey="since" label="담은 뒤" accessor={(r) => low(r.sinceRet)} sort={sort} className="num" />
                <SortableTh columnKey="tf" label={<>오늘<br />외인</>} accessor={(r) => low(r.today?.fgn)} sort={sort} className="num sc-today-col" />
                <SortableTh columnKey="to" label={<>오늘<br />기관</>} accessor={(r) => low(r.today?.org)} sort={sort} className="num sc-today-col" />
                <SortableTh columnKey="f5" label={<>외인<br />5일</>} accessor={(r) => low(r.fgn.d5)} sort={sort} className="num" />
                <SortableTh columnKey="f20" label={<>외인<br />20일</>} accessor={(r) => low(r.fgn.d20)} sort={sort} className="num" />
                <SortableTh columnKey="o5" label={<>기관<br />5일</>} accessor={(r) => low(r.org.d5)} sort={sort} className="num" />
                <SortableTh columnKey="o20" label={<>기관<br />20일</>} accessor={(r) => low(r.org.d20)} sort={sort} className="num" />
                <SortableTh columnKey="b5" label={<>3대장<br />5일</>} accessor={(r) => low(r.big3.d5)} sort={sort} className="num" thProps={{ title: "연기금 + 투신 + 사모" }} />
                <SortableTh columnKey="b20" label={<>3대장<br />20일</>} accessor={(r) => low(r.big3.d20)} sort={sort} className="num" thProps={{ title: "연기금 + 투신 + 사모" }} />
                <SortableTh columnKey="sh" label={<>공매도<br />비중</>} accessor={(r) => low(r.short.ratio)} sort={sort} className="num" thProps={{ title: "최근 일 공매도 비중. 아래 작은 수는 20일 평균" }} />
                <SortableTh columnKey="ln" label={<>대차<br />20일</>} accessor={(r) => low(r.loan.chg20)} sort={sort} className="num" thProps={{ title: "대차잔고 20일 전 대비 변화" }} />
                <SortableTh columnKey="fr" label={<>지분율<br />Δ20</>} accessor={(r) => low(r.fgnRatio.chg20)} sort={sort} className="num" thProps={{ title: "외국인 지분율, 20일 전 대비 %p" }} />
                <SortableTh columnKey="ma5" label={<>5일선<br />이격</>} accessor={(r) => low(r.chart.ma5Gap)} sort={sort} className="num" />
                <SortableTh columnKey="ma" label={<>20일선<br />이격</>} accessor={(r) => low(r.chart.ma20Gap)} sort={sort} className="num" />
                <SortableTh columnKey="hi" label={<>20일<br />고점</>} accessor={(r) => low(r.chart.hi20Gap)} sort={sort} className="num" />
                <th className="sc-spark-col">60일</th>
                <th>메모</th>
              </tr>
            </thead>
            <tbody>
              {sort.sorted.map((r) => (
                <tr
                  key={r.code}
                  className={`sc-row${open === r.code ? " on" : ""}`}
                  onClick={() => setOpen(open === r.code ? null : r.code)}
                >
                  {/*
                    세 줄 (2026-09-09 밤 — 벤티지 "3줄이니까 무지개 이런 마크들도 밑에 내리고"):
                    ① 이름·코드 ② 시장·업종 ③ 마크·뉴스·텔레그램. 오른쪽 정렬을 지킨다.
                  */}
                  <td className="sc-name">
                    <b>{r.name}</b>
                    <span className="pt-n"> {r.code}</span>
                    <div className="pt-n">
                      {r.market && <i className="scr-mkt">{r.market}</i>}
                      {r.sector}
                    </div>
                    <div className="sc-name-marks">
                      <SuperMark code={r.code} />
                      {buzz.badge(r.code, r.name)}
                    </div>
                  </td>
                  {/*
                    **실시간으로 오는 값인지 점으로 말한다** (2026-09-09 — 벤티지 "실시간 표시가
                    되어 있으면 얘가 실시간 받는구나 더 잘 알 수 있을 것 같은데"). 해외 표와 같은
                    점이다. 점이 없으면 60초 폴링 값이고, 그때는 왜 없는지도 손에 올리면 나온다.
                  */}
                  <td className={`num ${cls(r.changeRate)}`}>
                    <span
                      className={`uw-live-dot${liveOf(r.code) ? " rt" : " off"}`}
                      title={
                        liveOf(r.code)
                          ? "실시간 체결 — 값이 오는 대로 갱신됩니다"
                          : "실시간 값이 아직 없습니다 — 60초 조회로 채웁니다"
                      }
                    />
                    {won(r.price)}
                    <div>{pct(r.changeRate, 2)}</div>
                  </td>
                  <td className={`num ${cls(r.sinceRet)}`} title={`${r.since.slice(0, 10)} 에 ${won(r.sincePrice)}원`}>
                    {pct(r.sinceRet)}
                    <div className="pt-n">{daysSince(r.since)}일</div>
                  </td>
                  <td className={`num sc-today-col ${cls(r.today?.fgn)}`}>{r.today ? 억(r.today.fgn) : <span className="pt-n">-</span>}</td>
                  <td className={`num sc-today-col ${cls(r.today?.org)}`}>{r.today ? 억(r.today.org) : <span className="pt-n">-</span>}</td>
                  <td className={`num ${cls(r.fgn.d5)}`}>{억(r.fgn.d5)}<div><Streak f={r.fgn} /></div></td>
                  <td className={`num ${cls(r.fgn.d20)}`}>{억(r.fgn.d20)}</td>
                  <td className={`num ${cls(r.org.d5)}`}>{억(r.org.d5)}<div><Streak f={r.org} /></div></td>
                  <td className={`num ${cls(r.org.d20)}`}>{억(r.org.d20)}</td>
                  <td className={`num ${cls(r.big3.d5)}`} title={`연기금 ${억(r.pen.d5)} · 투신 ${억(r.trust.d5)} · 사모 ${억(r.samo.d5)}`}>{억(r.big3.d5)}</td>
                  <td className={`num ${cls(r.big3.d20)}`} title={`연기금 ${억(r.pen.d20)} · 투신 ${억(r.trust.d20)} · 사모 ${억(r.samo.d20)}`}>{억(r.big3.d20)}</td>
                  <td className={`num ${r.short.ratio !== null && r.short.ratio20 !== null && r.short.ratio > r.short.ratio20 * 1.5 ? "negative" : ""}`}>
                    {r.short.ratio === null ? "-" : `${r.short.ratio.toFixed(1)}%`}
                    <div className="pt-n">{r.short.ratio20 === null ? "" : `${r.short.ratio20.toFixed(1)}%`}</div>
                  </td>
                  <td className={`num ${cls(r.loan.chg20 === null ? null : -r.loan.chg20)}`}>{pct(r.loan.chg20)}</td>
                  <td className={`num ${cls(r.fgnRatio.chg20)}`}>
                    {r.fgnRatio.chg20 === null ? "-" : `${r.fgnRatio.chg20 > 0 ? "+" : ""}${r.fgnRatio.chg20}%p`}
                    <div className="pt-n">{r.fgnRatio.now === null ? "" : `${r.fgnRatio.now.toFixed(1)}%`}</div>
                  </td>
                  <td className={`num ${cls(r.chart.ma5Gap)}`}>{pct(r.chart.ma5Gap)}</td>
                  <td className={`num ${cls(r.chart.ma20Gap)}`}>{pct(r.chart.ma20Gap)}</td>
                  <td className={`num ${cls(r.chart.hi20Gap)}`}>{pct(r.chart.hi20Gap)}</td>
                  <td className="sc-spark-col"><Spark closes={r.chart.closes} /></td>
                  <td className="sc-memo" title={r.note}>{r.note ? r.note.slice(0, 40) : <span className="pt-n">—</span>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {open && rows.some((r) => r.code === open) && (
        <Detail
          code={open}
          live={liveOf(open)}
          onSelectStock={onSelectStock}
          onRemoved={() => {
            setOpen(null);
            void load();
          }}
          onNote={(code, note) => setRows((p) => p.map((r) => (r.code === code ? { ...r, note } : r)))}
        />
      )}

      <p className="table-note">
        수급은 억원(순매수). 5일·20일은 원장의 마지막 날 기준이며 장중에는 어제까지입니다 — 「오늘」 칸만 지금 값입니다.
        공매도 비중이 20일 평균의 1.5배를 넘으면 빨갛게, 대차잔고는 <b>줄어야</b> 빨갛게 적습니다.
      </p>
      {buzz.sheet(onSelectStock)}
    </div>
  );
}
