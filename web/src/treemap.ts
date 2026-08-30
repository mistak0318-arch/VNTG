/**
 * 트리맵 배치 (squarified) — **크기가 뜻을 가지는 지도** (2026-08-30 요청).
 *
 * ## 왜 필요한가
 *
 * 지금까지 MAP 은 타일이 전부 같은 크기였다. 그러면 「+7% 짜리 손톱만한 테마」와
 * 「+7% 짜리 시장의 기둥」이 똑같이 그려져서, **어느 쪽이 시장을 실제로 움직이는지**
 * 알 수 없다. 네이버 HOT 테마가 시가총액으로 크기를 주는 이유가 그것이다.
 *
 * ## 왜 「제곱화(squarified)」인가
 *
 * 값 순서대로 잘라 넣으면(slice-and-dice) 작은 것들이 **머리카락처럼 가늘고 긴 띠**가
 * 되어 이름이 안 들어간다. 제곱화는 각 줄에 넣을 개수를 정할 때 **가장 못생긴
 * 타일의 종횡비**를 보고, 그게 나빠지기 시작하면 줄을 끊는다. 결과가 정사각형에
 * 가까워져 글자가 들어간다.
 *
 * Bruls·Huizing·van Wijk (2000) 의 알고리즘이다. 40줄이면 되므로 의존성을 넣지 않는다.
 */

export interface TreemapItem<T> {
  /** 넓이의 근거 — 시가총액이든 거래대금이든. 0 이하는 부르는 쪽이 걸러 준다 */
  weight: number;
  data: T;
}

export interface TreemapRect<T> {
  data: T;
  /** 0~100 (%) — 부모 상자 안의 위치. CSS 로 그대로 쓴다 */
  x: number;
  y: number;
  w: number;
  h: number;
}

/** 이 줄에 넣었을 때 가장 못생긴 타일의 종횡비. 1 에 가까울수록 좋다 */
function worstRatio(row: number[], side: number, scale: number): number {
  if (row.length === 0) return Infinity;
  const sum = row.reduce((a, b) => a + b, 0) * scale;
  const max = Math.max(...row) * scale;
  const min = Math.min(...row) * scale;
  const s2 = sum * sum;
  const w2 = side * side;
  return Math.max((w2 * max) / s2, s2 / (w2 * min));
}

/**
 * 상자 하나를 채운다.
 *
 * 큰 것부터 넣어야 제곱화가 뜻대로 동작한다 — 작은 것부터 넣으면 큰 것이 마지막에
 * 남은 좁은 자리로 밀려 납작해진다.
 */
export function treemap<T>(items: TreemapItem<T>[], aspect = 1.9): TreemapRect<T>[] {
  const list = items.filter((i) => i.weight > 0).sort((a, b) => b.weight - a.weight);
  if (list.length === 0) return [];

  /* 100 × (100/aspect) 짜리 상자에서 계산하고 마지막에 % 로 되돌린다 */
  const W = 100;
  const H = 100 / aspect;
  const totalWeight = list.reduce((a, b) => a + b.weight, 0);
  const scale = (W * H) / totalWeight;

  const out: TreemapRect<T>[] = [];
  let x = 0;
  let y = 0;
  let w = W;
  let h = H;

  let i = 0;
  while (i < list.length) {
    const vertical = w >= h; // 짧은 쪽을 따라 줄을 세운다
    const side = vertical ? h : w;
    const row: number[] = [];
    const rowItems: TreemapItem<T>[] = [];

    /* 종횡비가 나빠지기 시작하면 그 앞에서 끊는다 */
    while (i < list.length) {
      const next = [...row, list[i].weight];
      if (row.length > 0 && worstRatio(next, side, scale) > worstRatio(row, side, scale)) break;
      row.push(list[i].weight);
      rowItems.push(list[i]);
      i += 1;
    }

    const rowSum = row.reduce((a, b) => a + b, 0) * scale;
    const thick = side > 0 ? rowSum / side : 0;

    let off = 0;
    for (let k = 0; k < rowItems.length; k += 1) {
      const len = side > 0 ? (row[k] * scale) / thick : 0;
      out.push(
        vertical
          ? { data: rowItems[k].data, x, y: y + off, w: thick, h: len }
          : { data: rowItems[k].data, x: x + off, y, w: len, h: thick },
      );
      off += len;
    }

    if (vertical) {
      x += thick;
      w -= thick;
    } else {
      y += thick;
      h -= thick;
    }
    /* 남은 자리가 없으면 끝 — 반올림 오차로 음수가 되는 것을 막는다 */
    if (w <= 0.01 || h <= 0.01) break;
  }

  /* 세로는 H 기준이었으므로 100 기준 % 로 되돌린다 */
  return out.map((r) => ({
    ...r,
    y: (r.y / H) * 100,
    h: (r.h / H) * 100,
  }));
}
