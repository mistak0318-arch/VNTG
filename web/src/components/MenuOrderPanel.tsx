import { useEffect, useRef, useState } from "react";
import {
  applyOrder,
  parseSection,
  sectionKey,
  SECTION_COLORS,
  useMenuPrefs,
} from "../useMenuOrder";
import { useDragOrder } from "../useDragOrder";

/**
 * 컬러피커 — **닫을 때만 확정한다.**
 *
 * React 의 onChange 는 네이티브 `input` 이라 다이얼로그에서 끄는 동안 계속 온다.
 * 그때마다 저장하면 저장 키(#이름|색)가 바뀌어 이 입력 자체가 다시 그려지고,
 * 열려 있던 OS 색상판이 무너진다. 네이티브 `change`(닫힘)에만 반응한다.
 */
function NativeColorPick({
  value,
  className,
  onPick,
}: {
  value: string;
  className: string;
  onPick: (color: string) => void;
}) {
  const ref = useRef<HTMLInputElement>(null);
  const pick = useRef(onPick);
  pick.current = onPick;
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const h = () => pick.current(el.value);
    el.addEventListener("change", h);
    return () => el.removeEventListener("change", h);
  }, []);
  return (
    <input
      ref={ref}
      type="color"
      className={className}
      defaultValue={value}
      title="원하는 색 직접 고르기"
    />
  );
}

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
  const [newSection, setNewSection] = useState("");
  /** 구분선 이름을 치는 중인 값 — 확정 전까지는 저장하지 않는다 */
  const [draft, setDraft] = useState<{ key: string; name: string } | null>(null);

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

  /* 즐겨찾기 줄 끌어서 옮기기 (2026-08-25) — 화살표와 같은 저장 */
  const favDrag = useDragOrder(prefs.favorites, (next) => save({ ...prefs, favorites: next }));

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

  /*
   * 즐겨찾기 줄들 — **섹션 구분(`#이름`) 포함, 저장 배열 그대로**의 순서다 (2026-08-27 개편).
   * 예전엔 가로 칩 + ◀▶ 였는데, 열 개가 넘으니 줄이 감겨서 순서가 안 읽혔다.
   * 사이드바와 같은 **세로 한 줄씩**으로 세우고, 끌어서(또는 ▲▼) 옮긴다.
   * 섹션을 끼우면 사이드바의 자주 쓰는 메뉴가 소제목으로 나뉜다.
   */
  const favRows = prefs.favorites.map((k) =>
    k.startsWith("#")
      ? { key: k, sec: parseSection(k), icon: "", label: "" }
      : {
          key: k,
          sec: null,
          icon: items.find((i) => i.key === k)?.icon ?? "❓",
          label: nameOf(k, items.find((i) => i.key === k)?.label ?? k),
        },
  );

  function removeFav(key: string) {
    save({ ...prefs, favorites: prefs.favorites.filter((k) => k !== key) });
  }

  function addFavSection() {
    const name = newSection.trim();
    if (!name) return;
    const key = sectionKey(name, null);
    if (prefs.favorites.includes(key)) return; // 같은 이름 두 번이면 순서 저장이 꼬인다
    save({ ...prefs, favorites: [...prefs.favorites, key] });
    setNewSection("");
  }

  /**
   * 구분선 이름을 **다 쳤을 때 한 번에** 반영한다.
   *
   * ⚠️ 한 글자마다 저장하면 안 된다 — 저장 키가 곧 이름이라(`#이름|색`) 키가 바뀌고,
   * 그 키가 React 의 `key` 라 칸이 통째로 다시 그려진다. **글자 하나 칠 때마다 커서가
   * 빠졌다.** 그래서 치는 동안은 여기(draft)에 담아 두고 엔터·포커스 해제에 확정한다.
   */
  function commitDraft(key: string, color: string | null) {
    if (!draft || draft.key !== key) return;
    const name = draft.name;
    setDraft(null);
    renameSection(key, name, color);
  }

  /**
   * 구분선의 이름·색을 고친다 — **자리는 그대로 두고 값만 바꾼다.**
   * 지우고 새로 넣으면 맨 뒤로 가서, 순서를 다시 잡아야 한다.
   */
  function renameSection(oldKey: string, name: string, color: string | null) {
    const next = sectionKey(name.trim() || "구분", color);
    if (next !== oldKey && prefs.favorites.includes(next)) return; // 같은 이름 둘은 안 된다
    save({
      ...prefs,
      favorites: prefs.favorites.map((k) => (k === oldKey ? next : k)),
    });
  }

  return (
    <>
      {favRows.length > 0 && (
        <section className="mo-fav">
          <div className="mo-fav-h">
            <b>자주 쓰는 메뉴 순서</b>
            <small>사이드바 맨 위에 이 순서대로 뜹니다 — 끌거나 ▲▼로 옮기세요</small>
          </div>
          <div className="mo-fav-list">
            {favRows.map((r, i) => (
              <div
                className={`mo-fav-row${r.sec !== null ? " sec" : ""}${favDrag.cls(r.key)}`}
                key={r.key}
                {...favDrag.props(r.key)}
              >
                <span className="mo-move">
                  <button
                    className="mo-arrow"
                    onClick={() => moveFav(i, -1)}
                    disabled={i === 0}
                    title="위로"
                  >
                    ▲
                  </button>
                  <button
                    className="mo-arrow"
                    onClick={() => moveFav(i, 1)}
                    disabled={i >= favRows.length - 1}
                    title="아래로"
                  >
                    ▼
                  </button>
                </span>
                <span className="mo-grip" aria-hidden="true">
                  ⠿
                </span>
                {r.sec !== null ? (
                  /*
                   * 구분선 — **이름을 고치고 색을 고른다** (2026-08-28).
                   * 예전엔 지우고 다시 만드는 수밖에 없었고, 색이 없어서 사이드바에서
                   * 메뉴 항목처럼 보였다.
                   */
                  <span className="mo-fav-secedit">
                    <input
                      className="pt-input mo-sec-name"
                      value={draft && draft.key === r.key ? draft.name : r.sec.name}
                      onChange={(e) => setDraft({ key: r.key, name: e.target.value })}
                      onBlur={() => commitDraft(r.key, r.sec!.color)}
                      onKeyDown={(e) => {
                        if (e.key === "Enter") e.currentTarget.blur();
                        if (e.key === "Escape") setDraft(null);
                      }}
                      title="구분 이름 (엔터로 확정)"
                      /*
                       * 줄 전체가 `draggable` 이라 칸 안에서 글자를 끌면 **줄이 끌려간다**
                       * — 글자 선택이 아예 안 된다. 여기서 끊는다.
                       */
                      onDragStart={(e) => {
                        e.preventDefault();
                        e.stopPropagation();
                      }}
                    />
                    <span className="mo-sec-colors">
                      {SECTION_COLORS.map((c) => (
                        <button
                          key={c.key || "default"}
                          className={`mo-sec-color${(r.sec!.color ?? "") === c.key ? " on" : ""}`}
                          style={c.key ? { background: c.key } : undefined}
                          title={c.label}
                          onClick={() => renameSection(r.key, r.sec!.name, c.key || null)}
                        >
                          {c.key ? "" : "○"}
                        </button>
                      ))}
                      {/*
                        아무 색이나 (2026-08-28 — 「팔레트를 주던지 해서 내가 원하는
                        색으로」). 프리셋에 없는 색은 여기서 고른다. 프리셋 색이면 그
                        동그라미에 표시가 가고, 아니면 이 피커가 지금 색을 보여 준다.
                      */}
                      <NativeColorPick
                        className={`mo-sec-picker${
                          r.sec.color && !SECTION_COLORS.some((c) => c.key === r.sec!.color)
                            ? " on"
                            : ""
                        }`}
                        value={
                          r.sec.color && /^#[0-9a-f]{6}$/i.test(r.sec.color)
                            ? r.sec.color
                            : "#d4a94e"
                        }
                        onPick={(color) => renameSection(r.key, r.sec!.name, color)}
                      />
                    </span>
                  </span>
                ) : (
                  <span className="mo-fav-name">
                    <span className="mo-icon">{r.icon}</span> {r.label}
                  </span>
                )}
                <button
                  className="row-del-btn"
                  onClick={() => removeFav(r.key)}
                  title={r.sec !== null ? "구분 삭제" : "자주 쓰는 메뉴에서 빼기 (메뉴 자체는 그대로)"}
                >
                  ✕
                </button>
              </div>
            ))}
          </div>
          <div className="filter-row">
            <input
              className="pt-input"
              placeholder="구분 이름 (예: 아침, 장중, 복기)"
              value={newSection}
              onChange={(e) => setNewSection(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && addFavSection()}
            />
            <button className="filter-btn" onClick={addFavSection} disabled={!newSection.trim()}>
              + 구분 추가
            </button>
            <span className="tg-ctl-hint">추가한 구분을 원하는 자리로 끌어 옮기세요</span>
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
