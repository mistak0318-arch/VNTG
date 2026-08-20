import { useEffect, useState } from "react";

/**
 * 엑셀 모드의 껍데기 — 리본 · 수식 입력줄 · 행번호 · 열문자 · 시트탭.
 *
 * ## 왜 색만 바꾸지 않았나
 *
 * 흰 배경에 격자만 깔면 그냥 **라이트 테마**로 보인다. 멀리서 봐도 주식 화면인 게
 * 그대로 티가 난다. 스프레드시트로 읽히게 만드는 건 색이 아니라 **모양**이다 —
 * 위의 리본, 왼쪽의 숫자 기둥, 아래의 시트 탭. 이 셋이 있으면 안의 내용이 무엇이든
 * 「엑셀 창」으로 먼저 읽힌다.
 *
 * ## 행번호는 스크롤을 따라 흘러야 한다
 *
 * 숫자가 1,2,3… 에 **박혀 있으면** 내용만 움직이는 게 눈에 걸린다. 화면을 내렸는데
 * 행번호가 그대로면 엑셀이 아니라 엑셀 그림이다. 그래서 `scrollY` 를 읽어
 * 첫 행 번호와 픽셀 어긋남을 같이 계산한다.
 *
 * 격자 배경도 **같은 값**으로 밀어 준다. 둘을 따로 계산하면 몇 픽셀씩 어긋나면서
 * 숫자와 줄이 안 맞는데, 그게 제일 먼저 들키는 부분이다.
 *
 * ## 리본은 눌리지 않는다 — 「파일」만 빼고
 *
 * 진짜로 동작하게 만들 수도 없고, 만들 이유도 없다. 다만 **눌러도 아무 일이 없는 것**과
 * 「누를 수 있어 보이는 것」은 다르므로 커서를 기본값으로 두고 클릭을 막았다.
 *
 * **「파일」은 메뉴를 연다.** 진짜 엑셀에서도 파일 탭을 누르면 전체 메뉴가 펼쳐지므로
 * 이 모드에서 메뉴를 여는 자리로 이보다 자연스러운 곳이 없다.
 * 좁은 화면에서 쓰던 **동그란 플로팅 버튼은 엑셀에 없는 물건**이라, 리본을 아무리 잘
 * 그려도 그것 하나로 위장이 깨진다. 엑셀 모드에서는 그 버튼을 내리고 여기로 옮겼다.
 *
 * **시트 탭도 진짜로 동작한다** — 어차피 화면을 옮기는 자리가 필요하고,
 * 엑셀에서도 시트 탭이 하는 일이 그것이다.
 */

/** 한 행의 높이(px). 격자·행번호가 이 값을 공유한다 */
const ROW_H = 22;
/** 한 열의 너비(px) */
const COL_W = 84;
/** 행번호 기둥의 너비(px) */
const GUTTER_W = 38;

/** 「파일」은 메뉴를 여는 자리라 따로 그린다 */
const RIBBON_TABS = [
  "홈",
  "삽입",
  "페이지 레이아웃",
  "수식",
  "데이터",
  "검토",
  "보기",
  "도움말",
];

/** A, B, C … Z, AA, AB … */
function colName(i: number): string {
  let n = i;
  let s = "";
  do {
    s = String.fromCharCode(65 + (n % 26)) + s;
    n = Math.floor(n / 26) - 1;
  } while (n >= 0);
  return s;
}

export interface Sheet {
  key: string;
  label: string;
}

