import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DIR = join(__dirname, "..", "data", "themeRoster");

/**
 * 테마 **구성원 명부** — 그날 어느 종목이 어느 테마였나 (2026-10-08).
 *
 * 벤티지: "네이버 테마는 네이버에서 실시간으로 해주는 거니까 그건 아주 가치가 있다고 …
 * 그게 매일매일 바꾸고 있으니까 매일매일 쌓이잖아" ·
 * "없다면 네이버 테마를 오늘부터 덮어쓰는 걸로 만드는 게 더 좋아."
 *
 * ## 무엇이 쌓이고 있었고 무엇이 아니었나
 *
 *  · **일별 테마 등락률**(`themeHistory.json`)은 **이미 쌓인다** — 날짜를 열쇠로 60일치.
 *  · **구성**(어느 종목이 어느 테마인가)은 **안 쌓였다.** `naverThemes.json` 한 파일을
 *    받을 때마다 덮어쓴다. 그래서 과거의 어느 날 그 테마에 무엇이 들어 있었는지는 알 수 없다.
 *
 * ## 왜 구성이 따로 중요한가 — **되짚기의 거짓말**
 *
 * 오늘의 구성으로 과거 수익률을 재면 **오늘 잘 나가는 종목이 그 테마에 들어 있는 채로**
 * 과거가 계산된다. 네이버는 오른 종목을 테마에 새로 넣기도 하므로, 그 테마의 과거가
 * 실제보다 좋아 보인다. 이 코드베이스가 그 병으로 한 번 데였다
 * (`dailyCloses` 주석 — 테마 강세가 −5.76%p 로 실패했다).
 *
 * 「지금 대세가 무엇인가」를 보는 데는 오늘 구성으로 충분하다. 그러나 「그때 그 테마를
 * 샀으면」을 물으려면 **그때의 구성**이 있어야 하고, 그건 오늘부터 쌓는 수밖에 없다.
 *
 * ## 담는 것 — 종목코드만
 *
 * 분류 파일은 3MB 다. 그대로 날마다 두면 1년에 750MB 다. 이름·편입 사유·시세는
 * 다른 데 있거나 다시 만들 수 있으므로 **테마 번호 → 종목코드 목록**만 담는다.
 * 하루 50KB 안팎이라 1년에 12MB 다.
 */

export interface RosterDay {
  /** YYYYMMDD (KST) */
  day: string;
  /** 시장별 — `kr` 는 네이버 테마, `us` 는 산업분류, `etf` 는 ETF 묶음 */
  markets: Record<string, Record<string, string[]>>;
}

const kstDay = (): string =>
  new Date(Date.now() + 9 * 3600_000).toISOString().slice(0, 10).replace(/-/g, "");

/**
 * 오늘치를 적는다. **하루 한 장**이라 같은 날 여러 번 불려도 덮어쓰기만 한다 —
 * 네이버가 장중에 테마를 고치면 마지막 모습이 남는다(그게 그날의 결론이다).
 */
export async function saveRoster(
  markets: Record<string, Record<string, string[]>>,
): Promise<{ day: string; themes: number; codes: number }> {
  const day = kstDay();
  let themes = 0;
  let codes = 0;
  for (const m of Object.values(markets)) {
    themes += Object.keys(m).length;
    for (const list of Object.values(m)) codes += list.length;
  }
  /* 빈 것을 적지 않는다 — 받아 오기가 실패한 날 빈 장을 남기면 그날이 「테마가 없던 날」이 된다 */
  if (themes === 0) return { day, themes: 0, codes: 0 };
  await mkdir(DIR, { recursive: true });
  const body: RosterDay = { day, markets };
  await writeFile(join(DIR, `${day}.json`), JSON.stringify(body), "utf-8");
  return { day, themes, codes };
}

/** 하루치 읽기. 없으면 null — 「그날은 안 쌓였다」와 「테마가 없었다」는 다르다 */
export async function loadRoster(day: string): Promise<RosterDay | null> {
  try {
    return JSON.parse(await readFile(join(DIR, `${day}.json`), "utf-8")) as RosterDay;
  } catch {
    return null;
  }
}

/** 쌓인 날짜들 (오래된 것부터). 화면이 「며칠치가 모였나」를 정직하게 말하는 데 쓴다 */
export async function rosterDays(): Promise<string[]> {
  try {
    return (await readdir(DIR))
      .filter((f) => /^\d{8}\.json$/.test(f))
      .map((f) => f.slice(0, 8))
      .sort();
  } catch {
    return [];
  }
}
