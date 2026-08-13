import { useEffect, useState, type ReactNode } from "react";

/**
 * 접었다 펼 수 있는 설정 카드.
 *
 * 설정 화면이 길어지면서 아래쪽 항목까지 스크롤하는 게 일이 됐다.
 * 접힌 상태를 기기별로 기억해서, 자주 쓰는 것만 펴놓고 쓸 수 있게 한다.
 *
 * 내용을 언마운트하지 않고 CSS로만 감추는 것도 방법이지만,
 * 여기 들어오는 패널들은 마운트될 때 API를 호출하므로(채널 목록, 신호등 설정 등)
 * **접혀 있으면 아예 렌더하지 않는다.** 안 보는 카드 때문에 호출이 나가면 안 된다.
 */

const STORAGE_KEY = "vntg.settings.open";

function readOpenMap(): Record<string, boolean> {
  try {
    return JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "{}") as Record<string, boolean>;
  } catch {
    return {};
  }
}

function writeOpen(id: string, open: boolean): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ ...readOpenMap(), [id]: open }));
  } catch {
    /* 사파리 프라이빗 모드 등 — 저장 못 해도 동작에는 지장 없다 */
  }
}

export function CollapsibleCard({
  id,
  title,
  hint,
  defaultOpen = false,
  badge,
  children,
}: {
  /** localStorage 키. 제목을 바꿔도 접힘 상태가 유지되도록 별도로 받는다 */
  id: string;
  title: string;
  /** 접혀 있을 때도 보이는 한 줄 설명 */
  hint?: string;
  defaultOpen?: boolean;
  /** 제목 옆 작은 표시 (예: 켜진 개수) */
  badge?: ReactNode;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(defaultOpen);

  // 첫 렌더에서 localStorage를 읽는다 (SSR이 아니므로 effect로 충분)
  useEffect(() => {
    const saved = readOpenMap()[id];
    if (typeof saved === "boolean") setOpen(saved);
  }, [id]);

  function toggle() {
    setOpen((v) => {
      writeOpen(id, !v);
      return !v;
    });
  }

  return (
    <section className={`card collapsible${open ? " open" : ""}`}>
      <button className="collapsible-head" onClick={toggle} aria-expanded={open}>
        <span className={`collapsible-caret${open ? " open" : ""}`}>▸</span>
        <h2>{title}</h2>
        {badge && <span className="collapsible-badge">{badge}</span>}
        <span className="collapsible-action">{open ? "접기" : "펼치기"}</span>
      </button>
      {!open && hint && <p className="collapsible-hint">{hint}</p>}
      {open && <div className="collapsible-body">{children}</div>}
    </section>
  );
}
