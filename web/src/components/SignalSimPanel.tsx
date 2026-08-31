import { useCallback, useEffect, useState } from "react";
import {
  api,
  type SignalConfig,
  type SignalSimResult,
  type SignalSweepResult,
  type BacktestSummary,
} from "../api";

/**
 * 신호등 시뮬레이터 (2026-08-31 — "신호등이 적절한지는 어떻게 봐야해.
 * 시뮬레이션 돌릴 수 있는 툴을 설정에 만들어주던가").
 *
 * ## 왜 백테스트와 따로 있나
 *
 * 백테스트는 설정 하나를 채점하는 데 **500 종목의 일봉을 새로 받아 7분**이 걸린다.
 * 그래서 조합을 볼 수가 없었다 — 문턱 하나 옮겨 보려고 7분을 기다리면 두 번은 안 한다.
 *
 * 비싼 것은 일봉이지 채점이 아니다. 그래서 백테스트가 **원시값을 파일로 남기고**,
 * 여기서는 그 파일만 다시 채점한다. API 를 한 번도 안 부르므로 즉답이다.
 *
 * ## 무엇을 보라고 만든 화면인가
 *
 * 「초록이 좋다」가 아니라 **「무엇이 초록을 좋게 만드나」**다. 전체 평균 하나로는
 * 고칠 데를 알 수 없다. 그래서 셋으로 나눠 낸다:
 *
 *   ① 점수 구간별 성적 — 점수가 높을수록 좋아야 한다. 안 그러면 점수가 고장 난 것이다
 *   ② 기준별 「가르는 힘」 — 이 기준 하나만으로 갈리나. 0 이면 켜 둘 이유가 없다
 *   ③ 초록선 훑기 — 커트라인을 옮겨 보며 어디서 잘라야 하는지 본다
 *
 * ⚠️ **표본에 없는 기준은 채점에서 통째로 빠진다.** 수급·재무·ETF 뒷배는 그때의
 * 값을 우리가 안 갖고 있다. 그 기준들의 문턱은 여기서 정할 수 없고, 화면이 그렇게 적는다.
 */

const N = (v: number | null | undefined, suffix = "%"): string =>
  v === null || v === undefined || !Number.isFinite(v) ? "-" : `${v > 0 ? "+" : ""}${v}${suffix}`;

const cls = (v: number | null | undefined): string =>
  v === null || v === undefined || !Number.isFinite(v) ? "" : v > 0 ? "positive" : v < 0 ? "negative" : "";

/** 표본이 적은 줄은 흐리게 — 세 건으로 낸 평균이 눈에 세게 박히면 안 된다 */
const thin = (n: number): string => (n < 200 ? " sim-thin" : "");

function StatCells({ s }: { s: BacktestSummary }) {
  return (
    <>
      <td className="num">{s.n.toLocaleString("ko-KR")}</td>
      <td className={`num ${cls(s.d5.avg)}`}>{N(s.d5.avg)}</td>
      <td className="num pt-n">{s.d5.win === null ? "-" : `${s.d5.win}%`}</td>
      <td className={`num ${cls(s.d20.avg)}`}>{N(s.d20.avg)}</td>
      <td className="num pt-n">{s.d20.win === null ? "-" : `${s.d20.win}%`}</td>
    </>
  );
}

