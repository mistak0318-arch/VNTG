import { useCallback, useEffect, useState } from "react";
import { api, type SysMem } from "../api";
import { useTabActive } from "../tabActive";

/**
 * 서버 메모리 칩 — **지금 서버가 어떤 상태인지, 그리고 손으로 비우기** (2026-10-08).
 *
 * 벤티지: "모니터 3개에 보드 창을 연동해서 사용하고 있고, 종목연동을 통해 각 종목의 차트를
 * 보거나 상세 정보를 보고있거든. … 캐시 지우기나 메모리 비우기 같은 버튼을 만들던가
 * 수동으로 처리할 수 있는 로직을 만들어라."
 *
 * ## 왜 이게 필요한가
 *
 * 보드를 세 창에 띄우고 종목연동을 켜면 **종목 하나를 누를 때 화면 셋이 같은 길을 동시에** 연다.
 * 종목 화면 한 장이 길 열다섯 개를 여니 한 번에 마흔다섯 개다. 서버 봉우리가 3배가 되고,
 * 그게 10/07 밤의 사망 두 건과 40초짜리 요청의 배경이다.
 *
 * 자동 복구는 heap 78% 를 넘어야 돈다. 그 아래에도 「지금 굼뜨다」가 느껴지는 구간이 있고,
 * 그때 사람이 직접 누를 길이 있어야 한다 — **고치는 데 시간이 걸리면 손잡이라도 줘야 한다.**
 *
 * ## 자리
 *
 * 머리줄, 「탭 모두 닫기」 옆. 어느 화면에서든 같은 자리다. 설정 안에 넣으면 **정작 굼뜰 때
 * 못 쓴다** — 엑셀·읽기 모드를 도구 칸으로 꺼낸 것과 같은 까닭이다.
 *
 * ⚠️ 평소에는 **눈에 안 띄어야 한다.** 숫자가 늘 떠 있으면 그것만 보게 된다.
 * 그래서 65% 아래에서는 작은 점 하나이고, 넘어서야 숫자와 색이 올라온다.
 */

/** 30초마다 — 더 자주 물으면 그 자체가 요청이다. 관문을 안 타는 길이라 서버가 바빠도 답한다 */
const TICK_MS = 30_000;

export function MemoryChip() {
  const [mem, setMem] = useState<SysMem | null>(null);
  const [busy, setBusy] = useState(false);
  const [said, setSaid] = useState<string | null>(null);
  const active = useTabActive();

  const load = useCallback(() => {
    api
      .sysMem()
      .then(setMem)
      .catch(() => {
        /* 못 읽어도 화면은 그대로 — 계기판이 고장나서 앱이 멈추면 안 된다 */
      });
  }, []);

  useEffect(() => {
    if (!active) return;
    load();
    const t = setInterval(load, TICK_MS);
    return () => clearInterval(t);
  }, [active, load]);

  async function recover() {
    setBusy(true);
    setSaid(null);
    try {
      const r = await api.sysRecover();
      setSaid(r.거둔MB > 0 ? `${r.거둔MB}MB 비움` : "비울 것이 없었습니다");
      load();
    } catch {
      setSaid("실패");
    } finally {
      setBusy(false);
      /* 말풍선은 잠깐만 — 머리줄에 글자가 눌어붙으면 거슬린다 */
      setTimeout(() => setSaid(null), 4000);
    }
  }

  if (!mem) return null;
  const pct = mem.복구.퍼센트;
  /* 65% 가 서버의 「경계」 문턱이다 — 같은 숫자를 써야 화면과 서버가 같은 말을 한다 */
  const level = mem.복구.상태 === "복구" ? "bad" : pct >= 65 ? "warn" : "ok";

  return (
    <span className={`memchip memchip-${level}`}>
      <button
        type="button"
        className="memchip-btn"
        onClick={() => void recover()}
        disabled={busy}
        title={
          `서버 메모리 ${mem.복구.heapMB}/${mem.복구.상한MB}MB (${pct}%) · 상태 ${mem.복구.상태}` +
          `\n동시에 도는 요청 ${mem.관문.지금도는것}/${mem.관문.동시한도} · 줄 선 것 ${mem.관문.기다리는것}` +
          `\n오늘 최고: 동시 ${mem.관문.최고동시} · 줄 ${mem.관문.최고기다림} · 가장 오래 기다린 ${(mem.관문.최대기다림ms / 1000).toFixed(1)}초` +
          (mem.관문.되돌려보냄 > 0 ? `\n바빠서 되돌려보냄 ${mem.관문.되돌려보냄}건` : "") +
          `\n\n눌러서 지금 비웁니다 — 다시 만들어도 싼 캐시를 놓고 메모리 청소를 돌립니다.` +
          `\n보드를 여러 창에 띄워 쓰면 요청이 창 수만큼 늘어나, 굼뜰 때 눌러 주세요.` +
          (mem.복구.GC가능 ? "" : "\n⚠️ 서버가 --expose-gc 없이 떠 있어 청소는 반쪽만 됩니다.")
        }
      >
        <i className="memchip-dot" />
        {level !== "ok" && <b>{pct}%</b>}
        {busy ? <em>비우는 중…</em> : said ? <em>{said}</em> : null}
      </button>
    </span>
  );
}
