/**
 * **AI 정리본을 읽을 수 있게** (2026-10-09).
 *
 * 벤티지: "텔레그램 ai 정리하는데도 글이 잘리고 좀 문제가 잇어보이네"
 *
 * 모델은 마크다운으로 답한다(`## 오늘 돌고 있는 이야기`, `* **제목:** 본문`). 그걸
 * `<pre>` 에 그대로 넣고 있었다 — **쓰여 있는 그대로**라 `##` 과 `**` 이 글자로 보이고,
 * `pre` 라 글꼴이 고정폭이 되어 한글이 띄엄띄엄 벌어졌다. 정보는 다 있는데 읽히지가 않는다.
 *
 * 머리글·목록·굵게 **세 가지만** 해석한다. 더 하려면 마크다운 라이브러리를 들여야 하는데,
 * 이 글에 나오는 것이 그 셋뿐이라 더 들일 값어치가 없다 — 못 알아본 줄은 평문 그대로 둔다.
 *
 * ⚠️ HTML 은 **해석하지 않는다.** 모델이 만든 글이라 태그가 섞여 들어올 수 있다.
 * 조각을 먼저 쪼개고 글자는 React 가 넣으므로, 태그가 와도 글자로만 보인다.
 */

/** `**굵게**` 만 조각으로 — 나머지는 글자 그대로 */
function bold(line: string, key: string) {
  const parts = line.split(/\*\*(.+?)\*\*/g);
  return parts.map((p, i) =>
    /* 홀수 조각이 `**` 안쪽이다 */
    i % 2 === 1 ? <b key={`${key}-${i}`}>{p}</b> : <span key={`${key}-${i}`}>{p}</span>,
  );
}

export function MdText({ text, className = "" }: { text: string; className?: string }) {
  const lines = (text ?? "").split("\n");
  return (
    <div className={`md ${className}`}>
      {lines.map((raw, i) => {
        const l = raw.trimEnd();
        if (l.trim() === "") return <div key={i} className="md-gap" />;
        const h = /^(#{1,4})\s+(.*)$/.exec(l);
        if (h) {
          const lv = Math.min(3, h[1].length);
          return (
            <div key={i} className={`md-h md-h${lv}`}>
              {bold(h[2], String(i))}
            </div>
          );
        }
        const li = /^\s*[-*•]\s+(.*)$/.exec(l);
        if (li) {
          return (
            <div key={i} className="md-li">
              <i className="md-bullet">·</i>
              <span>{bold(li[1], String(i))}</span>
            </div>
          );
        }
        return (
          <div key={i} className="md-p">
            {bold(l, String(i))}
          </div>
        );
      })}
    </div>
  );
}
