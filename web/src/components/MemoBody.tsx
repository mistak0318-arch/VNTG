import { Fragment } from "react";

/**
 * 메모 본문 읽기 — **아주 얕은 마크다운.**
 *
 * ## 왜 라이브러리를 안 쓰나
 *
 * 메모에 필요한 건 다섯 가지뿐이다: 제목, 목록, 체크박스, 굵게, 링크.
 * 이걸 위해 마크다운 파서를 들이면 번들이 커지고 **HTML 주입 위험**까지 따라온다
 * (남이 준 글이 아니라 내가 쓴 글이지만, 붙여넣기 한 줄로 사고가 난다).
 * 줄 단위로 훑어 React 요소로 만든다 — `dangerouslySetInnerHTML` 을 쓰지 않으므로
 * 태그가 섞여 들어와도 그냥 글자로 보인다.
 *
 * ## 체크박스는 눌러서 바뀐다
 *
 * `- [ ] 조건 확인` 을 눌러 `- [x]` 로 만든다. 「추적관찰」 메모에서 들어갈 조건을
 * 하나씩 지워 나가는 게 이 메모장의 실제 쓰임이라, 읽기 화면에서 바로 눌려야 한다.
 */

export function MemoBody({
  text,
  onToggle,
}: {
  text: string;
  /** 체크박스를 눌렀을 때 — 몇 번째 줄인지 알려 준다. 없으면 읽기 전용 */
  onToggle?: (line: number) => void;
}) {
  const lines = text.split("\n");
  return (
    <div className="mdx">
      {lines.map((raw, i) => {
        const key = `${i}`;

        /* 체크박스 — 제일 먼저 본다(목록보다 앞선다) */
        const cb = raw.match(/^(\s*)[-*]\s+\[([ xX])\]\s?(.*)$/);
        if (cb) {
          const done = cb[2].toLowerCase() === "x";
          return (
            <div className={`mdx-task${done ? " done" : ""}`} key={key}>
              <input
                type="checkbox"
                checked={done}
                disabled={!onToggle}
                onChange={() => onToggle?.(i)}
              />
              <span>{inline(cb[3])}</span>
            </div>
          );
        }

        const h = raw.match(/^(#{1,3})\s+(.*)$/);
        if (h) {
          const lv = h[1].length;
          return (
            <div className={`mdx-h mdx-h${lv}`} key={key}>
              {inline(h[2])}
            </div>
          );
        }

        const li = raw.match(/^(\s*)[-*]\s+(.*)$/);
        if (li) {
          return (
            <div className="mdx-li" key={key} style={{ paddingLeft: `${li[1].length * 0.5 + 0.9}rem` }}>
              <span className="mdx-dot">·</span>
              <span>{inline(li[2])}</span>
            </div>
          );
        }

        /* 「항목: 값」 — 템플릿이 이 꼴이라 이름 쪽을 조금 진하게 한다 */
        const kv = raw.match(/^([^:\n]{1,20}):\s*(.*)$/);
        if (kv && kv[1].trim() && !/^https?/.test(kv[1])) {
          return (
            <div className="mdx-kv" key={key}>
              <b>{kv[1]}</b>
              <span>{inline(kv[2])}</span>
            </div>
          );
        }

        if (!raw.trim()) return <div className="mdx-gap" key={key} />;
        return (
          <div className="mdx-p" key={key}>
            {inline(raw)}
          </div>
        );
      })}
    </div>
  );
}

/**
 * 줄 안쪽 — **굵게**와 링크만.
 * 정규식으로 자르고 조각을 이어 붙인다. HTML 을 만들지 않는다.
 */
function inline(s: string) {
  const out: React.ReactNode[] = [];
  const re = /(\*\*[^*]+\*\*)|(https?:\/\/[^\s]+)/g;
  let last = 0;
  let m: RegExpExecArray | null;
  let k = 0;
  while ((m = re.exec(s)) !== null) {
    if (m.index > last) out.push(<Fragment key={k++}>{s.slice(last, m.index)}</Fragment>);
    if (m[1]) out.push(<b key={k++}>{m[1].slice(2, -2)}</b>);
    else if (m[2])
      out.push(
        <a key={k++} href={m[2]} target="_blank" rel="noreferrer noopener">
          {m[2].length > 48 ? `${m[2].slice(0, 48)}…` : m[2]}
        </a>,
      );
    last = m.index + m[0].length;
  }
  if (last < s.length) out.push(<Fragment key={k++}>{s.slice(last)}</Fragment>);
  return out;
}

/** 그 줄의 체크박스를 켜고 끈다 — 읽기 화면에서 누른 것을 본문에 되돌려 쓴다 */
export function toggleTaskLine(text: string, line: number): string {
  const lines = text.split("\n");
  const m = lines[line]?.match(/^(\s*[-*]\s+\[)([ xX])(\].*)$/);
  if (!m) return text;
  lines[line] = `${m[1]}${m[2].toLowerCase() === "x" ? " " : "x"}${m[3]}`;
  return lines.join("\n");
}
