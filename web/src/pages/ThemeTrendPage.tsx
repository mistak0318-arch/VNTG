import { useEffect, useState } from "react";
import { api, type TrendResult, type TrendTheme } from "../api";

/**
 * **대세 테마 분석** — 지금 시장을 끌고 있는 묶음은 무엇인가 (2026-10-08).
 *
 * 벤티지: "대세 테마 분석이라는 메뉴를 하나 만들자 … 그 테마가 며칠간, 5일간, 10일간,
 * 20일간 어땠는지 알 수가 있고 … 각 테마들 중에서도 대표주 이런 거 좀 뽑아가지고
 * 한눈에 볼 수 있게"
 *
 * ## 테마 MAP 과 왜 따로인가
 *
 * MAP 은 **오늘의 지도**다. 이 화면은 **흐름**이다 — 5일·20일·60일을 같은 자로 재서
 * 「뜨는 중인가, 이미 갔는가」를 가른다. 물음이 다르면 화면도 달라야 한다
 * (벤티지: "이건 별도 메뉴로 가야 돼. 왜냐면 흐름을 보는 거기 때문에").
 *
 * ## 왜 두 줄로 나란히 세우나
 *
 * 벤티지: "잡주도 많이 오른 잡주를 그래도 보여주는 게 맞는 것 같아 … 단순히 많이 오르네,
 * 그리고 네가 말한 추천, 그렇게 두 개를"
 *
 *  · **많이 오른 순** — 잡주 몇이 끌어올린 테마도 그대로 올라온다. 그래도 봐야 한다.
 *    **관심이 쏠렸다는 사실 자체가 정보**다.
 *  · **종합 점수 순** — 수익률·상승비율·거래대금을 순위로 바꿔 묶은 점수. 「찐」 쪽이다.
 *
 * 두 줄에 **같이 오른 테마**가 진짜다. 그래서 한쪽에만 있는 테마에 표를 달아 둔다 —
 * 두 목록을 눈으로 대조하게 만들면 아무도 안 한다.
 */

const DAYS = [1, 5, 10, 20, 60] as const;
const MARKETS = [
  { key: "kr", label: "국내 테마", hint: "네이버 테마 — 분류는 네이버, 숫자는 우리가 일봉으로" },
  { key: "etf", label: "ETF", hint: "ETF 도 하나의 테마다 — 묶음이 곧 분류" },
  { key: "us", label: "해외 테마", hint: "미국 산업분류 — 국내 일봉 원장에 없어 기간이 제한된다" },
] as const;

const pct = (v: number | null, digits = 2) =>
  v === null || !Number.isFinite(v) ? "—" : `${v > 0 ? "+" : ""}${v.toFixed(digits)}%`;
const cls = (v: number | null) => (v === null ? "" : v > 0 ? "positive" : v < 0 ? "negative" : "");
const eok = (v: number) => (v >= 10000 ? `${(v / 10000).toFixed(1)}조` : `${Math.round(v).toLocaleString("ko-KR")}억`);

