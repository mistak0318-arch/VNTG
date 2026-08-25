import { useCallback, useEffect, useState } from "react";
import { api, type NewsItem } from "../api";
import { fmtNewsTime } from "./SectorNews";

/**
 * 속보 — **훑는 화면이지 읽는 화면이 아니다.**
 *
 * 일반 뉴스 목록은 제목·요약·메타가 다 같은 회색 글자라 눈이 미끄러진다.
 * 속보는 더하다 — 몇 초 안에 「방금 무슨 일이 났나」만 건지면 되는데
 * 문단을 읽게 만들면 목적이 죽는다. 그래서:
 *
 *   시각 레일   왼쪽에 HH:mm 고정폭 — 타임라인으로 훑는다(브리핑 이벤트와 같은 문법)
 *   방향 색     제목 속 급등·급락·상한가 같은 단어만 빨강/파랑 — 방향이 먼저 보인다
 *   갈래 배지   증시·기업 / 경제·정책 / 국제 — 색으로 갈래가 구분된다
 *   방금 점     10분 안 기사엔 붉은 점 — 「지금 난 것」과 「아까 것」이 갈린다
 *
 * 요약문은 안 싣는다 — 속보 제목이 곧 전문이다.
 */

const CAT_CLASS: Record<string, string> = {
  market: "bn-cat-market",
  econ: "bn-cat-econ",
  world: "bn-cat-world",
  etc: "bn-cat-etc",
};

/** 방향 단어만 물들인다 — 제목 전체를 칠하면 아무것도 안 보이는 것과 같다 */
const UP_RE = /급등|폭등|상한가|신고가|사상\s?최고|돌파|흑자|급반등/;
const DOWN_RE = /급락|폭락|하한가|신저가|사상\s?최저|적자|붕괴|급반락/;
const MARK_RE = new RegExp(`(${UP_RE.source}|${DOWN_RE.source})`, "g");

function HighlightTitle({ text }: { text: string }) {
  const parts = text.split(MARK_RE);
  return (
    <>
      {parts.map((p, i) =>
        UP_RE.test(p) && p.length <= 6 ? (
          <em className="bn-up" key={i}>
            {p}
          </em>
        ) : DOWN_RE.test(p) && p.length <= 6 ? (
          <em className="bn-down" key={i}>
            {p}
          </em>
        ) : (
          <span key={i}>{p}</span>
        ),
      )}
    </>
  );
}

/** "[속보] 제목" → 머리표와 본문을 가른다 — 머리표는 배지로 그린다 */
function splitHead(title: string): { head: string; body: string } {
  const m = /^\s*[[〔【<「(]?\s*(속보|단독|긴급)\s*[\]〕】>」)]\s*/.exec(title);
  if (!m) return { head: "속보", body: title };
  return { head: m[1], body: title.slice(m[0].length) };
}

function hhmm(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "--:--";
  const two = (n: number) => String(n).padStart(2, "0");
  return `${two(d.getHours())}:${two(d.getMinutes())}`;
}

export function BreakingNews() {
  const [cats, setCats] = useState<{ key: string; label: string; items: NewsItem[] }[]>([]);
  const [tab, setTab] = useState<string>("all");
  const [fetchedAt, setFetchedAt] = useState("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(() => {
    setLoading(true);
    api
      .newsBreaking()
      .then((r) => {
        setCats(r.categories);
        setFetchedAt(r.fetchedAt);
        setError(null);
      })
      .catch((e: Error) => setError(e.message))
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    load();
    /* 서버가 5분 캐시하므로 이보다 짧게 돌려도 네이버 호출은 안 늘어난다 */
    const t = setInterval(() => {
      if (document.visibilityState === "visible") load();
    }, 90_000);
    return () => clearInterval(t);
  }, [load]);

  const shown =
    tab === "all"
      ? cats
          .flatMap((c) => c.items.map((it) => ({ ...it, cat: c.key, catLabel: c.label })))
          .sort((a, b) => b.publishedAt.localeCompare(a.publishedAt))
      : (cats.find((c) => c.key === tab)?.items ?? []).map((it) => ({
          ...it,
          cat: tab,
          catLabel: cats.find((c) => c.key === tab)?.label ?? "",
        }));

  const total = cats.reduce((s, c) => s + c.items.length, 0);

  return (
    <div className="bn">
      <div className="filter-row ctl-ribbon">
        <button
          className={`filter-btn ${tab === "all" ? "active" : ""}`}
          onClick={() => setTab("all")}
        >
          전체 ({total})
        </button>
        {cats.map((c) => (
          <button
            key={c.key}
            className={`filter-btn ${tab === c.key ? "active" : ""}`}
            onClick={() => setTab(c.key)}
          >
            {c.label} ({c.items.length})
          </button>
        ))}
        <span className="news-fetched">{fetchedAt ? `${fmtNewsTime(fetchedAt)} 수집` : ""}</span>
        <button className="filter-btn" onClick={load} disabled={loading}>
          {loading ? "…" : "↻"}
        </button>
      </div>

      {error && <div className="error-banner">{error}</div>}
      {loading && shown.length === 0 && <div className="empty">속보 불러오는 중…</div>}
      {!loading && !error && shown.length === 0 && (
        <div className="empty">지금 걸린 속보가 없습니다 — [속보]·[단독]·[긴급] 머리표가 붙은 기사만 셉니다.</div>
      )}

      <div className="bn-list">
        {shown.map((it, i) => {
          const { head, body } = splitHead(it.title);
          const fresh = Date.now() - new Date(it.publishedAt).getTime() < 10 * 60_000;
          return (
            <a
              key={`${it.link}-${i}`}
              className={`bn-row ${CAT_CLASS[it.cat] ?? "bn-cat-etc"}`}
              href={it.link}
              target="_blank"
              rel="noreferrer noopener"
            >
              <span className="bn-time pt-n">
                {fresh && <i className="bn-fresh" title="10분 안에 나온 기사" />}
                {hhmm(it.publishedAt)}
              </span>
              <span className={`bn-head${head === "속보" ? "" : " alt"}`}>{head}</span>
              <span className="bn-body">
                <HighlightTitle text={body} />
                <span className="bn-meta">
                  {tab === "all" && <i className="bn-cat">{it.catLabel}</i>}
                  <i className={it.major ? "press-major" : ""}>{it.press}</i>
                  <i>{fmtNewsTime(it.publishedAt)}</i>
                </span>
              </span>
            </a>
          );
        })}
      </div>

      <div className="table-note">
        제목이 <b>[속보]·[단독]·[긴급]</b>으로 시작하는 기사만 모읍니다 — 본문에 「속보」가
        들어간 일반 기사는 뺍니다. <b>증시·기업</b> 갈래가 먼저고, 정치·사건 속보는 「그
        밖에」로 밀립니다. 빨강·파랑은 제목 속 <b>방향 단어</b>(급등·급락 따위)입니다.
      </div>
    </div>
  );
}
