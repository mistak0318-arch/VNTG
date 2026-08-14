import { useEffect, useState } from "react";
import { api, type EvaluatedLink } from "../api";

/**
 * 미국 ↔ 국내 테마 연동.
 *
 * 국내 장은 밤사이 미국을 보고 출발한다. 그런데 지금까지 화면은 "나스닥 +0.8%"까지만
 * 말해주고 **그게 어느 국내 테마로 이어지는지**는 사람이 머릿속으로 잇고 있었다.
 *
 * 여기 있는 연결은 **사람이 적은 가설**이다. 상관계수 검증 전이므로 고정된 진리처럼
 * 보이지 않게 화면에서도 그렇게 말한다. 참고 지표이지 매매 신호가 아니다.
 */

function pct(n: number | null): string {
  if (n === null) return "-";
  return `${n > 0 ? "+" : ""}${n.toFixed(2)}%`;
}

function cls(n: number | null): string {
  if (n === null) return "";
  return n > 0 ? "positive" : n < 0 ? "negative" : "";
}

function LinkCard({ link }: { link: EvaluatedLink }) {
  const [open, setOpen] = useState(false);
  const gap = link.gap;

  return (
    <div className={`uk-card${open ? " open" : ""}`}>
      <button className="uk-head" onClick={() => setOpen((v) => !v)}>
        <span className="uk-caret">{open ? "▾" : "▸"}</span>
        <span className="uk-label">{link.label}</span>
        <span className="uk-side">
          <span className="uk-cap">미국</span>
          <b className={cls(link.usAvg)}>{pct(link.usAvg)}</b>
        </span>
        <span className="uk-arrow">→</span>
        <span className="uk-side">
          <span className="uk-cap">국내</span>
          <b className={cls(link.krAvg)}>{pct(link.krAvg)}</b>
        </span>
        {link.stat ? (
          <span className={`uk-gap ${(link.surprise ?? 0) >= 0 ? "positive" : "negative"}`}>
            기대 {pct(link.expected)} · {(link.surprise ?? 0) >= 0 ? "더" : "덜"} 반영{" "}
            {Math.abs(link.surprise ?? 0).toFixed(1)}%p
          </span>
        ) : (
          gap !== null && (
            <span className={`uk-gap ${gap >= 0 ? "positive" : "negative"}`}>
              {gap >= 0 ? "더" : "덜"} 반영 {Math.abs(gap).toFixed(1)}%p
            </span>
          )
        )}
      </button>

      {open && (
        <div className="uk-body">
          <div className="uk-col">
            <div className="uk-col-name">미국</div>
            {link.usQuotes.map((q) => (
              <div className="uk-row" key={q.symbol}>
                <span className="uk-sym">{q.symbol}</span>
                <span className="uk-nm">{q.name}</span>
                <span className={`num ${cls(q.changeRate)}`}>
                  {q.error ? "조회 실패" : pct(q.changeRate)}
                </span>
              </div>
            ))}
          </div>
          <div className="uk-col">
            <div className="uk-col-name">국내 테마</div>
            {link.krThemes.length === 0 && <div className="empty">연결된 테마 없음</div>}
            {link.krThemes.map((t) => (
              <div className={`uk-row${t.found ? "" : " missing"}`} key={t.name}>
                <span className="uk-nm wide">{t.name}</span>
                <span className={`num ${cls(t.changeRate)}`}>
                  {t.found ? pct(t.changeRate) : "테마 없음"}
                </span>
              </div>
            ))}
          </div>
          {link.stat && (
            <div className="uk-memo">
              <b>연동 {link.stat.corr.toFixed(2)}</b> ({link.stat.us} → {link.stat.kr}, 최근{" "}
              {link.stat.samples}거래일). 미국이 1% 움직이면 국내는 평균{" "}
              <b>{link.stat.beta.toFixed(2)}%</b> 따라갔습니다.
              {Math.abs(link.stat.corr) < 0.3 && " 연동이 약하니 이 연결은 의심해 보세요."}
            </div>
          )}
          {link.memo && <div className="uk-memo">{link.memo}</div>}
        </div>
      )}
    </div>
  );
}

export function UsKrPanel() {
  const [links, setLinks] = useState<EvaluatedLink[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [at, setAt] = useState("");
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);

  /** 무거운 계산(구성종목 일봉 136회)이라 사용자가 누를 때만 돈다 */
  async function correlate() {
    setBusy(true);
    setNote(null);
    try {
      const r = await api.usKrCorrelate(60);
      setNote(`${r.result.days}일 기준 재계산 · 국내 ${r.result.krFetched}종목 · 쌍 ${r.result.pairs.length}개`);
      load();
    } catch (e) {
      setNote(e instanceof Error ? e.message : "계산 실패");
    } finally {
      setBusy(false);
    }
  }

  function load() {
    setLoading(true);
    api
      .usKr()
      .then((r) => {
        setLinks(r.links);
        setAt(r.at);
        setError(null);
      })
      .catch((e: Error) => setError(e.message))
      .finally(() => setLoading(false));
  }

  useEffect(load, []);

  if (loading && links.length === 0) return <div className="empty">불러오는 중…</div>;
  if (error) return <div className="error-banner">{error}</div>;

  // 미국 쪽이 크게 움직인 것부터 — 오늘 국내에 영향이 클 후보다
  const sorted = [...links].sort((a, b) => Math.abs(b.usAvg ?? 0) - Math.abs(a.usAvg ?? 0));
  const missing = links.flatMap((l) => l.krThemes.filter((t) => !t.found).map((t) => t.name));

  return (
    <>
      <div className="filter-row">
        <button className="filter-btn" onClick={load} disabled={loading || busy}>
          {loading ? "…" : "↻ 새로고침"}
        </button>
        <button
          className="filter-btn"
          onClick={() => void correlate()}
          disabled={busy}
          title="테마 구성종목 일봉을 받아 최근 60일 상관계수를 다시 계산합니다 (30초쯤)"
        >
          {busy ? "계산 중… (30초)" : "연동 다시 계산"}
        </button>
        {at && (
          <span className="breadth-count">
            {new Date(at).toLocaleTimeString("ko-KR", { hour12: false })} 기준
          </span>
        )}
      </div>

      <p className="page-note">
        밤사이 미국이 어느 국내 테마로 이어지는지 나란히 봅니다. <b>「기대」</b>는 최근 60일
        실측 연동(미국 D일 → 국내 D+1일)으로 계산한 값으로, 평소대로면 오늘 국내가 이만큼
        갔어야 한다는 뜻입니다. 실제와의 차이가 <b>덜/더 반영</b>입니다.{" "}
        <b>상관관계는 변합니다</b> — 참고 지표이지 매매 신호가 아닙니다.
      </p>

      {note && <div className="alert-note">{note}</div>}

      {sorted.map((l) => (
        <LinkCard key={l.label} link={l} />
      ))}

      {missing.length > 0 && (
        <div className="alert-note">
          연결에 적힌 테마 중 <b>{missing.join(", ")}</b> 을(를) 내 테마에서 못 찾았습니다.
          이름이 정확히 같아야 매칭됩니다.
        </div>
      )}

      <div className="table-note">
        미국 등락률은 전일 종가 대비 단순평균(지수와 개별종목이 섞여 있어 가중은 의미가 없습니다),
        국내는 내 테마의 시총 가중 등락률을 다시 단순평균한 값입니다. 미국 휴장일에는 값이
        직전 거래일 그대로 나옵니다.
      </div>
    </>
  );
}
