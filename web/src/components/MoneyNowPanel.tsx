import { useEffect, useRef, useState } from "react";
import { api, type MoneyAccountRow, type MoneyBuyerRow, type MoneyNow, type MoneyWhereTheme } from "../api";

/**
 * **돈의 흐름 — 「지금」 탭** (2026-09-17, 벤티지: "직장인·단타·스윙·종배 트레이더에게 가장 귀중한 정보를 가장 효율적으로").
 *
 * 한 화면, 위에서 아래로 30초. 계산은 전부 서버(moneyNow.ts) — 여기는 그리기만.
 *   ① 판정 띠  ② 돈이 가는 곳  ③ 지금 사는 손  ④ 내 계좌 렌즈  ⑤ 시간대 플랜
 * 폰이 먼저다 — 칸을 세로로 쌓고, 표는 최소 열. 종목을 누르면 상세.
 */
const pct = (v: number | null | undefined, d = 1) => (v === null || v === undefined ? "–" : `${v > 0 ? "+" : ""}${v.toFixed(d)}%`);
const cls = (v: number | null | undefined) => (v === null || v === undefined || v === 0 ? "" : v > 0 ? "positive" : "negative");

const KIND: Record<MoneyNow["verdict"]["kind"], { label: string; cls: string; icon: string }> = {
  in: { label: "돈이 들어오는 장", cls: "in", icon: "🟢" },
  out: { label: "돈이 빠지는 장", cls: "out", icon: "🔴" },
  rotate: { label: "회전만 도는 장", cls: "rotate", icon: "🟡" },
  unknown: { label: "판정 보류", cls: "", icon: "⚪" },
};

function ThemeChip({ t, onSelectStock }: { t: MoneyWhereTheme; onSelectStock?: (code: string, name: string) => void }) {
  return (
    <div className="mnw-theme">
      <b className={cls(t.changeRate)}>
        {t.name} {pct(t.changeRate)}
      </b>
      <span className="pt-n">
        {t.m1 !== null ? `한 달 ${pct(t.m1, 0)} · ` : ""}
        {Math.round(t.tradeValue).toLocaleString("ko-KR")}억
      </span>
      <span className="mnw-theme-stocks">
        {t.stocks.map((s) => (
          <button key={s.code} type="button" className="link-btn" onClick={() => onSelectStock?.(s.code, s.name)}>
            {s.name} <em className={cls(s.changeRate)}>{pct(s.changeRate)}</em>
          </button>
        ))}
      </span>
    </div>
  );
}

function BuyerLine({ b, i, onSelectStock }: { b: MoneyBuyerRow; i: number; onSelectStock?: (code: string, name: string) => void }) {
  return (
    <button type="button" className="mnw-row" onClick={() => onSelectStock?.(b.code, b.name)}>
      <b className="mnw-rank">{i + 1}</b>
      <span className="mnw-nm">
        {b.name}
      </span>
      <em className={`num ${cls(b.rate)}`}>{pct(b.rate)}</em>
      <span className="mnw-boost" title={b.boostKind === "30분" ? "최근 30분 거래대금 ÷ 오늘 평균 30분 거래대금" : "오늘 거래대금 ÷ (20일 평균 × 시각별 진행률)"}>
        ×{b.boost == null ? "—" : b.boost.toFixed(1)} <i>{b.boostKind}</i>
      </span>
      <span className="mnw-sub">
        {b.theme && <i className="mnw-theme-tag">{b.theme}</i>}
        {b.strength !== null && <i className={b.strength >= 120 ? "hot" : ""}>강도 {Math.round(b.strength)}</i>}
        {b.value30 !== null && <i>30분 {b.value30.toLocaleString("ko-KR")}억</i>}
        {b.todayValue !== null && <i>오늘 {b.todayValue.toLocaleString("ko-KR")}억</i>}
        {b.tags.map((t) => (
          <i key={t} className="mnw-tag">
            {t}
          </i>
        ))}
      </span>
    </button>
  );
}

