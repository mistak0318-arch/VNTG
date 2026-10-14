import { useCallback, useEffect, useState } from "react";
import { api } from "./api";

/**
 * **어느 탭이 윗줄이고 어느 탭이 아랫줄인가** — 순서와 **따로** 저장한다 (2026-10-14).
 *
 * 벤티지: "크기가 넓어지거나 줄어들면 위아래 메뉴가 위에 갔다 아래로 갔다 하는데,
 * 위쪽 아래쪽에 배치한 건 고정으로 하자. 어느 메뉴가 디바이스에 따라 위아래로 가면
 * 헷갈리니깐. 위쪽에 많으면 가로로 내가 스크롤해서 보면 되는 거니깐."
 *
 * ## 왜 「반으로 나누기」로는 안 되나
 *
 * 여태 줄은 **순서의 앞 절반·뒤 절반**이었다. 그러면 줄이 제 값이 아니라 **다른 것의
 * 그림자**다 — 탭 하나를 앞으로 옮기면 경계에 걸린 다른 탭이 밀려 내려가고, ETF 라서
 * 탭 몇 개가 빠지면 경계 자체가 움직인다. 「내가 위에 둔 것」이 내가 안 건드렸는데
 * 아래로 가 있으면, 손이 외운 자리가 매번 어긋난다.
 *
 * 줄을 **제 값으로** 저장한다. 아랫줄에 둘 키 목록 하나다. 한 번 정하면 폭이 바뀌든
 * 탭이 늘든 그 자리다. 윗줄이 넘치면 가로로 민다 — 벤티지가 그렇게 하자고 했다.
 *
 * ## 저장은 탭 순서와 같은 창고를 쓴다
 *
 * `api.cardOrder()` 는 `{ scope: string[] }` 한 덩이라, 여기에 칸 하나를 더 쓰면
 * **서버·동기화·다른 기기까지 그대로 따라온다**. 다만 `useCardOrder` 를 그대로 못 쓴다 —
 * 그쪽은 「아는 키 전부를 정렬」하는 물건이고, 여기 필요한 것은 **부분집합**이다.
 *
 * ⚠️ 저장된 값에 지금 없는 키가 섞여 있어도 지우지 않는다. ETF 라서 숨은 탭이 나중에
 * 다시 보일 수 있는데, 그때 제자리로 돌아와야 한다.
 */
const EVENT = "vntg:tab-rows";

export interface TabRows {
  /** 이 탭이 아랫줄인가 */
  isBottom: (key: string) => boolean;
  /** 아랫줄 여부를 정한다 */
  set: (key: string, bottom: boolean) => void;
  /** `target` 과 같은 줄로 옮긴다 — 끌어 놓기가 쓴다 */
  moveTo: (key: string, target: string) => void;
  /** 위↔아래 뒤집기 — 「탭 순서」 편집의 ▲▼ 가 쓴다 */
  toggle: (key: string) => void;
}

export function useTabRows(scope: string, defaultBottom: string[]): TabRows {
  /** null = 아직 안 읽음 → 그동안은 기본값을 쓴다 */
  const [bottom, setBottom] = useState<string[] | null>(null);
  const [all, setAll] = useState<Record<string, string[]>>({});

  useEffect(() => {
    let alive = true;
    api
      .cardOrder()
      .then((o) => {
        if (!alive) return;
        setAll(o);
        setBottom(Array.isArray(o[scope]) ? o[scope] : null);
      })
      .catch(() => {
        /* 못 읽으면 기본값 — 줄이 사라지지는 않는다 */
      });
    const onChanged = (e: Event) => {
      const d = (e as CustomEvent<{ scope: string; keys: string[] }>).detail;
      if (!d || d.scope !== scope) return;
      setBottom(d.keys);
    };
    window.addEventListener(EVENT, onChanged);
    return () => {
      alive = false;
      window.removeEventListener(EVENT, onChanged);
    };
  }, [scope]);

  const list = bottom ?? defaultBottom;

  const write = useCallback(
    (next: string[]) => {
      setBottom(next);
      const merged = { ...all, [scope]: next };
      setAll(merged);
      window.dispatchEvent(new CustomEvent(EVENT, { detail: { scope, keys: next } }));
      /* 제 칸만 보낸다 — 서버가 합친다(`cardOrder.ts`). 통째로 보내면 남의 칸을 지운다 */
      void api.cardOrderSave({ [scope]: next }).catch(() => {
        /* 서버에 못 올려도 이번 화면에는 적용돼 있다 */
      });
    },
    [all, scope],
  );

  const isBottom = useCallback((key: string) => list.includes(key), [list]);

  const set = useCallback(
    (key: string, toBottom: boolean) => {
      const has = list.includes(key);
      if (has === toBottom) return;
      write(toBottom ? [...list, key] : list.filter((k) => k !== key));
    },
    [list, write],
  );

  return {
    isBottom,
    set,
    moveTo: (key, target) => set(key, list.includes(target)),
    toggle: (key) => set(key, !list.includes(key)),
  };
}
