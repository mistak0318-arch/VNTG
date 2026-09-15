import { useEffect, useMemo, useState } from "react";
import { api, signClass, type BridgePairRow, type ThemeStrength } from "../api";
import { tint } from "./GroupTiles";
import { useTabActive } from "../tabActive";

/**
 * **한미 짝 — 네모 반반** (2026-09-15 — 벤티지: "미국 짝 한국 짝 지은 거 테마 MAP 에 따로 메뉴 만들어서
 * 보여 줘. 네모 반반으로 해서 눈에 확 보이게. 내가 손으로 그린 식으로").
 *
 * 국내 테마마다 타일 하나. 위에 이름, 네모를 반으로 갈라 **왼쪽 국내(오늘) · 오른쪽 미국(어젯밤)**.
 * 반쪽마다 제 등락으로 칠한다(`GroupTiles.tint` — 3% 에서 가장 진하다). 둘이 같은 색이면 같이 간 것이고
 * 빨강·파랑으로 갈리면 엇갈린 것이다 — 글자를 읽기 전에 보인다.
 *
 * 국내 값은 테마 DB·네이버 테마 MAP 과 **같은 숫자**(`themeStrength`, 구성종목 단순평균)다. 미국은 대표 업종의
 * 시총 가중. 누르면 그 국내 테마의 구성종목 시트가 열리고, 거기 「미국 짝」 칸에 이어진 업종·회사가 다 나온다.
 *
 * 자리는 **테마/업종 MAP 의 서브탭 맨 끝**이다(벤티지: "테마 MAP 에 따로 메뉴" · "여기 창에서 오른쪽 위에 두면 될 듯").
 */
type PairSort = "us" | "gap" | "kr";
const PAIR_SORTS: { key: PairSort; label: string }[] = [
  { key: "us", label: "미국 많이 움직인 순" },
  { key: "gap", label: "엇갈린 순" },
  { key: "kr", label: "국내 많이 움직인 순" },
];
const PAIR_PAGE = 30;

export function PairTiles({ onOpen }: { onOpen: (key: string, name: string) => void }) {
  const [pairs, setPairs] = useState<{ usAt: string; pairs: BridgePairRow[] } | null>(null);
  const [kr, setKr] = useState<ThemeStrength[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [sort, setSort] = useState<PairSort>("us");
  const [solidOnly, setSolidOnly] = useState(false);
  const [limit, setLimit] = useState(PAIR_PAGE);
  const tabActive = useTabActive();

  useEffect(() => {
    let alive = true;
    api
      .themeBridgePairs()
      .then((r) => alive && setPairs(r))
      .catch((e: Error) => alive && setError(e.message));
    const pullKr = () =>
      api
        .themeStrength("kr")
        .then((r) => alive && setKr(r.themes))
        .catch((e: Error) => alive && setError(e.message));
    void pullKr();
    /* 국내 쪽만 움직인다(미국은 하루 한 번) — 1분마다, 뒤에 있으면 쉰다 */
    const t = setInterval(() => {
      if (document.visibilityState === "visible" && tabActive) void pullKr();
    }, 60_000);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, [tabActive]);

  const krByKey = useMemo(() => new Map((kr ?? []).map((t) => [t.key, t])), [kr]);

  const rows = useMemo(() => {
    if (!pairs) return [];
    const out = pairs.pairs
      .map((p) => ({ p, t: krByKey.get(`kr:${p.no}`) }))
      .filter((r): r is { p: BridgePairRow; t: ThemeStrength } => Boolean(r.t) && (!solidOnly || r.p.us.via !== "낱말"));
    const us = (r: (typeof out)[number]) => r.p.us.changeRate ?? 0;
    const k = (r: (typeof out)[number]) => r.t.changeRate;
    /* 엇갈린 순 — 부호가 다른 짝만 앞에, 벌어진 만큼. 같은 방향은 뒤로 */
    const gap = (r: (typeof out)[number]) => (Math.sign(us(r)) !== Math.sign(k(r)) ? Math.abs(us(r) - k(r)) : -1);
    out.sort((a, b) =>
      sort === "us" ? Math.abs(us(b)) - Math.abs(us(a)) : sort === "kr" ? Math.abs(k(b)) - Math.abs(k(a)) : gap(b) - gap(a),
    );
    return out;
  }, [pairs, krByKey, sort, solidOnly]);

  if (error) return <div className="error-banner">{error}</div>;
  if (!pairs || !kr) return <div className="empty">짝 맞추는 중…</div>;

  const d = pairs.usAt ? new Date(new Date(pairs.usAt).getTime() - 12 * 3600_000) : null;
  const pct = (v: number | null) => (v === null ? "–" : `${v > 0 ? "+" : ""}${v.toFixed(2)}%`);

  return (
    <>
      <div className="filter-row pt-bar">
        {PAIR_SORTS.map((o) => (
          <button key={o.key} type="button" className={`filter-btn${sort === o.key ? " active" : ""}`} onClick={() => setSort(o.key)}>
            {o.label}
          </button>
        ))}
        <button
          type="button"
          className={`filter-btn${solidOnly ? " active" : ""}`}
          onClick={() => setSolidOnly((v) => !v)}
          title="편입 사유에 그 미국 업종 회사가 나오는 짝만"
        >
          근거 있는 짝만
        </button>
      </div>
      <div className="pt-legend">
        <span>
          <b>왼쪽</b> 국내 오늘 · <b>오른쪽</b> 미국 {d ? `${d.getMonth() + 1}/${d.getDate()}` : ""} 마감
        </span>
        <span>{rows.length}짝 · 점선은 테마 이름으로만 이은 어림</span>
      </div>
      <div className="pt-grid">
        {rows.slice(0, limit).map(({ p, t }) => (
          <button key={p.no} type="button" className={`pt-tile${p.us.via === "낱말" ? " guess" : ""}`} onClick={() => onOpen(t.key, t.name)}>
            <span className="pt-name">{t.name.replace(/\(.*?\)/g, "").trim() || t.name}</span>
            <span className="pt-box">
              <span className="pt-half" style={tint(t.changeRate)}>
                <i>국내</i>
                <b className={signClass(t.changeRate)}>{pct(t.changeRate)}</b>
              </span>
              <span className="pt-half" style={tint(p.us.changeRate)}>
                <i>미국</i>
                <b className={signClass(p.us.changeRate ?? 0)}>{pct(p.us.changeRate)}</b>
              </span>
            </span>
            <span className="pt-us">{p.us.name}</span>
          </button>
        ))}
      </div>
      {rows.length > limit && (
        <button type="button" className="filter-btn pt-more" onClick={() => setLimit((n) => n + PAIR_PAGE)}>
          더 보기 ({rows.length - limit}짝 남음)
        </button>
      )}
    </>
  );
}

