import { useEffect, useState } from "react";
import { api, fmtNum, normalizeStockCode, type SectorFlowResult } from "../api";

/**
 * 업종별 자금 흐름.
 *
 * 지금까지 화면에 있던 건 "오늘 외국인 +2.3조" 하나였다. 총액은 규모만 말해줄 뿐
 * **어디서 빼서 어디로 넣었는지**를 말해주지 않는다. 같은 +2.3조라도 반도체 한 곳에
 * 몰린 날과 전 업종에 고르게 퍼진 날은 완전히 다른 장이다.
 *
 * 업종 줄을 누르면 **그 자리에서** 구성종목이 펼쳐진다. "화학에 3,244억"을 보고 나면
 * 곧바로 "그래서 어느 종목이냐"가 궁금해지는데, 다른 화면으로 옮겨가게 하면 흐름이 끊긴다.
 */

const WINDOWS = [1, 5, 10, 20];

type Stock = { code: string; name: string; price: number; changeRate: number };

function pct(n: number): string {
  return `${n > 0 ? "+" : ""}${n.toFixed(2)}%`;
}

function cls(n: number): string {
  return n > 0 ? "positive" : n < 0 ? "negative" : "";
}

/**
 * 업종 구성종목 목록.
 *
 * 업종 줄이든 연속 줄이든 합의 줄이든, 누르면 같은 것을 보고 싶어한다.
 * 그래서 목록 자체를 떼어내 세 군데가 같이 쓴다. 펼칠 때만 조회한다.
 */
export function SectorStocks({
  market,
  code,
  onSelectStock,
}: {
  market: string;
  code: string;
  onSelectStock?: (code: string, name: string) => void;
}) {
  const [stocks, setStocks] = useState<Stock[] | null>(null);
  const [beforeTrading, setBeforeTrading] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    api
      .sectorFlowStocks(market, code)
      .then((r) => {
        if (cancelled) return;
        setStocks(r.stocks);
        setBeforeTrading(r.beforeTrading);
      })
      .catch((err: Error) => !cancelled && setError(err.message))
      .finally(() => !cancelled && setLoading(false));
    return () => {
      cancelled = true;
    };
  }, [market, code]);

  return (
    <div className="sf-stocks">
      {loading && <div className="empty">구성종목 불러오는 중…</div>}
      {error && <div className="error-banner">{error}</div>}
      {stocks && stocks.length === 0 && <div className="empty">구성종목을 못 받았습니다.</div>}
      {stocks?.slice(0, 20).map((s) => (
        <button
          key={s.code}
          className="sf-stock"
          onClick={() => onSelectStock?.(normalizeStockCode(s.code), s.name)}
        >
          <span className="sf-stock-name">{s.name}</span>
          <span className="num">{fmtNum(s.price)}</span>
          <span className={`num ${cls(s.changeRate)}`}>{pct(s.changeRate)}</span>
        </button>
      ))}
      {stocks && stocks.length > 0 && (
        <div className="sf-stocks-note">
          시가총액 순 · 종목을 누르면 상세로 이동합니다
          {beforeTrading && " · 아직 장이 열리지 않아 등락률이 0입니다"}
        </div>
      )}
    </div>
  );
}

