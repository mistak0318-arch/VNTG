import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import { AppearanceProvider } from "./useAppearance";
import { WatchedCodesProvider } from "./useWatchedCodes";
import { loadPrefs } from "./prefs";
import "./styles.css";
import "./overview.css";
/* 엑셀 모드는 색뿐 아니라 모양까지 바꿔서 규칙이 많다 — 파일을 따로 둔다 */
import "./excel.css";

/*
 * **설정을 먼저 받고 그린다.**
 *
 * 설정은 서버에 있고 화면은 localStorage 를 동기로 읽는다. 그려 놓고 값을 채우면
 * 예전 값으로 한 번 그렸다가 바뀌어서 **화면이 튄다** — 테마가 특히 눈에 띈다.
 * 그래서 받아서 채운 다음에 그린다. 서버를 못 읽어도 `loadPrefs` 는 그냥 돌아오므로
 * 이 기기 값으로 평소처럼 뜬다.
 */
void loadPrefs().then(() => {
  ReactDOM.createRoot(document.getElementById("root")!).render(
    <React.StrictMode>
      <AppearanceProvider>
        <WatchedCodesProvider>
          <App />
        </WatchedCodesProvider>
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
