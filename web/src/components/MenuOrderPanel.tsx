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
    persist(next, ordered);
  }

  function toggle(key: string) {
    const hidden = prefs.hidden.includes(key)
      ? prefs.hidden.filter((k) => k !== key)
      : [...prefs.hidden, key];
    save({ ...prefs, hidden });
  }

  /**
   * 즐겨찾기 순서 옮기기.
   *
   * 사이드바 맨 위 줄은 이 배열 순서를 그대로 쓴다. 예전엔 **올린 순서**로만 늘어서서
   * 나중에 올린 게 늘 뒤로 갔다 — 정작 제일 자주 쓰는 걸 앞으로 못 옮겼다.
   * 여기서도 끌어 옮기기 대신 화살표를 쓴다. 폰에서 드래그는 스크롤과 싸운다.
   */
  function moveFav(i: number, dir: -1 | 1) {
    const j = i + dir;
    if (j < 0 || j >= prefs.favorites.length) return;
    const next = [...prefs.favorites];
    [next[i], next[j]] = [next[j], next[i]];
    save({ ...prefs, favorites: next });
  }

  /** 자주 쓰는 메뉴에 올리고 내린다. 순서는 올린 순서다 */
  function toggleFav(key: string) {
    const favorites = prefs.favorites.includes(key)
      ? prefs.favorites.filter((k) => k !== key)
      : [...prefs.favorites, key];
    save({ ...prefs, favorites });
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
    prefs.favorites.length > 0 ||
    Object.keys(prefs.labels).length > 0 ||
    Object.keys(prefs.groupOf).length > 0 ||
    prefs.extraGroups.length > 0;

  /** 즐겨찾기에 올라간 항목들을 순서대로 — 없는 키는 걸러낸다 */
  const favItems = prefs.favorites
    .map((k) => items.find((i) => i.key === k))
    .filter((i): i is (typeof items)[number] => Boolean(i));

  return (
    <>
      {/*
        즐겨찾기 순서. 사이드바 맨 위 줄이 이 순서 그대로다.
        아래 목록에서 ☆ 로 올리고 내리며, **순서는 여기서만** 바꾼다 —
        아래 목록은 영역별로 나뉘어 있어 즐겨찾기 줄의 순서를 거기서 읽을 수 없다.
      */}
      {favItems.length > 0 && (
        <section className="mo-fav">
          <div className="mo-fav-h">
            <b>자주 쓰는 메뉴 순서</b>
            <small>사이드바 맨 위에 이 순서대로 뜹니다</small>
          </div>
          <div className="mo-fav-list">
            {favItems.map((it, i) => (
              <span className="gt-item" key={it.key}>
                <button
                  className="gt-move"
                  onClick={() => moveFav(i, -1)}
                  disabled={i === 0}
                  title="앞으로"
                >
                  ◀
                </button>
                <span className="mo-fav-chip">
                  {it.icon} {prefs.labels[it.key]?.trim() || it.label}
                </span>
                <button
                  className="gt-move"
                  onClick={() => moveFav(i, 1)}
                  disabled={i >= favItems.length - 1}
                  title="뒤로"
                >
                  ▶
                </button>
              </span>
            ))}
          </div>
        </section>
      )}

      <p className="page-note">
        <b>끌어다 놓아</b> 순서를 바꾸고, 다른 영역 머리 위에 놓으면 그 영역으로 옮겨집니다.
        이름을 누르면 내가 부르는 이름으로 고칠 수 있습니다. 이 설정은 <b>서버에 저장</b>되어
        미니PC·휴대폰·태블릿 어디서 열어도 같습니다. 숨긴 메뉴도 주소로는 열립니다.
      </p>

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
              {/* 영역도 같은 자리에 화살표 — 줄 종류가 달라도 손이 가는 곳은 같아야 한다 */}
              <span className="mo-move">
                <button
                  className="mo-arrow"
                  onClick={() => moveGroup(gi, -1)}
                  disabled={gi === 0}
                  title="위로"
                >
                  ▲
                </button>
                <button
                  className="mo-arrow"
                  onClick={() => moveGroup(gi, 1)}
                  disabled={gi === groups.length - 1}
                  title="아래로"
                >
                  ▼
                </button>
              </span>
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
                    {/*
                      ⚠️ **화살표를 앞으로 옮겼다.**

                      예전 순서는 `⠿ 아이콘 이름 ↑ ↓ 표시 ★` 였다. 순서를 바꾸는 건
                      이 화면에서 제일 자주 하는 일인데 그 버튼이 **줄 오른쪽 끝**에 있어서,
                      한 칸 옮길 때마다 눈이 왼쪽(이름)과 오른쪽(화살표)을 오갔다.
                      메뉴 이름 길이가 제각각이라 **화살표 위치도 줄마다 달라서** 연달아
                      누르기도 어려웠다.

                      화살표를 맨 앞에 붙박아 두면 **줄이 바뀌어도 자리가 안 움직인다** —
                      같은 자리를 연달아 누르면 계속 올라간다. 아이콘도 이름 옆으로
                      작게 붙인다. 아이콘은 **찾는 표지**지 누르는 것이 아니다.
                    */}
                    <span className="mo-move">
                      <button
                        className="mo-arrow"
                        onClick={() => moveItem(it.key, -1)}
                        disabled={idx === 0}
                        title="위로"
                      >
                        ▲
                      </button>
                      <button
                        className="mo-arrow"
                        onClick={() => moveItem(it.key, 1)}
                        disabled={idx === ordered.length - 1}
                        title="아래로"
                      >
                        ▼
                      </button>
                    </span>
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
                      className={`filter-btn${hidden ? "" : " active"}`}
                      onClick={() => toggle(it.key)}
                    >
                      {hidden ? "숨김" : "표시"}
                    </button>
                    {/*
                      자주 쓰는 메뉴로 올리기. 올려도 원래 자리에서 사라지지 않는다 —
                      찾을 때 "여기 있었는데" 하고 헤매면 안 된다.
                    */}
                    <button
                      className={`filter-btn${prefs.favorites.includes(it.key) ? " active" : ""}`}
                      onClick={() => toggleFav(it.key)}
                      title="맨 위 「자주 쓰는 메뉴」에 올립니다"
                    >
                      {prefs.favorites.includes(it.key) ? "★" : "☆"}
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
          onClick={() => save({ order: [], hidden: [], labels: {}, groupOf: {}, extraGroups: [], favorites: [] })}
          disabled={!dirty}
        >
          기본으로 되돌리기
        </button>
      </div>
    </>
  );
}
