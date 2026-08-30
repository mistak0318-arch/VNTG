import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import sharp from "sharp";

/**
 * 로그인 배경 — 「심연을 유영하는 혹등고래」 (2026-08-30 요청).
 *
 * ## 왜 그림 파일이 아니라 스크립트인가
 *
 * 배경 한 장을 손으로 그려 넣으면 다음에 「골드를 조금만 줄여」 같은 말이 나왔을 때
 * 다시 그릴 방법이 없다. 여기서는 **좌표와 색이 전부 값으로 적혀 있어서** 한 줄
 * 고치고 다시 돌리면 두 해상도가 같이 새로 나온다.
 *
 * 돌리는 법:  node scripts/make-login-bg.mjs      (web/ 에서)
 *
 * ## 구도 — 가운데는 비워 둔다
 *
 * 로그인 칸이 앉을 자리(가로 30~70%, 세로 25~75%)에는 아무것도 안 넣는다. 고래도
 * 광선도 그 밖으로 돌리고, 마지막에 그 영역을 한 번 더 어둡게 덮어 **흰 글자가
 * 반드시 읽히게** 만든다. 배경이 예쁜 것보다 글자가 읽히는 게 먼저다.
 *
 * ## 가로·세로는 자르지 않고 다시 짠다
 *
 * 16:9 를 9:19.5 로 자르면 고래가 통째로 날아간다. 그래서 같은 부품(고래·광선·
 * 궤적)을 **세로 구도에 맞게 다시 배치**한다 — 가로는 고래가 오른쪽에서 비스듬히
 * 올라오고, 세로는 아래쪽에 길게 눕는다.
 *
 * ## 필름 그레인은 sharp 로 얹는다
 *
 * SVG 의 feTurbulence 는 렌더러마다 결과가 달라서(resvg/librsvg) 믿기 어렵다.
 * 그레인만 sharp 로 따로 만들어 overlay 로 덮으면 어디서 굽든 같은 그림이 나온다.
 */

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUT = resolve(__dirname, "..", "public");

/* ── 색 ──────────────────────────────────────────────────────────────────
 * 브리프의 딥네이비 #0A0E19 → 블랙. 중간톤은 다크틸, 포인트는 따뜻한 골드 하나.
 * 골드는 **한 군데만** 쓴다 — 두 군데가 되는 순간 「포인트」가 아니라 무늬가 된다.
 */
const C = {
  deepTop: "#0A0E19",
  deepMid: "#070A12",
  deepBot: "#05070E",
  teal: "#2E6B76",
  tealLit: "#4FA3B0",
  gold: "#C89A4A",
  goldLit: "#E8C27E",
};

