/*
 * 서비스 워커.
 *
 * 있는 이유는 하나다 — **안드로이드 크롬이 이게 있어야 "앱으로 설치"를 시켜 준다.**
 * 없으면 홈 화면 아이콘이 그냥 북마크가 되고, 누를 때마다 크롬 탭이 하나씩 새로 열린다.
 *
 * 그래서 **캐시는 최소한만** 한다. HTS 에서 낡은 값을 보여 주는 건 안 보여 주는 것보다
 * 나쁘다 — 어제 종가를 오늘 현재가로 착각하면 판단이 통째로 틀어진다.
 *
 *   · `/api/` 는 **절대 캐시하지 않는다.** 손도 대지 않고 통과시킨다
 *   · 앱 껍데기(HTML·JS·CSS·아이콘)만 담아 두되 **네트워크를 먼저** 본다.
 *     새 버전을 받으면 그걸 쓰고, 網이 끊겼을 때만 담아 둔 걸 꺼낸다
 *
 * 미니PC 를 업데이트하면 파일 이름(해시)이 바뀌므로 낡은 껍데기는 아래에서 지운다.
 */

const CACHE = "vntg-shell-v1";

self.addEventListener("install", (e) => {
  // 새 워커가 즉시 일하게 한다 — 업데이트가 한 박자 늦게 먹는 걸 막는다
  self.skipWaiting();
  e.waitUntil(
    caches.open(CACHE).then((c) =>
      c.addAll(["./", "./index.html", "./manifest.json", "./icon-192.png"]).catch(() => undefined),
    ),
  );
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener("fetch", (e) => {
  const req = e.request;
  if (req.method !== "GET") return;

  const url = new URL(req.url);
  // 시세·수급은 늘 새것이어야 한다. 캐시에 얼씬도 못 하게 한다
  if (url.pathname.startsWith("/api/")) return;
  // 다른 출처(야후 이미지 등)는 우리 소관이 아니다
  if (url.origin !== self.location.origin) return;

  e.respondWith(
    fetch(req)
      .then((res) => {
        // 받은 김에 껍데기를 갱신해 둔다. 실패해도 응답은 그대로 돌려준다
        if (res.ok) {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put(req, copy)).catch(() => undefined);
        }
        return res;
      })
      .catch(async () => {
        // 網이 끊겼을 때만 여기로 온다
        const hit = await caches.match(req);
        if (hit) return hit;
        // SPA 라 어떤 경로로 들어와도 index.html 이 진입점이다
        if (req.mode === "navigate") {
          const shell = await caches.match("./index.html");
          if (shell) return shell;
        }
        return new Response("오프라인입니다", {
          status: 503,
          headers: { "content-type": "text/plain; charset=utf-8" },
        });
      }),
  );
});
