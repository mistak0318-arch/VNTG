import { useCallback, useEffect, useRef, useState, type KeyboardEvent } from "react";

/**
 * **후보 목록을 방향키로 오르내리고 엔터로 고른다** (2026-09-08).
 *
 * 벤티지: "종목 찾는 메뉴에서 이렇게 하단에 나오잖아. 이때 내가 방향키로 아래로 위로 해서
 * 엔터로 선택하고 싶은데 그게 안 되더라고." → "비슷한 건들 검토해서 전체적으로 적용되게 해줘."
 *
 * 검색칸이 앱 안에 열여덟 군데 있는데, 엔터가 붙은 곳조차 **무조건 첫 후보**를 골랐고
 * 방향키로 짚어 내려가는 자리는 한 군데도 없었다. 각자 짜면 또 열여덟 갈래로 갈리므로
 * 여기 하나로 둔다.
 *
 * ## 쓰는 법
 *
 * ```tsx
 * const keys = useListKeys(results, (r) => pick(r), { onEscape: () => setOpen(false) });
 * <input {...keys.inputProps} value={q} onChange={...} />
 * {results.map((r, i) => (
 *   <button key={r.code} {...keys.itemProps(i)} onClick={() => pick(r)}>…</button>
 * ))}
 * ```
 *
 * ## 정한 것들
 *
 *   · **아무것도 안 짚은 상태(-1)에서 시작한다.** 첫 후보를 미리 칠해 두면 엔터를 누를 때
 *     「내가 고른 것」과 「그냥 첫 줄」이 구별이 안 된다. ↓ 를 한 번 눌러야 첫 줄이 잡힌다.
 *   · 다만 **엔터는 아무것도 안 짚었어도 첫 후보를 고른다** — 이미 그렇게 동작하던 자리가
 *     있었고, 「치고 엔터」가 제일 흔한 손버릇이다.
 *   · 목록이 바뀌면 짚은 자리를 **0 이 아니라 -1 로** 되돌린다. 글자를 더 치는 동안 커서가
 *     엉뚱한 줄에 남아 있으면 엔터가 사고가 된다.
 *   · ↑↓ 는 **끝에서 돈다**(맨 아래에서 ↓ 하면 맨 위로). 목록이 짧아서 도는 편이 빠르다.
 *   · Home/End·PageUp/PageDown 도 받는다. 손이 익은 사람은 이걸 먼저 누른다.
 *   · 짚은 줄은 `scrollIntoView({ block: "nearest" })` 로 따라간다 — 목록이 스크롤될 때
 *     짚은 줄이 화면 밖에 있으면 방향키가 먹통처럼 느껴진다.
 *   · **한글 조합 중(IME)에는 엔터를 먹지 않는다.** 「삼성」을 치다 확정하려고 누른 엔터가
 *     종목 선택으로 새면 안 된다 — `isComposing` 으로 가린다.
 */
export interface ListKeys {
  /** 지금 짚은 자리. -1 이면 아무것도 안 짚음 */
  active: number;
  setActive: (i: number) => void;
  /** 검색칸에 펼친다 — onKeyDown 과 접근성 속성 */
  inputProps: {
    onKeyDown: (e: KeyboardEvent<HTMLInputElement>) => void;
    role: "combobox";
    "aria-expanded": boolean;
    "aria-activedescendant": string | undefined;
    autoComplete: "off";
  };
  /** 후보 한 줄에 펼친다 */
  itemProps: (i: number) => {
    ref: (el: HTMLElement | null) => void;
    className: string;
    id: string;
    role: "option";
    "aria-selected": boolean;
    onMouseEnter: () => void;
  };
  /** 목록을 다시 그릴 때 짚은 자리를 지우고 싶으면 */
  reset: () => void;
}

let seq = 0;