/** 씨앗 고정 난수 — 돌릴 때마다 입자가 튀면 「고쳤더니 딴 그림」이 된다 */
function rng(seed) {
  let s = seed >>> 0;
  return () => ((s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 4294967296);
}

/* ── 혹등고래 ────────────────────────────────────────────────────────────
 * 옆모습, 코가 오른쪽. 지역 좌표 1200 × 520.
 *
 * 혹등고래를 혹등고래로 보이게 하는 것은 셋이다: **아주 긴 가슴지느러미**(몸길이의
 * 1/3), 등의 혹과 작은 등지느러미, 그리고 뒤가 톱니처럼 갈라진 꼬리. 이 셋을 살리고
 * 나머지는 뭉갠다 — 미니멀하게 가려면 뺄 것이 아니라 **남길 것**을 골라야 한다.
 */
const WHALE_BODY = `
M 1206,272
C 1204,234 1186,200 1148,177
C 1086,140 998,124 900,120
C 800,117 700,122 620,133
C 560,141 502,149 462,153
C 452,138 443,124 431,113
C 423,130 415,145 395,156
C 339,169 279,185 235,201
C 209,211 189,219 175,227
C 149,207 95,166 29,119
C 13,108 3,115 11,131
C 43,186 83,225 119,249
L 131,257
C 95,283 53,323 13,383
C 3,398 13,404 27,393
C 91,347 139,301 167,277
C 197,269 227,281 269,297
C 359,337 469,367 589,379
C 709,391 829,383 939,357
C 1049,335 1140,314 1184,296
C 1198,290 1206,282 1206,272
Z`.replace(/\s+/g, " ");

/**
 * 가슴지느러미 — **혹등고래의 정체성**이다.
 *
 * 몸길이의 3분의 1에 달하는 이 지느러미가 없으면 그냥 고래이고, 짧으면 돌고래가
 * 된다. 그래서 실루엣에서 제일 길게 뽑는다. 머리 바로 뒤에서 앞아래로 뻗는다.
 */
const WHALE_FIN = `
M 872,326
C 936,376 1032,454 1122,532
C 1138,546 1128,562 1110,550
C 1010,484 900,398 848,342
Z`.replace(/\s+/g, " ");

/**
 * 몸 안의 데이터 입자.
 *
 * 실루엣을 통째로 칠하면 「검은 고래」고, 입자로 채우면 **어둠 속에서 떠오르는**
 * 느낌이 된다. 그래서 위쪽 가장자리와 머리 쪽을 밝게, 꼬리로 갈수록 성기게 둔다 —
 * 빛이 위에서 오니까 그게 자연스럽고, 시선도 머리로 모인다.
 */
function particles(seed, n) {
  const r = rng(seed);
  const out = [];
  for (let i = 0; i < n; i += 1) {
    const x = r() * 1200;
    const y = 90 + r() * 330;

    /* 머리(오른쪽)로 갈수록, 위로 갈수록 밝게 */
    const head = Math.pow(x / 1200, 1.5);
    const top = Math.pow(1 - (y - 90) / 330, 1.8);
    const lit = Math.min(1, head * 0.55 + top * 0.75);

    const op = (0.06 + lit * 0.62) * (0.45 + r() * 0.55);
    if (op < 0.05) continue;
    const rad = 0.9 + r() * 2.1 + lit * 1.6;
    /* 골드는 아주 드물게 — 머리 근처에만 몇 알 */
    const isGold = head > 0.72 && r() > 0.9;
    out.push(
      `<circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="${rad.toFixed(2)}" fill="${
        isGold ? C.goldLit : C.tealLit
      }" opacity="${op.toFixed(3)}"/>`,
    );
  }
  return out.join("");
}

/** 머리 위의 혹(tubercle) — 실제 혹등고래의 표식. 입자 몇 알로만 암시한다 */
function tubercles() {
  const pts = [
    [1150, 232],
    [1120, 217],
    [1086, 204],
    [1050, 193],
    [1012, 185],
    [972, 179],
    [930, 176],
  ];
  return pts
    .map(
      ([x, y], i) =>
        `<circle cx="${x}" cy="${y}" r="${(3.4 - i * 0.18).toFixed(2)}" fill="${C.tealLit}" opacity="${(
          0.5 -
          i * 0.045
        ).toFixed(3)}"/>`,
    )
    .join("");
}

/**
 * 고래 한 덩이. `id` 로 그라디언트 이름을 나눠서 가로·세로 두 장이 서로 안 섞이게 한다.
 */
function whale(id, transform, seed) {
  /*
   * 윤곽을 **점선으로** 긋는다.
   *
   * `stroke-dasharray="0 N"` + `linecap="round"` 은 선 대신 **동그란 점을 N 간격으로**
   * 찍는다. 실루엣을 실선으로 두르면 스티커처럼 오려 붙인 티가 나는데, 점으로 두르면
   * 「입자가 모여 형태가 된」 것으로 읽힌다. 브리프가 말한 게 그것이다.
   *
   * 실선 림라이트를 아주 옅게 한 겹 깔아 점들이 흩어져 보이지 않게 묶어 준다.
   */
  const dotted = (d, w, gap, op, grad = "rim") =>
    `<path d="${d}" fill="none" stroke="url(#${id}-${grad})" stroke-width="${w}"
       stroke-dasharray="0 ${gap}" stroke-linecap="round" opacity="${op}"/>`;

  return `
<g transform="${transform}">
  <!-- 지느러미가 몸보다 뒤 — 반대로 두면 몸 위에 얹힌 판때기로 보인다 -->
  <path d="${WHALE_FIN}" fill="url(#${id}-fin)" opacity="0.7"/>
  <g filter="url(#${id}-soft)" opacity="0.5">${dotted(WHALE_FIN, 6.5, 15, 1, "finrim")}</g>
  ${dotted(WHALE_FIN, 4.2, 12, 0.95, "finrim")}
  ${dotted(WHALE_FIN, 2, 6, 0.4, "finrim")}

  <!-- 몸통은 **거의 안 칠한다**. 바탕보다 아주 조금 밝은 덩어리로만 존재해서
       입자가 없는 곳에도 「뭔가 있다」는 느낌만 남긴다 -->
  <path d="${WHALE_BODY}" fill="url(#${id}-body)" opacity="0.55"/>

  <g clip-path="url(#${id}-clip)">${particles(seed, 900)}</g>
  <g clip-path="url(#${id}-clip)">${tubercles()}</g>

  <!-- 윤곽 — 굵은 점 위에 잔 점을 겹쳐 밀도가 고르지 않게 -->
  <g filter="url(#${id}-soft)" opacity="0.55">${dotted(WHALE_BODY, 7, 17, 1)}</g>
  ${dotted(WHALE_BODY, 4.6, 15, 0.92)}
  ${dotted(WHALE_BODY, 2.2, 7, 0.42)}

  <!-- 등을 훑는 실선 한 겹 — 점들을 하나의 형태로 묶는다 -->
  <path d="${WHALE_BODY}" fill="none" stroke="url(#${id}-rim)" stroke-width="1"
        opacity="0.22"/>
</g>`;
}

/**
 * 완만히 상승하는 빛의 궤적.
 *
 * 「성공에 대한 확신」을 그림으로 옮기면 결국 **꺾이지 않고 올라가는 선**이다.
 * 다만 캔들차트는 빼라고 했으므로 눈금도 축도 없이 빛줄기 하나로만 둔다.
 */
function trail(id, d, width) {
  return `
<path d="${d}" fill="none" stroke="url(#${id}-trail)" stroke-width="${width * 5}"
      filter="url(#${id}-soft)" opacity="0.35" stroke-linecap="round"/>
<path d="${d}" fill="none" stroke="url(#${id}-trail)" stroke-width="${width}"
      opacity="0.75" stroke-linecap="round"/>`;
}

/** 궤적을 따라 흩어지는 입자 — 선만 있으면 그냥 선이다 */
function trailDust(seed, pts, spread, n) {
  const r = rng(seed);
  const out = [];
  for (let i = 0; i < n; i += 1) {
    const t = r();
    /* 3차 베지어 위의 점 */
    const [p0, p1, p2, p3] = pts;
    const u = 1 - t;
    const x = u * u * u * p0[0] + 3 * u * u * t * p1[0] + 3 * u * t * t * p2[0] + t * t * t * p3[0];
    const y = u * u * u * p0[1] + 3 * u * u * t * p1[1] + 3 * u * t * t * p2[1] + t * t * t * p3[1];
    const dx = (r() - 0.5) * spread;
    const dy = (r() - 0.5) * spread * 0.55;
    const op = (0.06 + r() * 0.3) * (0.35 + t * 0.65);
    out.push(
      `<circle cx="${(x + dx).toFixed(1)}" cy="${(y + dy).toFixed(1)}" r="${(0.8 + r() * 2).toFixed(
        2,
      )}" fill="${r() > 0.93 ? C.goldLit : C.tealLit}" opacity="${op.toFixed(3)}"/>`,
    );
  }
  return out.join("");
}

/** 위에서 내려오는 볼류메트릭 광선. 넓게 퍼지면서 옅어진다 */
function beam(id, x1, x2, x3, x4, yTop, yBot, op) {
  return `<path d="M ${x1},${yTop} L ${x2},${yTop} L ${x4},${yBot} L ${x3},${yBot} Z"
    fill="url(#${id}-beam)" opacity="${op}" filter="url(#${id}-haze)"/>`;
}

function defs(id, W, H, opts) {
  return `
<defs>
  <!--
    바탕: 딥네이비에서 블랙으로.
    ⚠️ 밝은 쪽이 **광원과 같은 쪽**이어야 한다. 처음엔 왼쪽 위를 밝게 뒀는데, 거기가
    하필 로그인 칸 자리라 카드 뒤가 뿌옇게 떴다. 빛은 오른쪽 위에서 오므로 밝은
    끝도 그쪽이다 — 그러면 왼쪽은 저절로 깊어지고 글자가 앉을 자리가 조용해진다.
  -->
  <linearGradient id="${id}-deep" x1="${opts.deepX1}" y1="0" x2="${opts.deepX2}" y2="1">
    <stop offset="0" stop-color="${C.deepTop}"/>
    <stop offset="0.55" stop-color="${C.deepMid}"/>
    <stop offset="1" stop-color="${C.deepBot}"/>
  </linearGradient>

  <linearGradient id="${id}-body" x1="0" y1="0" x2="0.25" y2="1">
    <stop offset="0" stop-color="#16323A" stop-opacity="0.92"/>
    <stop offset="0.5" stop-color="#0C1A20" stop-opacity="0.9"/>
    <stop offset="1" stop-color="#05090D" stop-opacity="0.96"/>
  </linearGradient>
  <linearGradient id="${id}-fin" x1="0" y1="0" x2="0.4" y2="1">
    <stop offset="0" stop-color="#12272E" stop-opacity="0.85"/>
    <stop offset="1" stop-color="#04070B" stop-opacity="0.95"/>
  </linearGradient>

  <!-- 림라이트: 등은 밝고 배로 갈수록 사라진다 -->
  <linearGradient id="${id}-rim" x1="0.15" y1="0" x2="0.5" y2="1">
    <stop offset="0" stop-color="${C.goldLit}" stop-opacity="0.55"/>
    <stop offset="0.22" stop-color="${C.tealLit}" stop-opacity="0.75"/>
    <stop offset="0.6" stop-color="${C.teal}" stop-opacity="0.18"/>
    <stop offset="1" stop-color="${C.teal}" stop-opacity="0"/>
  </linearGradient>

  <!--
    지느러미 전용 광.
    ⚠️ 처음엔 몸통 림라이트를 같이 썼는데, 그 그라디언트는 **아래로 갈수록 투명**해서
    (등만 밝히려고 그렇게 만들었다) 몸 아래로 뻗는 지느러미가 통째로 사라졌다.
    혹등고래에서 제일 알아보기 쉬운 부위가 안 보이니 그냥 물고기가 됐다.
  -->
  <linearGradient id="${id}-finrim" x1="0" y1="0" x2="0.7" y2="1">
    <stop offset="0" stop-color="${C.tealLit}" stop-opacity="0.7"/>
    <stop offset="0.55" stop-color="${C.teal}" stop-opacity="0.45"/>
    <stop offset="1" stop-color="${C.teal}" stop-opacity="0.22"/>
  </linearGradient>

  <linearGradient id="${id}-trail" x1="0" y1="1" x2="1" y2="0">
    <stop offset="0" stop-color="${C.teal}" stop-opacity="0"/>
    <stop offset="0.45" stop-color="${C.tealLit}" stop-opacity="0.55"/>
    <stop offset="1" stop-color="${C.goldLit}" stop-opacity="0.8"/>
  </linearGradient>

  <linearGradient id="${id}-beam" x1="0" y1="0" x2="0" y2="1">
    <stop offset="0" stop-color="${C.tealLit}" stop-opacity="0.16"/>
    <stop offset="0.45" stop-color="${C.teal}" stop-opacity="0.07"/>
    <stop offset="1" stop-color="${C.teal}" stop-opacity="0"/>
  </linearGradient>

  <!-- 따뜻한 골드 포인트 조명 하나 -->
  <!-- 가운데를 밝게 몰면 가로등이 된다. 아주 옅게 넓게 퍼뜨려 **공기가 따뜻한**
       느낌만 남긴다 — 광원이 보이는 게 아니라 광원이 있다는 것만 알면 된다 -->
  <radialGradient id="${id}-gold">
    <stop offset="0" stop-color="${C.goldLit}" stop-opacity="0.17"/>
    <stop offset="0.3" stop-color="${C.gold}" stop-opacity="0.1"/>
    <stop offset="0.62" stop-color="${C.gold}" stop-opacity="0.04"/>
    <stop offset="1" stop-color="${C.gold}" stop-opacity="0"/>
  </radialGradient>

  <!-- 가운데를 덮어 글자가 읽히게 만드는 층 -->
  <!--
    ⚠️ 이 층의 **가장자리가 캔버스 안에서 끝나면 안 된다.**
    처음엔 화면보다 작은 타원으로 덮었는데, 어두워지는 끝선이 왼쪽에 **달무리 같은
    원**으로 드러났다. 배경에 동그란 테두리가 보이는 순간 「그림」이 아니라 「도형」이
    된다. 그래서 화면 밖까지 넉넉히 키우고 아주 천천히 옅어지게 둔다.
  -->
  <radialGradient id="${id}-calm">
    <stop offset="0" stop-color="${C.deepBot}" stop-opacity="0.6"/>
    <stop offset="0.45" stop-color="${C.deepBot}" stop-opacity="0.4"/>
    <stop offset="0.75" stop-color="${C.deepBot}" stop-opacity="0.16"/>
    <stop offset="1" stop-color="${C.deepBot}" stop-opacity="0"/>
  </radialGradient>

  <!-- 비네트는 **아주 일찍 시작해 아주 천천히** 진해져야 한다. 늦게 시작하면
       그 경계가 동그란 테두리로 보인다(실제로 왼쪽에 달무리 같은 원이 생겼다) -->
  <radialGradient id="${id}-vig">
    <stop offset="0" stop-color="#000" stop-opacity="0"/>
    <stop offset="0.45" stop-color="#000" stop-opacity="0.1"/>
    <stop offset="0.75" stop-color="#000" stop-opacity="0.33"/>
    <stop offset="1" stop-color="#000" stop-opacity="0.62"/>
  </radialGradient>

  <!-- 얕은 심도: 먼 것일수록 흐리다 -->
  <filter id="${id}-soft" x="-30%" y="-30%" width="160%" height="160%">
    <feGaussianBlur stdDeviation="${opts.soft}"/>
  </filter>
  <filter id="${id}-haze" x="-40%" y="-20%" width="180%" height="140%">
    <feGaussianBlur stdDeviation="${opts.haze}"/>
  </filter>
  <filter id="${id}-far" x="-30%" y="-30%" width="160%" height="160%">
    <feGaussianBlur stdDeviation="${opts.far}"/>
  </filter>

  <clipPath id="${id}-clip"><path d="${WHALE_BODY}"/></clipPath>
</defs>`;
}

/* ── 가로 2560 × 1440 ───────────────────────────────────────────────────
 * 고래는 오른쪽 아래에서 비스듬히 올라와 오른쪽 프레임 밖으로 나간다.
 * 광선은 오른쪽 위에서 내려와 고래를 감싸고, 궤적은 왼쪽 아래에서 고래 머리로 오른다.
 * 가운데(768~1792 × 360~1080)에는 아무것도 두지 않는다.
 */
function wide() {
  const W = 2560;
  const H = 1440;
  const id = "w";
  const trailPts = [
    [60, 1330],
    [700, 1300],
    [1240, 1210],
    [1720, 1010],
  ];
  const td = `M ${trailPts[0]} C ${trailPts[1]} ${trailPts[2]} ${trailPts[3]}`.replace(/,/g, " ").replace(
    /(\d) (\d)/g,
    "$1,$2",
  );
  const d = `M ${trailPts[0][0]},${trailPts[0][1]} C ${trailPts[1][0]},${trailPts[1][1]} ${trailPts[2][0]},${trailPts[2][1]} ${trailPts[3][0]},${trailPts[3][1]}`;
  void td;

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">
${defs(id, W, H, { deepX1: 1, deepX2: 0.15, soft: 9, haze: 24, far: 16 })}
  <rect width="${W}" height="${H}" fill="url(#${id}-deep)"/>

  <!--
    광선 — 오른쪽 위에서만. 왼쪽으로 번지면 로그인 칸 뒤가 얼룩진다.
    ⚠️ 넓은 사다리꼴에 큰 블러를 먹이면 **빛줄기가 아니라 얼룩**이 된다. 좁게 시작해
    길게 내려가야 방향이 읽힌다 — 빛은 퍼지는 게 아니라 가는 것이다.
  -->
  <!--
    ⚠️ 넷을 촘촘히 세웠더니 **각진 세로 띠**가 되어 화면에 패널이 붙은 것처럼 보였다.
    빛줄기는 개수가 아니라 **기울기와 간격**으로 읽힌다. 둘로 줄이고, 눕히고,
    사이를 넓게 벌린다.
  -->
  <g>
    ${beam(id, 1900, 2010, 1420, 1610, -100, 1560, 0.34)}
    ${beam(id, 2330, 2420, 1960, 2120, -100, 1560, 0.26)}
  </g>

  <!-- 따뜻한 골드 포인트 **하나**. 고래 등 위쪽에서 비스듬히 -->
  <ellipse cx="2210" cy="560" rx="720" ry="600" fill="url(#${id}-gold)"/>

  <!-- 상승 궤적 — 고래 뒤로 지나간다 -->
  <g>${trail(id, d, 3.2)}</g>
  <g filter="url(#${id}-far)">${trailDust(20260830, trailPts, 90, 240)}</g>

  <!-- 고래: **완만히** 올라간다(-16°). 가파르면 솟구치는 그림이 되어
       「흔들림 없는 확신」이 아니라 흥분이 된다. 머리만 오른쪽으로 빠져나간다 -->
  ${whale(id, "translate(1150 1000) rotate(-16) scale(1.05)", 77001)}

  <!-- 멀리 떠 있는 미세 입자 — 물속이라는 것을 알려 주는 최소한의 단서 -->
  <g filter="url(#${id}-far)">${dust(31337, W, H, 150, [768, 360, 1792, 1080])}</g>

  <!-- 가운데 비우기 → 비네트 순서로 덮는다 -->
  <ellipse cx="${W / 2}" cy="${H / 2}" rx="1560" ry="1080" fill="url(#${id}-calm)"/>
  <rect width="${W}" height="${H}" fill="url(#${id}-vig)"/>
</svg>`;
}

/* ── 세로 1170 × 2532 ───────────────────────────────────────────────────
 * 자른 것이 아니라 다시 짠다. 고래는 아래쪽에 거의 눕고 왼쪽 프레임 밖으로 빠진다.
 * 광선은 위에서 곧게 내려오고, 궤적은 왼쪽 아래에서 오른쪽 위로 오른다.
 * 가운데(351~819 × 633~1899)를 비운다.
 */
function tall() {
  const W = 1170;
  const H = 2532;
  const id = "t";
  const trailPts = [
    [-40, 2330],
    [300, 2270],
    [640, 2160],
    [980, 1935],
  ];
  const d = `M ${trailPts[0][0]},${trailPts[0][1]} C ${trailPts[1][0]},${trailPts[1][1]} ${trailPts[2][0]},${trailPts[2][1]} ${trailPts[3][0]},${trailPts[3][1]}`;

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">
${defs(id, W, H, { deepX1: 0.9, deepX2: 0.1, soft: 7, haze: 22, far: 13 })}
  <rect width="${W}" height="${H}" fill="url(#${id}-deep)"/>

  <!-- 광선 — 세로 화면이라 덜 눕는다. 가로판과 같은 이유로 **둘만** 쓴다 -->
  <g>
    ${beam(id, 600, 690, 400, 520, -100, 2200, 0.34)}
    ${beam(id, 930, 1010, 790, 900, -100, 2200, 0.26)}
  </g>

  <ellipse cx="880" cy="1720" rx="430" ry="430" fill="url(#${id}-gold)"/>

  <g>${trail(id, d, 2.6)}</g>
  <g filter="url(#${id}-far)">${trailDust(20260831, trailPts, 62, 200)}</g>

  <!-- 고래: 아래쪽에 길게. 왼쪽으로 빠져나간다 -->
  ${whale(id, "translate(-30 1980) rotate(-9) scale(1.02)", 77002)}

  <g filter="url(#${id}-far)">${dust(60613, W, H, 130, [351, 633, 819, 1899])}</g>

  <ellipse cx="${W / 2}" cy="1250" rx="900" ry="1500" fill="url(#${id}-calm)"/>
  <rect width="${W}" height="${H}" fill="url(#${id}-vig)"/>
</svg>`;
}

/**
 * 화면에 흩어진 미세 입자.
 *
 * `keepOut` 안에는 안 뿌린다 — 가운데를 「비교적 균일하고 어둡게」 두라는 것이
 * 구도의 첫 번째 조건이고, 입자 몇 알이 거기 떠 있으면 그게 곧 디테일이다.
 */
function dust(seed, W, H, n, keepOut) {
  const r = rng(seed);
  const [kx1, ky1, kx2, ky2] = keepOut;
  const out = [];
  for (let i = 0; i < n; i += 1) {
    const x = r() * W;
    const y = r() * H;
    if (x > kx1 && x < kx2 && y > ky1 && y < ky2) continue;
    out.push(
      `<circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="${(0.7 + r() * 1.9).toFixed(2)}" fill="${
        r() > 0.92 ? C.goldLit : C.tealLit
      }" opacity="${(0.04 + r() * 0.17).toFixed(3)}"/>`,
    );
  }
  return out.join("");
}

/**
 * 굽기 — SVG → PNG, 그 위에 필름 그레인.
 *
 * 그레인을 `overlay` 로 얹으면 어두운 데는 거의 안 보이고 중간톤에서만 살아난다.
 * 그게 실제 필름이 하는 일이라 「깨끗한 벡터」 티를 지우는 데 이만한 게 없다.
 */
async function bake(svg, name, W, H) {
  writeFileSync(resolve(OUT, `${name}.svg`), svg);

  const base = await sharp(Buffer.from(svg)).png().toBuffer();
  const grain = await sharp({
    create: {
      width: W,
      height: H,
      channels: 3,
      background: { r: 128, g: 128, b: 128 },
      noise: { type: "gaussian", mean: 128, sigma: 9 },
    },
  })
    .png()
    .toBuffer();

  await sharp(base)
    .composite([{ input: grain, blend: "overlay" }])
    .png({ quality: 92, compressionLevel: 9 })
    .toFile(resolve(OUT, `${name}.png`));

  return resolve(OUT, `${name}.png`);
}

mkdirSync(OUT, { recursive: true });
const a = await bake(wide(), "login-bg-wide", 2560, 1440);
const b = await bake(tall(), "login-bg-tall", 1170, 2532);
console.log("만들었다:\n  " + a + "\n  " + b);
