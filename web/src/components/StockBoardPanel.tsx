import { useCallback, useEffect, useRef, useState } from "react";
import { api, fmtNum, type BoardPost } from "../api";

/**
 * **네이버 종목토론실** (2026-09-09).
 *
 * 벤티지: "각 종목들 클릭하면 나오는 거 종목상세 마지막 탭에 네이버 종목토론실 연결해서
 * 보여줄 수 있나?"
 *
 * ## 이 화면이 정직하려면
 *
 * 여기 있는 글은 **아무 검증도 없는 남의 말**이다. 우리 화면의 다른 숫자들과 나란히
 * 놓이면 같은 무게로 읽히므로, 두 가지를 눈에 보이게 둔다.
 *
 *   · **주주 인증** 칩 — 네이버가 자산 연결로 확인한 계정. 이 판에서 유일하게 값이 있는
 *     표식이라 따로 세우고, **인증만 보기**로 거를 수 있게 한다
 *   · 맨 아래 한 줄 — 이건 시세도 공시도 아니라는 말
 *
 * ## 왜 본문을 글자로만 받나
 *
 * 서버가 태그를 털어서 준다. 남이 쓴 HTML 을 그대로 화면에 심으면 그 순간 이 탭이
 * 우리 앱에서 가장 위험한 자리가 된다 — 글자만 받으면 그 걱정이 통째로 없다.
 *
 * ## 부르는 때
 *
 * **탭을 열 때만.** 폴링도 배경 수집도 없다 — 새로고침은 단추로 사람이 시킨다.
 */

/** 2026-09-09T10:38:46 → 오늘이면 10:38, 아니면 09.09 10:38 */
function when(iso: string): string {
  const s = String(iso ?? "");
  const m = s.match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/);
  if (!m) return s;
  const [, y, mo, d, hh, mi] = m;
  const now = new Date();
  const today =
    Number(y) === now.getFullYear() && Number(mo) === now.getMonth() + 1 && Number(d) === now.getDate();
  return today ? `${hh}:${mi}` : `${mo}.${d} ${hh}:${mi}`;
}

function Post({ p }: { p: BoardPost }) {
  const [open, setOpen] = useState(false);
  /* 본문이 짧으면 접을 이유가 없다 — 접기 단추만 늘어난다 */
  const long = p.body.length > 140;
  const body = open || !long ? p.body : `${p.body.slice(0, 140)}…`;

  return (
    <article className={`ndisc-post${p.depth > 0 ? " reply" : ""}`}>
      <header className="ndisc-head">
        {p.depth > 0 && <span className="ndisc-re" title="답글">↳</span>}
        <b className="ndisc-title">{p.title || "(제목 없음)"}</b>
        <span className="ndisc-who">
          {p.writer}
          {p.holder && (
            <i className="ndisc-holder" title="네이버가 자산 연결로 확인한 주주입니다">
              주주
            </i>
          )}
        </span>
        <span className="ndisc-at pt-n">{when(p.at)}</span>
      </header>
      {p.body && <p className="ndisc-body">{body}</p>}
      <footer className="ndisc-foot">
        {long && (
          <button type="button" className="ndisc-more" onClick={() => setOpen((v) => !v)}>
            {open ? "접기" : "더 보기"}
          </button>
        )}
        <span className="pt-n">조회 {fmtNum(p.views)}</span>
        {p.good > 0 && <span className="positive">추천 {fmtNum(p.good)}</span>}
        {p.bad > 0 && <span className="negative">비추 {fmtNum(p.bad)}</span>}
        {p.images > 0 && <span className="pt-n" title="글에 사진이 있습니다">사진 {p.images}</span>}
        {p.filtered && (
          <span className="ndisc-flag" title="네이버 클린봇이 걸러 둔 글입니다">
            클린봇
          </span>
        )}
        <a className="ndisc-link" href={p.link} target="_blank" rel="noreferrer noopener">
          네이버에서 열기 ↗
        </a>
      </footer>
    </article>
  );
}

