import { useEffect, useState } from "react";
import { api, type SysTopicExamples } from "../api";
import { setPref } from "../prefs";
import { SYS_ENABLED_KEY, SYS_EVENT, SYS_MODE_KEY, SYS_NOASK_KEY, SYS_SEARCH_KEY } from "./SysAssist";
import { SysIcon } from "./SysIcon";

/**
 * 시스 도우미 설정 (2026-09-03) — 켜기/끄기 · 기본 모드 · 웹 검색 · 되묻기 · **주제별 예시 질문**.
 * 값은 `vntg.sys.*` 로 전역(서버 동기). 바꾸면 같은 창의 버튼이 바로 따라온다(SYS_EVENT).
 * 모델은 「AI 모델」 카드의 「시스 도우미」 줄에서.
 *
 * 예시 질문(업그레이드 ④ — 벤티지: "정규식은 내가 못 고쳐"): 주제마다 기본 예시가 있고, 여기서 한 줄에
 * 하나씩 더 보태면 그 낱말로도 그 주제가 걸린다. 서버 파일(`data/sysTopics.json`)이라 기기 공통.
 */
function read(key: string, fallback: string): string {
  try {
    return localStorage.getItem(key) ?? fallback;
  } catch {
    return fallback;
  }
}

export function SysConfigPanel() {
  const [enabled, setEnabled] = useState(read(SYS_ENABLED_KEY, "1") !== "0");
  const [mode, setMode] = useState(read(SYS_MODE_KEY, "plain"));
  const [search, setSearch] = useState(read(SYS_SEARCH_KEY, "1") !== "0");
  const [noAsk, setNoAsk] = useState(read(SYS_NOASK_KEY, "0") === "1");
  const [topics, setTopics] = useState<SysTopicExamples[] | null>(null);
  const [draft, setDraft] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);

  useEffect(() => {
    api
      .sysTopics()
      .then((r) => {
        setTopics(r.topics);
        setDraft(Object.fromEntries(r.topics.map((t) => [t.key, t.custom.join("\n")])));
      })
      .catch(() => setTopics([]));
  }, []);

  const put = (key: string, value: string) => {
    setPref(key, value);
    window.dispatchEvent(new Event(SYS_EVENT));
  };

  async function saveTopics() {
    setSaving(true);
    setMsg(null);
    try {
      const custom: Record<string, string[]> = {};
      for (const [k, v] of Object.entries(draft)) custom[k] = v.split("\n").map((s) => s.trim()).filter(Boolean);
      const r = await api.sysTopicsSave(custom);
      setTopics(r.topics);
      setMsg("저장됐다 — 다음 질문부터 이 예시로도 걸린다");
    } catch (e) {
      setMsg(e instanceof Error ? e.message : "저장 실패");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="sys-cfg">
      <label className="sys-cfg-row">
        <input
          type="checkbox"
          checked={enabled}
          onChange={(e) => {
            setEnabled(e.target.checked);
            put(SYS_ENABLED_KEY, e.target.checked ? "1" : "0");
          }}
        />
        <span>
          <b>시스 버튼 보이기</b> — 어느 화면에서든 우하단 <SysIcon size="1.2em" />. 끄면 버튼이 사라진다(서버 기능은 그대로).
        </span>
      </label>
      <div className="sys-cfg-row">
        <span>기본 모드</span>
        <span className="sys-seg">
          <button type="button" className={mode === "plain" ? "on" : ""} onClick={() => { setMode("plain"); put(SYS_MODE_KEY, "plain"); }}>
            일반 (비용 0)
          </button>
          <button type="button" className={mode === "ai" ? "on" : ""} onClick={() => { setMode("ai"); put(SYS_MODE_KEY, "ai"); }}>
            AI
          </button>
        </span>
        <span className="sys-dim">패널에서 그때그때 바꿀 수 있고, 여기 값은 다음에 열 때의 기본이다.</span>
      </div>
      <label className="sys-cfg-row">
        <input
          type="checkbox"
          checked={search}
          onChange={(e) => {
            setSearch(e.target.checked);
            put(SYS_SEARCH_KEY, e.target.checked ? "1" : "0");
          }}
        />
        <span>
          AI 모드에서 <b>웹 검색</b>도 쓴다 (회당 약 $0.01, 한 질문에 최대 5회)
        </span>
      </label>
      <label className="sys-cfg-row">
        <input
          type="checkbox"
          checked={!noAsk}
          onChange={(e) => {
            setNoAsk(!e.target.checked);
            put(SYS_NOASK_KEY, e.target.checked ? "0" : "1");
          }}
        />
        <span>
          <b>모호하면 되묻는다</b> — 「하이닉스 어때?」처럼 종목만 있으면 시세·뉴스·실적 중 뭘 볼지 한 번 묻는다. 패널에서 「다」를
          두 번 연속 고르면 스스로 꺼진다. 여기서 다시 켠다.
        </span>
      </label>
      <p className="sys-dim" style={{ margin: "6px 0 0" }}>
        모델은 <b>분석 기준 › AI 모델</b>의 「시스 도우미 AI 모드」 줄에서 고른다. AI 답 끝에는 늘 「제일 무거운 재료 · 틀릴 수 있는
        이유 · 확인 안 한 것」 세 줄이 붙는다. 마감 뒤 15:50에 오늘 물어본 종목이 그 뒤로 어떻게 됐는지 알림함으로 한 번 온다(알림
        설정 「시스 되짚기」).
      </p>

      <div className="sys-cfg-topics">
        <div className="sys-cfg-topics-h">
          <b>주제별 예시 질문</b>
          <span className="sys-dim">정규식 대신 예시로 건다. 한 줄에 하나씩 보태면 그 낱말로도 그 주제가 걸린다. 여러 주제에 같이 나오는 낱말(「오늘」)은 못 가른다.</span>
        </div>
        {topics === null && <div className="sys-dim">불러오는 중…</div>}
        {topics?.map((t) => (
          <div key={t.key} className="sys-cfg-topic">
            <div className="sys-cfg-topic-name">
              <b>{t.title}</b>
              <span className="sys-dim">{t.builtin.length ? t.builtin.join(" · ") : "예시 없음(종목명·테마명으로 건다)"}</span>
            </div>
            <textarea
              rows={2}
              placeholder="여기에 예시 질문을 한 줄에 하나씩"
              value={draft[t.key] ?? ""}
              onChange={(e) => setDraft((d) => ({ ...d, [t.key]: e.target.value }))}
            />
          </div>
        ))}
        {topics && topics.length > 0 && (
          <div className="sys-cfg-row">
            <button type="button" className="primary-btn" onClick={() => void saveTopics()} disabled={saving}>
              {saving ? "저장 중…" : "예시 저장"}
            </button>
            {msg && <span className="sys-dim">{msg}</span>}
          </div>
        )}
      </div>
    </div>
  );
}
