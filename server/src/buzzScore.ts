import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * 「갑자기 커졌나」를 재는 자 — 버즈와 뉴스 키워드가 **같은 잣대**를 쓴다.
 *
 * ## 배수만 보면 왜 안 되나
 *
 * 지금까지는 `recent / baseline` 배수로 판정했다. 그런데 배수는 **표본 크기를
 * 무시한다**:
 *
 *   평소 0.5건 → 지금 2건   = 4배   (거의 우연이다)
 *   평소 10건  → 지금 40건  = 4배   (분명한 사건이다)
 *
 * 둘을 같은 4배로 취급하면, 문턱을 낮추면 잔챙이가 쏟아지고 높이면 진짜를 놓친다.
 * 그래서 손으로 「6건 이상 **그리고** 3배 이상, 또는 3건 이상 **그리고** 8배 이상」
 * 같은 규칙을 덧대게 되는데, 이건 값 네 개를 눈대중으로 맞추는 일이라 늘 어정쩡하다.
 *
 * ## 대신 「얼마나 뜻밖인가」를 잰다
 *
 * 드문 사건의 건수는 푸아송 분포를 따른다. 평균이 λ면 표준편차는 √λ 다. 그러면
 * **평균에서 몇 표준편차나 벗어났는지**가 곧 뜻밖의 정도다:
 *
 *     z = (지금 − 평소) / √(평소 + 1)
 *
 * `+1` 은 평소가 0 에 가까울 때 분모가 0 으로 무너지는 것을 막는 완충이다.
 * 이 하나로 위의 두 경우가 제대로 갈린다:
 *
 *   0.5 → 2건 :  z = 1.5 / √1.5  = 1.22   (약하다)
 *   10  → 40건:  z = 30  / √11   = 9.05   (강하다)
 *
 * 그리고 예전 규칙 둘이 **거의 같은 z 에서 갈린다**는 것도 확인했다 —
 * 「6건·3배」는 z≈2.31, 「3건·8배」는 z≈2.24. 즉 그 두 규칙은 사실 **하나의 값을
 * 서툴게 근사한 것**이었다. 이제 값 하나(zMin≈2.2)로 둘을 대신한다.
 *
 * 덤으로 예전 규칙이 놓치던 것도 잡힌다: 평소 20건이 40건이 된 경우(2배)는
 * 배수 문턱 3배에 걸려 탈락했지만 z=4.4 로 분명한 사건이다.
 *
 * ## 몇 군데서 나왔나 — 출처가 갈릴수록 진짜다
 *
 * 한 방(또는 한 언론사)이 같은 말을 열 번 한 것과 **열 곳이 한 번씩** 한 것은
 * 완전히 다르다. 앞은 그곳의 버릇이고 뒤는 시장의 화제다. 그래서 z 에 출처
 * 다양성을 곱한다 — 한 곳이면 절반으로 깎고, 세 곳 이상이면 온전히 준다.
 */

const here = dirname(fileURLToPath(import.meta.url));
const FILE = join(here, "..", "data", "buzzConfig.json");

export interface BuzzConfig {
  /** 몇 표준편차부터 「급증」으로 볼지. 낮추면 많이 잡히고 높이면 확실한 것만 */
  zMin: number;
  /** 아무리 뜻밖이어도 이 건수 미만이면 안 울린다 — 1~2건은 아직 흐름이 아니다 */
  minCount: number;
  /** 출처가 이만큼 갈려야 온전한 점수. 1로 두면 다양성을 안 본다 */
  fullSources: number;
  /** 한 곳에서만 나온 것에 줄 가중치(0~1). 0.5면 절반으로 깎는다 */
  singleSourcePenalty: number;
  /** 버즈 판정 창(시간) */
  buzzWindowHours: number;
  /** 며칠치를 「평소」로 볼지 */
  baselineDays: number;
  /** 시간대 보정을 쓸지 — 끄면 하루 내내 고르다고 가정한다 */
  timeOfDay: boolean;
}

export const DEFAULTS: BuzzConfig = {
  /* 2.2 — 예전 규칙 둘(6건·3배 = z2.31, 3건·8배 = z2.24)이 갈리던 지점 */
  zMin: 2.2,
  minCount: 3,
  fullSources: 3,
  singleSourcePenalty: 0.5,
  buzzWindowHours: 12,
  baselineDays: 7,
  timeOfDay: true,
};

let cache: BuzzConfig | null = null;

export async function getBuzzConfig(): Promise<BuzzConfig> {
  if (cache) return cache;
  try {
    cache = { ...DEFAULTS, ...(JSON.parse(await readFile(FILE, "utf-8")) as Partial<BuzzConfig>) };
  } catch {
    cache = { ...DEFAULTS };
  }
  return cache;
}

export async function saveBuzzConfig(patch: Partial<BuzzConfig>): Promise<BuzzConfig> {
  const cur = await getBuzzConfig();
  const next: BuzzConfig = {
    ...cur,
    /* 범위를 여기서 조인다 — 화면이 뭘 보내든 말이 되는 값만 저장한다 */
    zMin: clamp(patch.zMin ?? cur.zMin, 0.5, 8),
    minCount: Math.round(clamp(patch.minCount ?? cur.minCount, 1, 50)),
    fullSources: Math.round(clamp(patch.fullSources ?? cur.fullSources, 1, 10)),
    singleSourcePenalty: clamp(patch.singleSourcePenalty ?? cur.singleSourcePenalty, 0.1, 1),
    buzzWindowHours: Math.round(clamp(patch.buzzWindowHours ?? cur.buzzWindowHours, 1, 48)),
    baselineDays: Math.round(clamp(patch.baselineDays ?? cur.baselineDays, 2, 30)),
    timeOfDay: patch.timeOfDay ?? cur.timeOfDay,
  };
  cache = next;
  await mkdir(dirname(FILE), { recursive: true });
  await writeFile(FILE, JSON.stringify(next, null, 2), "utf-8");
  return next;
}

function clamp(v: number, lo: number, hi: number): number {
  return Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : lo;
}

/**
 * 뜻밖의 정도.
 *
 * `+1` 완충이 핵심이다 — 이게 없으면 평소 0.01건짜리가 1건만 나와도 z 가 10 을
 * 넘어 화면이 잔챙이로 덮인다.
 */
export function zScore(recent: number, baseline: number): number {
  return (recent - baseline) / Math.sqrt(baseline + 1);
}

/** 출처 다양성 가중 — 한 곳이면 깎고 여러 곳이면 온전히 */
export function sourceWeight(sources: number, cfg: BuzzConfig): number {
  if (sources <= 0) return 1; // 출처를 모르는 옛 기록은 깎지 않는다(모른다 ≠ 하나다)
  const t = Math.min(1, sources / Math.max(1, cfg.fullSources));
  return cfg.singleSourcePenalty + (1 - cfg.singleSourcePenalty) * t;
}

/** 화면 정렬과 알림 판정에 함께 쓰는 최종 점수 */
export function buzzPoints(
  recent: number,
  baseline: number,
  sources: number,
  cfg: BuzzConfig,
): { z: number; score: number; alert: boolean } {
  const z = zScore(recent, baseline);
  const score = z * sourceWeight(sources, cfg);
  return { z, score, alert: recent >= cfg.minCount && score >= cfg.zMin };
}
