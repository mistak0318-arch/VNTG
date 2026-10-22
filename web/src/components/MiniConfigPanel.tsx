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

  type HK = "hotkey" | "boardHotkey" | "orderHotkey";
  /* 셋이 같은 조합을 고르면 셋 다 열린다(판정이 따로) — 고른 쪽이 이기고 나머지는 「안 씀」 */
  function setHotkey(which: HK, value: Hotkey) {
    const next = { ...cfg, [which]: value };
    for (const other of ["hotkey", "boardHotkey", "orderHotkey"] as HK[]) {
      if (other !== which && value !== "off" && cfg[other] === value) next[other] = "off";
    }
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

      {/* 주문 미니창 (2026-09-07) — 미니창을 주문 화면으로 바로 */}
      <div className="appearance-row">
        <span className="appearance-label">주문 미니창 단축키</span>
        <select
          className="group-select"
          style={{ maxWidth: 220 }}
          value={cfg.orderHotkey}
          onChange={(e) => setHotkey("orderHotkey", e.target.value as Hotkey)}
        >
          {WINDOW_HOTKEYS.map((h) => (
            <option key={h.key} value={h.key}>
              {h.label}
            </option>
          ))}
        </select>
        <span className="pt-n">
          {WINDOW_HOTKEYS.find((h) => h.key === cfg.orderHotkey)?.hint} · 미니창을 <b>주문 화면으로</b> 엽니다
        </span>
      </div>

      {/*
        **창 연동 켜고 끄기** (2026-10-22 — 벤티지: "미니창에서 종목검색할때 연동모드
        키고 끌 수 있는 옵션 넣을 수 있게 설정에 넣어줄래?").

        미니창의 쓸모는 「본창을 안 떠나고 곁눈질」인데, 연동이 켜져 있으면 미니창에서
        뭘 하나 찾아볼 때마다 **본창까지 끌려간다** — 보던 자리를 잃지 않으려고 연 창이
        보던 자리를 뺏는 셈이다. 끄면 미니창이 저 혼자 본다.
      */}
      <div className="appearance-row">
        <span className="appearance-label">창 연동</span>
        <label className="mini-link-toggle">
          <input
            type="checkbox"
            checked={cfg.link}
            onChange={(e) => update({ ...cfg, link: e.target.checked })}
          />
          <span>미니창에서 고른 종목을 다른 창과 맞춘다</span>
        </label>
        <span className="pt-n">
          {cfg.link ? (
            <>
              미니창에서 종목을 고르면 <b>본창·보드도 같이</b> 바뀌고, 반대로 본창에서 고른
              종목을 미니창이 따라갑니다.
            </>
          ) : (
            <>
              미니창이 <b>저 혼자</b> 봅니다 — 본창은 보던 자리에 그대로 있습니다.
            </>
          )}
        </span>
      </div>

      <div className="table-note">
        단축키는 <b>본창 어디서든</b> 창을 띄웁니다. 조합키(
        {hotkeyLabel("ctrl-m")} 등)는 화면잠금과 같은 방식이라 입력창에 커서가 있어도
        동작하고, <b>연타</b>(m 세 번 등)는 글자를 치다 우연히 걸리지 않게 입력창에서는 안
        듣습니다. 같은 이름의 창 하나만 열리므로 여러 번 눌러도 창이 늘어나지 않습니다.
        {(isTap(cfg.hotkey) || isTap(cfg.boardHotkey) || isTap(cfg.orderHotkey)) && (
          <>
            {" "}
            연타는 <b>0.6초 안에 세 번</b>입니다 — 한 박자 쉬면 처음부터 셉니다.
          </>
        )}
      </div>
    </div>
  );
}