const V: Record<MoneyAccountRow["verdict"], { label: string; cls: string }> = {
  in: { label: "들어옴", cls: "in" },
  out: { label: "빠짐", cls: "out" },
  quiet: { label: "조용", cls: "" },
};

function AccountLine({ r, onSelectStock }: { r: MoneyAccountRow; onSelectStock?: (code: string, name: string) => void }) {
  return (
    <button type="button" className="mnw-row mnw-acc" onClick={() => onSelectStock?.(r.code, r.name)} title={r.why}>
      <b className={`mnw-verdict ${V[r.verdict].cls}`}>{V[r.verdict].label}</b>
      <span className="mnw-nm">
        {r.name}
      </span>
      <em className={`num ${cls(r.rate)}`}>{pct(r.rate)}</em>
      <em className={`num mnw-pnl ${cls(r.pnlRate)}`} title="보유 수익률">{r.pnlRate === null ? "" : pct(r.pnlRate)}</em>
      <span className="mnw-sub">
        {r.isEtf && <i className="mnw-theme-tag">ETF</i>}
        {r.rotation &&<i className={`mnw-rot ${r.rotation}`}>{r.rotation}{r.theme ? ` · ${r.theme}` : ""}</i>}
        {r.est && (
          <i className={r.est.fgn + r.est.orgn > 0 ? "hot" : r.est.fgn + r.est.orgn < 0 ? "cold" : ""}>
            {r.est.time} 외인 {r.est.fgn > 0 ? "+" : ""}
            {(r.est.fgn / 1000).toFixed(1)}천주 · 기관 {r.est.orgn > 0 ? "+" : ""}
            {(r.est.orgn / 1000).toFixed(1)}천주
          </i>
        )}
        {r.boost !== null && <i>{r.isEtf ? "배수" : "30분"} ×{r.boost.toFixed(1)}</i>}
        {r.strength !== null && <i>강도 {Math.round(r.strength)}</i>}
        {r.tags.map((t) => (
          <i key={t} className="mnw-tag">
            {t}
          </i>
        ))}
      </span>
    </button>
  );
}

