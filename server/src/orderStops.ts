import { promises as fs } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * **계좌 자리의 손절선** (2026-09-04) — 벤티지: "그걸 복기노트에서 하면 안되지 주문메뉴의
 * 계좌에서 해야지."
 *
 * 맞다. 어제까지 손절선은 **복기 노트의 매수 기록**에만 붙었다(`tradeJournal.openPositions`).
 * 그건 「돌아보며 적는 장부」지 「지금 들고 있는 것」이 아니다. 복기 노트에 안 적은 종목은
 * 계좌에 들고 있어도 감시가 안 됐고, 주문 화면에서 산 것도 마찬가지였다.
 *
 * 손절선은 **자리에 붙어야 한다.** 그래서 종목코드 하나에 값 하나로 따로 둔다.
 *
 * ## 복기 노트의 손절선을 없애지 않는다
 *
 * 그쪽은 **R 배수의 분모**다 — 「걸었던 것 대비 얼마를 벌었나」를 내려면 그때 정한 손절선이
 * 필요하고, 그건 지금 값이 아니라 **그 매매의 기록**이다. 둘은 다른 물음의 답이라 같이 산다.
 * 감시는 둘 다 본다(`stopWatch`). 같은 종목이 양쪽에 있으면 **계좌 쪽이 이긴다** — 그게 지금 값이다.
 *
 * ## 파일 하나에 통째로
 *
 * 자리가 수십 개를 넘지 않는다. 종목당 한 줄이라 파일 하나로 충분하고, 그편이 손으로 열어
 * 고치기도 쉽다(주문 관련 파일은 사람이 직접 볼 일이 생긴다).
 */

const here = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = join(here, "..", "data");
const FILE = join(DATA_DIR, "orderStops.json");

export interface OrderStop {
  /** 손절선(원). 0 이나 없으면 감시 안 함 */
  stop: number;
  /** 적을 때의 종목명 — 화면이 이름을 못 찾을 때 쓴다 */
  name: string;
  /** 마지막으로 고친 시각 (ISO) */
  at: string;
}

type Store = Record<string, OrderStop>;

let cache: Store | null = null;

async function load(): Promise<Store> {
  if (cache) return cache;
  try {
    cache = JSON.parse(await fs.readFile(FILE, "utf8")) as Store;
  } catch {
    cache = {};
  }
  return cache;
}

export async function readOrderStops(): Promise<Store> {
  return { ...(await load()) };
}

/** 0 이하를 주면 지운다 — 「비워서 끄기」가 따로 있는 것보다 칸 하나가 낫다 */
export async function setOrderStop(code: string, stop: number, name: string): Promise<Store> {
  if (!/^\d{6}$/.test(code)) throw new Error("종목코드가 6자리가 아니다");
  const cur = await load();
  const next: Store = { ...cur };
  if (!Number.isFinite(stop) || stop <= 0) {
    delete next[code];
  } else {
    next[code] = { stop: Math.round(stop), name: name.slice(0, 40), at: new Date().toISOString() };
  }
  cache = next;
  await fs.mkdir(DATA_DIR, { recursive: true });
  await fs.writeFile(FILE, JSON.stringify(next, null, 2), "utf8");
  return { ...next };
}
