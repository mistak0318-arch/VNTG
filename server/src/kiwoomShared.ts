import type { KiwoomClient } from "./kiwoomClient.js";

/**
 * **키움 클라이언트 한 자리** (2026-11-12).
 *
 * 대부분의 모듈은 클라이언트를 인자로 받는다 — 그게 맞다. 그런데 `globalMarket` 처럼
 * **인자 없이 불리는**(`getGlobalMarket()`) 모듈이 키움 값을 하나 끼워야 할 때가 있다.
 * 야간선물은 한투라 `hantooGet` 이 모듈 전역이라 문제가 없었는데, VKOSPI 는 키움이다.
 *
 * 줄줄이 인자를 타고 내려가게 고치는 대신 **뜰 때 한 번 맡겨 둔다.** 서버에 키움
 * 클라이언트는 하나뿐이다(`index.ts` 의 `client`).
 *
 * ⚠️ 아직 안 맡겼으면 `null` 이다 — 쓰는 쪽은 **없을 때를 견뎌야 한다**(값 없이 넘어간다).
 * 여기서 던지면 기동 순서가 바뀔 때마다 서버가 안 뜬다.
 */

let shared: KiwoomClient | null = null;

export function setSharedKiwoom(c: KiwoomClient): void {
  shared = c;
}

export function sharedKiwoom(): KiwoomClient | null {
  return shared;
}