export function StockBoardPanel({ code }: { code: string }) {
  const [posts, setPosts] = useState<BoardPost[]>([]);
  const [next, setNext] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [more, setMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /** 주주 인증만 / 원글만 */
  const [holderOnly, setHolderOnly] = useState(false);
  const [rootOnly, setRootOnly] = useState(false);
  /* 종목을 빠르게 바꾸면 늦게 온 응답이 나중에 덮어쓴다 — 마지막 것만 받는다 */
  const want = useRef(code);
  /* 새로고침마다 세대가 오른다 — 그 전에 떠난 「더 불러오기」 응답은 버린다 */
  const gen = useRef(0);

  const load = useCallback(async () => {
    want.current = code;
    gen.current += 1;
    setLoading(true);
    setError(null);
    const r = await api.stockBoard(code).catch((e: unknown) => ({
      posts: [],
      next: null,
      error: e instanceof Error ? e.message : "못 불렀습니다",
    }));
    if (want.current !== code) return;
    setPosts(r.posts);
    setNext(r.next);
    setError(r.error ?? null);
    setLoading(false);
  }, [code]);

  useEffect(() => {
    if (!code) return;
    setPosts([]);
    setNext(null);
    void load();
  }, [code, load]);

  async function loadMore() {
    if (!next || more) return;
    setMore(true);
    const myGen = gen.current;
    const r = await api.stockBoard(code, next).catch(() => null);
    /* 그 사이 새로고침이 지나갔으면 이 쪽은 옛 목록의 뒷장이다 — 버린다 */
    if (r && want.current === code && gen.current === myGen) {
      /*
       * 같은 글이 두 번 오는 일이 있다(그 사이 새 글이 올라오면 자리가 밀린다).
       * ⚠️ **지금 상태를 기준으로** 붙인다 (2026-09-09 재검토에서 잡힘). 렌더 때 닫힌 `posts`
       * 를 쓰면, 더 불러오는 사이에 「새로고침」이 끝났을 때 **옛 목록 + 2쪽**이 새 목록을
       * 덮어썼다. 함수형으로 받으면 늘 최신 목록에 이어 붙는다.
       */
      setPosts((prev) => {
        const seen = new Set(prev.map((p) => p.id));
        return [...prev, ...r.posts.filter((p) => !seen.has(p.id))];
      });
      setNext(r.next);
    }
    setMore(false);
  }

  const shown = posts.filter((p) => (!holderOnly || p.holder) && (!rootOnly || p.depth === 0));
  const holders = posts.filter((p) => p.holder).length;

  if (loading && posts.length === 0) return <div className="empty">종목토론실 불러오는 중…</div>;

  return (
    <div className="ndisc">
      <div className="filter-row">
        <button
          type="button"
          className={`filter-btn${holderOnly ? " active" : ""}`}
          onClick={() => setHolderOnly((v) => !v)}
          title="네이버가 자산 연결로 확인한 주주가 쓴 글만"
        >
          주주 인증만 ({holders})
        </button>
        <button
          type="button"
          className={`filter-btn${rootOnly ? " active" : ""}`}
          onClick={() => setRootOnly((v) => !v)}
          title="답글을 빼고 원글만"
        >
          원글만
        </button>
        <button type="button" className="filter-btn" onClick={() => void load()} disabled={loading}>
          {loading ? "…" : "새로고침"}
        </button>
        <a
          className="filter-btn"
          href={`https://m.stock.naver.com/pc/domestic/stock/${code}/discussion`}
          target="_blank"
          rel="noreferrer noopener"
        >
          네이버에서 ↗
        </a>
      </div>

      {error && <div className="error-banner">{error}</div>}

      {shown.length === 0 ? (
        <div className="page-note">
          {posts.length === 0
            ? "글이 없습니다."
            : "거른 조건에 맞는 글이 없습니다 — 위 단추를 꺼 보세요."}
        </div>
      ) : (
        <div className="ndisc-list">
          {shown.map((p) => (
            <Post key={p.id} p={p} />
          ))}
        </div>
      )}

      {next && (
        <button type="button" className="filter-btn ndisc-page" onClick={() => void loadMore()} disabled={more}>
          {more ? "불러오는 중…" : "더 불러오기"}
        </button>
      )}

      <div className="table-note">
        ⚠️ 네이버 종목토론실 글입니다 — <b>검증되지 않은 남의 말</b>이고 시세도 공시도
        아닙니다. <b>주주</b> 칩은 네이버가 자산 연결로 확인한 계정이라는 표시일 뿐,
        그 사람 말이 맞다는 뜻이 아닙니다. 판단의 근거로 쓰지 말고 <b>지금 무슨 말이
        도는가</b>만 보세요.
      </div>
    </div>
  );
}