function ThemeRow({
  t,
  rank,
  both,
  onSelectStock,
}: {
  t: TrendTheme;
  rank: number;
  /** 두 줄 모두에 있나 — 있으면 그게 진짜다 */
  both: boolean;
  onSelectStock: (code: string, name: string) => void;
}) {
  const [open, setOpen] = useState(false);
  /* 잰 종목이 너무 적으면 평균이 평균이 아니다 — 흐리게 그리고 까닭을 적는다 */
  const thin = t.measured > 0 && t.measured < Math.min(5, Math.ceil(t.members * 0.5));
  return (
    <div className={`tt-row${thin ? " tt-thin" : ""}`}>
      <button type="button" className="tt-head" onClick={() => setOpen((v) => !v)}>
        <span className="tt-rank">{rank}</span>
        <b className="tt-name">
          {t.name}
          {both && <em className="tt-both" title="많이 오른 순·종합 점수 순 둘 다에 있습니다 — 고르게 오르면서 돈도 돌았다는 뜻">둘 다</em>}
          {t.group && <i className="tt-group">{t.group}</i>}
        </b>
        <span className={`tt-ret ${cls(t.ret)}`}>{pct(t.ret)}</span>
        <span className="tt-br" title="그 기간에 오른 종목 비율 — 평균만 보면 하나가 끌어올린 것과 고르게 오른 것이 같아 보인다">
          {t.breadth === null ? "—" : `${t.breadth}%`}
        </span>
        <span className="tt-money" title="테마 거래대금 합(어림)">{eok(t.tradeValue)}</span>
        <span className="tt-score" title={`수익률 ${t.parts.ret} · 상승비율 ${t.parts.breadth} · 거래대금 ${t.parts.money} (각 0~100 순위)`}>
          {t.score}
        </span>
        <span className="tt-caret">{open ? "▾" : "▸"}</span>
      </button>
      {open && (
        <div className="tt-body">
          <div className="pt-n tt-meta">
            구성 {t.members}종목 · 잰 것 {t.measured}
            {thin && <b className="negative"> — 잰 것이 적어 평균이 얇습니다</b>} · 시총 {eok(t.marketCap)}
            <span className="tt-parts">
              점수 속: 수익률 {t.parts.ret} · 상승비율 {t.parts.breadth} · 거래대금 {t.parts.money}
            </span>
          </div>
          {t.leaders.length === 0 ? (
            <div className="empty">대표주를 못 뽑았습니다 — 오른 종목이 없거나 거래대금을 모릅니다</div>
          ) : (
            <ul className="tt-leaders">
              {t.leaders.map((s) => (
                <li key={s.code}>
                  <button type="button" className="tt-stock" onClick={() => onSelectStock(s.code, s.name)}>
                    {s.name}
                  </button>
                  <span className={cls(s.ret)}>{pct(s.ret)}</span>
                  {s.share !== null && (
                    <i className="pt-n" title="이 테마 거래대금에서 차지하는 비중 — 테마를 실제로 끌고 있는지">
                      돈 비중 {s.share.toFixed(0)}%
                    </i>
                  )}
                  {s.desc && <em className="tt-desc">{s.desc}</em>}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}

function List({
  title,
  why,
  rows,
  otherKeys,
  onSelectStock,
}: {
  title: string;
  why: string;
  rows: TrendTheme[];
  otherKeys: Set<string>;
  onSelectStock: (code: string, name: string) => void;
}) {
  return (
    <section className="card tt-list">
      <h3 className="section-heading">
        {title}
        <i className="pt-n">{why}</i>
      </h3>
      <div className="tt-cols pt-n">
        <span />
        <span>테마</span>
        <span>기간 등락</span>
        <span>상승비율</span>
        <span>거래대금</span>
        <span>점수</span>
        <span />
      </div>
      {rows.map((t, i) => (
        <ThemeRow key={t.key} t={t} rank={i + 1} both={otherKeys.has(t.key)} onSelectStock={onSelectStock} />
      ))}
    </section>
  );
}

export function ThemeTrendPage({ onSelectStock }: { onSelectStock: (code: string, name: string) => void }) {
  const [market, setMarket] = useState<"kr" | "etf" | "us">("kr");
  const [days, setDays] = useState<number>(5);
  const [data, setData] = useState<TrendResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    setBusy(true);
    setErr(null);
    api
      .themeTrend(market, days)
      .then((r) => alive && setData(r))
      .catch((e: Error) => alive && setErr(e.message))
      .finally(() => alive && setBusy(false));
    return () => {
      alive = false;
    };
  }, [market, days]);

  /* 몇 개까지 보여줄까 — 266개를 다 그리면 아무것도 안 보인다 */
  const TOP = 15;
  const byReturn = (data?.byReturn ?? []).slice(0, TOP);
  const byScore = (data?.byScore ?? []).slice(0, TOP);
  const scoreKeys = new Set(byScore.map((t) => t.key));
  const returnKeys = new Set(byReturn.map((t) => t.key));

  return (
    <div>
      <div className="filter-row">
        {MARKETS.map((m) => (
          <button
            key={m.key}
            type="button"
            className={`filter-btn ${market === m.key ? "active" : ""}`}
            title={m.hint}
            onClick={() => setMarket(m.key)}
          >
            {m.label}
          </button>
        ))}
        <span className="period-sep" />
        {DAYS.map((d) => (
          <button
            key={d}
            type="button"
            className={`filter-btn ${days === d ? "active" : ""}`}
            onClick={() => setDays(d)}
            title={`최근 ${d}거래일`}
          >
            {d === 1 ? "오늘" : `${d}일`}
          </button>
        ))}
      </div>

      <p className="page-note">
        테마 MAP 이 <b>오늘의 지도</b>라면 이 화면은 <b>흐름</b>입니다 — 같은 자로 기간을 바꿔
        재서 「뜨는 중인가, 이미 갔는가」를 가립니다. 분류는 네이버 것이고{" "}
        <b>숫자는 우리가 일봉으로 직접</b> 냅니다(조회 0회).
      </p>
      <p className="page-note">
        ⚠️ <b>오늘의 테마 구성으로 과거를 잽니다.</b> 네이버가 오른 뒤에 넣은 종목이 그 테마의
        과거에 섞이므로, <b>「이 테마를 샀으면 벌었다」로 읽으면 안 됩니다</b> — 지금 무엇이
        대세인지를 보는 화면입니다. 구성은 2026-10-08부터 날마다 쌓고 있어서, 쌓이면 그때의
        구성으로 다시 잴 수 있습니다.
      </p>

      {err && <div className="error-banner">{err}</div>}
      {data?.note && <div className="alert-note">{data.note}</div>}
      {busy && !data && <div className="page-note">세는 중…</div>}

      {data && (
        <>
          <div className="pt-n tt-count">
            테마 {data.total}개 중 위 {TOP}개 · 기준 {data.at?.slice(0, 16).replace("T", " ")}
          </div>
          <div className="tt-two">
            <List
              title="많이 오른 순"
              why="단순 평균 등락률 — 잡주가 끌어올린 것도 그대로 옵니다. 관심이 쏠렸다는 것도 정보입니다"
              rows={byReturn}
              otherKeys={scoreKeys}
              onSelectStock={onSelectStock}
            />
            <List
              title="종합 점수 순"
              why="수익률 50 · 상승비율 30 · 거래대금 20 을 각각 순위로 바꿔 묶었습니다 — 고르게 오르면서 돈이 돈 쪽"
              rows={byScore}
              otherKeys={returnKeys}
              onSelectStock={onSelectStock}
            />
          </div>
        </>
      )}
    </div>
  );
}
