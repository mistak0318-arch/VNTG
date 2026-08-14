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

  /*
   * 그룹(시황 / 종목 분석 / 마이페이지 / 계좌 / 설정)도 옮길 수 있어야 한다.
   * App 이 그룹 순서에도 같은 order 배열을 쓰므로, **그룹 이름을 키로 넣으면** 된다.
   * 항목만 옮길 수 있어서 정작 큰 덩어리는 못 바꾸고 있었다.
   */
  const groups = [...new Set(items.map((i) => i.group))];
  const orderedGroups = applyOrder(
    groups.map((g) => ({ key: g })),
    prefs.order,
  ).map((g) => g.key);

  function moveGroup(index: number, delta: number) {
    const next = [...orderedGroups];
    const to = index + delta;
    if (to < 0 || to >= next.length) return;
    [next[index], next[to]] = [next[to], next[index]];
    // 그룹 키를 앞에 두고 항목 키를 뒤에 이어 붙인다 — 둘이 한 배열을 나눠 쓴다
    save({ ...prefs, order: [...next, ...ordered.map((i) => i.key)] });
  }

  function move(index: number, delta: number) {
    const next = [...ordered];
    const to = index + delta;
    if (to < 0 || to >= next.length) return;
    [next[index], next[to]] = [next[to], next[index]];
    save({ ...prefs, order: [...orderedGroups, ...next.map((i) => i.key)] });
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

      <h4 className="section-heading">그룹 순서</h4>
      <div className="mo-list">
        {orderedGroups.map((g, i) => (
          <div className="mo-row mo-group-row" key={g}>
            <span className="mo-label">
              <b>{g}</b>
            </span>
            <span className="mo-group">{items.filter((x) => x.group === g).length}개 메뉴</span>
            <button className="filter-btn" onClick={() => moveGroup(i, -1)} disabled={i === 0} title="위로">
              ↑
            </button>
            <button
              className="filter-btn"
              onClick={() => moveGroup(i, 1)}
              disabled={i === orderedGroups.length - 1}
              title="아래로"
            >
              ↓
            </button>
          </div>
        ))}
      </div>

      <h4 className="section-heading">메뉴 순서·표시</h4>
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
