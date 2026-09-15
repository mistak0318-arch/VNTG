import { useEffect, useState } from "react";
import { api, type NaverBriefing } from "../api";

/**
 * **다른 눈** — 네이버 AI 시황 브리핑 (2026-09-16).
 *
 * 벤티지: "비슷한 거 있다고 제끼지 말고 융합해서 업그레이드."
 *
 * 우리도 AI 요약을 쓴다(데일리 리포트·장전 브리핑). 그래서 이걸 **대체가 아니라 대조**로 넣는다 —
 * 같은 장을 다른 모델이 어떻게 읽었나. 데일리 리포트의 AI 요약 프롬프트에도 같은 규칙으로 들어가 있다
 * (`aiSummary.ts` 의 `NAVER_RULE`): **베끼지 말고, 다르게 봤으면 그 점을 한 줄로 짚어라.**
 *
 * 접힌 채로 둔다 — 우리 요약을 먼저 읽고 나서 견주라는 뜻이다.
 */
export function NaverBriefingBlock({ open = false }: { open?: boolean }) {
  const [data, setData] = useState<{ latest: NaverBriefing | null; recent: NaverBriefing[] } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [expand, setExpand] = useState<number | null>(null);

  useEffect(() => {
    let alive = true;
    api
      .naverBriefing()
      .then((r) => alive && setData(r))
      .catch((e: Error) => alive && setError(e.message));
    return () => {
      alive = false;
    };
  }, []);

  if (error) return null; // 참고용이라 못 받으면 조용히 빠진다
  if (!data?.latest) return null;

  return (
    <details className="nvb" open={open}>
      <summary>
        🤖 다른 눈 — 네이버 AI 시황 브리핑 <span>{data.latest.when.slice(5, 16).replace("-", "/")}</span>
      </summary>
      <div className="nvb-body">
        {data.recent.slice(0, 4).map((b) => (
          <div className={`nvb-item${expand === b.id ? " open" : ""}`} key={b.id}>
            <button type="button" className="nvb-h" onClick={() => setExpand(expand === b.id ? null : b.id)}>
              <i>{b.when.slice(11, 16)}</i>
              {b.title}
            </button>
            {expand === b.id && <p className="nvb-sum">{b.summary}</p>}
          </div>
        ))}
        <div className="table-note">
          네이버가 자기 AI 로 만든 시황입니다. <b>우리 요약과 견주라고</b> 둔 것이지 근거가 아닙니다 — 같은 장을
          다르게 읽었다면 그 차이가 볼 거리입니다.
        </div>
      </div>
    </details>
  );
}
