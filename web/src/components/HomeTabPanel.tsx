import { useState } from "react";
import { HOME_TAB_KEY, MENU_ITEMS, homeTab } from "../App";
import { setPref } from "../prefs";

/**
 * **시작 화면 고르기** (2026-11-16).
 *
 * 벤티지: "시작화면이 왜 맨날 마켓 브리핑이야. 시황 대시보드로 할 수 있게 해줘.
 * 아니면 옵션에서 설정할 수 있게 만들어주던가."
 *
 * 「시황 대시보드로 바꿔 달라」가 아니라 **고르게 해 달라**로 읽었다. 둘 중 하나만
 * 박아 두면 다음에 또 같은 말을 하게 된다.
 *
 * ## 왜 메뉴 전체를 보여 주나
 *
 * 시작 화면이 될 만한 것을 내가 추려서 넷쯤 내놓을 수도 있었다. 그런데 그 추림은
 * **내 짐작**이고, 벤티지가 아침에 제일 먼저 여는 게 「주도주」일 수도 「항해일지」일
 * 수도 있다. 메뉴에 있는 것은 전부 고를 수 있게 둔다 — 고르는 쪽이 아는 일이다.
 *
 * ⚠️ 주소에 화면이 적혀 있으면(새로고침·즐겨찾기·링크) **그쪽이 이긴다.** 이 설정은
 * 주소가 비었을 때만 쓰인다(`useHashRoute` 의 fallback). 그래야 링크를 눌러 들어온
 * 사람이 엉뚱한 화면으로 끌려가지 않는다.
 */
export function HomeTabPanel() {
  const [tab, setTab] = useState(homeTab);
  const [said, setSaid] = useState("");

  const pick = (key: string) => {
    setTab(key);
    /* 전역으로 — 기기를 옮겨도 따라온다(`prefs.ts`). 글자 크기·테마와 같은 층이다 */
    setPref(HOME_TAB_KEY, key);
    const label = MENU_ITEMS.find((m) => m.key === key)?.label ?? key;
    setSaid(`다음에 열 때 「${label}」로 시작합니다.`);
  };

  /* 그룹별로 묶어 보여 준다 — 사이드바와 같은 덩어리라 눈이 찾던 자리에서 찾는다 */
  const groups = [...new Set(MENU_ITEMS.map((m) => m.group))];

  return (
    <div className="home-tab">
      {groups.map((g) => (
        <div className="home-tab-g" key={g}>
          <div className="home-tab-gn">{g}</div>
          <div className="home-tab-row">
            {MENU_ITEMS.filter((m) => m.group === g).map((m) => (
              <button
                type="button"
                key={m.key}
                className={`filter-btn${tab === m.key ? " active" : ""}`}
                onClick={() => pick(m.key)}
              >
                <span aria-hidden>{m.icon}</span> {m.label}
              </button>
            ))}
          </div>
        </div>
      ))}
      {said && <div className="home-tab-said">{said}</div>}
      <div className="table-note">
        주소에 화면이 적혀 있으면(새로고침·즐겨찾기·링크) <b>그쪽이 우선</b>입니다 — 이 설정은 주소 없이
        들어올 때만 쓰입니다. 처음 켜는 기기에서는 서버 설정이 아직 안 내려와 한 번은 예전 화면으로 뜰 수
        있습니다.
      </div>
    </div>
  );
}
