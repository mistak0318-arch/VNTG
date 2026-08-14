import { useState } from "react";
import { applyOrder, useMenuPrefs } from "../useMenuOrder";

/**
 * 사이드바 메뉴 구성.
 *
 * 처음엔 위/아래 버튼만 뒀는데, 메뉴가 스물다섯 개가 되니 한 칸씩 미는 건 못 할 일이다.
 * **끌어다 놓기**로 바꾸고, 그 김에 두 가지를 더 열었다.
 *
 *   영역 옮기기 — 항목을 다른 영역 위에 놓으면 그쪽으로 간다. 영역도 새로 만들 수 있다.
 *   이름 바꾸기 — 코드가 붙인 이름이 내 머릿속 이름과 다를 수 있다.
 *
 * 위/아래 버튼도 남겨 둔다. 휴대폰에서 끌기는 스크롤과 싸우기 때문이다.
 */

export interface MenuItemRef {
  key: string;
  label: string;
  icon: string;
  group: string;
}

export function MenuOrderPanel({ items }: { items: MenuItemRef[] }) {
  const { prefs, save } = useMenuPrefs();
  const [dragging, setDragging] = useState<string | null>(null);
  const [over, setOver] = useState<string | null>(null);
  const [editing, setEditing] = useState<string | null>(null);
  const [newGroup, setNewGroup] = useState("");

<<<<<<< HEAD
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
=======
  /** 내가 옮긴 영역을 반영한 목록 */
  const placed = items.map((i) => ({ ...i, group: prefs.groupOf[i.key] ?? i.group }));
  const ordered = applyOrder(placed, prefs.order);

  const baseGroups = [...new Set(items.map((i) => i.group))];
  const allGroups = [
    ...new Set([...baseGroups, ...prefs.extraGroups, ...Object.values(prefs.groupOf)]),
  ];
  const groups = applyOrder(
    allGroups.map((g) => ({ key: g })),
    prefs.order,
  ).map((g) => g.key);

  /** 순서 배열에는 영역 이름과 항목 키가 함께 산다 */
  function persist(
    nextGroups: string[],
    nextItems: { key: string }[],
    patch: Partial<typeof prefs> = {},
  ) {
    save({ ...prefs, ...patch, order: [...nextGroups, ...nextItems.map((i) => i.key)] });
  }

  function nameOf(key: string, fallback: string): string {
    return prefs.labels[key]?.trim() || fallback;
  }

  function rename(key: string, value: string) {
    const labels = { ...prefs.labels };
    if (value.trim()) labels[key] = value.trim();
    else delete labels[key];
    save({ ...prefs, labels });
  }

  /** 항목 위에 놓으면 그 자리에 끼우고, 그 항목의 영역을 따라간다 */
  function dropOnItem(targetKey: string) {
    if (!dragging || dragging === targetKey) return;
    const from = ordered.findIndex((i) => i.key === dragging);
    const to = ordered.findIndex((i) => i.key === targetKey);
    if (from < 0 || to < 0) return;
>>>>>>> a515a0e3aa60d068114fb1dd4a9674f785b8118e
    const next = [...ordered];
    const [moved] = next.splice(from, 1);
    next.splice(to, 0, moved);
    // 자리만 옮기고 영역이 그대로면 화면에서 안 움직인 것처럼 보인다
    persist(groups, next, { groupOf: { ...prefs.groupOf, [moved.key]: ordered[to].group } });
    setDragging(null);
    setOver(null);
  }

  /** 영역 머리에 놓으면 그 영역의 맨 끝으로 */
  function dropOnGroup(group: string) {
    if (!dragging) return;
    const moved = ordered.find((i) => i.key === dragging);
    if (!moved) return;
    const next = ordered.filter((i) => i.key !== dragging);
    const lastIdx = next.map((i) => i.group).lastIndexOf(group);
    next.splice(lastIdx < 0 ? next.length : lastIdx + 1, 0, moved);
    persist(groups, next, { groupOf: { ...prefs.groupOf, [dragging]: group } });
    setDragging(null);
    setOver(null);
  }

  function moveItem(key: string, delta: number) {
    const from = ordered.findIndex((i) => i.key === key);
    const to = from + delta;
    if (to < 0 || to >= ordered.length) return;
    const next = [...ordered];
    [next[from], next[to]] = [next[to], next[from]];
    persist(groups, next, { groupOf: { ...prefs.groupOf, [key]: ordered[to].group } });
  }

  function moveGroup(index: number, delta: number) {
    const next = [...groups];
    const to = index + delta;
    if (to < 0 || to >= next.length) return;
    [next[index], next[to]] = [next[to], next[index]];
<<<<<<< HEAD
    save({ ...prefs, order: [...orderedGroups, ...next.map((i) => i.key)] });
=======
    persist(next, ordered);
>>>>>>> a515a0e3aa60d068114fb1dd4a9674f785b8118e
  }

  function toggle(key: string) {
    const hidden = prefs.hidden.includes(key)
      ? prefs.hidden.filter((k) => k !== key)
      : [...prefs.hidden, key];
    save({ ...prefs, hidden });
  }

  function addGroup() {
    const name = newGroup.trim();
    if (!name || groups.includes(name)) return;
    save({ ...prefs, extraGroups: [...prefs.extraGroups, name] });
    setNewGroup("");
  }

  const dirty =
    prefs.order.length > 0 ||
    prefs.hidden.length > 0 ||
    Object.keys(prefs.labels).length > 0 ||
    Object.keys(prefs.groupOf).length > 0 ||
    prefs.extraGroups.length > 0;

  return (
    <>
      <p className="page-note">
        <b>끌어다 놓아</b> 순서를 바꾸고, 다른 영역 머리 위에 놓으면 그 영역으로 옮겨집니다.
        이름을 누르면 내가 부르는 이름으로 고칠 수 있습니다. 이 설정은 <b>이 기기에만</b>{" "}
        저장되므로 미니PC와 휴대폰을 다르게 둘 수 있습니다. 숨긴 메뉴도 주소로는 열립니다.
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
        {groups.map((g, gi) => (
          <div key={g}>
            <div
              className={`mo-row mo-group-row${over === `g:${g}` ? " over" : ""}`}
              onDragOver={(e) => {
                e.preventDefault();
                setOver(`g:${g}`);
              }}
              onDragLeave={() => setOver(null)}
              onDrop={() => dropOnGroup(g)}
            >
              {editing === `g:${g}` ? (
                <input
                  className="mo-rename"
                  autoFocus
                  defaultValue={nameOf(g, g)}
                  onBlur={(e) => {
                    rename(g, e.target.value);
                    setEditing(null);
                  }}
                  onKeyDown={(e) => e.key === "Enter" && (e.target as HTMLInputElement).blur()}
                />
              ) : (
                <button className="mo-name" onClick={() => setEditing(`g:${g}`)} title="이름 바꾸기">
                  <b>{nameOf(g, g)}</b>
                </button>
              )}
              <span className="mo-group">{ordered.filter((i) => i.group === g).length}개</span>
              <button className="filter-btn" onClick={() => moveGroup(gi, -1)} disabled={gi === 0}>
                ↑
              </button>
              <button
                className="filter-btn"
                onClick={() => moveGroup(gi, 1)}
                disabled={gi === groups.length - 1}
              >
                ↓
              </button>
            </div>

            {ordered
              .filter((i) => i.group === g)
              .map((it) => {
                const hidden = prefs.hidden.includes(it.key);
                const idx = ordered.findIndex((x) => x.key === it.key);
                return (
                  <div
                    className={`mo-row${hidden ? " off" : ""}${over === it.key ? " over" : ""}${
                      dragging === it.key ? " dragging" : ""
                    }`}
                    key={it.key}
                    draggable
                    onDragStart={() => setDragging(it.key)}
                    onDragEnd={() => {
                      setDragging(null);
                      setOver(null);
                    }}
                    onDragOver={(e) => {
                      e.preventDefault();
                      setOver(it.key);
                    }}
                    onDrop={() => dropOnItem(it.key)}
                  >
                    <span className="mo-grip" aria-hidden="true">
                      ⠿
                    </span>
                    <span className="mo-icon">{it.icon}</span>
                    {editing === it.key ? (
                      <input
                        className="mo-rename"
                        autoFocus
                        defaultValue={nameOf(it.key, it.label)}
                        onBlur={(e) => {
                          rename(it.key, e.target.value);
                          setEditing(null);
                        }}
                        onKeyDown={(e) => e.key === "Enter" && (e.target as HTMLInputElement).blur()}
                      />
                    ) : (
                      <button
                        className="mo-name"
                        onClick={() => setEditing(it.key)}
                        title="눌러서 이름 바꾸기"
                      >
                        {nameOf(it.key, it.label)}
                        {prefs.labels[it.key] && <em className="mo-orig"> ({it.label})</em>}
                      </button>
                    )}
                    <button
                      className="filter-btn"
                      onClick={() => moveItem(it.key, -1)}
                      disabled={idx === 0}
                    >
                      ↑
                    </button>
                    <button
                      className="filter-btn"
                      onClick={() => moveItem(it.key, 1)}
                      disabled={idx === ordered.length - 1}
                    >
                      ↓
                    </button>
                    <button
                      className={`filter-btn${hidden ? "" : " active"}`}
                      onClick={() => toggle(it.key)}
                    >
                      {hidden ? "숨김" : "표시"}
                    </button>
                  </div>
                );
              })}
          </div>
        ))}
      </div>

      <div className="filter-row">
        <input
          className="pt-input"
          placeholder="새 영역 이름"
          value={newGroup}
          onChange={(e) => setNewGroup(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && addGroup()}
        />
        <button className="filter-btn" onClick={addGroup} disabled={!newGroup.trim()}>
          + 영역 추가
        </button>
        <span className="tg-ctl-hint">만든 뒤 메뉴를 끌어다 놓으세요</span>
        <button
          className="filter-btn danger"
          onClick={() => save({ order: [], hidden: [], labels: {}, groupOf: {}, extraGroups: [] })}
          disabled={!dirty}
        >
          기본으로 되돌리기
        </button>
      </div>
    </>
  );
}
