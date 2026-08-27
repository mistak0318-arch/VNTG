import { themeStrength, type ThemeStrength } from "./themeStrength.js";

/**
 * 테마 브리핑 — **국내와 미국이 같은 이야기를 하는 자리를 찾는다.**
 *
 * ## 왜 필요한가
 *
 * 「미국 SMR 이 먼저 오르고 며칠 뒤 국내 원자력이 따라간다」 같은 흐름은 실제로
 * 있는데, 두 화면이 따로 있으면 사람이 오가며 눈으로 맞춰야 한다. 그 짝을 서버가 맺고,
 * **어느 쪽이 앞서는지**까지 적어 준다.
 *
 * ## 어떻게 짝을 맺나 — 그리고 그 한계
 *
 * 국내와 미국은 **종목이 겹치지 않는다.** 그래서 ETF 역인덱스처럼 구성종목을 뒤집는
 * 방법을 쓸 수 없고, **이름으로 이을 수밖에 없다.** 여기 적힌 사전이 그 이음매다.
 *
 * ⚠️ 그래서 이건 **어림이다.** 사전에 없는 짝은 안 나오고, 이름이 비슷해도 실제
 * 내용이 다를 수 있다. 화면이 「어림」이라고 적는 이유다. 사전을 늘리는 것이 곧
 * 이 화면의 품질이므로, 새 짝이 보이면 여기 한 줄 더하면 된다.
 *
 * 억지로 자동 매칭(형태소·임베딩)을 넣지 않은 이유도 같다 — 틀린 짝이 섞이면
 * 「미국이 앞선다」는 문장 자체를 못 믿게 된다. 조용히 적게 맺는 편이 낫다.
 */

/** 국내 테마명 조각 ↔ 미국 테마명 조각. 부분일치로 찾는다 */
const PAIRS: { label: string; kr: string[]; us: string[] }[] = [
  { label: "반도체", kr: ["반도체"], us: ["반도체"] },
  { label: "원자력·SMR", kr: ["원자력", "SMR"], us: ["전기 유틸리티", "원자력"] },
  { label: "2차전지·배터리", kr: ["2차전지", "전지"], us: ["전기 부품", "자동차"] },
  { label: "바이오·제약", kr: ["바이오", "제약"], us: ["생명 공학", "제약"] },
  { label: "인공지능·소프트웨어", kr: ["인공지능", "AI", "소프트웨어"], us: ["소프트웨어", "IT 서비스"] },
  { label: "블록체인·가상자산", kr: ["가상화폐", "블록체인", "비트코인"], us: ["블록 체인", "암호화폐"] },
  { label: "우주항공·방산", kr: ["우주", "항공", "방산"], us: ["항공우주", "방위"] },
  { label: "로봇", kr: ["로봇"], us: ["기계", "산업 자동화"] },
  { label: "자동차", kr: ["자동차"], us: ["자동차"] },
  { label: "은행·금융", kr: ["은행", "증권", "보험"], us: ["은행", "보험", "투자"] },
  { label: "조선·해운", kr: ["조선", "해운"], us: ["해운", "조선"] },
  { label: "정유·에너지", kr: ["정유", "석유", "가스"], us: ["오일", "가스"] },
  { label: "게임", kr: ["게임"], us: ["게임", "엔터테인먼트"] },
  { label: "미디어·엔터", kr: ["엔터", "미디어", "영화"], us: ["미디어", "엔터테인먼트"] },
  { label: "화장품·소비재", kr: ["화장품"], us: ["개인 용품", "화장품"] },
  { label: "철강·소재", kr: ["철강", "비철"], us: ["금속", "광업"] },
  { label: "통신", kr: ["통신"], us: ["통신"] },
  { label: "건설·부동산", kr: ["건설", "부동산"], us: ["건설", "부동산"] },
];

export interface ThemeLink {
  key: string;
  label: string;
  kr: ThemeStrength | null;
  us: ThemeStrength | null;
  etf: ThemeStrength | null;
  /** 어느 쪽이 앞서는가 — 낼 수 없으면 null */
  lead: "kr" | "us" | null;
  note: string;
}

/** 이름 조각으로 가장 큰 테마 하나를 고른다 — 여럿이면 종목 수가 많은 쪽 */
function pick(rows: ThemeStrength[], words: string[]): ThemeStrength | null {
  const hit = rows.filter((t) => words.some((w) => t.name.includes(w)));
  if (hit.length === 0) return null;
  return hit.sort((a, b) => b.stocks.length - a.stocks.length)[0];
}

export async function themeLinks(): Promise<{ pairs: ThemeLink[]; note: string }> {
  const [kr, us, etf] = await Promise.all([
    themeStrength("kr").then((r) => r.themes),
    themeStrength("us").then((r) => r.themes),
    themeStrength("etf").then((r) => r.themes),
  ]);

  const pairs: ThemeLink[] = [];
  for (const p of PAIRS) {
    const k = pick(kr, p.kr);
    const u = pick(us, p.us);
    const e = pick(etf, p.us);
    // 한쪽도 못 찾으면 짝이 아니다
    if (!k && !u) continue;

    /*
     * 「누가 앞서나」 — **주간 누적으로 견준다.**
     * 오늘 하루로 재면 그날의 노이즈가 그대로 결론이 된다. 미국이 지난 5일 앞섰는데
     * 국내가 아직 안 움직였다면 그게 이 화면이 찾는 그림이다.
     *
     * 미국은 아직 등락률을 못 내므로(주 1회 갱신) 지금은 대개 null 이다 —
     * 그때는 판정하지 않는다. **모르는 것을 아는 척하지 않는다.**
     */
    let lead: "kr" | "us" | null = null;
    let note = "";
    if (k?.w1 != null && u?.w1 != null) {
      const gap = u.w1 - k.w1;
      if (Math.abs(gap) >= 3) {
        lead = gap > 0 ? "us" : "kr";
        note =
          gap > 0
            ? `미국이 주간 ${u.w1.toFixed(1)}% 로 국내(${k.w1.toFixed(1)}%)보다 ${Math.abs(gap).toFixed(1)}%p 앞섭니다 — 국내가 따라가는 구간인지 볼 자리입니다`
            : `국내가 주간 ${k.w1.toFixed(1)}% 로 미국(${u.w1.toFixed(1)}%)보다 앞섭니다`;
      } else {
        note = "주간 흐름이 비슷합니다 — 같이 가는 구간입니다";
      }
    } else if (!u) {
      note = "짝이 될 미국 테마를 못 찾았습니다";
    } else {
      note = "기록이 며칠 더 쌓이면 어느 쪽이 앞서는지 나옵니다";
    }

    pairs.push({ key: p.label, label: p.label, kr: k, us: u, etf: e, lead, note });
  }

  return {
    pairs,
    note:
      "국내와 미국은 종목이 겹치지 않아 **이름으로** 짝을 맺습니다 — 어림입니다. " +
      "앞뒤 판정은 주간 누적으로 하며, 3%p 이상 벌어질 때만 적습니다.",
  };
}
