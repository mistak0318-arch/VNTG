import { useCallback, useEffect, useState } from "react";
import { api } from "./api";
import { useDragOrder } from "./useDragOrder";

/**
 * 화면 카드 배치.
 *
 * ## 왜 끌어 옮기기가 아닌가
 *
 * 끌어 옮기기가 더 좋은 조작인 건 맞다 — 아홉 번째 카드를 두 번째로 보낼 때 한 번이면 된다.
 * 그런데 세 가지가 걸렸다.
 *
 *   1. 드래그 미리보기·드롭 표시·가장자리 자동 스크롤은 전부 전환과 프레임 콜백 위에 얹힌다.
 *      **개발 창에서 그게 동작하지 않아 확인이 안 된다.** 확인 못 한 걸 넣을 수는 없다.
 *   2. 폰·태블릿에서 드래그는 스크롤과 싸운다. 그러면 같은 「카드 순서」를 기기마다 다른
 *      방법으로 바꾸게 된다. (메뉴 순서·관심종목이 이미 화살표인 이유다)
 *   3. 어려운 건 조작이 아니라 **순서 모델**이다. 그걸 먼저 세워 두면 나중에 PC 에
 *      드래그를 얹어도 버리는 게 없다.
 *
 * 대신 **「맨 앞으로」를 같이 둔다.** 실제로 하려는 건 "이 카드를 맨 위에 두고 싶다"이지
 * "여덟 칸 앞으로"가 아니다. 여덟 번 누르게 만들면 안 된다.
 *
 * ## 순서를 어떻게 먹이나
 *
 * JSX 를 재배열하지 않는다. 카드는 격자의 자식이므로 **CSS `order`** 만 주면 자리가 바뀐다.
 * 화면 구조를 안 건드리니 카드가 다시 만들어지지 않고(차트·스크롤 위치가 살아 있다),
 * 무엇보다 **레이아웃 값이라 폭을 재서 확인할 수 있다.**
 */

/** 저장된 순서 + 코드가 아는 카드 목록 → 카드 키별 order 값 */
export function orderMap(known: string[], saved: string[]): Map<string, number> {
  const rank = new Map<string, number>();
  /*
   * 저장된 것 먼저, **모르는 것은 원래 자리대로 뒤에.**
   * 코드에 카드가 새로 생기면 저장분에 없다 — 빠뜨리면 새 기능이 화면에서 사라진다.
   */
  const ordered = [...saved.filter((k) => known.includes(k)), ...known.filter((k) => !saved.includes(k))];
  ordered.forEach((k, i) => rank.set(k, i));
  return rank;
}

/**
 * 순서가 바뀌었다는 **전역 알림** (2026-08-27).
 *
 * ⚠️ 훅이 인스턴스마다 자기 상태만 들고 있었다. 설정 화면에서 리포트 섹션 순서를
 * 바꿔도 **이미 열려 있는 리포트 탭은 그대로**였다 — 서버엔 저장됐는데 화면이 안
 * 따라오니 「적용이 안 된다」가 된다. 탭 상한을 없애 화면이 언마운트되지 않으면서
 * 더 잘 드러났다. 저장한 인스턴스가 알리고, 같은 scope 를 보는 인스턴스가 받는다.
 */
const ORDER_EVENT = "vntg:card-order";

export function useCardOrder(scope: string, known: string[]) {
  const [saved, setSaved] = useState<string[]>([]);
  const [all, setAll] = useState<Record<string, string[]>>({});

  useEffect(() => {
    let alive = true;
    const pull = () =>
      api
        .cardOrder()
        .then((o) => {
          if (!alive) return;
          setAll(o);
          setSaved(Array.isArray(o[scope]) ? o[scope] : []);
        })
        .catch(() => {
          /* 못 읽으면 코드 순서 그대로 — 카드가 사라지진 않는다 */
        });
    void pull();

    /* 다른 화면이 순서를 바꿨다 — 내 scope 면 다시 읽는다 */
    const onChanged = (e: Event) => {
      const detail = (e as CustomEvent<{ scope: string; order: string[] }>).detail;
      if (!detail || detail.scope !== scope) return;
      setSaved(detail.order);
      setAll((prev) => ({ ...prev, [detail.scope]: detail.order }));
    };
    window.addEventListener(ORDER_EVENT, onChanged);
    return () => {
      alive = false;
      window.removeEventListener(ORDER_EVENT, onChanged);
    };
  }, [scope]);

  const rank = orderMap(known, saved);
  /** 지금 보이는 차례대로의 키 목록 — 앞뒤로 옮길 때 이 배열을 다시 쓴다 */
  const current = [...known].sort((a, b) => (rank.get(a) ?? 0) - (rank.get(b) ?? 0));

  const write = useCallback(
    (next: string[]) => {
      setSaved(next);
      const merged = { ...all, [scope]: next };
      setAll(merged);
      // 같은 scope 를 보고 있는 다른 화면도 즉시 따라온다 (열려 있는 탭 포함)
      window.dispatchEvent(new CustomEvent(ORDER_EVENT, { detail: { scope, order: next } }));
      void api.cardOrderSave(merged).catch(() => {
        /* 서버에 못 올려도 이번 화면에는 적용돼 있다 */
      });
    },
    [all, scope],
  );

  /** 한 칸 앞뒤로 */
  const move = useCallback(
    (key: string, dir: -1 | 1) => {
      const i = current.indexOf(key);
      const j = i + dir;
      if (i < 0 || j < 0 || j >= current.length) return;
      const next = [...current];
      [next[i], next[j]] = [next[j], next[i]];
      write(next);
    },
    [current, write],
  );

  /** 맨 앞으로 — 여덟 번 누르게 만들지 않으려고 둔다 */
  const toFront = useCallback(
    (key: string) => {
      write([key, ...current.filter((k) => k !== key)]);
    },
    [current, write],
  );

  /** 코드에 적힌 순서로 되돌린다 */
  const reset = useCallback(() => write([]), [write]);

  /*
   * 끌어서 옮기기 (2026-08-25) — 화살표와 같은 write 로 떨어진다.
   * PC 는 끌고, 폰은 화살표 그대로. 소비처는 요소에 `{...order.drag.props(key)}` 를
   * 스프레드하고 `order.drag.cls(key)` 를 클래스에 붙이면 끝이다.
   */
  const drag = useDragOrder(current, write);

  return {
    /** 카드에 넘길 CSS order 값 */
    orderOf: (key: string) => rank.get(key) ?? 0,
    isFirst: (key: string) => current[0] === key,
    isLast: (key: string) => current[current.length - 1] === key,
    /** 코드 순서 그대로인가 — 「되돌리기」를 보여줄지 정한다 */
    customized: saved.length > 0,
    move,
    toFront,
    reset,
    drag,
  };
}
