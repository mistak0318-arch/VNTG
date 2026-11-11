import { sharedKiwoom } from "./kiwoomShared.js";
import { noteLife } from "./lifecycle.js";

/**
 * **VKOSPI — 코스피200 변동성지수** (2026-11-12 — 벤티지: "VKOSPI 라고 알아 너? 그 지표도
 * 볼 수 있음 좋겠는데 코스피 야간선물 밑에다가").
 *
 * 한국판 VIX 다. 코스피200 **옵션 가격에 박힌 기대 변동성**을 연율로 환산한 값이라,
 * 지수가 떨어질 때 같이 오르는 게 보통이다 — 「지금 시장이 얼마나 겁먹었나」다.
 *
 * ## 받아올 데를 전수로 찾았다
 *
 *   야후    `^VKOSPI` · `VKOSPI` · `^VKS` · `^KSVKOSPI`   넷 다 404
 *   네이버  index API 는 `StockConflict` (KOSPI·KPI200 은 같은 길로 정상이다 —
 *           길이 막힌 게 아니라 **VKOSPI 가 없다**), 검색도 결과 0,
 *           옛 지수 페이지는 302 로 사라졌다
 *   KRX     공개 JSON 이 세션 쿠키를 요구하고(`LOGOUT`), 쿠키를 붙여도 응답이 안 끝난다
 *
 * **키움 업종에 있었다.** 미니PC 서버가 직접 물어 로그에 적은 답이다(로컬에서 키움
 * 토큰을 받으면 미니PC 것이 끊길 수 있어 서버에게 물었다):
 *
 *     VKOSPI 찾음 — 603 변동성지수  (업종수 001:31 · 101:34)
 *
 * 더 얄궂은 건 **우리가 이미 알고 있었다**는 것이다. `marketSnapshot.ts` 의
 * `NON_SECTOR_CODES` 에 `603` 이 「스타일」로 적혀 있다 — 섹터 분석에서 **일부러 빼던**
 * 코드다(종목이 없는 지수라 「오늘 강한 섹터 1위: 변동성지수」가 나오면 안 된다).
 * 빼 두고는 쓸 수 있다는 걸 잊었다.
 *
 * ## 조회 아끼기
 *
 * 60초 캐시. 그리고 **정규장(09:00~15:40)에만 새로 받는다** — VKOSPI 는 코스피200 옵션
 * 호가에서 나오므로 장이 닫히면 안 움직인다. 닫힌 동안 60초마다 묻는 건 키움 한도만
 * 먹는다(장중 느려짐의 단골이다).
 */

const SECT = "/api/dostk/sect";
/** 키움 업종코드 — 「603 변동성지수」. `marketSnapshot.NON_SECTOR_CODES` 와 같은 값이다 */
const VKOSPI_CODE = "603";
const TTL_MS = 60_000;

export interface VkospiQuote {
  price: number;
  change: number | null;
  changeRate: number | null;
  at: number;
}

let cache: VkospiQuote | null = null;
let at = 0;
let inflight: Promise<VkospiQuote | null> | null = null;

/**
 * **첫 결과를 한 번만 적는다** — 성공이든 실패든.
 *
 * 아래 `catch` 는 못 받은 걸 삼키고 넘어간다(줄 하나 때문에 시황이 흔들리면 안 되니까).
 * 그런데 **삼키기만 하면 「왜 줄이 없지」에 답할 길이 없다** — 이 프로젝트가 되풀이해
 * 당한 자리다. 뜨고 처음 한 번은 결과를 남겨 둔다. 매번 적으면 60초마다 로그가 는다.
 */
let noted = false;
function note(msg: string): void {
  if (noted) return;
  noted = true;
  noteLife("START", msg);
}

/** 코스피200 옵션이 도는 동안만 — KST 평일 09:00~15:40 */
function krxOpen(now = new Date()): boolean {
  const kst = new Date(now.getTime() + (9 * 60 + now.getTimezoneOffset()) * 60_000);
  const day = kst.getDay();
  if (day === 0 || day === 6) return false;
  const mins = kst.getHours() * 60 + kst.getMinutes();
  return mins >= 9 * 60 && mins <= 15 * 60 + 40;
}

/** 키움은 부호를 기호로 준다(`+`/`-`/`3`·`5`) — 숫자만 뽑고 부호는 등락률에서 가져온다 */
function num(v: unknown): number {
  const n = Number(String(v ?? "").replace(/[^0-9.-]/g, ""));
  return Number.isFinite(n) ? n : NaN;
}

export async function vkospi(): Promise<VkospiQuote | null> {
  const fresh = Date.now() - at < TTL_MS;
  /* 장이 닫혀 있으면 들고 있던 값을 그대로 — 안 움직이는 값을 60초마다 묻지 않는다 */
  if (cache && (fresh || !krxOpen())) return cache;
  if (inflight) return inflight;

  inflight = (async () => {
    try {
      const client = sharedKiwoom();
      /* 아직 안 맡겨졌으면 조용히 넘어간다 — 줄 하나 때문에 시황 전체가 흔들리면 안 된다 */
      if (!client) return cache;
      const { data } = await client.request<Record<string, unknown>>(SECT, "ka20001", {
        mrkt_tp: "0",
        inds_cd: VKOSPI_CODE,
      });
      const price = Math.abs(num(data.cur_prc));
      if (!Number.isFinite(price) || price <= 0) {
        note(`VKOSPI 값이 비었다 — cur_prc=${String(data.cur_prc)}`);
        return cache;
      }
      const rate = num(data.flu_rt);
      const change = num(data.pred_pre);
      cache = {
        price,
        /* `pred_pre` 는 부호가 기호로 와서 크기만 믿는다 — 방향은 등락률이 쥐고 있다 */
        change: Number.isFinite(change) ? (Number.isFinite(rate) && rate < 0 ? -Math.abs(change) : Math.abs(change)) : null,
        changeRate: Number.isFinite(rate) ? rate : null,
        at: Date.now(),
      };
      at = Date.now();
      note(`VKOSPI ${cache.price} (${cache.changeRate ?? "?"}%)`);
      return cache;
    } catch (e) {
      /* 못 받으면 들고 있던 값 — 없으면 줄이 안 나간다(없는 값을 있는 척하지 않는다) */
      note(`VKOSPI 실패 — ${e instanceof Error ? e.message : String(e)}`);
      return cache;
    } finally {
      inflight = null;
    }
  })();
  return inflight;
}
