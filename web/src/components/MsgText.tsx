import { msgFlow } from "../msgFlow";

/**
 * **텔레그램 글 한 덩이를 읽을 수 있게** (2026-10-09).
 *
 * 벤티지: "텔레그램 글 읽을 때 이게 줄정리라는 게 안 돼 있어서 좀 보기가 힘든데
 * 이거 가독성 있게 개편 좀 안 되려나?" · (주요 채널 화면을 보여주며) "이쪽도 함 봐줘"
 *
 * ## 무엇을 하나
 *
 * 글은 **그대로** 둔다. 요약하지도, 다시 쓰지도, 줄을 지우지도 않는다 — 속보를 손대면
 * 그건 더 이상 속보가 아니다. 하는 일은 **줄마다 무슨 줄인지 표시를 다는 것**뿐이다.
 *
 * 우리가 모으는 방들은 생김새가 일정하다:
 *
 *   #속보 일본 정부: 지출 심사 재개…      ← 제목
 *   AI+ : 일본 정부가 공공자금을…          ← 기계 요약
 *   관련 : $JPN, $USDJPY, $JGB            ← 종목·지수
 *   #규제, #정부지출, #채권시장             ← 꼬리표
 *   2026-10-09 09:31:24                   ← 시각
 *   ✈ 빠른속보, 특파원김씨                 ← 출처
 *
 * 여섯 줄이 **같은 크기·같은 색**으로 붙어 있으면 눈이 어디부터 읽을지를 매번 고른다.
 * 제목은 굵게, 요약은 한 칸 들여, 꼬리표·시각·출처는 작고 흐리게 — 그러면 **제목만
 * 훑다가 걸리는 것만 들여다보는** 읽기가 된다. 스무 건이 쌓인 화면에서는 그게 전부다.
 *
 * ⚠️ 못 알아본 줄은 **아무 표시도 안 단다.** 규칙에 안 맞는 방이 있어도 예전 그대로
 * 보이기만 하면 된다 — 알아보기에 실패해서 글이 사라지는 일은 없어야 한다.
 */

/** 줄의 갈래 — 못 알아보면 빈 문자열(= 꾸미지 않음) */
export function kindOf(line: string, first: boolean): string {
  const t = line.trim();
  if (!t) return "";
  /* 제목 — 「#속보」로 시작하거나, 그런 머리말이 없으면 첫 줄이 제목 노릇을 한다 */
  if (/^[#[【]?\s*(속보|단독|긴급|공시)/u.test(t)) return "title";
  if (/^(AI\+?|요약)\s*[:：]/u.test(t)) return "ai";
  if (/^(관련|종목|관련종목)\s*[:：]/u.test(t)) return "rel";
  /* 꼬리표만 있는 줄 — 글 속의 해시태그 한두 개와 가르려고 「#로 시작하고 #이 둘 이상」 */
  if (/^#\S/u.test(t) && (t.match(/#/gu)?.length ?? 0) >= 2) return "tags";
  if (/^(출처\s*\|)?\s*\d{4}-\d{2}-\d{2}/u.test(t)) return "meta";
  if (/^[✈📎🔗↗]/u.test(t)) return "meta";
  return first ? "title" : "";
}

export function MsgText({ text, className = "" }: { text: string; className?: string }) {
  const lines = msgFlow(text ?? "").split("\n");
  /* 첫 「내용 있는 줄」이 어디인지 — 빈 줄로 시작하는 글이 있다 */
  const firstAt = lines.findIndex((l) => l.trim() !== "");
  return (
    <div className={`msgt ${className}`}>
      {lines.map((l, i) => {
        const k = kindOf(l, i === firstAt);
        /* 빈 줄도 그대로 둔다 — 글쓴이가 문단을 나눈 자리다 */
        if (l.trim() === "") return <div key={i} className="msgt-gap" />;
        return (
          <div key={i} className={k ? `msgt-l msgt-${k}` : "msgt-l"}>
            {l}
          </div>
        );
      })}
    </div>
  );
}
