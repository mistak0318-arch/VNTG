import { Fragment, useEffect, useState } from "react";
import { api, fmtKstHm, type HantooNewsItem } from "../api";
import { useTabActive } from "../tabActive";

/** 「9월 21일 (일)」 — 날짜 구분줄에만 쓴다. KST 로 읽어야 자정 근처가 안 어긋난다 */
function fmtKstDayLabel(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const k = new Date(d.getTime() + 9 * 3600_000);
  const w = ["일", "월", "화", "수", "목", "금", "토"][k.getUTCDay()];
  return `${k.getUTCMonth() + 1}월 ${k.getUTCDate()}일 (${w})`;
}

/**
 * 🏦 한투 속보 — 한국투자증권 HTS 뉴스창 그대로 (FHKST01011800, 2026-09-10).
 *
 * 네이버 속보와 다른 점: **종목코드가 달려 온다.** 제목에서 종목을 맞히는 게 아니라 한투가 붙인
 * 것이라 칩이 정확하다. 자동 생성 줄(「○○ 소폭 상승세 +3%」)이 절반쯤 섞여 기본은 뺀다 —
 * 켜면 그것도 흐름(어느 종목이 지금 움직이나)으로 읽을 수 있다. 원문 링크는 안 주므로
 * 제목을 누르면 네이버 뉴스 검색으로 간다.
 */
export function HantooNewsPanel({ onSelectStock }: { onSelectStock: (code: string, name: string) => void }) {
  const [items, setItems] = useState<HantooNewsItem[]>([]);
  const [next, setNext] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [hideAuto, setHideAuto] = useState(() => localStorage.getItem("vntg.hantooNews.hideAuto") !== "0");
  const [onlyStock, setOnlyStock] = useState(() => localStorage.getItem("vntg.hantooNews.onlyStock") === "1");

  const load = (srno?: string) => {
    setLoading(true);
    return api
      .hantooNews(srno)
      .then((r) => {
        if (!r.ready) {
          setError("한투 API 가 준비돼 있지 않습니다 (키·토큰).");
          return;
        }
        setError(null);
        setItems((prev) => {
          const seen = new Set(prev.map((x) => x.id));
          const add = r.items.filter((x) => !seen.has(x.id));
          /* 첫 장(srno 없음)은 최신이 앞이라 앞에 붙이고, 더 보기는 뒤에 */
          const merged = srno ? [...prev, ...add] : [...add, ...prev];
          return merged.sort((a, b) => b.at.localeCompare(a.at)).slice(0, 400);
        });
        if (srno || next === null) setNext(r.next);
      })
      .catch((e: Error) => setError(e.message))
      .finally(() => setLoading(false));
  };

  /* 숨은 탭에서는 안 묻는다 (2026-09-22) — 탭은 `display:none` 이라 열어 둔 수만큼 배가된다 */
  const tabActive = useTabActive();
  useEffect(() => {
    if (!tabActive) return;
    void load();
    const t = setInterval(() => void load(), 60_000);
    return () => clearInterval(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tabActive]);

  const shown = items.filter((x) => (!hideAuto || !x.auto) && (!onlyStock || x.stocks.length > 0));
  const searchUrl = (title: string) => `https://search.naver.com/search.naver?where=news&sm=tab_jum&query=${encodeURIComponent(title.replace(/\[.*?\]/g, "").slice(0, 60))}`;

  return (
    <div className="hn">
      <div className="filter-row">
        <button
          className={`filter-btn${hideAuto ? " active" : ""}`}
          onClick={() => {
            setHideAuto((v) => {
              localStorage.setItem("vntg.hantooNews.hideAuto", v ? "0" : "1");
              return !v;
            });
          }}
          title="「○○ 소폭 상승세 +3%」 같은 자동 생성 줄을 뺍니다"
        >
          자동 줄 빼기
        </button>
        <button
          className={`filter-btn${onlyStock ? " active" : ""}`}
          onClick={() => {
            setOnlyStock((v) => {
              localStorage.setItem("vntg.hantooNews.onlyStock", v ? "0" : "1");
              return !v;
            });
          }}
        >
          종목 언급만
        </button>
        <span className="pt-n">
          {shown.length}건{items.length !== shown.length ? ` / ${items.length}` : ""} · 1분마다
        </span>
        <button className="refresh-btn" onClick={() => void load()} disabled={loading}>
          {loading ? "…" : "↻"}
        </button>
      </div>
      {error && <div className="error-banner">{error}</div>}
      {shown.length === 0 && !loading && !error && <div className="empty">지금은 걸리는 줄이 없습니다.</div>}
      <ul className="hn-list">
        {shown.map((n, i) => {
          /*
           * **날짜가 바뀌면 구분줄** (2026-09-22 — 벤티지: "한투속보는 가독성이 넘 안 좋아").
           * 시각을 `HH:mm` 로만 찍는데 「더 보기(이전 40건)」를 누르면 어제·그제까지 내려간다.
           * 전부 `14:32` 로 보여서 어느 날 것인지 알 길이 없었다.
           */
          const day = n.at.slice(0, 10);
          const newDay = i === 0 || shown[i - 1].at.slice(0, 10) !== day;
          return (
            <Fragment key={n.id}>
              {newDay && i > 0 && <li className="hn-day">{fmtKstDayLabel(n.at)}</li>}
              <li className={`hn-item${n.auto ? " auto" : ""}`}>
                <span className="hn-tm">{fmtKstHm(n.at)}</span>
                <span className="hn-body">
                  <a className="hn-title" href={searchUrl(n.title)} target="_blank" rel="noreferrer" title="네이버 뉴스에서 이 제목 찾기">
                    {n.title}
                  </a>
                  {/*
                   * 출처·종목칩은 **제목 아랫줄**로 내렸다 (2026-09-22). 예전엔 `.hn-stocks` 가
                   * `display:inline` 이라 제목 → 출처 → 칩이 한 문단으로 흘러, 제목이 길면
                   * 줄 끝에서 엉켰다. 제목만 한 덩어리로 보이게 두는 편이 훑기 좋다.
                   */}
                  {(n.org || n.stocks.length > 0) && (
                    <span className="hn-meta">
                      {n.org && <i className="hn-org">{n.org}</i>}
                      {n.stocks.slice(0, 6).map((s) => (
                        <button type="button" className="rp-nc-stock" key={s.code} onClick={() => onSelectStock(s.code, s.name)} title={`${s.name} 종목 상세`}>
                          {s.name}
                        </button>
                      ))}
                    </span>
                  )}
                </span>
              </li>
            </Fragment>
          );
        })}
      </ul>
      {next && (
        <button className="filter-btn hn-more" onClick={() => void load(next)} disabled={loading}>
          더 보기 (이전 40건)
        </button>
      )}
      <div className="table-note">
        한국투자증권 뉴스창(제목만) — 종목 칩은 한투가 붙인 것이라 정확합니다. 원문 링크는 안 주어서 제목을
        누르면 네이버 뉴스 검색으로 갑니다.
      </div>
    </div>
  );
}