export function MoneyNowPanel({ onSelectStock }: { onSelectStock?: (code: string, name: string) => void }) {
  const [data, setData] = useState<MoneyNow | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const loadSeq = useRef(0);
  const load = (fresh = false) => {
    setBusy(true);
    const seq = ++loadSeq.current; // ↻ 직후 늦게 온 옛 폴링이 새 값을 덮지 않게 (2026-09-18 전수검증 D19)
    api
      .moneyNow(fresh)
      .then((r) => {
        if (seq !== loadSeq.current) return;
        setData(r);
        setError(null);
      })
      .catch((e: Error) => {
        if (seq === loadSeq.current) setError(e.message);
      })
      .finally(() => {
        if (seq === loadSeq.current) setBusy(false);
      });
  };
  useEffect(() => {
    load();
    /* 서버가 60초 캐시라 60초면 충분하다 — 보이지 않을 땐 쉰다 */
    const t = window.setInterval(() => {
      if (document.visibilityState === "visible") load();
    }, 60_000);
    return () => window.clearInterval(t);
  }, []);

  if (error && !data) return <div className="error-banner">{error}</div>;
  if (!data) return <div className="empty">돈의 흐름을 재는 중… (처음엔 잔고·잠정치까지 10초쯤)</div>;

  const k = KIND[data.verdict.kind];
  const at = new Date(data.at).toLocaleTimeString("ko-KR", { hour: "2-digit", minute: "2-digit" });
  const inRows = data.account.rows.filter((r) => r.verdict === "in");
  const outRows = data.account.rows.filter((r) => r.verdict === "out");
  /* 계좌별 묶음 — 들어온 순서(키움 → 수동 계좌 차례)를 지키고, 묶음 요약은 평가금액 가중 등락 */
  const groups = (() => {
    const m = new Map<string, MoneyAccountRow[]>();
    for (const r of data.account.rows) m.set(r.account, [...(m.get(r.account) ?? []), r]);
    return [...m.entries()].map(([name, rows]) => {
      const valueMan = rows.reduce((s, r) => s + (r.valueMan ?? 0), 0);
      const w = rows.filter((r) => r.rate !== null && (r.valueMan ?? 0) > 0);
      const wsum = w.reduce((s, r) => s + (r.valueMan ?? 0), 0);
      const rate = wsum > 0 ? w.reduce((s, r) => s + (r.rate ?? 0) * (r.valueMan ?? 0), 0) / wsum : null;
      return { name, rows, valueMan, rate, in: rows.filter((r) => r.verdict === "in").length, out: rows.filter((r) => r.verdict === "out").length };
    });
  })();

  return (
    <div className="mnw">
      {/* ① 판정 띠 */}
      <section className={`mnw-verdict-card ${k.cls}`}>
        <div className="mnw-vhead">
          <span className="mnw-slot">{data.slot.label}</span>
          <b className="mnw-kind">
            {k.icon} {k.label}
          </b>
          <span className="mnw-at">
            {at}
            {data.stale ? " · 갱신 중" : ""}
            <button type="button" className={`ov-refresh${busy ? " busy" : ""}`} onClick={() => load(true)} title="지금 다시 재기">
              ↻
            </button>
          </span>
        </div>
        <div className="mnw-line">{data.verdict.line}</div>
        <div className="mnw-parts">
          {data.verdict.parts.map((p) => (
            <span key={p.key} className={`mnw-part ${p.sign === 1 ? "up" : p.sign === -1 ? "down" : p.sign === 0 ? "flat" : "na"}`} title={p.text}>
              <i>{p.sign === 1 ? "▲" : p.sign === -1 ? "▼" : p.sign === 0 ? "–" : "?"}</i> {p.label}
              <small>{p.text}</small>
            </span>
          ))}
        </div>
        {/* 추세 + 성적표 (2026-09-17 저녁 — "판정을 믿을 근거가 없다") */}
        {(data.trend.length > 1 || data.record.days > 0) && (
          <div className="mnw-trend">
            {data.trend.length > 1 && (
              <span className="mnw-trend-line" title="오늘 판정이 10분마다 어떻게 바뀌었나">
                {data.trend.slice(-6).map((t, i) => (
                  <em key={t.hhmm} className={`k-${t.kind}`}>
                    {i > 0 && <i>→</i>}
                    {t.hhmm} {t.kind === "in" ? "들어옴" : t.kind === "out" ? "빠짐" : t.kind === "rotate" ? "회전" : "?"}
                  </em>
                ))}
              </span>
            )}
            <span className="mnw-record" title={data.record.note}>
              {data.record.days > 0
                ? `📋 판정 성적 ${data.record.days}일 — 10:00 ${data.record.n1000 > 0 ? `${Math.round((data.record.hit1000 / data.record.n1000) * 100)}%` : "–"} · 13:30 ${data.record.n1330 > 0 ? `${Math.round((data.record.hit1330 / data.record.n1330) * 100)}%` : "–"}`
                : "📋 판정 성적표는 오늘부터 쌓입니다"}
            </span>
          </div>
        )}
        <div className="mnw-advice">🕒 {data.slot.advice}</div>
      </section>

      {/* ② 돈이 가는 곳 */}
      <section className="card mnw-card">
        <h3>
          돈이 가는 곳 <span className="usm-sub">테마 로테이션 · 국내 ETF · 어젯밤 미국</span>
        </h3>
        {!data.where.ready && <div className="pt-n">월간 누적이 아직 없어 로테이션 분류가 비어 있습니다 (마감 뒤 정리가 돌면 채워집니다)</div>}
        <div className="mnw-where">
          <div className="mnw-where-col">
            <div className="mnw-h">🚀 신규 부상 <i>한 달 조용했는데 오늘 튐 — 자리바꿈의 입구</i></div>
            {data.where.fresh.length === 0 && <div className="pt-n">없음</div>}
            {data.where.fresh.map((t) => (
              <ThemeChip key={t.key} t={t} onSelectStock={onSelectStock} />
            ))}
          </div>
          <div className="mnw-where-col">
            <div className="mnw-h">🏁 주도 지속 <i>한 달을 끌어 왔고 오늘도</i></div>
            {data.where.lead.length === 0 && <div className="pt-n">없음</div>}
            {data.where.lead.map((t) => (
              <ThemeChip key={t.key} t={t} onSelectStock={onSelectStock} />
            ))}
          </div>
          <div className="mnw-where-col">
            <div className="mnw-h">😴 주도 휴식 <i>끌어 왔는데 오늘 쉼 — 눌림인지 이탈인지</i></div>
            {data.where.rest.length === 0 && <div className="pt-n">없음</div>}
            {data.where.rest.map((t) => (
              <ThemeChip key={t.key} t={t} onSelectStock={onSelectStock} />
            ))}
          </div>
        </div>
        <div className="mnw-etfline">
          {data.where.krEtf.length > 0 && (
            <span>
              🇰🇷 ETF{" "}
              {data.where.krEtf.map((e) => (
                <button key={e.code} type="button" className="mfp-chip" onClick={() => onSelectStock?.(e.code, e.name)} title={e.name}>
                  {e.label} <em className={`num ${cls(e.d1)}`}>{pct(e.d1)}</em>
                  {e.volRatio !== null && e.volRatio >= 1.5 && <em className="hot"> ×{e.volRatio.toFixed(1)}</em>}
                </button>
              ))}
            </span>
          )}
          {data.where.usEtf.length > 0 && (
            <span>
              🇺🇸 어젯밤{" "}
              {data.where.usEtf.map((e) => (
                <span key={e.symbol} className="mfp-chip" title={e.symbol}>
                  {e.name} <em className={`num ${cls(e.d1)}`}>{pct(e.d1)}</em>
                </span>
              ))}
            </span>
          )}
        </div>
      </section>

      {/* ③ 지금 사는 손 — 세 갈래 (2026-09-17 저녁: 이미 튄 종목이 1위면 매수 목록이 아니라 추격 금지 목록이다) */}
      <section className="card mnw-card">
        <h3>
          지금 사는 손 <span className="usm-sub">30분 거래대금 배수 × 체결강도 — 실시간 175 + 거래대금 상위 100</span>
        </h3>
        {data.buckets.quiet.length + data.buckets.breakout.length + data.buckets.hot.length === 0 && <div className="pt-n">배수 1.2 를 넘는 종목이 없습니다 — 장 밖이거나 조용한 장</div>}
        {(
          [
            { key: "quiet", icon: "🧲", title: "조용히 담는 중", hint: "등락 −1~+3% 인데 돈이 붙는다 — 단타·스윙이 볼 자리", rows: data.buckets.quiet },
            { key: "breakout", icon: "🚪", title: "돌파 임박", hint: "60일 고가 −3% 안, 아직 +5% 전", rows: data.buckets.breakout },
            { key: "hot", icon: "🔥", title: "이미 튐 — 추격 금지", hint: "+5% 이상이거나 VI", rows: data.buckets.hot },
          ] as const
        ).map((b) =>
          b.rows.length === 0 ? null : (
            <div key={b.key} className={`mnw-bucket ${b.key}`}>
              <div className="mnw-h">
                {b.icon} {b.title} <i>{b.hint}</i>
              </div>
              <div className="mnw-list">
                {b.rows.map((r, i) => (
                  <BuyerLine key={r.code} b={r} i={i} onSelectStock={onSelectStock} />
                ))}
              </div>
            </div>
          ),
        )}
        <div className="table-note">배수 = 최근 30분 거래대금 ÷ 오늘 평균 30분 거래대금(실시간 종목) 또는 오늘 거래대금 ÷ (20일 평균 × 시각별 진행률)(순위판 종목). 체결강도 120↑ 는 사는 쪽이 세다. 오늘 30억 미만은 뺀다. 신호등 점수엔 안 들어갑니다.</div>
      </section>

      {/* ④ 내 계좌 렌즈 */}
      <section className="card mnw-card">
        <h3>
          내 계좌 렌즈{" "}
          <span className="usm-sub">
            {data.account.rows.length}종목 · 들어옴 {inRows.length} · 빠짐 {outRows.length}
          </span>
        </h3>
        {data.account.rows.length === 0 && <div className="pt-n">{data.account.note}</div>}
        {/* 계좌별 묶음 (2026-09-17 저녁 — 벤티지: "수동 계좌에 여러 종목이 같이 들어 있으면 같이 보이네"). 키움이 먼저, 묶음마다 요약 줄 */}
        {groups.map((g) => (
          <div className="mnw-acc-group" key={g.name}>
            <div className="mnw-acc-h">
              <b>{g.name}</b>
              <span>
                {g.rows.length}종목
                {g.valueMan > 0 ? ` · 평가 ${g.valueMan >= 10000 ? `${(g.valueMan / 10000).toFixed(1)}억` : `${g.valueMan.toLocaleString("ko-KR")}만`}` : ""}
                {g.rate !== null ? ` · 오늘 ` : ""}
                {g.rate !== null && <em className={cls(g.rate)}>{pct(g.rate, 2)}</em>}
              </span>
              <span className="mnw-acc-cnt">
                {g.in > 0 && <i className="in">들어옴 {g.in}</i>}
                {g.out > 0 && <i className="out">빠짐 {g.out}</i>}
                {g.in === 0 && g.out === 0 && <i>조용</i>}
              </span>
            </div>
            <div className="mnw-list">
              {g.rows.map((r) => (
                <AccountLine key={`${r.account}:${r.code}`} r={r} onSelectStock={onSelectStock} />
              ))}
            </div>
          </div>
        ))}
        {data.account.rows.length > 0 && <div className="table-note">{data.account.note}. 「들어옴」 = 잠정 순매수이거나 30분 배수 1.3↑에 오르는 중 · 「빠짐」 = 잠정 순매도에 내리는 중. 보는 자리이지 매매 지시가 아닙니다.</div>}
      </section>

      {/* ⑤ 시간대 플랜 */}
      <section className="card mnw-card mnw-plan">
        <h3>
          {data.plan.title} <span className="usm-sub">지금 할 일만</span>
        </h3>
        {data.plan.cross && (
          <div className="mnw-cross">
            <div className="mnw-h">
              ⚡ 교차 <i>종배 후보 ∩ 사는 손 ∩ 마크(슈퍼·쌍끌이·외인3칸) — 세 눈이 겹치는 것만</i>
            </div>
            {data.plan.cross.length === 0 && <div className="pt-n">지금은 겹치는 종목이 없습니다</div>}
            <ol className="mnw-plan-list">
              {data.plan.cross.map((it) => (
                <li key={`x-${it.code ?? it.name}`}>
                  <button type="button" className="link-btn" onClick={() => it.code && onSelectStock?.(it.code, it.name)}>
                    {it.name}
                  </button>{" "}
                  <span className="pt-n">{it.text}</span>
                </li>
              ))}
            </ol>
          </div>
        )}
        {data.plan.items.length === 0 && <div className="pt-n">지금 시각엔 볼 것이 없습니다</div>}
        <ol className="mnw-plan-list">
          {data.plan.items.map((it, i) => (
            <li key={`${it.code ?? it.name}-${i}`}>
              {it.code ? (
                <button type="button" className="link-btn" onClick={() => onSelectStock?.(it.code!, it.name)}>
                  {it.name}
                </button>
              ) : (
                <b>{it.name}</b>
              )}{" "}
              <span className="pt-n">{it.text}</span>
            </li>
          ))}
        </ol>
        {data.plan.note && <div className="table-note">{data.plan.note}</div>}
      </section>
      {data.errors.length > 0 && <div className="pt-n">못 받은 재료: {data.errors.join(" · ")}</div>}
    </div>
  );
}
