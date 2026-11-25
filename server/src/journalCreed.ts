import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * **#매일읽기 — 내 원칙** (2026-11-25).
 *
 * 벤티지의 업노트 복기 노트 맨 아래에는 늘 이게 붙어 있었다:
 *
 *     #매일읽기  JM의 실전 투자 원칙 (2025 Ver.) !!! 하루에 한 번씩 읽는다 !!!
 *     #매일읽기  [매수전략]
 *     #매일읽기  [매도전략]
 *
 * ## 왜 가이드 메뉴가 아니라 복기 노트 안인가
 *
 * 우리 앱은 이런 글을 「가이드」 메뉴로 빼 놨다. 그런데 **따로 있으면 안 읽는다** —
 * 벤티지의 노트에서 이건 복기의 **일부**였다. 매매를 돌아보는 바로 그 자리에서
 * 원칙을 다시 읽어야 「오늘 이걸 지켰나」가 이어진다.
 *
 * ## 고칠 수 있어야 한다
 *
 * 원칙은 바뀐다(업노트 제목부터 「2025 Ver.」이다). 코드에 박아 두면 바뀔 때마다
 * 배포해야 하므로 **파일로 둔다.** 기본값은 업노트에 적혀 있던 것을 그대로 옮겼다 —
 * 내가 지어낸 문장이 하나도 없다.
 */

const here = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = join(here, "..", "data");
const FILE = join(DATA_DIR, "journalCreed.json");

export interface JournalCreed {
  /** 마크다운에 가까운 평문. 화면은 줄바꿈만 살려 그린다 */
  text: string;
  updatedAt: string;
}

/** 업노트에 적혀 있던 그대로 — 고치는 것은 벤티지 몫이다 */
const DEFAULT_TEXT = `[목표] 몰빵 투자의 도파민을 끊고, '잃지 않는 시스템'으로 안정적인 현금 흐름 창출

■ 실전 투자 원칙
1. 자금 운용 (비중) — 한 종목당 투자금은 1억~2억 원 사이로 유지. 원활한 매매(호가 소화)와 리스크 통제가 가능한 최적의 규모.
2. 포트폴리오 (분산) — 보유 종목은 최대 3개까지만. 각 종목의 섹터는 겹치지 않게 (예: 반도체 + 바이오 + 음식료).
3. 수익 실현 (익절) — 수익률 10~20%(수익금 1~2천만 원) 도달 시 미련 없이 매도. 상승 후 조정이 오는 법칙을 기억하고 다음 타자(종목)로 교체 매매.
4. 리스크 관리 (대응) — 수급 주체(외국인, 기관) 중 하나라도 이탈하거나 흔들리면 비중의 30~50% 즉시 매도. 예측이 틀렸을 때는 감정을 배제하고 기계적으로 대응.

■ 매수전략
1. 시장에서 주목하는 테마군 (거래대금 500억 이상, 코스피 거래대금 상위 50위 안에 있는 테마군)
2. 외국인/연기금/사모펀드/투자신탁 10일간 매수, 20일간 매수가 플러스 구간일 것
   · 수급 요건: 외국인 또는 기관 중 최소 한 주체의 10~20일 주도적 매수 우위 + 반대 주체의 대규모 매도 폭탄(수급 이탈) 부재
3. 차트는 정배열이고, 최근 거래량이 늘어나면서 상승추세에 있는 차트일 것
4. 공매도, 대차거래가 감소하고 있거나, 크게 늘어나지 않고 있는 종목일 것
5. 매출이 증가세에 있고, 향후 매출이 늘어날 수 있는 종목일 것
6. 급하게 오른 종목의 경우 최근 1년간 200% 상승의 여지가 있는지 체크할 것 (투자주의 종목으로 지정될 가능성. 급락이 연출되어 큰 손실이 발생할 수 있음)

■ 매도전략
1. 외국인/연기금/사모펀드 수급이 단 한 주체라도 흔들리려고 하는 경우 50% 이상 매도하고 대기 (단, 강력한 호재가 지속 중일 때는 예외로 하고 홀딩)
2. 같은 테마군의 종목들이 약세로 가는 경우 해당 종목도 테마군의 움직임에 영향을 받을 수 있으므로 매도 50% 이상 준비할 것
3. 차트가 꺾이거나, 공매도/대차거래가 눈에 띄게 증가하는 경우 50% 이상 매도할 것
4. 최근 상승을 체크해서 1년 내 200% 상승의 가능성이 있는지 체크할 것. 투자주의 종목으로 지정되기 전에 매도해야 함
5. VI(변동성 완화장치) 걸리거나 +10% 넘어가면, 이유 불문하고 물량의 50%는 시장가로 던진다. (머리를 보고 어깨에서 판다)
6. -3% 도달 시 50% 매도, -4% 도달 시 전량 매도 (자동주문 걸어놓기)`;

export async function getCreed(): Promise<JournalCreed> {
  try {
    const parsed = JSON.parse(await readFile(FILE, "utf-8")) as Partial<JournalCreed>;
    if (typeof parsed.text === "string" && parsed.text.trim().length > 0) {
      return { text: parsed.text, updatedAt: parsed.updatedAt ?? "" };
    }
  } catch {
    /* 아직 없으면 기본값 — 처음 여는 날에도 읽을 것이 있어야 한다 */
  }
  return { text: DEFAULT_TEXT, updatedAt: "" };
}

export async function setCreed(text: string): Promise<JournalCreed> {
  const next: JournalCreed = { text: String(text ?? "").slice(0, 20_000), updatedAt: new Date().toISOString() };
  await mkdir(DATA_DIR, { recursive: true });
  await writeFile(FILE, JSON.stringify(next, null, 2), "utf-8");
  return next;
}
