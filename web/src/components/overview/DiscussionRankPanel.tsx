import { useEffect, useState } from "react";
import { api, signClass, type DiscussionRank } from "../../api";

/**
 * **개미 토론** — 네이버 종목토론 랭킹 (2026-09-16).
 *
 * 벤티지: "비슷한 거 있다고 제끼지 말고 융합해서 업그레이드". 화제 레이더(뉴스·텔레그램)가 **기사와 채널**의
 * 화제라면 이건 **개인 투자자의 화제**다. 셋이 같은 종목을 가리키면 그날의 진짜 중심이고, 토론만 뜨거우면
 * 쏠림 쪽이다.
 *
 * 순위는 한 시간마다. 괄호는 직전 순위 — 많이 뛰어오른 종목이 새로 불붙은 곳이다.
 * ⚠️ **신호등 점수에는 안 들어간다** (문턱·무게 12월까지 동결). 보는 재료일 뿐이다.
 */
export function DiscussionRankPanel({ onSelectStock }: { onSelectStock: (code: string, name: string) => void }) {
  const [data, setData] = useState<{ rankTime: string; items: DiscussionRank[] } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    const pull = () =>
      api
        .naverDiscussion()
        .then((r) => alive && setData(r))
        .catch((e: Error) => alive && setError(e.message));
    void pull();
    const t = window.setInterval(pull, 10 * 60_000);
    return () => {
      alive = false;
      window.clearInterval(t);
    };
  }, []);

  if (error) return <div className="empty">네이버 토론을 못 받음</div>;
  if (!data) return <div className="empty">불러오는 중…</div>;

  const jump = (r: DiscussionRank) => (r.prevRank === null ? "신규" : r.prevRank - r.rank);
  /* 장 전에는 네이버가 등락률을 0.0 으로 준다 — 열두 칸이 모두 「0.0%」면 고장 난 화면으로 보인다 */
  const anyMove = data.items.some((r) => (r.rate ?? 0) !== 0);
  return (
    <div className="dsc">
      <div className="dsc-head">
        🗣 개미 토론 <span>{data.rankTime.slice(11, 16)} 기준 · 네이버 종목토론</span>
      </div>
      <div className="dsc-list">
        {data.items.slice(0, 12).map((r) => {
          const j = jump(r);
          const hot = j === "신규" || (typeof j === "number" && j >= 10);
          return (
            <button
              key={r.code}
              type="button"
              className={`dsc-chip${hot ? " hot" : ""}`}
              onClick={() => (open === r.code ? onSelectStock(r.code, r.name ?? r.code) : setOpen(r.code))}
              title={r.posts.join("\n") || "누르면 요즘 글, 한 번 더 누르면 종목 상세"}
            >
              <b>{r.rank}</b>
              {r.name ?? r.code}
              {r.rate !== null && anyMove && <em className={`num ${signClass(r.rate)}`}>{`${r.rate > 0 ? "+" : ""}${r.rate.toFixed(1)}%`}</em>}
              <i className={hot ? "up" : ""}>{j === "신규" ? "신규" : typeof j === "number" && j > 0 ? `↑${j}` : typeof j === "number" && j < 0 ? `↓${-j}` : "–"}</i>
            </button>
          );
        })}
      </div>
      {open && (
        <div className="dsc-posts">
          {(data.items.find((x) => x.code === open)?.posts ?? []).map((t, i) => (
            <div key={i}>· {t}</div>
          ))}
          <span className="dsc-more">칩을 한 번 더 누르면 종목 상세로 갑니다</span>
        </div>
      )}
    </div>
  );
}
