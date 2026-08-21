import { HOTKEYS, PIN, useScreenLock, type Hotkey } from "../useScreenLock";

/**
 * 화면 잠금 설정 — **켜고 끄기와 시간, 그 둘뿐이다.**
 *
 * 비밀번호는 네 자리로 고정이라 정하는 칸이 없다. 자리를 뜰 때 한 번 누르고
 * 돌아와서 한 번 치는 게 전부인 기능인데, 그 앞에 설정 단계가 있으면 정작 급할 때
 * 못 쓴다.
 *
 * **기기마다 따로다.** 회사 PC 는 잠그고 집은 안 잠그는 게 자연스럽다 —
 * 서버에 저장하면 집에서도 5분마다 비밀번호를 넣게 된다.
 */
export function ScreenLockPanel() {
  const { config, save, lock } = useScreenLock();

  return (
    <div>
      <p className="page-note">
        자리를 비운 사이 화면을 가립니다. <b>이 기기에만</b> 저장되므로 회사 PC 만 켜 둘 수
        있습니다. 메뉴 맨 아래 <b>🔒</b> 버튼이나 <b>단축키</b>로 언제든 바로 잠깁니다.
      </p>

      <div className="st-cfg-row">
        <span className="st-cfg-k">사용</span>
        <label className="st-cfg-chk">
          <input
            type="checkbox"
            checked={config.enabled}
            onChange={(e) => save({ ...config, enabled: e.target.checked })}
          />
          자리를 비우면 저절로 잠그기
        </label>
      </div>

      <div className="st-cfg-row">
        <span className="st-cfg-k">잠기는 시간</span>
        <span>
          <input
            type="number"
            min={1}
            max={120}
            value={config.minutes}
            onChange={(e) => save({ ...config, minutes: Number(e.target.value) })}
          />{" "}
          분 동안 아무 동작이 없으면
        </span>
      </div>

      {/*
        단축키 — **회사에서 누가 다가올 때 버튼을 찾을 새가 없다.**
        손이 이미 키보드에 있으니 키 하나가 훨씬 빠르다.
        자동 잠금과 따로 논다 — 시간 잠금은 꺼 두고 단축키만 쓸 수 있다.
      */}
      <div className="st-cfg-row">
        <span className="st-cfg-k">단축키</span>
        <span>
          <select
            value={config.hotkey}
            onChange={(e) => save({ ...config, hotkey: e.target.value as Hotkey })}
          >
            {HOTKEYS.map((h) => (
              <option key={h.key} value={h.key}>
                {h.label}
              </option>
            ))}
          </select>{" "}
          <span className="pt-n">{HOTKEYS.find((h) => h.key === config.hotkey)?.hint}</span>
        </span>
      </div>

      <div className="filter-row">
        <button className="filter-btn" onClick={lock}>
          지금 잠그기
        </button>
        <span className="pt-n">비밀번호는 <b>{PIN}</b> 네 자리입니다</span>
      </div>

      <div className="st-cfg-note">
        ⚠️ <b>이건 화면을 가리는 용도지 보안 경계가 아닙니다.</b> 네 자리는 경우의 수가 만
        개뿐이라 작정하고 찍으면 뚫리고, 개발자도구를 열거나 API 를 직접 부르면 우회됩니다.
        진짜 방어는 <b>Cloudflare 인증(6시간)</b>과 <b>OS 화면 잠금</b>이고, 이건 그 사이의
        몇 분을 메웁니다.
      </div>
    </div>
  );
}
