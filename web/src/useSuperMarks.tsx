import { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react";
import { api } from "./api";

/**
 * 슈퍼신호등 표식 — **어느 화면에서든 같은 종목에 같은 표시가 뜨게** (2026-08-31).
 *
 * 벤티지 요청: "심볼 달린애들은 어디 어느 메뉴에서 봐도 그 심볼 보이게 고쳐줄래?
 * 그래야 내가 여기저기 보다가 아 역시 신호등에 걸린애들이 여기있구나, 아 무지개까지
 * 달린애가 이런데 있네 이렇게 알 수 있짢아."
 *
 * ## 왜 Context 인가
 *
 * 화면마다 `/api/signal/super` 를 부르면 표 하나 그릴 때마다 원장을 통째로 받는다.
 * 관심종목 별표(`useWatchedCodes`)가 이미 같은 문제를 Context 로 풀었으므로
 * **같은 문법**을 쓴다 — 한 번 받아 모두가 나눠 본다.
 *
 * ## 표식의 뜻
 *
 *   🌈 무지개  사흘 이상 계속 교집합에 걸린 활성 종목. 지속성이 성적을 가른
 *              유일한 축이라 거기에 등급을 뒀다(서버 RAINBOW_DAYS 주석 참고).
 *   🌟 슈퍼    지금 추적 중인 슈퍼신호등 종목.
 *   ⚡ 교차    맥박 교차 그룹에서만 온 종목(슈퍼 원장은 아니다).
 *
 * ⚠️ **이탈한 종목에는 안 붙인다.** 표식은 「지금 그런가」를 말하는 것이지
 * 「그런 적 있다」가 아니다 — 이력은 슈퍼신호등 대시보드가 들고 있다.
 */

export type SuperMark = "super" | "cross" | "rainbow";

interface MarksValue {
  /** 이 종목이 가진 표식 **전부** — 겹치는 것이 곧 정보다 */
  marksOf: (code: string) => SuperMark[];
  /** 몇 종목이 표식을 갖고 있나 — 화면이 「아직 안 받았다」를 구분할 때 */
  size: number;
  reload: () => void;
}

const MarksContext = createContext<MarksValue | null>(null);

/**
 * 5분마다 다시 받는다. 편입·이탈은 하루 한 번(15:45)이라 더 자주 볼 이유가 없고,
 * 그렇다고 안 갱신하면 그날 편입분이 밤새 안 보인다.
 */
const TTL_MS = 5 * 60_000;

export function SuperMarksProvider({ children }: { children: React.ReactNode }) {
  const [marks, setMarks] = useState<Map<string, SuperMark[]>>(new Map());

  const load = useCallback(() => {
    api
      .signalSuper()
      .then((r) => {
        const m = new Map<string, SuperMark[]>();
        for (const e of r.entries ?? []) {
          /* 이탈한 것은 표식이 없다 — 「지금 그런가」를 말하는 표시다 */
          if (e.active === false) continue;
          const tags = e.groupTags ?? [];
          /*
           * **겹쳐서 단다** (2026-08-31 — "슈퍼신호등 + 교차 + 무지개 까지
           * 있으면 더 좋은 애라고 볼수있고").
           *
           * 셋 중 하나만 고르면 그 겹침이 사라진다. 🌟⚡🌈 가 나란히 붙은 종목은
           * **세 관점이 동시에 가리키고 사흘째 유지되는** 것이라, 그 사실 자체가
           * 이 표식 체계에서 제일 강한 신호다.
           *
           * 순서는 넓은 것에서 좁은 것으로 — 🌟(원장) ⚡(교차) 🌈(지속성).
           * 순서를 고정해야 여러 화면에서 같은 모양으로 읽힌다.
           */
          const list: SuperMark[] = [];
          if (tags.length === 0 || tags.includes("super")) list.push("super");
          if (tags.includes("cross")) list.push("cross");
          if (e.rainbow) list.push("rainbow");
          if (list.length > 0) m.set(e.code, list);
        }
        setMarks(m);
      })
      .catch(() => {
        /* 못 받으면 표식만 없다 — 화면은 그대로 뜬다 */
      });
  }, []);

  useEffect(() => {
    load();
    const t = window.setInterval(load, TTL_MS);
    return () => window.clearInterval(t);
  }, [load]);

  const value = useMemo<MarksValue>(
    () => ({ marksOf: (code) => marks.get(code) ?? [], size: marks.size, reload: load }),
    [marks, load],
  );
  return <MarksContext.Provider value={value}>{children}</MarksContext.Provider>;
}

export function useSuperMarks(): MarksValue {
  const ctx = useContext(MarksContext);
  /*
   * Provider 밖에서도 **터지지 않는다.** 이 표식은 곁들이는 정보라, 없다고 해서
   * 화면이 못 뜨면 안 된다 — 별표(useWatchedCodes)는 없으면 던지지만 그건 그
   * 화면의 본체이기 때문이다. 여기는 다르다.
   */
  return ctx ?? { marksOf: () => [], size: 0, reload: () => undefined };
}

const LABEL: Record<SuperMark, { icon: string; short: string; title: string }> = {
  super: {
    icon: "🌟",
    short: "슈퍼신호등",
    title: "슈퍼신호등 추적 중 — 여러 목록 교집합 + 신호등 초록",
  },
  cross: {
    icon: "⚡",
    short: "교차",
    title: "맥박 교차 그룹 — 세 화면이 동시에 가리킨 종목",
  },
  rainbow: {
    icon: "🌈",
    short: "무지개(지속성)",
    title: "무지개 — 사흘 이상 계속 교집합에 걸린 종목 (지속성이 성적을 가른 축)",
  },
};

/**
 * 종목명 옆에 붙는 표식.
 *
 * 별표(`WatchStar`)와 나란히 놓이는 자리라 같은 크기·같은 여백을 쓴다.
 * 없으면 아무것도 안 그린다 — 빈 자리를 남기면 이름 정렬이 어긋난다.
 */
export function SuperMark({ code }: { code: string }) {
  const { marksOf } = useSuperMarks();
  const marks = marksOf(code);
  if (marks.length === 0) return null;
  /*
   * 겹친 것은 **하나로 묶어** 설명한다 — 표식마다 툴팁이 따로면 무엇이 겹쳤는지가
   * 안 읽힌다. 셋 다면 「세 관점이 동시에 가리키고 사흘째 유지되는 종목」이다.
   */
  const title =
    marks.length === 1
      ? LABEL[marks[0]].title
      : marks.map((k) => `${LABEL[k].icon} ${LABEL[k].short}`).join(" · ") +
        (marks.length >= 3 ? " — 세 가지가 다 겹친 종목입니다" : "");
  return (
    <span className={`super-mark ${marks.map((k) => `mark-${k}`).join(" ")}`} title={title}>
      {marks.map((k) => LABEL[k].icon).join("")}
    </span>
  );
}
