import { useState } from "react";
import {
  MINI_HOTKEYS,
  MINI_SCREENS,
  MINI_SLOT_COUNT,
  readMiniConfig,
  saveMiniConfig,
} from "../miniConfig";

/**
 * 미니창 설정 (2026-08-26) — 상단 버튼 1~5 배정 + 여는 단축키.
 * 화면잠금 단축키와 같은 프리셋 방식 — 겹치는 조합을 고르는 사고를 목록에서 막는다.
 */
export function MiniConfigPanel() {
  const [cfg, setCfg] = useState(readMiniConfig);

  function update(next: typeof cfg) {
    setCfg(next);
    saveMiniConfig(next);
  }

  return (
    <div>
      <p className="page-note">
        미니창(🪟 — 설정 메뉴 아래, 또는 아래 단축키)의 <b>상단 버튼 1~{MINI_SLOT_COUNT}</b>에
        어떤 화면을 물릴지 정합니다. 바뀐 배정은 열려 있는 미니창에도 바로 적용됩니다.
      </p>

      {cfg.slots.map((slot, i) => (
        <div className="appearance-row" key={i}>
          <span className="appearance-label">버튼 {i + 1}</span>
          <select
            className="group-select"
            style={{ maxWidth: 220 }}
            value={slot}
            onChange={(e) => {
              const slots = [...cfg.slots];
              slots[i] = e.target.value as (typeof cfg.slots)[number];
              update({ ...cfg, slots });
            }}
          >
            {MINI_SCREENS.map((s) => (
              <option key={s.key} value={s.key} title={s.hint}>
                {s.icon} {s.label}
              </option>
            ))}
          </select>
        </div>
      ))}

      <div className="appearance-row">
        <span className="appearance-label">여는 단축키</span>
        <select
          className="group-select"
          style={{ maxWidth: 220 }}
          value={cfg.hotkey}
          onChange={(e) => update({ ...cfg, hotkey: e.target.value as typeof cfg.hotkey })}
        >
          {MINI_HOTKEYS.map((h) => (
            <option key={h.key} value={h.key}>
              {h.label}
            </option>
          ))}
        </select>
        <span className="pt-n">{MINI_HOTKEYS.find((h) => h.key === cfg.hotkey)?.hint}</span>
      </div>
      <div className="table-note">
        단축키는 <b>본창 어디서든</b> 미니창을 띄웁니다 — 화면잠금(Ctrl+Q 등)과 같은 방식이라
        입력창에 커서가 있어도 동작합니다. 같은 이름의 팝업 하나만 열리므로 여러 번 눌러도
        창이 늘어나지 않습니다.
      </div>
    </div>
  );
}
