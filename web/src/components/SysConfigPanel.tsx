import { useState } from "react";
import { setPref } from "../prefs";
import { SYS_ENABLED_KEY, SYS_EVENT, SYS_MODE_KEY, SYS_SEARCH_KEY } from "./SysAssist";
import { SysIcon } from "./SysIcon";

/**
 * 시스 도우미 설정 (2026-09-03) — 켜기/끄기 · 기본 모드 · 웹 검색.
 * 값은 `vntg.sys.*` 로 전역(서버 동기). 바꾸면 같은 창의 버튼이 바로 따라온다(SYS_EVENT).
 * 모델은 「AI 모델」 카드의 「시스 도우미」 줄에서.
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

  const put = (key: string, value: string) => {
    setPref(key, value);
    window.dispatchEvent(new Event(SYS_EVENT));
  };

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
      <p className="sys-dim" style={{ margin: "6px 0 0" }}>
        모델은 <b>분석 기준 › AI 모델</b>의 「시스 도우미 AI 모드」 줄에서 고른다. 안 고르면 「시황 질문하기」 모델을 따라간다.
        AI 로 물은 것은 시황 질문하기 기록에 <b>[시스]</b> 표시로 같이 남는다.
      </p>
    </div>
  );
}