export function useListKeys<T>(
  items: readonly T[] | null | undefined,
  onPick: (item: T, index: number) => void,
  opts: {
    /** Escape 를 눌렀을 때. 없으면 짚은 자리만 지운다 */
    onEscape?: () => void;
    /** 짚은 줄에 붙일 클래스. 기본 `on` */
    activeClass?: string;
    /** 후보 줄의 기본 클래스 — `itemProps` 가 합쳐서 돌려준다 */
    itemClass?: string;
    /** 아무것도 안 짚었을 때 엔터로 첫 후보를 고를지. 기본 true */
    enterPicksFirst?: boolean;
  } = {},
): ListKeys {
  const { onEscape, activeClass = "on", itemClass = "", enterPicksFirst = true } = opts;
  const list = items ?? [];
  const n = list.length;
  const [active, setActive] = useState(-1);
  const els = useRef<(HTMLElement | null)[]>([]);
  const idBase = useRef<string>("");
  if (!idBase.current) idBase.current = `lk${++seq}`;

  /* 목록이 바뀌면 짚은 자리를 지운다 — 남아 있으면 엔터가 엉뚱한 줄을 고른다 */
  const sig = `${n}:${String((list[0] as { code?: string; term?: string; symbol?: string } | undefined)?.code ?? (list[0] as { symbol?: string } | undefined)?.symbol ?? "")}`;
  const lastSig = useRef(sig);
  useEffect(() => {
    if (lastSig.current !== sig) {
      lastSig.current = sig;
      setActive(-1);
    }
  }, [sig]);

  /* 짚은 줄을 보이는 자리로 */
  useEffect(() => {
    if (active < 0) return;
    els.current[active]?.scrollIntoView({ block: "nearest" });
  }, [active]);

  const move = useCallback(
    (delta: number) => {
      if (n === 0) return;
      setActive((cur) => {
        if (cur < 0) return delta > 0 ? 0 : n - 1;
        return ((cur + delta) % n + n) % n;
      });
    },
    [n],
  );

  const onKeyDown = useCallback(
    (e: KeyboardEvent<HTMLInputElement>) => {
      /* 한글 조합 중의 엔터는 글자 확정이지 선택이 아니다 */
      const composing = e.nativeEvent.isComposing || e.keyCode === 229;
      switch (e.key) {
        case "ArrowDown":
          e.preventDefault();
          move(1);
          return;
        case "ArrowUp":
          e.preventDefault();
          move(-1);
          return;
        case "PageDown":
          if (n === 0) return;
          e.preventDefault();
          setActive((c) => Math.min(n - 1, (c < 0 ? 0 : c) + 5));
          return;
        case "PageUp":
          if (n === 0) return;
          e.preventDefault();
          setActive((c) => Math.max(0, (c < 0 ? 0 : c) - 5));
          return;
        case "Home":
          if (n === 0) return;
          e.preventDefault();
          setActive(0);
          return;
        case "End":
          if (n === 0) return;
          e.preventDefault();
          setActive(n - 1);
          return;
        case "Enter": {
          if (composing) return;
          const i = active >= 0 ? active : enterPicksFirst ? 0 : -1;
          if (i < 0 || i >= n) return;
          e.preventDefault();
          setActive(-1);
          onPick(list[i], i);
          return;
        }
        case "Escape":
          e.preventDefault();
          setActive(-1);
          onEscape?.();
          return;
        default:
      }
    },
    [active, enterPicksFirst, list, move, n, onEscape, onPick],
  );

  const itemProps = useCallback(
    (i: number) => ({
      ref: (el: HTMLElement | null) => {
        els.current[i] = el;
      },
      className: `${itemClass}${i === active ? ` ${activeClass}` : ""}`.trim(),
      id: `${idBase.current}-${i}`,
      role: "option" as const,
      "aria-selected": i === active,
      /* 마우스를 올리면 그 줄이 짚인다 — 키보드와 마우스가 서로 다른 줄을 칠하면 헷갈린다 */
      onMouseEnter: () => setActive(i),
    }),
    [active, activeClass, itemClass],
  );

  return {
    active,
    setActive,
    inputProps: {
      onKeyDown,
      role: "combobox",
      "aria-expanded": n > 0,
      "aria-activedescendant": active >= 0 ? `${idBase.current}-${active}` : undefined,
      autoComplete: "off",
    },
    itemProps,
    reset: () => setActive(-1),
  };
}
