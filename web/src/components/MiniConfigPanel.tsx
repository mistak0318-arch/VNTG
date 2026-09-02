import { useState } from "react";
import { hotkeyLabel, WINDOW_HOTKEYS, type Hotkey } from "../hotkey";
import { MINI_SCREENS, MINI_SLOT_COUNT, readMiniConfig, saveMiniConfig } from "../miniConfig";

/**
 * 미니창 설정 (2026-08-26) — 상단 버튼 1~7 배정 + 여는 단축키.
 * 화면잠금 단축키와 같은 프리셋 방식 — 겹치는 조합을 고르는 사고를 목록에서 막는다.
 *
 * 2026-09-02: **보드 새창** 단축키가 같은 자리에 붙었다. 둘이 같은 조합을 고르면
 * 둘 다 열리므로(판정이 따로 돈다) 여기서 막는다 — 고른 쪽이 이기고 다른 쪽은
 * 「안 씀」으로 물러난다. 조용히 무시하는 것보다 눈에 보이게 바뀌는 편이 낫다.
 */
export function MiniConfigPanel() {
  const [cfg, setCfg] = useState(readMiniConfig);

  function update(next: typeof cfg) {
    setCfg(next);
    saveMiniConfig(next);
  }

  function setHotkey(which: "hotkey" | "boardHotkey", value: Hotkey) {
    const other = which === "hotkey" ? "boardHotkey" : "hotkey";
    const next = { ...cfg, [which]: value };
    if (value !== "off" && cfg[other] === value) next[other] = "off";
    update(next);
  }

  const isTap = (k: Hotkey) => k.startsWith("tap-");

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
        <span className="appearance-label">미니창 단축키</span>
        <select
          className="group-select"
          style={{ maxWidth: 220 }}
          value={cfg.hotkey}
          onChange={(e) => setHotkey("hotkey", e.target.value as Hotkey)}
        >
          {WINDOW_HOTKEYS.map((h) => (
            <option key={h.key} value={h.key}>
              {h.label}
            </option>
          ))}
        </select>
        <span className="pt-n">{WINDOW_HOTKEYS.find((h) => h.key === cfg.hotkey)?.hint}</span>
      </div>

      <div className="appearance-row">
        <span className="appearance-label">보드 새창 단축키</span>
        <select
          className="group-select"
          style={{ maxWidth: 220 }}
          value={cfg.boardHotkey}
          onChange={(e) => setHotkey("boardHotkey", e.target.value as Hotkey)}
        >
          {WINDOW_HOTKEYS.map((h) => (
            <option key={h.key} value={h.key}>
              {h.label}
            </option>
          ))}
        </select>
        <span className="pt-n">{WINDOW_HOTKEYS.find((h) => h.key === cfg.boardHotkey)?.hint}</span>
      </div>

      <div className="table-note">
        단축키는 <b>본창 어디서든</b> 창을 띄웁니다. 조합키(
        {hotkeyLabel("ctrl-m")} 등)는 화면잠금과 같은 방식이라 입력창에 커서가 있어도
        동작하고, <b>연타</b>(m 세 번 등)는 글자를 치다 우연히 걸리지 않게 입력창에서는 안
        듣습니다. 같은 이름의 창 하나만 열리므로 여러 번 눌러도 창이 늘어나지 않습니다.
        {(isTap(cfg.hotkey) || isTap(cfg.boardHotkey)) && (
          <>
            {" "}
            연타는 <b>0.6초 안에 세 번</b>입니다 — 한 박자 쉬면 처음부터 셉니다.
          </>
        )}
      </div>
    </div>
  );
}
