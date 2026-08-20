import { useState } from "react";
import { sha256, useScreenLock } from "../useScreenLock";

/**
 * 화면 잠금 설정.
 *
 * **기기마다 따로다.** 회사 PC 는 잠그고 집은 안 잠그는 게 자연스럽다 —
 * 서버에 저장하면 집에서도 5분마다 비밀번호를 넣게 된다.
 */
export function ScreenLockPanel() {
  const { config, save, lock } = useScreenLock();
  const [pw, setPw] = useState("");
  const [pw2, setPw2] = useState("");
  const [msg, setMsg] = useState<string | null>(null);

  async function setPassword() {
    if (pw.length < 4) {
      setMsg("4자 이상으로 정해 주세요.");
      return;
    }
    if (pw !== pw2) {
      setMsg("두 번 입력한 값이 다릅니다.");
      return;
    }
    save({ ...config, hash: await sha256(pw) });
    setPw("");
    setPw2("");
    setMsg("비밀번호를 저장했습니다.");
  }

  return (
    <div>
      <p className="page-note">
        자리를 비운 사이 화면을 가립니다. <b>이 기기에만</b> 저장되므로 회사 PC 만 켜 둘 수
        있습니다.
      </p>

      <div className="st-cfg-row">
        <span className="st-cfg-k">사용</span>
        <label className="st-cfg-chk">
          <input
            type="checkbox"
            checked={config.enabled}
            onChange={(e) => save({ ...config, enabled: e.target.checked })}
            disabled={!config.hash}
          />
          자리를 비우면 잠그기
          {!config.hash && <span className="pt-n"> (먼저 비밀번호를 정하세요)</span>}
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

      <div className="st-cfg-row">
        <span className="st-cfg-k">비밀번호</span>
        <span className="lockset-pw">
          <input
            type="password"
            value={pw}
            onChange={(e) => setPw(e.target.value)}
            placeholder={config.hash ? "새 비밀번호" : "비밀번호"}
            autoComplete="new-password"
          />
          <input
            type="password"
            value={pw2}
            onChange={(e) => setPw2(e.target.value)}
            placeholder="한 번 더"
            autoComplete="new-password"
          />
          <button className="filter-btn" onClick={() => void setPassword()}>
            저장
          </button>
        </span>
      </div>
      {msg && <div className="alert-note">{msg}</div>}

      {config.hash && config.enabled && (
        <div className="filter-row">
          <button className="filter-btn" onClick={lock}>
            지금 잠그기
          </button>
          <span className="pt-n">자리를 뜰 때 눌러 두면 바로 잠깁니다</span>
        </div>
      )}

      <div className="st-cfg-note">
        비밀번호는 <b>해시로만</b> 저장됩니다 — 브라우저 저장소를 열어봐도 원문이 안 보입니다.
        되돌릴 수 없으니 잊으면 여기서 새로 정하셔야 합니다.
        <br />
        ⚠️ <b>이건 화면을 가리는 용도지 보안 경계가 아닙니다.</b> 개발자도구를 열거나 API 를
        직접 부르면 우회됩니다. 진짜 방어는 <b>Cloudflare 인증(6시간)</b>과{" "}
        <b>OS 화면 잠금</b>이고, 이건 그 사이의 몇 분을 메웁니다.
      </div>
    </div>
  );
}
