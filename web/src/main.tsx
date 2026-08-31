import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import { LoginGate } from "./components/LoginGate";
import { AppearanceProvider } from "./useAppearance";
import { WatchedCodesProvider } from "./useWatchedCodes";
import { SuperMarksProvider } from "./useSuperMarks";
import { applyPushedPrefs, loadPrefs } from "./prefs";
import "./styles.css";
import "./overview.css";
/* 엑셀 모드는 색뿐 아니라 모양까지 바꿔서 규칙이 많다 — 파일을 따로 둔다 */
import "./excel.css";
import "./login.css";
import "./keywordFlow.css";

/*
 * **설정을 먼저 받고 그린다.**
 *
 * 설정은 서버에 있고 화면은 localStorage 를 동기로 읽는다. 그려 놓고 값을 채우면
 * 예전 값으로 한 번 그렸다가 바뀌어서 **화면이 튄다** — 테마가 특히 눈에 띈다.
 * 그래서 받아서 채운 다음에 그린다. 서버를 못 읽어도 `loadPrefs` 는 그냥 돌아오므로
 * 이 기기 값으로 평소처럼 뜬다.
 */
void loadPrefs().then(() => {
  // 다른 기기가 배포한 기기별 설정(화면설정 등)이 있으면 렌더 전에 적용 — 도장이 중복을 막는다
  applyPushedPrefs();
  ReactDOM.createRoot(document.getElementById("root")!).render(
    <React.StrictMode>
      <AppearanceProvider>
        {/*
          로그인 문은 **제일 바깥**이다. 안쪽에 두면 잠긴 동안에도 앱이 먼저 그려지고,
          그 화면들이 저마다 막힌 요청을 쏘아 401 이 무더기로 난다.
          잠금이 꺼져 있으면(기본값) 아무것도 그리지 않고 그대로 통과시킨다.
        */}
        <LoginGate>
          <WatchedCodesProvider>
            {/*
              슈퍼신호등 표식 — 어느 화면에서든 같은 종목에 같은 표시가 뜨게
              (2026-08-31). 관심종목 별표와 같은 자리·같은 문법이다.
            */}
            <SuperMarksProvider>
              <App />
            </SuperMarksProvider>
          </WatchedCodesProvider>
        </LoginGate>
      </AppearanceProvider>
    </React.StrictMode>,
  );
});

/*
 * 서비스 워커 등록.
 *
 * 안드로이드 크롬은 **서비스 워커가 있어야 홈 화면 아이콘을 앱으로 만들어 준다.**
 * 없으면 북마크가 되고, 누를 때마다 크롬 탭이 하나씩 새로 열린다.
 *
 * 보안 컨텍스트(HTTPS 또는 localhost)에서만 등록된다 — http 로 접속하면 브라우저가
 * 조용히 거절한다. 그래서 실패해도 아무 일도 하지 않는다. 화면은 그대로 돌아간다.
 */
if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    void navigator.serviceWorker.register("/sw.js").catch(() => undefined);
  });
}
