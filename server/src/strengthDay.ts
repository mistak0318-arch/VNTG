import type { KiwoomClient } from "./kiwoomClient.js";

/**
 * **체결강도 — 하루치를 모아 들고 있기** (2026-10-08).
 *
 * 벤티지: "체결강도는 장 끝나고 나서는 기록이 안 되는 것 같거든. 그래서 이거 어떻게 해야 되나?
 * 아니면은 더 길게 보여주든가 해야 되는데 … 장 중에 어땠는지 알 수가 없네."
 *
 * ## 무엇이 문제였나
 *
 * 기록이 안 되는 게 아니었다. **`ka10046` 은 한 번에 60줄 — 최근 한 시간만** 준다(실측:
 * 18:03 에 부르면 17:04~18:03). 장이 끝난 뒤라 한 시간이 통째로 애프터 구간이었을 뿐이고,
 * **장중에 봤어도 「장 초반」은 애초에 안 나왔다.** 이 줄을 만든 까닭이 「장 초반엔 셌는데
 * 지금 식네」였으니 60분짜리 창으로는 쓸모가 없다.
 *
 * ## 고친 방법
 *
 * 연속조회가 **한 쪽에 한 시간씩 뒤로** 걸어간다(실측: 1쪽 17:04~18:03 → 5쪽 12:45~13:44).
 * 그래서 어떤 종목을 처음 볼 때 08:00 에 닿을 때까지 뒤로 걸어가 하루치를 만들고, 그 뒤로는
 * **맨 앞 한 쪽만** 다시 받아 덧댄다. 처음 한 번만 비싸고 그 다음부터는 조회 한 번이다.
 *
 * ⚠️ 우리가 1분마다 찍어 쌓는 길은 **버렸다.** 서버가 꺼져 있던 구간이 비기 때문이다.
 * 키움 것은 서버를 껐다 켜도 08:00 부터 온전하다 — 쌓는 것보다 걸어가서 받아오는 게 낫다.
 *
 * ## 메모리
 *
 * 10/07 에 OOM 으로 두 번 죽은 적이 있다. 종목 하나에 600~700줄이고, 많이 열어 본 날
 * 그게 쌓이면 또 봉우리가 된다. **본 지 오래된 종목부터 버린다**(LRU, 60종목). 날이 바뀌면
 * 통째로 버린다 — 어제 흐름은 이 줄이 답할 질문이 아니다.
 */

const MRKCOND = "/api/dostk/mrkcond";
/**
 * **08:00 부터 20:00 까지** — 프리장이 열리는 때부터 애프터가 닫힐 때까지가 하루다
 * (벤티지: "다 긁어올 수 있는 거면 8시부터 … 오후 8시까지").
 *
 * 한 쪽이 60분이니 12시간이면 12쪽. 체결이 없는 분은 줄이 안 와서 보통 더 적게 걷는다
 * (프리·애프터가 얇다). 14 는 그 여유분이다 — 더 걸으면 조회만 버린다.
 */
const DAY_START = "080000";
const MAX_PAGES = 14;
/** 들고 있을 종목 수 — 넘으면 본 지 오래된 것부터 버린다 */
const MAX_CODES = 60;
/** 이 안에 또 물으면 그대로 돌려준다. 1분봉이라 더 자주 받을 것이 없다 */
const FRESH_MS = 20_000;

export type StrengthRow = Record<string, unknown> & { cntr_tm?: string };

interface Day {
  day: string;
  /** HHMMSS → 줄. 같은 분이 다시 오면 **나중 것으로 덮는다** (그 분이 아직 안 끝났을 수 있다) */
  rows: Map<string, StrengthRow>;
  /** 09:00 까지 걸어가 봤는가 — 한 번만 한다 */
  walked: boolean;
  /** 마지막으로 키움에 물은 때 */
  at: number;
  /** 마지막으로 누가 본 때 (버릴 차례를 정한다) */
  seen: number;
}

const store = new Map<string, Day>();

const kstDay = () => new Date(Date.now() + 9 * 3600_000).toISOString().slice(0, 10);
const alCode = (code: string) => (/^\d{6}$/.test(code) ? `${code}_AL` : code);

function rowsOf(data: unknown): StrengthRow[] {
  const list = (data as { cntr_str_tm?: unknown })?.cntr_str_tm;
  return Array.isArray(list) ? (list as StrengthRow[]) : [];
}

function merge(d: Day, rows: StrengthRow[]): string {
  let earliest = "999999";
  for (const r of rows) {
    const t = String(r.cntr_tm ?? "");
    if (!t) continue;
    d.rows.set(t, r);
    if (t < earliest) earliest = t;
  }
  return earliest;
}

/** 오래된 종목부터 버린다 — 지금 보고 있는 것은 `seen` 이 최근이라 남는다 */
function trim() {
  if (store.size <= MAX_CODES) return;
  const old = [...store.entries()].sort((a, b) => a[1].seen - b[1].seen);
  for (const [code] of old.slice(0, store.size - MAX_CODES)) store.delete(code);
}

