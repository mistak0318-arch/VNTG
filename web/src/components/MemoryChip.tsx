import { useCallback, useEffect, useRef, useState } from "react";
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
 *
 * ## 누르면 상태, 그 안에서 비우기 (2026-10-08 고침)
 *
 * 벤티지: "어제 만든 상태 버튼 있잖아 메모리나 api 호출 이런거 **모바일에서는 마우스
 * 오버가 안 되니깐** 한번 눌러서 상태보고 버튼 눌러서 정리하게 하자"
 *
 * 처음엔 상태를 `title` 에만 담고 **누르면 바로 비웠다.** 폰에는 마우스오버가 없으니
 * 상태는 아예 볼 길이 없고, 보려고 누르면 비워졌다 — 읽을 수 없는 계기판에
 * 되돌릴 수 없는 손잡이만 달려 있던 셈이다.
 *
 * 그래서 **한 번 눌러 펼치고, 비우기는 그 안의 단추**로 나눈다. 보는 것과 하는 것은
 * 다른 동작이다. `title` 은 PC 에서 그대로 두되 「눌러서 자세히」만 남긴다.
 */

/** 30초마다 — 더 자주 물으면 그 자체가 요청이다. 관문을 안 타는 길이라 서버가 바빠도 답한다 */
const TICK_MS = 30_000;

export function MemoryChip() {
  const [mem, setMem] = useState<SysMem | null>(null);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [said, setSaid] = useState<string | null>(null);
  const active = useTabActive();
  const wrap = useRef<HTMLSpanElement | null>(null);

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

  /* 펼쳤을 땐 더 자주 — 보고 있는 동안 멈춘 숫자를 보여주면 안 된다 */
  useEffect(() => {
    if (!open) return;
    load();
    const t = setInterval(load, 5000);
    return () => clearInterval(t);
  }, [open, load]);

  /* 바깥을 누르거나 ESC 면 접는다 — 폰에서 팝업이 안 닫히면 그 자체가 고장이다 */
  useEffect(() => {
    if (!open) return;
    const away = (e: MouseEvent) => {
      if (wrap.current && !wrap.current.contains(e.target as Node)) setOpen(false);
    };
    const esc = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", away);
    document.addEventListener("keydown", esc);
    return () => {
      document.removeEventListener("mousedown", away);
      document.removeEventListener("keydown", esc);
    };
  }, [open]);

  async function recover() {
    setBusy(true);
    setSaid(null);
    try {
      const r = await api.sysRecover();
      const parts: string[] = [];
      if (r.거둔MB > 0) parts.push(`${r.거둔MB}MB`);
      if (r.한투줄비움 > 0) parts.push(`한투 줄 ${r.한투줄비움}건`);
      setSaid(parts.length > 0 ? `${parts.join(" · ")} 비웠습니다` : "비울 것이 없었습니다");
      load();
    } catch {
      setSaid("실패했습니다");
    } finally {
      setBusy(false);
      setTimeout(() => setSaid(null), 6000);
    }
  }

  if (!mem) return null;
  const pct = mem.복구.퍼센트;
  /* 65% 가 서버의 「경계」 문턱이다 — 같은 숫자를 써야 화면과 서버가 같은 말을 한다 */
  const level = mem.복구.상태 === "복구" ? "bad" : pct >= 65 ? "warn" : "ok";
  const g = mem.관문;

  return (
    <span className={`memchip memchip-${level}${open ? " on" : ""}`} ref={wrap}>
      <button
        type="button"
        className="memchip-btn"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        title={`서버 상태 ${pct}% · ${mem.복구.상태} — 눌러서 자세히 보고, 거기서 비웁니다`}
      >
        <i className="memchip-dot" />
        {level !== "ok" && <b>{pct}%</b>}
      </button>
      {open && (
        <div className="mem-pop">
          <div className="mem-pop-h">
            <b>서버 상태</b>
            <span className={`mem-pop-lv mem-pop-${level}`}>{mem.복구.상태}</span>
            <button type="button" className="mem-pop-x" onClick={() => setOpen(false)} title="닫기">
              ✕
            </button>
          </div>
          {/*
            **메모리를 맨 위에, 막대로.** 숫자 두 개(1,230/6,144MB)보다 길이 하나가 빠르다.
            경계 65% 자리에 눈금을 그어 둬 「얼마나 왔나」를 견줄 데가 있게 한다.
          */}
          <div className="mem-bar" title={`${mem.복구.heapMB} / ${mem.복구.상한MB}MB`}>
            <i style={{ width: `${Math.min(100, pct)}%` }} className={`mem-bar-f mem-pop-${level}`} />
            <u style={{ left: "65%" }} />
          </div>
          <div className="mem-row">
            <span>메모리</span>
            <b>
              {mem.복구.heapMB.toLocaleString("ko-KR")} / {mem.복구.상한MB.toLocaleString("ko-KR")}MB <em>({pct}%)</em>
            </b>
          </div>
          <div className="mem-row">
            <span>지금 도는 요청</span>
            <b>
              {g.지금도는것} / {g.동시한도}
              {g.기다리는것 > 0 && <em> · 줄 선 것 {g.기다리는것}</em>}
            </b>
          </div>
          <div className="mem-row">
            <span>증권사 줄</span>
            <b>
              키움 {mem.증권사줄.키움줄} · 한투 {mem.증권사줄.한투줄}
            </b>
          </div>
          <div className="mem-row">
            <span>겹쳐서 아낀 조회</span>
            <b>{mem.합치기.겹쳐서아낌.toLocaleString("ko-KR")}건</b>
          </div>
          <div className="mem-row">
            <span>오늘 최고</span>
            <b>
              동시 {g.최고동시} · 줄 {g.최고기다림} · 최장 {(g.최대기다림ms / 1000).toFixed(1)}초
            </b>
          </div>
          {g.되돌려보냄 > 0 && (
            <div className="mem-row">
              <span>바빠서 되돌려보냄</span>
              <b>{g.되돌려보냄.toLocaleString("ko-KR")}건</b>
            </div>
          )}
          <p className="mem-pop-n">
            창을 여러 개 띄워 쓰면 종목 하나에 요청이 창 수만큼 늘어납니다. 굼뜰 때 아래를 누르세요 —
            다시 만들어도 싼 캐시를 놓고 메모리 청소를 돌립니다.
            {!mem.복구.GC가능 && " ⚠️ 서버가 --expose-gc 없이 떠 있어 청소는 반쪽만 됩니다."}
          </p>
          {/*
            **보는 것과 하는 것을 나눈다.** 예전엔 칩을 누르면 바로 비웠는데,
            폰에서는 상태를 보려면 누를 수밖에 없어서 보려다 비우게 됐다.
          */}
          <button type="button" className="mem-pop-go" onClick={() => void recover()} disabled={busy}>
            {busy ? "비우는 중…" : "지금 비우기"}
          </button>
          {said && <div className="mem-pop-said">{said}</div>}
        </div>
      )}
    </span>
  );
}