export function ExcelChrome({
  sheets,
  current,
  onGo,
  onMenu,
}: {
  sheets: Sheet[];
  current: string;
  onGo: (key: string) => void;
  /** 「파일」 탭을 누르면 — 이 모드에서 메뉴를 여는 자리다 */
  onMenu: () => void;
}) {
  const [scroll, setScroll] = useState(0);
  const [size, setSize] = useState({ w: window.innerWidth, h: window.innerHeight });

  /*
   * 스크롤을 **두 갈래**로 읽는다.
   *
   * `scroll` 이벤트가 정상이면 그걸로 충분하지만, 이 프로젝트에서 화면을 확인하는
   * 브라우저 창은 화면을 실제로 그리지 않아 스크롤 이벤트가 아예 안 온다.
   * 그때 행번호가 처음 값에 얼어붙는데, **그게 맞는지 틀렸는지 볼 방법이 없어진다.**
   *
   * 그래서 타이머로도 같은 값을 확인한다. 값이 그대로면 `setState` 가 아무 일도
   * 하지 않으므로(같은 숫자면 React 가 다시 그리지 않는다) 가만히 있을 때의 비용은 없다.
   */
  useEffect(() => {
    const sync = () => {
      setScroll(window.scrollY);
      setSize((s) =>
        s.w === window.innerWidth && s.h === window.innerHeight
          ? s
          : { w: window.innerWidth, h: window.innerHeight },
      );
    };
    window.addEventListener("scroll", sync, { passive: true });
    window.addEventListener("resize", sync);
    const t = setInterval(sync, 120);
    sync();
    return () => {
      window.removeEventListener("scroll", sync);
      window.removeEventListener("resize", sync);
      clearInterval(t);
    };
  }, []);

  // 첫 행 번호와 어긋난 픽셀 — 격자와 행번호가 같이 쓴다
  const firstRow = Math.floor(scroll / ROW_H) + 1;
  const offset = -(scroll % ROW_H);

  const rowCount = Math.ceil(size.h / ROW_H) + 2;
  const colCount = Math.ceil(size.w / COL_W) + 1;

  const sheetLabel = sheets.find((s) => s.key === current)?.label ?? current;

  return (
    <>
      {/*
        격자는 내용 **뒤**에 깔린다. 카드가 흰 배경으로 덮으므로 격자는 카드 사이
        빈 곳에서만 보이는데, 엑셀에서도 값이 든 칸은 칸 색이 덮으니 같은 모양이 된다.
      */}
      <div
        className="xl-grid"
        style={{ backgroundPosition: `0 ${offset}px` }}
        aria-hidden="true"
      />

      <div className="xl-chrome" aria-hidden="true">
        <div className="xl-ribbon">
          <div className="xl-ribbon-tabs">
            {/* 진짜 엑셀도 파일 탭에서 전체 메뉴가 열린다 — 이 모드의 메뉴 버튼이다 */}
            <button type="button" className="xl-rtab xl-file" onClick={onMenu}>
              파일
            </button>
            {RIBBON_TABS.map((t) => (
              <span key={t} className={`xl-rtab${t === "홈" ? " active" : ""}`}>
                {t}
              </span>
            ))}
          </div>
          <div className="xl-ribbon-body">
            <div className="xl-rgroup">
              <span className="xl-rbig">📋</span>
              <span className="xl-rname">붙여넣기</span>
            </div>
            <div className="xl-rgroup xl-rfont">
              <div className="xl-rline">
                <span className="xl-rbox">맑은 고딕</span>
                <span className="xl-rbox xl-rnum">11</span>
              </div>
              <div className="xl-rline">
                <span className="xl-rbtn xl-b">가</span>
                <span className="xl-rbtn xl-i">가</span>
                <span className="xl-rbtn xl-u">가</span>
                <span className="xl-rsep" />
                <span className="xl-rbtn">田</span>
                <span className="xl-rbtn">▨</span>
              </div>
              <div className="xl-rname">글꼴</div>
            </div>
            <div className="xl-rgroup xl-rfont">
              <div className="xl-rline">
                <span className="xl-rbtn">≡</span>
                <span className="xl-rbtn">≣</span>
                <span className="xl-rbtn">⇥</span>
              </div>
              <div className="xl-rline">
                <span className="xl-rbox xl-wide">병합하고 가운데 맞춤</span>
              </div>
              <div className="xl-rname">맞춤</div>
            </div>
            <div className="xl-rgroup xl-rfont">
              <div className="xl-rline">
                <span className="xl-rbox xl-wide">일반</span>
              </div>
              <div className="xl-rline">
                <span className="xl-rbtn">₩</span>
                <span className="xl-rbtn">%</span>
                <span className="xl-rbtn">,</span>
                <span className="xl-rbtn">.00</span>
              </div>
              <div className="xl-rname">표시 형식</div>
            </div>
          </div>
        </div>

        {/*
          수식 입력줄. 셀 주소는 **지금 보고 있는 행**을 따라 움직인다 —
          늘 A1 이면 스크롤할 때 안 맞는 게 보인다.
        */}
        <div className="xl-formula">
          <span className="xl-namebox">A{firstRow}</span>
          <span className="xl-fx">fx</span>
          <span className="xl-fbar">
            =VLOOKUP($A{firstRow},'{sheetLabel}'!$A:$H,4,FALSE)
          </span>
        </div>

        <div className="xl-colhead" style={{ paddingLeft: GUTTER_W }}>
          <span className="xl-corner" style={{ width: GUTTER_W }}>
            ◢
          </span>
          {Array.from({ length: colCount }, (_, i) => (
            <span key={i} className="xl-col" style={{ width: COL_W }}>
              {colName(i)}
            </span>
          ))}
        </div>

        <div className="xl-gutter" style={{ width: GUTTER_W }}>
          <div style={{ transform: `translateY(${offset}px)` }}>
            {Array.from({ length: rowCount }, (_, i) => (
              <div key={i} className="xl-row" style={{ height: ROW_H }}>
                {firstRow + i}
              </div>
            ))}
          </div>
        </div>
      </div>

      {/* 시트 탭은 진짜로 화면을 옮긴다 */}
      <div className="xl-sheets">
        <span className="xl-sheet-arrows" aria-hidden="true">
          ◀ ▶
        </span>
        {sheets.map((s) => (
          <button
            key={s.key}
            className={`xl-sheet${s.key === current ? " active" : ""}`}
            onClick={() => onGo(s.key)}
          >
            {s.label}
          </button>
        ))}
        <span className="xl-sheet-plus" aria-hidden="true">
          ＋
        </span>
        <span className="xl-status" aria-hidden="true">
          준비
        </span>
      </div>
    </>
  );
}
