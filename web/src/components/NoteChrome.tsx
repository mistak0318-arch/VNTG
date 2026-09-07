/**
 * 메모 모드의 껍데기 — 위 「‹ 폴더 · 완료」, 제목 줄, 아래 도구줄 (2026-09-07).
 *
 * 벤티지: "엑셀 위장한 프로그램들이 요새 많고, 핸드폰 하면서 엑셀 화면 보고 있다는 것도
 * 좀 어색하다. 새로운 모드 하나 창안해볼래?"
 *
 * ## 폰에서 자연스러운 화면은 메모다
 *
 * 폰을 들여다보는 사람이 가장 흔하게 보고 있는 것 — 메시지, 메모, 뉴스. 그중 **표와
 * 숫자가 들어 있어도 이상하지 않은 것**은 메모뿐이다. 요즘 메모 앱은 표를 넣고 색펜으로
 * 적는다. 그래서 색을 다 빼지 않았다 — 빨강·파랑을 **펜 색**(벽돌·슬레이트)으로 눌러
 * 「색펜으로 적은 표」가 되게 했다. 엑셀 모드가 명암으로 방향을 가른 것과 다른 선택인데,
 * 메모엔 색펜이 자연스럽고 회계 장부엔 아니라서다.
 *
 * ## 껍데기는 얇다 — 엑셀과 반대
 *
 * 엑셀은 리본·행번호·격자·시트탭이 다 있어야 엑셀로 읽힌다(모양이 위장이다). 메모 앱은
 * 반대로 **아무것도 없는 게** 메모 앱이다 — 종이색 바탕, 얇은 위아래 줄, 시스템 글꼴.
 * 그래서 이 파일은 짧고 CSS 도 짧다. 위장을 만드는 건 뺀 것들이다.
 *
 * ## 「완료」가 위장 해제다
 *
 * 메모 앱의 「완료」는 편집을 끝내는 단추다. 여기서는 **이 모드를 끄는** 단추다 —
 * 급하게 켰다가 끄는 자리가 화면 오른쪽 위에 늘 있어야 하고, 그 자리에 있는 단추가
 * 「완료」인 것이 메모 앱이다. 「‹ 폴더」는 메뉴를 연다(엑셀의 「파일」과 같은 자리).
 *
 * 아래 도구줄은 눌리지 않는다 — 진짜로 동작할 수 없고, 동작하는 척하면 더 이상하다.
 * 커서를 기본값으로 두고 클릭을 막았다.
 */
export function NoteChrome({
  onMenu,
  onExit,
}: {
  /** 「‹ 폴더」 — 이 모드에서 메뉴를 여는 자리 */
  onMenu: () => void;
  /** 「완료」 — 이 모드를 끈다 */
  onExit: () => void;
}) {
  const now = new Date(Date.now() + 9 * 3600_000);
  const title = `${now.getUTCMonth() + 1}월 ${now.getUTCDate()}일 메모`;
  const stamp = `${now.getUTCFullYear()}년 ${now.getUTCMonth() + 1}월 ${now.getUTCDate()}일 ${String(
    now.getUTCHours(),
  ).padStart(2, "0")}:${String(now.getUTCMinutes()).padStart(2, "0")}`;

  return (
    <>
      <div className="nt-top" role="banner">
        <button className="nt-back" onClick={onMenu} title="메뉴">
          ‹ 폴더
        </button>
        <span className="nt-top-title">메모</span>
        <button className="nt-done" onClick={onExit} title="메모 모드 끄기">
          완료
        </button>
      </div>
      <div className="nt-head">
        <div className="nt-title">{title}</div>
        <div className="nt-stamp">{stamp}</div>
      </div>
      <div className="nt-foot" aria-hidden="true">
        {["☑", "⊞", "✎", "📷", "⋯"].map((ic, i) => (
          <span className="nt-tool" key={i}>
            {ic}
          </span>
        ))}
      </div>
    </>
  );
}