/**
 * 오늘 08:00(프리장) 부터 지금까지의 체결강도. **오래된 것이 앞** — 키움과 반대다.
 */
export async function strengthDay(client: KiwoomClient, code: string): Promise<StrengthRow[]> {
  const today = kstDay();
  let d = store.get(code);
  if (!d || d.day !== today) {
    d = { day: today, rows: new Map(), walked: false, at: 0, seen: 0 };
    store.set(code, d);
  }
  d.seen = Date.now();

  if (Date.now() - d.at < FRESH_MS && d.rows.size > 0) return sorted(d);

  /* 맨 앞 한 쪽은 늘 다시 받는다 — 방금 몇 분이 여기 있다. 조회 **한 번**이다 */
  const first = await client.request<Record<string, unknown>>(MRKCOND, "ka10046", { stk_cd: alCode(code) });
  d.at = Date.now();
  merge(d, rowsOf(first.data));
  trim();

  /* 하루치는 뒤에서 채운다. 줄에 이미 있으면 또 넣지 않는다 */
  if (!d.walked && !walkQueue.includes(code)) {
    walkQueue.push(code);
    void pumpWalk(client);
  }
  return sorted(d);
}

/**
 * ⚠️ **뒤로 걷기를 요청 안에서 하면 안 된다** (2026-10-10 — 벤티지: "속도는 왜 이렇게
 * 느려졌어. 시세분석 들어갈 때랑 각각 종목 눌렀을 때 더 이상해졌잖아").
 *
 * 처음엔 첫 요청이 08:00 에 닿을 때까지 **그 자리에서** 걸었다. 애프터까지 끝난 저녁이면
 * 한 종목에 열두 쪽이고, 그동안 요청 하나가 **과부하 관문의 자리까지 물고** 서 있다.
 * 10/09 밤 실측:
 *
 *   GET /api/market/strength/005930   59.6초
 *   GET /api/market/strength/034020   30.9초
 *   GET /krx/measures/005930          66.9초   ← 뒤에 밀린 애먼 요청
 *
 * 세 종목을 열면 키움 줄에 서른여섯이 서고 **그 뒤의 모든 창구가 같이 선다.** 선 하나
 * 보자고 화면 전체를 멈춰 세운 꼴이다 — 값이 비싼 게 아니라 **줄 서는 자리가 틀렸다.**
 * 「조회가 많다」와 「사람을 기다리게 한다」는 다른 문제이고, 여기서 틀린 것은 뒤쪽이다.
 *
 * 그래서 기다리게 하지 않는다. 화면은 최근 한 시간을 바로 받고, 하루치는 다음 번에 묻을 때
 * 들어온다. 걷기는 **온 서버에 한 번에 하나**만 돈다 — 종목을 연달아 눌러도 걷기가 겹쳐
 * 쌓이지 않는다. 겹쳐 쌓이는 것이 바로 지금 고치는 그 일이다.
 */
let walking = false;
const walkQueue: string[] = [];

async function walkBack(client: KiwoomClient, code: string): Promise<void> {
  const d = store.get(code);
  if (!d || d.walked) return;
  d.walked = true;
  const al = alCode(code);
  let earliest = "999999";
  for (const t of d.rows.keys()) if (t < earliest) earliest = t;
  /*
   * 맨 앞부터 다시 받는다. 이어 걸으려면 `next-key` 가 있어야 하는데 그건 받은 그 자리에서
   * 한 번 쓰고 버려지는 값이라, 앞선 요청이 들고 있던 것을 여기로 가져올 수 없다.
   * 한 쪽을 더 쓰는 대신 사람을 안 기다리게 한다.
   */
  let r = await client.request<Record<string, unknown>>(MRKCOND, "ka10046", { stk_cd: al });
  for (let page = 2; page <= MAX_PAGES; page++) {
    if (r.contYn !== "Y" || !r.nextKey) break;
    /* 08:00 에 닿았으면 그만 — 그 앞은 장전 시간외 단일가라 흐름이 아니다 */
    if (earliest <= DAY_START) break;
    r = await client.request<Record<string, unknown>>(MRKCOND, "ka10046", { stk_cd: al }, { contYn: "Y", nextKey: r.nextKey });
    const rows = rowsOf(r.data);
    if (rows.length === 0) break;
    const got = merge(d, rows);
    if (got < earliest) earliest = got;
  }
}

async function pumpWalk(client: KiwoomClient): Promise<void> {
  if (walking) return;
  walking = true;
  try {
    for (;;) {
      const code = walkQueue.shift();
      if (!code) break;
      await walkBack(client, code).catch(() => {
        /* 한 종목이 실패해도 줄은 계속 — 그 종목은 한 시간짜리로 남는다 */
      });
    }
  } finally {
    walking = false;
  }
}

function sorted(d: Day): StrengthRow[] {
  return [...d.rows.values()].sort((a, b) => String(a.cntr_tm ?? "").localeCompare(String(b.cntr_tm ?? "")));
}
