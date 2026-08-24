import { useState } from "react";
import { api } from "../api";
import { useWatchedCodes } from "../useWatchedCodes";
import { WatchAddSheet, type WatchAddTarget } from "./WatchAddSheet";

/**
 * 관심종목 **담기 버튼** — 누르면 그룹을 고르는 시트가 열린다.
 *
 * ## 왜 따로 뺐나
 *
 * `WatchStar` 는 **표시 전용**이다. 담긴 종목에만 별이 차는 그림이라, 아직 안 담긴
 * 종목 앞에서는 담을 방법이 없었다 — 종목발굴에서 백 종목을 넘겨 보다가 하나 담으려면
 * 개별종목분석으로 건너가야 했다. **거르는 자리에서 담지 못하면 거르는 뜻이 없다.**
 *
 * 담는 동작은 종목 상세 안에 박혀 있었다. 그걸 여기로 꺼내 두 화면이 같은 것을 쓴다.
 *
 * ## 그룹이 없으면 안 묻는다
 *
 * 그룹을 하나도 안 만들어 뒀으면 시트를 띄워 봐야 고를 게 없다. 그때는 바로 담는다.
 * 이미 담긴 종목은 늘 시트를 연다 — 어느 그룹에 들었는지 보고 빼기도 해야 한다.
 */
export function WatchButton({
  code,
  name,
  /** 담는 순간의 가격을 편입가로 적는다 — 나중에 「편입 대비」가 여기서 나온다 */
  price = 0,
  className = "filter-btn",
}: {
  code: string;
  name: string;
  price?: number;
  className?: string;
}) {
  const watchedCodes = useWatchedCodes();
  const watched = watchedCodes.isWatched(code);
  const [busy, setBusy] = useState(false);
  const [target, setTarget] = useState<WatchAddTarget | null>(null);
  const [err, setErr] = useState<string | null>(null);

  async function onClick() {
    if (busy || !code) return;
    setBusy(true);
    setErr(null);
    try {
      const { groups } = await api.watchGroups().catch(() => ({ groups: [] as string[] }));
      if (groups.length === 0 && !watched) {
        await api.watchlistAdd({ code, name, addedPrice: price });
        watchedCodes.markAdded(code);
      } else {
        setTarget({ code, name, addedPrice: price });
      }
    } catch (e) {
      setErr(e instanceof Error ? e.message : "관심종목 처리 실패");
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <button
        className={`${className}${watched ? " active" : ""}`}
        onClick={() => void onClick()}
        disabled={busy || !code}
        title={watched ? "담긴 그룹 확인·추가·제거" : "관심종목에 담기"}
      >
        {watched ? "★ 관심종목" : "☆ 관심종목"}
      </button>
      {err && <span className="uw-err"> {err}</span>}
      {target && <WatchAddSheet target={target} onClose={() => setTarget(null)} />}
    </>
  );
}
