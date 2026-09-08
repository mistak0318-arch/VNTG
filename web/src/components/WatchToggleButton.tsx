import { useState } from "react";
import { api } from "../api";
import { useWatchedCodes } from "../useWatchedCodes";
import { WatchAddSheet, type WatchAddTarget } from "./WatchAddSheet";

/**
 * **관심종목 담기 별 — 한 곳에서** (2026-09-08).
 *
 * 벤티지: "보드의 가격 요약 카드랑 개별종목분석 부분에 관심종목에 넣는 기능이 빠져있네?
 * 여기에도 넣어줘야지."
 *
 * 여태 이 단추는 **클릭 시트(StockDetail)에만** 있었다. 같은 종목을 보는 다른 두 화면에는
 * 없어서, 개별종목분석에서 담으려면 시트를 따로 열어야 했다. 화면마다 다시 짜면 어디는
 * 되고 어디는 안 되는 상태가 또 생기므로(오늘만 세 번째다) 그 로직을 여기 하나로 옮긴다.
 *
 * ## 누르면 무엇을 하나
 *
 * 이미 담긴 종목이면 **그룹 고르는 창**을 연다 — 예전에 곧바로 지웠더니, 한 종목이 여러
 * 그룹에 담기게 된 뒤로는 「다른 그룹에 하나 더 담으려고 눌렀는데 있던 것까지 사라지는」
 * 일이 났다. 그룹이 하나도 없을 때만 묻지 않고 바로 담는다 — 빈 창은 방해다.
 *
 * 담는 순간의 값을 **편입가**로 적는다. 나중에 「담고 나서 몇 %」를 보는 기준이 그것이다.
 */
export function WatchToggleButton({
  code,
  name,
  price,
  className,
}: {
  code: string;
  name: string;
  /** 편입가로 적을 값 — 없으면 0(서버가 나중에 채운다) */
  price?: number | null;
  className?: string;
}) {
  const watchedCodes = useWatchedCodes();
  const watched = watchedCodes.isWatched(code);
  const [busy, setBusy] = useState(false);
  const [target, setTarget] = useState<WatchAddTarget | null>(null);

  async function toggle(e: React.MouseEvent) {
    e.stopPropagation();
    if (busy || !code) return;
    setBusy(true);
    try {
      const at = Math.abs(Number(price ?? 0)) || 0;
      const { groups } = await api.watchGroups().catch(() => ({ groups: [] as string[] }));
      if (groups.length === 0 && !watched) {
        await api.watchlistAdd({ code, name, addedPrice: at });
        watchedCodes.markAdded(code);
      } else {
        setTarget({ code, name, addedPrice: at });
      }
    } catch {
      /* 실패하면 별이 안 켜진다 — 그것이 곧 「안 담겼다」는 표시다 */
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <button
        type="button"
        className={`watch-btn${watched ? " on" : ""}${className ? ` ${className}` : ""}`}
        onClick={(e) => void toggle(e)}
        disabled={busy}
        title={watched ? "그룹 고치기 (담긴 그룹 확인·추가·제거)" : "관심종목에 추가"}
      >
        {watched ? "★" : "☆"}
      </button>
      {target && <WatchAddSheet target={target} onClose={() => setTarget(null)} />}
    </>
  );
}
