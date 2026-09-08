import { useState } from "react";
import { canVibrate, preview, readNotifyPrefs, saveNotifyPrefs, SOUNDS, type NotifyPrefs } from "../notifySound";

/**
 * 체결 알림 설정 (2026-09-08 — 벤티지 "알림 옵션 관련해서 설정 메뉴에서 할 수 있게 해줘").
 *
 * **이 기기의 사정**이라 로컬에 둔다. 회사 PC 에서 소리를 끈 것이 집 PC 까지 따라가면
 * 안 된다 — 텔레그램 알림처럼 「어디로 보낼까」가 아니라 「이 자리에서 어떻게 알릴까」다.
 */
export function NotifySoundPanel() {
  const [p, setP] = useState<NotifyPrefs>(readNotifyPrefs());
  const set = (patch: Partial<NotifyPrefs>) => setP(saveNotifyPrefs(patch));
  const vibrateOk = canVibrate();

  return (
    <div className="ns-panel">
      <p className="page-note">
        주문이 <b>체결되면</b> 화면 구석에 뜨고 소리가 납니다. 알림함(종)에는 어차피 쌓이지만,
        종은 찾아가 눌러야 보이므로 <b>지금 당장</b> 알아야 하는 것만 여기서 울립니다.
      </p>

      <label className="ns-row">
        <input type="checkbox" checked={p.toast} onChange={(e) => set({ toast: e.target.checked })} />
        <span>
          <b>화면에 띄우기</b>
          <small>오른쪽 아래에 7초. 누르면 그 자리로 갑니다</small>
        </span>
      </label>

      <label className="ns-row">
        <input type="checkbox" checked={p.sound} onChange={(e) => set({ sound: e.target.checked })} />
        <span>
          <b>소리</b>
          <small>브라우저가 만드는 소리라 받아 둔 음원이 없습니다 — 용량도 라이선스도 없습니다</small>
        </span>
      </label>

      {p.sound && (
        <div className="ns-sub">
          <div className="ns-sounds">
            {SOUNDS.map((s) => (
              <button
                key={s.key}
                type="button"
                className={`filter-btn${p.soundKey === s.key ? " active" : ""}`}
                title={`${s.hint} · 눌러서 들어보기`}
                onClick={() => {
                  const next = saveNotifyPrefs({ soundKey: s.key });
                  setP(next);
                  preview({ ...next, vibrate: false });
                }}
              >
                {s.label}
              </button>
            ))}
          </div>
          <label className="ns-vol">
            <span>크기</span>
            <input
              type="range"
              min={0.1}
              max={1}
              step={0.1}
              value={p.volume}
              onChange={(e) => set({ volume: Number(e.target.value) })}
              onMouseUp={() => preview({ ...readNotifyPrefs(), vibrate: false })}
              onTouchEnd={() => preview({ ...readNotifyPrefs(), vibrate: false })}
            />
            <b>{Math.round(p.volume * 100)}%</b>
          </label>
        </div>
      )}

      <label className={`ns-row${vibrateOk ? "" : " off"}`}>
        <input type="checkbox" checked={p.vibrate && vibrateOk} disabled={!vibrateOk} onChange={(e) => set({ vibrate: e.target.checked })} />
        <span>
          <b>진동</b>
          <small>
            {vibrateOk
              ? "안드로이드에서 됩니다 — 홈 화면에 깐 앱에서도 그대로입니다"
              : "이 기기는 진동을 지원하지 않습니다. 아이폰 사파리에는 이 기능이 없습니다"}
          </small>
        </span>
      </label>

      <div className="ns-scope">
        <span className="ns-scope-l">무엇에 울릴까</span>
        {(
          [
            ["fill", "체결만", "주문이 실제로 체결됐을 때만"],
            ["order", "주문·감시까지", "체결 + 감시 발동 · 손절 · 접수 · 취소"],
            ["all", "모든 알림", "종목·시장·시스템 알림까지 전부"],
          ] as const
        ).map(([k, label, hint]) => (
          <button key={k} type="button" className={`filter-btn${p.scope === k ? " active" : ""}`} title={hint} onClick={() => set({ scope: k })}>
            {label}
          </button>
        ))}
      </div>

      <div className="ns-test">
        <button type="button" className="ord-mk" onClick={() => preview(readNotifyPrefs())}>
          지금 들어보기
        </button>
        <small>
          ⚠️ 브라우저는 <b>페이지를 한 번 누르기 전</b>에는 소리를 막습니다. 앱을 열자마자 오는 첫 알림은
          소리가 안 날 수 있는데, 그건 브라우저 규칙이라 우회할 수 없습니다. 화면에 뜨는 것은 그때도 뜹니다.
        </small>
      </div>
    </div>
  );
}
