import { useEffect, useState } from "react";
import { api, type NaverBriefing } from "../api";

/**
 * **다른 눈** — 네이버 AI 시황 브리핑 (2026-09-16).
 *
 * 벤티지: "비슷한 거 있다고 제끼지 말고 융합해서 업그레이드." 그리고 뒤에 —
 * "네이버 AI 시황이 1시간마다 나오는 구조인 거야? 그렇다면 시황 대시보드 신호등 밑에 접힌 메뉴로
 * 해서, 새로 나올 때마다 NEW 버튼 보여지게 해 주고, 펼치면 나오는 게 어때."
 *
 * 실측으로 **1시간마다** 맞다 — `[프리마켓]`·`[정규장]` 같은 꼬리표가 붙어 나오고 id 가 하나씩 는다.
 *
 * 우리도 AI 요약을 쓴다(데일리 리포트·장전 브리핑). 그래서 이건 **대체가 아니라 대조**다 —
 * 같은 장을 다른 모델이 어떻게 읽었나. 데일리 리포트의 AI 요약 프롬프트에도 같은 규칙으로 들어가
 * 있다(`aiSummary.ts` 의 `NAVER_RULE`): **베끼지 말고, 다르게 봤으면 그 점을 한 줄로 짚어라.**
 *
 * ## 읽은 표시는 이 브라우저에만
 *
 * 마지막으로 열어 본 브리핑 id 를 `localStorage` 에 둔다. **서버에 안 보낸다** — 「내가 이미
 * 읽었나」는 기기마다 다른 게 자연스럽고, 못 읽어도(사생활 보호 창·저장소 차단) NEW 가 한 번 더
 * 뜨는 것뿐이라 잃을 게 없다. 읽기·쓰기를 다 try 로 감싼다.
 */

const SEEN_KEY = "naverBriefing.seenId";

function readSeen(): number {
  try {
    return Number(localStorage.getItem(SEEN_KEY) ?? "0") || 0;
  } catch {
    return 0;
  }
}
function writeSeen(id: number): void {
  try {
    localStorage.setItem(SEEN_KEY, String(id));
  } catch {
    /* 저장이 막혀 있어도 화면은 그대로 돈다 */
  }
}

export function NaverBriefingBlock({ open = false }: { open?: boolean }) {
  const [data, setData] = useState<{ latest: NaverBriefing | null; recent: NaverBriefing[] } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [expand, setExpand] = useState<number | null>(null);
  const [seen, setSeen] = useState(readSeen);

  useEffect(() => {
    let alive = true;
    const pull = () =>
      api
        .naverBriefing()
        .then((r) => alive && setData(r))
        .catch((e: Error) => alive && setError(e.message));
    void pull();
    /* 한 시간에 한 번 나오는 글이라 10분 간격이면 충분하다 — 서버도 10분 캐시다 */
    const t = window.setInterval(pull, 10 * 60_000);
    return () => {
      alive = false;
      window.clearInterval(t);
    };
  }, []);

  if (error) return null; // 참고용이라 못 받으면 조용히 빠진다
  if (!data?.latest) return null;

  const latest = data.latest;
  const isNew = latest.id > seen;
  /* 펼치는 순간 「읽었다」로 — 접을 때가 아니라 펼칠 때다 */
  const markRead = (openNow: boolean) => {
    if (!openNow) return;
    writeSeen(latest.id);
    setSeen(latest.id);
  };

  return (
    <details className="nvb" open={open} onToggle={(e) => markRead((e.currentTarget as HTMLDetailsElement).open)}>
      <summary>
        🤖 다른 눈 — 네이버 AI 시황
        {isNew && <b className="nvb-new">NEW</b>}
        <span>
          {latest.when.slice(11, 16)} · {latest.title.slice(0, 22)}
          {latest.title.length > 22 ? "…" : ""}
        </span>
      </summary>
      <div className="nvb-body">
        {data.recent.slice(0, 6).map((b) => (
          <div className={`nvb-item${expand === b.id ? " open" : ""}`} key={b.id}>
            <button type="button" className="nvb-h" onClick={() => setExpand(expand === b.id ? null : b.id)}>
              <i>{b.when.slice(11, 16)}</i>
              {b.title}
            </button>
            {expand === b.id && <p className="nvb-sum">{b.summary}</p>}
          </div>
        ))}
        <div className="table-note">
          네이버가 자기 AI 로 <b>한 시간마다</b> 만드는 시황입니다. <b>우리 요약과 견주라고</b> 둔 것이지
          근거가 아닙니다 — 같은 장을 다르게 읽었다면 그 차이가 볼 거리입니다. 줄을 누르면 본문이 펼쳐집니다.
        </div>
      </div>
    </details>
  );
}
