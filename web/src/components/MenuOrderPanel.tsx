import { applyOrder, useMenuPrefs } from "../useMenuOrder";

/**
 * 사이드바 메뉴 순서·표시 설정.
 *
 * 드래그앤드롭 대신 **위/아래 버튼**을 쓴다. 모바일에서 드래그는 스크롤과 싸우고,
 * 메뉴 스무 개를 한 칸씩 옮기는 일이 자주 있는 것도 아니라 버튼이 확실하다.
 */

export interface MenuItemRef {
  key: string;
  label: string;
  icon: string;
  group: string;
}

export function MenuOrderPanel({ items }: { items: MenuItemRef[] }) {
  const { prefs, save } = useMenuPrefs();
  const ordered = applyOrder(items, prefs.order);

  function move(index: number, delta: number) {
    const next = [...ordered];
    const to = index + delta;
    if (to < 0 || to >= next.length) return;
    [next[index], next[to]] = [next[to], next[index]];
    save({ ...prefs, order: next.map((i) => i.key) });
  }

  function toggle(key: string) {
    const hidden = prefs.hidden.includes(key)
      ? prefs.hidden.filter((k) => k !== key)
      : [...prefs.hidden, key];
    save({ ...prefs, hidden });
  }

  return (
    <>
      <p className="page-note">
        사이드바에 나오는 순서와 표시 여부를 정합니다. 이 설정은 <b>이 기기에만</b> 저장되므로
        미니PC와 휴대폰을 다르게 둘 수 있습니다. 숨긴 메뉴도 주소로는 열립니다.
      </p>

      <div className="mo-list">
        {ordered.map((it, i) => {
          const hidden = prefs.hidden.includes(it.key);
          return (
            <div className={`mo-row${hidden ? " off" : ""}`} key={it.key}>
              <span className="mo-icon">{it.icon}</span>
              <span className="mo-label">{it.label}</span>
              <span className="mo-group">{it.group}</span>
              <button
                className="filter-btn"
                onClick={() => move(i, -1)}
                disabled={i === 0}
                title="위로"
              >
                ↑
              </button>
              <button
                className="filter-btn"
                onClick={() => move(i, 1)}
                disabled={i === ordered.length - 1}
                title="아래로"
              >
                ↓
              </button>
              <button
                className={`filter-btn${hidden ? "" : " active"}`}
                onClick={() => toggle(it.key)}
                title={hidden ? "사이드바에 표시" : "사이드바에서 숨김"}
              >
                {hidden ? "숨김" : "표시"}
              </button>
            </div>
          );
        })}
      </div>

      <div className="filter-row">
        <button
          className="filter-btn"
          onClick={() => save({ order: [], hidden: [] })}
          disabled={prefs.order.length === 0 && prefs.hidden.length === 0}
        >
          기본 순서로 되돌리기
        </button>
      </div>
    </>
  );
}
