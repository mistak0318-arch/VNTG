import { useEffect, useMemo, useState } from "react";
import { api } from "../api";
import { CHANGELOG, CHANGELOG_COMMITS } from "../changelog";

/**
 * 설정 › **정보** (2026-09-04) — 벤티지: "설정메뉴에 정보 라는 탭 하나 만들어서
 * 버전별로 기록 좀 해줘. 뭘 발행했고 했는지."
 *
 * ## 「버전」이 없어서 날짜로 묶는다
 *
 * 이 도구엔 v1.2.3 같은 번호가 없다. 고치면 그날 바로 미니PC 로 나가기 때문에 —
 * **하루가 곧 한 판**이다. 그래서 날짜로 묶고, 그날 나간 것들을 한 줄씩 적는다.
 * 줄은 커밋 제목이다(`scripts/build-changelog.mjs` 가 구워 넣는다). 이 저장소는 커밋
 * 제목에 「무엇을 왜」를 한 문장으로 적는 규칙이라, 따로 릴리스 노트를 쓰지 않아도
 * 그대로 읽힌다.
 *
 * ## 지금 돌고 있는 판
 *
 * 맨 위 칸은 **이 기기가 보고 있는 것**과 **서버가 돌고 있는 것**을 나란히 놓는다.
 * 폰에서 옛 화면이 캐시로 남아 「고쳤다는데 왜 그대로냐」가 되는 일이 있었다 —
 * 그때 여기를 보면 둘이 다른 것이 보인다.
 */

function ago(iso: string): string {
  const sec = Math.max(0, Math.floor((Date.now() - new Date(iso).getTime()) / 1000));
  if (sec < 60) return `${sec}초`;
  if (sec < 3600) return `${Math.floor(sec / 60)}분`;
  if (sec < 86400) return `${Math.floor(sec / 3600)}시간`;
  return `${Math.floor(sec / 86400)}일`;
}

function weekday(date: string): string {
  const d = new Date(`${date}T00:00:00+09:00`);
  return ["일", "월", "화", "수", "목", "금", "토"][d.getDay()] ?? "";
}

export function AboutPanel() {
  const [health, setHealth] = useState<{ startedAt: string; uptimeSec: number } | null>(null);
  const [err, setErr] = useState<string | null>(null);
  /** 며칠씩 끊어 보여 준다 — 400건을 한 번에 그리면 스크롤이 끝나지 않는다 */
  const [days, setDays] = useState(6);
  const [q, setQ] = useState("");

  useEffect(() => {
    void api
      .health()
      .then((h) => setHealth({ startedAt: h.startedAt, uptimeSec: h.uptimeSec }))
      .catch((e: unknown) => setErr(e instanceof Error ? e.message : "서버 상태를 못 읽었다"));
  }, []);

  const filtered = useMemo(() => {
    const term = q.trim();
    if (!term) return CHANGELOG;
    return CHANGELOG.map((d) => ({
      ...d,
      items: d.items.filter((i) => i.subject.includes(term)),
    })).filter((d) => d.items.length > 0);
  }, [q]);

  const shown = q.trim() ? filtered : filtered.slice(0, days);
  const hiddenDays = q.trim() ? 0 : Math.max(0, filtered.length - days);

  return (
    <div className="about">
      <div className="about-now">
        <div className="about-cell">
          <span>이 기기가 보는 판</span>
          <b>{CHANGELOG[0]?.date ?? "-"}</b>
          <small>
            {CHANGELOG[0]?.items[0]?.hash ?? "-"} · 이력 {CHANGELOG_COMMITS}건
          </small>
        </div>
        <div className="about-cell">
          <span>서버가 켜진 지</span>
          <b>{health ? ago(health.startedAt) : err ? "-" : "…"}</b>
          <small>
            {health
              ? new Date(health.startedAt).toLocaleString("ko-KR", { timeZone: "Asia/Seoul" })
              : (err ?? "확인 중")}
          </small>
        </div>
      </div>
      <p className="table-note">
        이 도구엔 버전 번호가 없습니다 — 고치면 그날 바로 나가기 때문에 <b>하루가 곧 한 판</b>입니다.
        아래는 날짜별로 그날 나간 것들입니다. 화면이 옛것 같으면 위 두 칸의 날짜를 견줘 보세요.
      </p>

      <input
        className="about-find"
        placeholder="찾기 — 「시스」 「손절」 「신호등」 처럼"
        value={q}
        onChange={(e) => setQ(e.target.value)}
      />
      {q.trim() && (
        <p className="table-note">
          {filtered.reduce((n, d) => n + d.items.length, 0)}건 · {filtered.length}일
        </p>
      )}

      {shown.map((d) => (
        <div className="about-day" key={d.date}>
          <div className="about-date">
            {d.date} <i>({weekday(d.date)})</i>
            <span>{d.items.length}건</span>
          </div>
          <ul className="about-list">
            {d.items.map((i) => (
              <li key={i.hash}>
                <code>{i.hash}</code>
                {i.subject}
              </li>
            ))}
          </ul>
        </div>
      ))}

      {hiddenDays > 0 && (
        <button type="button" className="about-more" onClick={() => setDays((v) => v + 6)}>
          이전 {hiddenDays}일 더 보기
        </button>
      )}
      {q.trim() && filtered.length === 0 && <p className="empty">그런 줄은 없습니다</p>}
    </div>
  );
}
