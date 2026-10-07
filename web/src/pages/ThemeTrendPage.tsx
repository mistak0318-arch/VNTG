import { useEffect, useState } from "react";
import { api, type OverviewResult, type TrendTheme } from "../api";

/**
 * **대세 테마 분석** — 시장과 기간을 **한 화면에 펼친다** (2026-10-08).
 *
 * 벤티지: "일일이 하나씩 클릭해서 봐야 돼. 나는 한눈에 보는 게 필요하다고. 5일 클릭하고
 * 10일 클릭하고 ETF 클릭했다 해외 클릭했다 그게 아니라 한눈에 … 상위 5개씩 모아가지고."
 *
 * ⚠️ 첫 판을 탭(국내/ETF/해외)과 기간 단추로 만들었다가 바로 물렀다. **클릭해서 비교하게
 * 만들면 사람은 비교를 안 한다.** 「국내 5일」과 「ETF 20일」을 머릿속에서 맞추는 일은
 * 화면이 할 일이지 보는 사람이 할 일이 아니다.
 *
 * ## 짜임
 *
 * 세로로 **시장 셋**(국내·ETF·해외), 가로로 **기간 넷**(오늘·5일·20일·60일).
 * 한 칸 안에 **두 줄 세우기**를 위아래로 둔다 —
 *
 *   · 위 **많이 오른 순** — 잡주가 끌어올린 것도 그대로. 관심이 쏠렸다는 것도 정보다.
 *   · 아래 **찐** — 수익률·상승비율·거래대금을 순위로 묶은 점수.
 *
 * 두 줄에 **같이 오른 테마**에 점을 찍는다. 그게 이 화면의 결론이라, 눈으로 대조하게
 * 만들면 안 된다.
 *
 * ## 테마 MAP 과 왜 따로인가
 *
 * MAP 은 오늘의 지도고 이 화면은 흐름이다. 같은 자로 기간만 바꿔 재야
 * 「뜨는 중인가, 이미 갔는가」가 갈린다.
 */

const pct = (v: number | null) =>
  v === null || !Number.isFinite(v) ? "—" : `${v > 0 ? "+" : ""}${v.toFixed(1)}%`;
const cls = (v: number | null) => (v === null ? "" : v > 0 ? "positive" : v < 0 ? "negative" : "");
const dayLabel = (d: number) => (d === 1 ? "오늘" : `${d}일`);

/** 다섯 줄 — 테마 이름·등락률, 그리고 대표주 하나 */
function Five({
  rows,
  both,
  onSelectStock,
}: {
  rows: TrendTheme[];
  both: Set<string>;
  onSelectStock: (code: string, name: string) => void;
}) {
  if (rows.length === 0) return <div className="tt-none">—</div>;
  return (
    <ol className="tt-five">
      {rows.map((t) => {
        const lead = t.leaders[0];
        return (
          <li key={t.key} className={both.has(t.key) ? "tt-hit" : undefined}>
            <span className="tt-nm" title={`${t.name} · 구성 ${t.members}종목 중 ${t.measured} 잼 · 상승비율 ${t.breadth ?? "—"}% · 점수 ${t.score}`}>
              {both.has(t.key) && <i className="tt-dot" title="많이 오른 순·찐 둘 다에 있습니다 — 고르게 오르면서 돈도 돌았다는 뜻">●</i>}
              {t.name}
            </span>
            <span className={`tt-rt ${cls(t.ret)}`}>{pct(t.ret)}</span>
            {/* 대표주 — 「많이 오른 것」이 아니라 「오르면서 돈이 몰린 것」 */}
            {lead && (
              <button
                type="button"
                className="tt-lead"
                onClick={() => onSelectStock(lead.code, lead.name)}
                title={`대표주 — ${lead.name}${lead.share !== null ? ` · 이 테마 거래대금의 ${lead.share.toFixed(0)}%` : ""}${lead.desc ? `\n${lead.desc}` : ""}`}
              >
                {lead.name}
              </button>
            )}
          </li>
        );
      })}
    </ol>
  );
}

export function ThemeTrendPage({ onSelectStock }: { onSelectStock: (code: string, name: string) => void }) {
  const [data, setData] = useState<OverviewResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    setBusy(true);
    setErr(null);
    api
      .themeTrendOverview(5)
      .then((r) => alive && setData(r))
      .catch((e: Error) => alive && setErr(e.message))
      .finally(() => alive && setBusy(false));
    return () => {
      alive = false;
    };
  }, []);

  return (
    <div>
      <p className="page-note">
        테마 MAP 이 <b>오늘의 지도</b>라면 이 화면은 <b>흐름</b>입니다 — 같은 자로 기간만 바꿔
        재서 「뜨는 중인가, 이미 갔는가」를 가립니다. 분류는 네이버 것이고{" "}
        <b>숫자는 우리가 일봉으로 직접</b> 냅니다(조회 0회).
      </p>
      <p className="page-note">
        각 칸은 위가 <b>많이 오른 순</b>(잡주가 끌어올린 것도 그대로 — 관심이 쏠렸다는 것도
        정보입니다), 아래가 <b>찐</b>(수익률 50·상승비율 30·거래대금 20 을 각각 순위로 바꿔
        묶은 점수)입니다. <b>●</b> 는 둘 다에 오른 테마 — 고르게 오르면서 돈도 돌았다는 뜻입니다.
      </p>
      <p className="page-note">
        ⚠️ <b>오늘의 테마 구성으로 과거를 잽니다.</b> 네이버가 오른 뒤에 넣은 종목이 그 테마의
        과거에 섞이므로 <b>「이 테마를 샀으면 벌었다」로 읽으면 안 됩니다</b> — 지금 무엇이
        대세인지를 보는 화면입니다. 구성은 2026-10-08부터 날마다 쌓는 중이라, 모이면 그때의
        구성으로 다시 잴 수 있습니다.
      </p>

      {err && <div className="error-banner">{err}</div>}
      {busy && !data && <div className="page-note">세는 중…</div>}

      {data?.markets.map((m) => (
        <section className="card tt-mk" key={m.market}>
          <h3 className="section-heading">
            {m.label}
            <i className="pt-n">테마 {m.total}개 · 각 칸 상위 {data.top}</i>
          </h3>
          {m.note && <div className="alert-note">{m.note}</div>}
          <div className="tt-cells">
            {m.cells.map((c) => {
              const rk = new Set(c.byReturn.map((t) => t.key));
              const sk = new Set(c.byScore.map((t) => t.key));
              const both = new Set([...rk].filter((k) => sk.has(k)));
              return (
                <div className="tt-cell" key={c.days}>
                  <div className="tt-cell-h">{dayLabel(c.days)}</div>
                  <div className="tt-sub">많이 오른</div>
                  <Five rows={c.byReturn} both={both} onSelectStock={onSelectStock} />
                  <div className="tt-sub tt-sub2">찐</div>
                  <Five rows={c.byScore} both={both} onSelectStock={onSelectStock} />
                </div>
              );
            })}
          </div>
        </section>
      ))}
    </div>
  );
}
