/**
 * 리포트 체크포인트 — 예측 → 결과 → 복기 루프의 첫 단계.
 *
 * 이 앱은 "내 매매 논리를 찾는 훈련 도구"인데, 훈련은 예측하고 결과를 보고 복기해야 성립한다.
 * 지금까지는 **예측만 있고 결과 대조가 없었다.** 리포트가 쌓여도 자유 텍스트라
 * 기계가 채점할 수 없고, AI에게 지난 리포트 전문을 다시 읽히면 비용과 부정확성이 같이 온다.
 *
 * 그래서 리포트를 만들 때 **채점 가능한 형태**를 같이 뽑는다.
 * 며칠 뒤 실제 등락을 붙이는 건 기계가 하고, AI는 채점표를 보고 복기만 한다.
 *
 * **주의**: 이건 예측 적중률을 재는 도구가 아니다. 맞고 틀림보다
 * "어떤 근거가 실제로 통했는가"를 남기는 게 목적이다.
 */

export type CheckKind = "stock" | "theme" | "market";
export type CheckDirection = "up" | "down" | "flat";

export interface Checkpoint {
  kind: CheckKind;
  /** 종목이면 6자리 코드, 테마면 테마명, 시장이면 KOSPI/KOSDAQ */
  key: string;
  /** 화면에 보일 이름 (종목명 등). 없으면 key 를 쓴다 */
  label: string;
  direction: CheckDirection;
  /** 왜 그렇게 봤는지 — 나중에 복기할 때 이게 핵심이다 */
  reason: string;
}

const DIRECTION_WORDS: [RegExp, CheckDirection][] = [
  [/^(상승|강세|긍정|매수우위)/, "up"],
  [/^(하락|약세|부정|매도우위)/, "down"],
  [/^(중립|보합|혼조|관망)/, "flat"],
];

const KIND_WORDS: Record<string, CheckKind> = {
  종목: "stock",
  테마: "theme",
  시장: "market",
};

/**
 * 리포트 본문에서 체크포인트를 뽑아낸다.
 *
 * 기대하는 형식 (프롬프트가 이렇게 쓰도록 지시한다):
 *   - [종목|005930|삼성전자] 상승 | 외국인 4일 연속 순매수
 *   - [테마|HBM 밸류체인] 상승 | AMAT 연동 0.57인데 오늘 덜 반영
 *   - [시장|KOSPI] 중립 | 지수는 올랐으나 상승비율 45%
 *
 * 형식이 조금 어긋나도 최대한 건지되, **방향을 못 읽으면 버린다** —
 * 방향 없는 체크포인트는 채점할 수가 없어서 남겨봐야 쓸모가 없다.
 */
export function parseCheckpoints(text: string): Checkpoint[] {
  const out: Checkpoint[] = [];
  const seen = new Set<string>();

  for (const raw of text.split("\n")) {
    const line = raw.trim().replace(/^[-*•]\s*/, "");
    const m = /^\[([^\]]+)\]\s*(.+)$/.exec(line);
    if (!m) continue;

    const parts = m[1].split("|").map((s) => s.trim());
    const kind = KIND_WORDS[parts[0]];
    if (!kind || !parts[1]) continue;

    const rest = m[2];
    // "상승 | 근거" 또는 "상승 - 근거" 또는 "상승 근거"
    const sep = /^([^|\-—]+)[|\-—]\s*(.*)$/.exec(rest);
    const dirText = (sep ? sep[1] : rest).trim();
    const reason = (sep ? sep[2] : "").trim();

    const direction = DIRECTION_WORDS.find(([re]) => re.test(dirText))?.[1];
    if (!direction) continue; // 방향을 못 읽으면 채점이 안 된다

    const key = parts[1];
    const dedup = `${kind}|${key}`;
    if (seen.has(dedup)) continue;
    seen.add(dedup);

    out.push({ kind, key, label: parts[2] || key, direction, reason });
  }
  return out.slice(0, 12);
}

/** 리포트 본문에서 체크포인트 섹션을 걷어낸다 (화면에는 표로 따로 보여주므로) */
export function stripCheckpointSection(text: string): string {
  const idx = text.indexOf("## 체크포인트");
  return idx < 0 ? text : text.slice(0, idx).trimEnd();
}

/** 프롬프트에 붙일 지시문 — 판마다 같은 형식을 쓰게 한다 */
export const CHECKPOINT_RULE = `
## 체크포인트
(**형식을 정확히 지켜라.** 나중에 실제 결과와 대조해 복기하는 데 쓰인다.
3~5개. 지금 데이터로 근거를 댈 수 있는 것만 쓰고, 확신이 없으면 적게 써라.
방향은 상승/하락/중립 중 하나. 근거는 **데이터에 있는 수치**를 인용해 한 줄로.)

- [종목|6자리코드|종목명] 방향 | 근거
- [테마|테마이름] 방향 | 근거
- [시장|KOSPI] 방향 | 근거

예:
- [종목|005930|삼성전자] 상승 | 외국인 5일 연속 순매수 +2.9조, 코스피 전기전자 주체 5/5 합의
- [테마|HBM 밸류체인] 중립 | AMAT 연동 0.57이나 오늘 기대 대비 2.3%p 더 반영돼 단기 과열
- [시장|KOSPI] 하락 | 지수 +0.9%인데 상승비율 42%로 폭이 좁음`;