/** 연속 순매수·순매도 한 줄. 점 하나가 하루 */
function StreakRow({
  s,
  onSelectStock,
}: {
  s: SectorFlowResult["streaks"][number];
  onSelectStock?: (code: string, name: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const up = s.streak > 0;
  return (
    <div className={`sf-item${open ? " open" : ""}`}>
      <button className="sf-streak" onClick={() => setOpen((v) => !v)} title="누르면 구성종목이 펼쳐집니다">
        <span className="sf-caret">{open ? "▾" : "▸"}</span>
        <span className="sf-streak-name">{s.label}</span>
        <span className="sf-streak-dots">
          {Array.from({ length: Math.min(Math.abs(s.streak), 10) }).map((_, i) => (
            <i className={up ? "positive" : "negative"} key={i} />
          ))}
        </span>
        <b className={up ? "positive" : "negative"}>{Math.abs(s.streak)}일</b>
      </button>
      {open && <SectorStocks market={s.market} code={s.code} onSelectStock={onSelectStock} />}
    </div>
  );
}

/** 주체 합의 한 줄 */
function ConsensusRow({
  c,
  subjects,
  onSelectStock,
}: {
  c: SectorFlowResult["consensusBuy"][number];
  subjects: { key: string; label: string }[];
  onSelectStock?: (code: string, name: string) => void;
}) {
  const [open, setOpen] = useState(false);
  return (
    <div className={`sf-item${open ? " open" : ""}`}>
      <button className="sf-cons" onClick={() => setOpen((v) => !v)} title="누르면 구성종목이 펼쳐집니다">
        <span className="sf-caret">{open ? "▾" : "▸"}</span>
        <span className="sf-name">{c.label}</span>
        <span className={`sf-agree ${c.side > 0 ? "positive" : "negative"}`}>
          {c.agree}/{subjects.length} {c.side > 0 ? "매수" : "매도"}
        </span>
        {c.values.map((v, i) => (
          <span key={i} className={`sf-val ${cls(v)}`}>
            {fmtNum(Math.round(v))}
          </span>
        ))}
        <span className={`sf-val ${cls(c.total)}`}>
          <b>{fmtNum(Math.round(c.total))}</b>
        </span>
      </button>
      {open && <SectorStocks market={c.market} code={c.code} onSelectStock={onSelectStock} />}
    </div>
  );
}

/** 업종 한 줄 + 펼쳤을 때의 구성종목 */
function SectorRow({
  stat,
  max,
  onSelectStock,
}: {
  stat: SectorFlowResult["stats"][number];
  max: number;
  onSelectStock?: (code: string, name: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const width = max > 0 ? `${Math.min((Math.abs(stat.sum) / max) * 100, 100).toFixed(1)}%` : "0%";
  const up = stat.sum > 0;

  return (
    <div className={`sf-item${open ? " open" : ""}`}>
      <button className="sf-row" onClick={() => setOpen((v) => !v)} title="누르면 구성종목이 펼쳐집니다">
        <span className="sf-caret">{open ? "▾" : "▸"}</span>
        <span className="sf-name">{stat.name}</span>
        <span className={`sf-market ${stat.market}`}>{stat.market === "kospi" ? "코스피" : "코스닥"}</span>
        <span className="sf-bar">
          <span className={`sf-fill ${up ? "positive" : "negative"}`} style={{ width }} />
        </span>
        <span className={`sf-val ${up ? "positive" : "negative"}`}>{fmtNum(Math.round(stat.sum))}</span>
        <span className="sf-rank">
          {stat.rankChange !== null && stat.rankChange !== 0 ? (
            <b className={stat.rankChange > 0 ? "positive" : "negative"}>
              {stat.rankChange > 0 ? "▲" : "▼"}
              {Math.abs(stat.rankChange)}
            </b>
          ) : (
            ""
          )}
        </span>
      </button>
      {open && (
        <SectorStocks market={stat.market} code={stat.code} onSelectStock={onSelectStock} />
      )}
    </div>
  );
}

export function SectorFlowPanel({
  onSelectStock,
}: {
  onSelectStock?: (code: string, name: string) => void;
}) {
  const [data, setData] = useState<SectorFlowResult | null>(null);
  const [subject, setSubject] = useState("foreign");
  const [window, setWindow] = useState(5);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    api
      .sectorFlow(subject, window)
      .then((r) => {
        if (!cancelled) {
          setData(r);
          setError(null);
        }
      })
      .catch((err: Error) => !cancelled && setError(err.message))
      .finally(() => !cancelled && setLoading(false));
    return () => {
      cancelled = true;
    };
  }, [subject, window]);

  async function backfill() {
    setBusy(true);
    setNote(null);
    try {
      const r = await api.sectorFlowBackfill(120);
      setNote(`${r.added}일 채움 · 휴장일 ${r.skipped}일 제외 · 보유 ${r.total}일`);
      setData(await api.sectorFlow(subject, window));
    } catch (err) {
      setNote(err instanceof Error ? err.message : "실패");
    } finally {
      setBusy(false);
    }
  }

  if (loading && !data) return <div className="empty">자금 흐름 불러오는 중...</div>;
  if (error) return <div className="error-banner">{error}</div>;
  if (!data) return null;

  const enough = data.dates.length >= 2;
  const top = data.stats.slice(0, 10);
  const bottom = data.stats.slice(-10).reverse();
  const max = Math.max(...data.stats.map((s) => Math.abs(s.sum)), 1);
  const buys = data.streaks.filter((s) => s.streak > 0).slice(0, 6);
  const sells = data.streaks.filter((s) => s.streak < 0).slice(0, 6);

  return (
    <>
      <div className="filter-row">
        {data.subjects.map((s) => (
          <button
            key={s.key}
            className={`filter-btn ${subject === s.key ? "active" : ""}`}
            onClick={() => setSubject(s.key)}
          >
            {s.label}
          </button>
        ))}
        <span className="news-scope-sep" />
        {WINDOWS.map((w) => (
          <button
            key={w}
            className={`filter-btn ${window === w ? "active" : ""}`}
            onClick={() => setWindow(w)}
            title={w === 1 ? "하루치는 노이즈가 많습니다" : `${w}거래일 누적`}
          >
            {w}일
          </button>
        ))}
        <span className="breadth-count">
          {data.dates.length > 0 ? `${data.dates[0]} ~ ${data.dates[data.dates.length - 1]}` : ""}
        </span>
        <button className="filter-btn" onClick={() => void backfill()} disabled={busy}>
          {busy ? "채우는 중…" : "과거분 채우기"}
        </button>
      </div>
      {note && <div className="alert-note">{note}</div>}

      {!enough ? (
        <div className="page-note">
          아직 <b>{data.dates.length}일치</b>뿐입니다. 「과거분 채우기」를 누르면 최근 120거래일을
          한 번에 받아옵니다 — 이 데이터는 <b>과거 조회가 되므로</b> 시장 폭과 달리 기다릴 필요가
          없습니다 (2시장 × 120일이라 1분쯤 걸립니다).
        </div>
      ) : (
        <>
          <div className="flow-two-col">
            <section className="sf-block">
              <h4 className="sf-block-title buy">
                {data.subjectLabel}이 담은 업종<span>{data.window}일 누적 · 억원</span>
              </h4>
              {top.map((s) => (
                <SectorRow key={s.code} stat={s} max={max} onSelectStock={onSelectStock} />
              ))}
            </section>

            <section className="sf-block">
              <h4 className="sf-block-title sell">
                {data.subjectLabel}이 던진 업종<span>{data.window}일 누적 · 억원</span>
              </h4>
              {bottom.map((s) => (
                <SectorRow key={s.code} stat={s} max={max} onSelectStock={onSelectStock} />
              ))}
            </section>
          </div>

          <div className="table-note">
            업종을 누르면 <b>구성종목이 그 자리에서 펼쳐집니다.</b> ▲▼는 직전 같은 기간 대비{" "}
            <b>순위 변화</b>로, 금액보다 순위가 크게 움직인 업종이 자금이 새로 들어오거나 빠져나가는
            곳입니다.
          </div>

          {data.sizes.length > 0 && (
            <>
              <h4 className="section-heading">규모별 자금 배분 (코스피)</h4>
              <div className="data-table-wrap">
                <table className="data-table num">
                  <thead>
                    <tr>
                      <th className="sticky-col">구분</th>
                      <th>외국인</th>
                      <th>기관</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.sizes.map((s) => (
                      <tr key={s.label}>
                        <td className="sticky-col">{s.label}</td>
                        <td className={cls(s.foreign)}>{fmtNum(Math.round(s.foreign))}</td>
                        <td className={cls(s.institution)}>{fmtNum(Math.round(s.institution))}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <div className="table-note">
                {data.window}일 누적 · 억원. 자금이 <b>대형주에서 중소형으로 옮겨가는 구간</b>은 장의
                성격이 바뀌는 지점입니다 — 지수는 쉬는데 개별 종목이 움직이기 시작합니다.
              </div>
            </>
          )}

          {(buys.length > 0 || sells.length > 0) && (
            <>
              <h4 className="section-heading">연속 {data.subjectLabel} 순매수·순매도</h4>
              <div className="flow-two-col">
                <div className="sf-streak-col">
                  <div className="sf-streak-head buy">연속 순매수</div>
                  {buys.length === 0 && <div className="empty">없음</div>}
                  {buys.map((s) => (
                    <StreakRow key={s.code} s={s} onSelectStock={onSelectStock} />
                  ))}
                </div>
                <div className="sf-streak-col">
                  <div className="sf-streak-head sell">연속 순매도</div>
                  {sells.length === 0 && <div className="empty">없음</div>}
                  {sells.map((s) => (
                    <StreakRow key={s.code} s={s} onSelectStock={onSelectStock} />
                  ))}
                </div>
              </div>
              <div className="table-note">
                점 하나가 하루입니다. 하루치 순매수는 노이즈지만{" "}
                <b>며칠 연속인지는 신호</b>입니다 — 방향을 정해놓고 사는 주체가 있다는 뜻입니다.
                업종을 누르면 구성종목이 펼쳐집니다.
              </div>
            </>
          )}

          {(data.consensusBuy.length > 0 || data.consensusSell.length > 0) && (
            <>
              <h4 className="section-heading">주체 합의 — 여러 주체가 같은 방향</h4>
              <div className="sf-cons-head">
                <span />
                <span>업종</span>
                <span>합의</span>
                {data.consensusSubjects.map((x) => (
                  <span key={x.key}>{x.label}</span>
                ))}
                <span>합계</span>
              </div>
              {[...data.consensusBuy, ...data.consensusSell].map((c) => (
                <ConsensusRow
                  key={`${c.side}-${c.code}`}
                  c={c}
                  subjects={data.consensusSubjects}
                  onSelectStock={onSelectStock}
                />
              ))}
              <div className="table-note">
                {data.window}일 누적 · 억원. 한 주체만 사는 것과 <b>여러 주체가 같이 사는 것</b>은
                무게가 다릅니다 — 하나는 하루아침에 방향을 바꿀 수 있지만, 셋 이상이 같은 곳을
                보고 있다면 개별 판단이 아니라 흐름에 가깝습니다. <b>개인은 제외</b>했습니다
                (기관·외국인이 사면 개인은 자동으로 반대편이 되어 합의라는 말이 성립하지 않습니다).
                업종을 누르면 구성종목이 펼쳐집니다.
              </div>
            </>
          )}

          {data.splits.length > 0 && (
            <>
              <h4 className="section-heading">기관 내부 이견 — 연기금 vs 투신</h4>
              <div className="data-table-wrap">
                <table className="data-table num">
                  <thead>
                    <tr>
                      <th className="sticky-col">업종</th>
                      <th>연기금</th>
                      <th>투신</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.splits.map((s) => (
                      <tr key={s.code}>
                        <td className="sticky-col">{s.label}</td>
                        <td className={cls(s.pension)}>{fmtNum(Math.round(s.pension))}</td>
                        <td className={cls(s.trust)}>{fmtNum(Math.round(s.trust))}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <div className="table-note">
                둘 다 기관이지만 성격이 다릅니다 — 연기금은 길게 보고 담고, 투신은 성과에 쫓겨 짧게
                돕니다. 방향이 갈리는 업종은 <b>변곡 후보로만</b> 보고 단정하지 마세요.
              </div>
            </>
          )}
        </>
      )}
    </>
  );
}