export function SignalSimPanel({ config }: { config: SignalConfig | null }) {
  const [meta, setMeta] = useState<{ has: boolean; builtAt?: string; obs?: number; codeCount?: number; days?: number } | null>(null);
  const [res, setRes] = useState<SignalSimResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  /** 지금 화면의 설정(저장 전)으로 잴지, 저장된 설정으로 잴지 */
  const [useDraft, setUseDraft] = useState(true);

  useEffect(() => {
    api.signalSamples().then(setMeta).catch(() => setMeta({ has: false }));
  }, []);

  const run = useCallback(() => {
    setBusy(true);
    setErr(null);
    api
      .signalSimulate(useDraft && config ? config : undefined)
      .then((r) => setRes(r.result))
      .catch((e: unknown) => setErr(e instanceof Error ? e.message : String(e)))
      .finally(() => setBusy(false));
  }, [config, useDraft]);

  if (meta && !meta.has) {
    return (
      <section className="card sim-card">
        <h3>시뮬레이터</h3>
        <p className="sim-empty">
          아직 <b>표본이 없습니다.</b> 신호등 찾기 화면에서 <b>백테스트를 한 번</b> 돌리면
          그때 받은 일봉에서 원시값이 파일로 남고, 그 뒤로는 여기서 설정을 바꿔 가며{" "}
          <b>즉시</b> 성적을 볼 수 있습니다 — 일봉을 다시 받지 않습니다.
        </p>
        <p className="pt-n">
          백테스트는 백그라운드로 돕니다. 화면을 떠나도 계속 돌고, 표본은 파일이라 서버를
          다시 켜도 남습니다.
        </p>
      </section>
    );
  }

  return (
    <section className="card sim-card">
      <h3>시뮬레이터 — 이 설정이면 성적이 어떻게 되나</h3>
      {meta?.has && (
        <p className="pt-n sim-meta">
          표본 {meta.obs?.toLocaleString("ko-KR")}건 · 거래대금 상위 {meta.codeCount}종목 ×{" "}
          {meta.days}거래일 · {meta.builtAt?.slice(0, 16).replace("T", " ")} 수집
        </p>
      )}

      <SimHowTo />

      <div className="sim-actions">
        <label className="sim-toggle">
          <input type="checkbox" checked={useDraft} onChange={(e) => setUseDraft(e.target.checked)} />
          <span>지금 화면의 설정으로 (끄면 저장된 설정)</span>
        </label>
        <button className="primary-btn" onClick={run} disabled={busy}>
          {busy ? "채점 중…" : "돌려보기"}
        </button>
      </div>

      {err && <p className="sim-err">{err}</p>}

      {res && (
        <>
          {res.skipped.length > 0 && (
            <p className="sim-warn">
              ⚠️ <b>{res.skipped.length}개 기준이 채점에서 빠졌습니다</b> — {res.skipped.join(" · ")}.
              그때의 값을 우리가 안 갖고 있어 되짚을 수 없습니다.{" "}
              <b>이 기준들의 문턱은 여기서 정할 수 없습니다.</b>
            </p>
          )}

          <h4>① 점수 구간별 — 점수가 높을수록 좋아야 한다</h4>
          <div className="table-wrap">
            <table className="sim-table">
              <thead>
                <tr>
                  <th>구간</th>
                  <th className="num">표본</th>
                  <th className="num">5일</th>
                  <th className="num">승률</th>
                  <th className="num">20일</th>
                  <th className="num">승률</th>
                </tr>
              </thead>
              <tbody>
                <tr className="sim-row-base">
                  <td>전체</td>
                  <StatCells s={res.base} />
                </tr>
                <tr className="sim-row-green">
                  <td>초록</td>
                  <StatCells s={res.green} />
                </tr>
                {res.buckets.map((b) => (
                  <tr key={b.label} className={thin(b.s.n).trim()}>
                    <td>{b.label}</td>
                    <StatCells s={b.s} />
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <h4>② 기준별 「가르는 힘」 — 이 기준 하나만으로 갈리나</h4>
          <p className="pt-n">
            <b>가르는 힘</b>은 그 기준이 만점인 무리의 20일 성적에서 0점 무리를 뺀 값입니다.
            양수면 「높을수록 그 뒤가 좋았다」, <b>0 언저리면 아무것도 안 가르고</b> 있고,{" "}
            <b>음수면 거꾸로 걸려 있습니다.</b>
          </p>
          <div className="table-wrap">
            <table className="sim-table">
              <thead>
                <tr>
                  <th>기준</th>
                  <th className="num">가중치</th>
                  <th className="num">가르는 힘</th>
                  <th className="num">만점 표본</th>
                  <th className="num">만점 20일</th>
                  <th className="num">0점 20일</th>
                </tr>
              </thead>
              <tbody>
                {[...res.checks]
                  .sort((a, b) => (b.edge ?? -9999) - (a.edge ?? -9999))
                  .map((c) => (
                    <tr key={c.key} className={c.inSamples ? thin(c.hit.n).trim() : "sim-na"}>
                      <td>
                        {c.label}
                        <span className="pt-n"> · {c.axis}</span>
                      </td>
                      <td className="num">{c.weight}</td>
                      <td className={`num sim-edge ${cls(c.edge)}`}>
                        {c.inSamples ? N(c.edge, "%p") : "재현 불가"}
                      </td>
                      <td className="num">{c.inSamples ? c.hit.n.toLocaleString("ko-KR") : "-"}</td>
                      <td className={`num ${cls(c.hit.d20.avg)}`}>
                        {c.inSamples ? N(c.hit.d20.avg) : "-"}
                      </td>
                      <td className={`num ${cls(c.miss.d20.avg)}`}>
                        {c.inSamples ? N(c.miss.d20.avg) : "-"}
                      </td>
                    </tr>
                  ))}
              </tbody>
            </table>
          </div>

          <h4>③ 초록선 훑기 — 어디서 잘라야 하나</h4>
          <p className="pt-n">
            지금 초록은 <b>70점</b>부터입니다. 커트라인을 옮겨 가며 그 위쪽의 성적을 잰 것입니다
            — <b>초과분</b>이 전체 대비 얼마나 나은지(%p)를 봅니다. 표본이 급격히 줄어드는
            구간의 숫자는 흐리게 그립니다.
          </p>
          <div className="table-wrap">
            <table className="sim-table">
              <thead>
                <tr>
                  <th className="num">이상</th>
                  <th className="num">표본</th>
                  <th className="num">20일</th>
                  <th className="num">승률</th>
                  <th className="num">초과분</th>
                </tr>
              </thead>
              <tbody>
                {res.cuts.map((c) => (
                  <tr key={c.cut} className={`${c.cut === 70 ? "sim-row-green " : ""}${thin(c.s.n).trim()}`}>
                    <td className="num">{c.cut}점</td>
                    <td className="num">{c.s.n.toLocaleString("ko-KR")}</td>
                    <td className={`num ${cls(c.s.d20.avg)}`}>{N(c.s.d20.avg)}</td>
                    <td className="num pt-n">{c.s.d20.win === null ? "-" : `${c.s.d20.win}%`}</td>
                    <td className={`num sim-edge ${cls(c.lift)}`}>{N(c.lift, "%p")}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <SweepBlock config={useDraft ? config : null} days={res.days} />
        </>
      )}
    </section>
  );
}

/**
 * 읽는 법 — **숫자만 있으면 매번 처음부터 생각하게 된다.**
 *
 * 특히 「가르는 힘」과 「앞/뒤」는 뜻을 모르면 정반대로 읽기 쉽다. 접어 두되
 * 기본은 펴 둔다 — 처음 보는 사람이 접힌 설명을 펴 볼 확률은 낮다.
 */
function SimHowTo() {
  const [open, setOpen] = useState(true);
  return (
    <div className="sig-guide sim-howto">
      <button className="filter-btn" onClick={() => setOpen((v) => !v)}>
        {open ? "▴ 읽는 법 접기" : "▾ 이 표들을 어떻게 읽나"}
      </button>
      {!open ? null : (
        <div className="sig-guide-body">
          <h4>이 도구가 답하려는 물음</h4>
          <p>
            「초록이 좋은가」가 아니라 <b>「무엇이 초록을 좋게 만드나」</b>입니다. 전체
            평균 하나로는 고칠 데를 알 수 없습니다 — 어느 기준이 성적을 가르는지가
            보여야 그 기준만 손볼 수 있습니다.
          </p>

          <h4>어떻게 이렇게 빠른가</h4>
          <p>
            백테스트가 <b>일봉에서 뽑은 원시값을 파일로 남겨</b> 둡니다 — 신고가 대비 몇 %,
            20일선에서 몇 % 벌어졌나, 위쪽에 매물이 몇 % 쌓였나 같은 값들입니다.
            이 값들은 <b>설정과 무관</b>합니다. 설정이 정하는 건 그 값을 어디서 자르고
            얼마로 곱하느냐뿐이죠. 그래서 설정을 바꿔도 <b>일봉을 다시 받지 않고</b>{" "}
            그 파일만 다시 채점합니다. 6만~19만 관측에 수십 밀리초입니다.
          </p>

          <h4>나온 숫자를 어떻게 해석하나</h4>
          <ul>
            <li>
              <b>초과분은 벌 돈이 아닙니다.</b> 「+1.51%p」는 시장이 +4.19% 갈 때 초록이
              +5.70% 갔다는 뜻입니다. <b>시장이 빠지면 초록도 빠집니다</b> — 덜 빠질
              뿐입니다. 「살 때인가」가 아니라 <b>「사려면 무엇을 사나」</b>의 답입니다.
            </li>
            <li>
              <b>승률이 시장과 같은 게 정상입니다.</b> 초록의 우위는 더 자주 이겨서가
              아니라 <b>이길 때 더 크게 이겨서</b> 나옵니다. 그래서{" "}
              <b>손절을 짧게 자르면 이 우위가 사라집니다</b> — 큰 수익이 날 자리를 미리
              끊는 셈이라서요.
            </li>
            <li>
              <b>초록은 「사라」가 아니라 「후보」입니다.</b> 초록이 전체의 10~15%면
              500 종목 중 하루 50~70개입니다. 거기서 다시 골라야 합니다.
            </li>
            <li>
              <b>20일 기준입니다.</b> 한 달쯤 들고 있었을 때의 성적입니다. 단타에 쓰면
              다른 도구를 보고 있는 것입니다.
            </li>
          </ul>

          <h4>「가르는 힘」 — 이 기준이 일을 하고 있나</h4>
          <p>
            그 기준이 <b>만점인 종목-날</b>들의 20일 뒤 성적에서, <b>0점인 것</b>들의
            성적을 뺀 값입니다.
          </p>
          <ul>
            <li>
              <b>크게 양수</b> — 이 기준이 높을수록 그 뒤가 좋았습니다. 제 몫을 하는 기준입니다.
            </li>
            <li>
              <b>0 언저리</b> — 아무것도 안 가릅니다. 켜 두면 점수만 복잡해지고 다른
              기준을 <b>희석</b>시킵니다.
            </li>
            <li>
              <b>음수</b> — <b>거꾸로 걸려 있습니다.</b> 높을수록 나빴는데 점수는 올려
              주고 있었다는 뜻입니다.
            </li>
          </ul>
          <p className="sim-note">
            ⚠️ <b>위험 축은 부호를 뒤집어 읽습니다.</b> 위험 축(매물 부담·이격도)은
            「점수가 높으면 위험하니 초록을 막는다」는 전제입니다. 그러니 위험 축 기준의
            가르는 힘이 <b>양수</b>면 그게 거꾸로입니다 — 막지 말아야 할 것을 막고 있는
            것이니까요.
          </p>

          <h4>「앞 / 뒤」 — 왜 반으로 가르나</h4>
          <p>
            조합을 여러 개 돌려 <b>그중 제일 좋은 것을 고르면 거의 반드시 과최적화</b>됩니다.
            표본이 한 장세에 몰려 있고 같은 종목이 여러 날 겹쳐 들어가 있어서, 우연히
            이 기간에만 맞는 조합이 하나쯤은 반드시 나오기 때문입니다.
          </p>
          <p>
            그래서 표본을 날짜로 반 갈라 <b>앞쪽에서 고르고 뒤쪽에서 채점</b>합니다.
            앞에서만 좋고 뒤에서 무너지는 조합은 그 기간에 맞춘 것입니다.{" "}
            <b>양쪽에서 다 양수인 것만</b> 믿을 만합니다.
          </p>
          <p className="sim-note">
            실제로 이 분할이 사고를 막았습니다. 120거래일 표본에서 전 구간 평균으로는{" "}
            <b>「+7.95%, 압도적」</b>이던 조합이 <b>뒤쪽 절반에서 -19%p</b> 였습니다.
            앞쪽 상승장이 그 숫자를 전부 만들고 있었던 겁니다. 기간을 400일로 늘리니
            앞뒤 시장이 비슷해졌고(+4.34% / +4.02%) 그제야 읽을 수 있는 표가 됐습니다.
          </p>

          <h4>기간이 짧으면 안 되는 이유</h4>
          <p>
            120일이면 <b>장세 하나</b>밖에 안 들어갑니다. 그 안에서 앞뒤를 갈라 봐야
            「상승장에서 고르고 하락장에서 채점」하는 꼴이라, 추세추종 기준이면 무조건
            집니다. <b>400거래일</b>이면 오르내림이 몇 번 들어가서 앞뒤가 비슷한 시장이
            됩니다. 일봉은 한 번 부르면 넉넉히 오므로 <b>기간을 늘려도 조회 수는 같습니다.</b>
          </p>

          <h4>못 재는 것 — 정직하게</h4>
          <p>
            <b>ETF 뒷배 · 영업이익 증가 · 시가총액</b>은 그때의 편입 비중·공시·상장주식수를
            우리가 갖고 있지 않아 되짚을 수 없습니다. 그래서 채점에서 통째로 빠집니다.{" "}
            <b>「틀렸다」가 아니라 「잴 수 없다」</b>입니다 — 여기서 안 보인다고 끄면
            되짚을 수 있는 것만 남은 신호등이 됩니다.
          </p>
          <p>
            <b>수급 3종</b>(외국인·기관·외인 연속)은 2026-08-31 부터 <b>채점 안으로
            들어왔습니다</b> — 일별 투자자 조회가 하루하루를 주기 때문입니다. 대신 표본을
            모을 때 종목당 조회가 세 배로 늘어 <b>시간이 몇 배</b> 걸립니다. 표본이 그
            이전 것이면 여기서도 여전히 빠진 것으로 나옵니다.
          </p>
          <p>
            <b>테마 강세</b>는 최근 60여 일만 되짚히고, 그마저 <b>구성은 오늘 것</b>을
            씁니다(석 달 전에 어느 종목이 어느 테마였는지 기록이 없습니다). 기간을 늘려도
            이 기준의 표본만 안 늘어납니다.
          </p>
        </div>
      )}
    </div>
  );
}

/**
 * ④ 전수 훑기 — **모든 조합**을 돌리되, 뒤쪽 절반으로 채점한다.
 *
 * ## 왜 「앞/뒤」로 나누나
 *
 * 248개를 돌려 그중 1등을 고르면 거의 반드시 과최적화된다. 우연히 이 기간에만
 * 맞는 조합이 하나쯤은 반드시 나오기 때문이다. 그래서 표본을 **날짜로 반 갈라**
 * 앞쪽에서 고르고 뒤쪽에서 채점한다.
 *
 * 실제로 2026-08-31 첫 실행에서 이것이 사고를 막았다 — 전 구간 평균으로는
 * 「+7.95%, 압도적」이던 조합이 **뒤쪽에서 -19%p** 였다. 앞쪽 상승장이 그 숫자를
 * 전부 만들고 있었다. 분할이 없었으면 그 값을 기본값에 넣었을 것이다.
 */
function SweepBlock({ config, days }: { config: SignalConfig | null; days: number }) {
  const [res, setRes] = useState<SignalSweepResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const run = useCallback(() => {
    setBusy(true);
    setErr(null);
    api
      .signalSweep(config ?? undefined, 20)
      .then((r) => setRes(r.result))
      .catch((e: unknown) => setErr(e instanceof Error ? e.message : String(e)))
      .finally(() => setBusy(false));
  }, [config]);

  const pp = (v: number | null): string =>
    v === null || !Number.isFinite(v) ? "-" : `${v > 0 ? "+" : ""}${v.toFixed(2)}%p`;

  return (
    <>
      <h4>④ 전수 훑기 — 모든 조합을 돌리고, 뒤쪽 절반으로 채점한다</h4>
      <p className="pt-n">
        기준을 켜고 끄는 <b>모든 조합</b>을 돌립니다. 다만 <b>순위는 전체 성적이 아니라
        「뒤쪽 절반」 성적</b>으로 매깁니다 — 표본을 날짜로 반 갈라 앞에서 고르고 뒤에서
        채점하는 것입니다. 앞에서만 좋고 뒤에서 무너지는 조합은 그 기간에 맞춘 것이지
        기준이 좋은 게 아닙니다.
      </p>
      <div className="sim-actions">
        <button className="filter-btn" onClick={run} disabled={busy}>
          {busy ? "훑는 중…" : "모든 조합 훑기"}
        </button>
      </div>
      {err && <p className="sim-err">{err}</p>}
      {res && (
        <>
          <p className="pt-n sim-meta">
            {res.splitDate.slice(0, 4)}-{res.splitDate.slice(4, 6)}-{res.splitDate.slice(6)} 에서
            갈랐습니다 · 앞쪽 시장 평균 {res.trainBase}% · 뒤쪽 {res.testBase}% ·{" "}
            읽을 만한 조합 {res.combos}개
          </p>
          {res.current && (
            <p className={`sim-warn${(res.current.testLift ?? 0) < 0 ? "" : ""}`}>
              <b>지금 설정</b>은 전체 {pp(res.current.lift)} · 앞 {pp(res.current.trainLift)} · 뒤{" "}
              <b>{pp(res.current.testLift)}</b> 입니다.
            </p>
          )}
          {res.rows.length > 0 && (res.rows[0].testLift ?? -1) <= 0 && (
            <p className="sim-warn">
              ⚠️ <b>뒤쪽 절반에서 시장을 이긴 조합이 하나도 없습니다.</b> 지금 표본으로는
              「이 조합이 낫다」고 말할 근거가 없습니다 — 기본값을 바꾸지 마세요.
              표본이 한 장세에만 걸쳐 있을 때 흔히 이렇게 나옵니다. 기간을 늘려
              다시 모아 보는 편이 낫습니다.
            </p>
          )}
          <div className="table-wrap">
            <table className="sim-table">
              <thead>
                <tr>
                  <th className="num">#</th>
                  <th className="num">뒤(검증)</th>
                  <th className="num">앞</th>
                  <th className="num">전체</th>
                  <th className="num">초록</th>
                  <th>켠 기준</th>
                </tr>
              </thead>
              <tbody>
                {res.rows.map((r, i) => (
                  <tr key={r.keys.join(",")} className={thin(r.testN).trim()}>
                    <td className="num pt-n">{i + 1}</td>
                    <td className={`num sim-edge ${cls(r.testLift)}`}>{pp(r.testLift)}</td>
                    <td className={`num ${cls(r.trainLift)}`}>{pp(r.trainLift)}</td>
                    <td className={`num ${cls(r.lift)}`}>{pp(r.lift)}</td>
                    <td className="num">{r.n.toLocaleString("ko-KR")}</td>
                    <td className="sim-combo">{r.labels.join(" · ")}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}

      <p className="sim-warn">
        ⚠️ <b>표에서 제일 위에 있다고 그대로 쓰면 안 됩니다.</b> 표본이 {days}거래일에
        몰려 있고 같은 종목이 여러 날 겹쳐 들어가 있어 관측이 서로 독립이 아닙니다.
        <b>뒤쪽에서도 뚜렷하게 이기는 것</b>만, 그것도 이유를 설명할 수 있을 때만 옮기세요.
      </p>
    </>
  );
}
