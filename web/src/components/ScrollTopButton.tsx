import { useEffect, useState } from "react";

/**
 * 맨 위로 — **길게 내려간 화면에서만 뜨는 플로팅 단추** (2026-08-29 요청).
 *
 * 데일리 리포트나 개별종목분석은 한 화면이 3만 픽셀을 넘는다. 끝까지 읽고
 * 위로 돌아가려면 손가락으로 한참을 훑어야 했다 — 「스크롤바가 생길 만큼
 * 길어졌을 때」가 정확히 이 단추가 필요한 순간이다.
 *
 * ## 언제 뜨나
 *
 * 두 화면(=보이는 높이의 2배) 넘게 내려갔을 때. 조금 내려간 화면에서는
 * 위로 올리는 게 어렵지 않고, 그때 뜨는 단추는 그냥 가리는 물건이다.
 *
 * ## 어디에 뜨나
 *
 * 오른쪽 아래. 읽는 글은 왼쪽부터 차므로 오른쪽 끝이 제일 덜 가린다.
 * **평소엔 반투명**으로 물러나 있다가 손이 닿으면 진해진다.
 *
 * ⚠️ 텔레그램 방에는 이미 오른쪽 아래에 「방 목록」·「맨 아래로」가 있다.
 * 그 화면에서는 이 단추가 **한 칸 위로 비켜 앉는다**(`.has-room-fab`) —
 * 겹쳐 놓으면 둘 다 못 누른다.
 */
export function ScrollTopButton() {
  const [show, setShow] = useState(false);
  /* 방 화면인가 — 그 화면의 단추들과 자리를 나눠야 한다 */
  const [roomFab, setRoomFab] = useState(false);

  useEffect(() => {
    const check = () => {
      setShow(window.scrollY > window.innerHeight * 2);
      setRoomFab(document.querySelector(".tgr-fab") !== null);
    };
    check();
    window.addEventListener("scroll", check, { passive: true });
    /* 화면이 바뀌면(탭 이동) 길이도 단추 유무도 달라진다 — 잠깐 뒤 다시 잰다 */
    const t = setInterval(check, 1000);
    return () => {
      window.removeEventListener("scroll", check);
      clearInterval(t);
    };
  }, []);

  if (!show) return null;

  return (
    <button
      className={`scroll-top${roomFab ? " has-room-fab" : ""}`}
      onClick={() => {
        /*
         * 3만 픽셀을 스르륵 굴리면 몇 초를 기다리게 된다 — 멀면 즉시 뛴다.
         * 가까울 때만 부드럽게(어디로 갔는지 눈이 따라간다).
         */
        const far = window.scrollY > window.innerHeight * 4;
        window.scrollTo({ top: 0, behavior: far ? "auto" : "smooth" });
      }}
      title="맨 위로"
      aria-label="맨 위로"
    >
      ↑
    </button>
  );
}
