/**
 * 키움 해외 관심그룹을 미국 관심종목으로 옮긴다.
 *
 * 티커는 **손으로 적지 않고** Yahoo 검색으로 해석한다 — 화면에 한글 이름만 있어서
 * 티커를 외워 적으면 틀리기 쉽다. 못 찾은 것은 지우지 않고 끝에 모아 보고한다.
 *
 *   node scripts/seed-us-watch.mjs          — 미리보기
 *   node scripts/seed-us-watch.mjs --write  — 실제로 담는다
 */
const API = process.env.VNTG_API ?? "http://localhost:4000";

/** [그룹명, 메모, [화면이름 → 검색어]] */
const GROUPS = [
  ["빅테크", "ACE 미국빅테크TOP7Plus", {
    "엔비디아":"NVIDIA","알파벳 A":"GOOGL","아마존닷컴":"Amazon",
    "애플":"Apple","마이크로소프트":"Microsoft","브로드컴":"Broadcom","메타 플랫폼스":"Meta Platforms",
    "넷플릭스":"Netflix","테슬라":"Tesla","팔란티어 테크":"Palantir" }],
  ["시장 주도주", "KoAct 미국나스닥성장기업액티브", {
    "마이크론 테크놀로지":"Micron Technology","코어위브":"CoreWeave","블룸 에너지":"Bloom Energy",
    "오클로":"Oklo","뉴스케일 파워":"NuScale Power","버티브 홀딩스":"Vertiv Holdings",
    "GE베르노바":"GE Vernova","루멘텀 홀딩스":"Lumentum","코히어런트":"Coherent Corp",
    "샌디스크":"SanDisk","인텔":"Intel","웨스턴 디지털":"Western Digital",
    "어플라이드 옵토일렉":"Applied Optoelectronics","시에나":"Ciena","코닝":"Corning",
    "에이피알엠 홀딩스":"Arm Holdings","레딧":"Reddit" }],
  ["반도체", "KODEX 미국반도체", {
    "엔비디아":"NVIDIA","SK하이닉스(ADR)":"SK Hynix","마이크론 테크놀로지":"Micron Technology",
    "샌디스크":"SanDisk","램 리서치":"Lam Research","어플라이드 머티리얼":"Applied Materials",
    "TSMC(ADR)":"Taiwan Semiconductor","마벨 테크놀로지 그룹":"Marvell Technology",
    "브로드컴":"Broadcom","퀄컴":"Qualcomm","AMD":"Advanced Micro Devices","케이엘에이":"KLA Corp",
    "ASML 홀딩(ADR)":"ASML Holding","텍사스 인스트루먼츠":"Texas Instruments","시놉시스":"Synopsys",
    "인텔":"Intel","델 테크놀로지스":"Dell Technologies","IBM":"IBM" }],
  ["원자력·SMR", "ACE 미국SMR원자력TOP10", {
    "오클로":"Oklo","뉴스케일 파워":"NuScale Power","X-에너지":"X Energy","센트러스 에너지":"Centrus Energy",
    "카메코":"Cameco","GE베르노바":"GE Vernova","컨스틀레이션 에너지":"Constellation Energy",
    "비스트라 에너지":"VST","BWX 테크놀로지스":"BWX Technologies","에너지 퓨얼스":"UUUU",
    "우라늄 에너지":"Uranium Energy" }],
  ["전력인프라", "SOL 미국AI전력인프라", {
    "버티브 홀딩스":"Vertiv Holdings","오클로":"Oklo","GE베르노바":"GE Vernova",
    "이턴 코퍼레이션":"Eaton Corp","콴타 서비시스":"Quanta Services","컨스틀레이션 에너지":"Constellation Energy",
    "블룸 에너지":"Bloom Energy","엔터지":"Entergy","비스트라 에너지":"VST","카메코":"Cameco" }],
  ["우주항공", "TIGER 미국우주테크", {
    "레드와이어":"Redwire","인튜이티브 머신스":"Intuitive Machines",
    "로켓 랩":"Rocket Lab","AST 스페이스모바일":"AST SpaceMobile","플래닛 랩스":"Planet Labs",
    "바이샛":"Viasat","글로벌스타":"Globalstar","MDA 스페이스":"MDA Space",
    "파이어플라이 에어로":"Firefly Aerospace","요크 스페이스 시스템":"York Space",
    "블랙스카이 테크놀로":"BlackSky Technology" }],
  ["로봇", "KoAct 미국로봇피지컬AI액티브", {
    "테슬라":"Tesla","인튜이티브 서지컬":"Intuitive Surgical","애널로그 디바이시스":"Analog Devices",
    "테라다인":"Teradyne","플렉스":"Flex Ltd","캐터필러":"Caterpillar","아우스터":"Ouster",
    "서브 로보틱스":"Serve Robotics","팀켄":"Timken" }],
  ["양자", "PLUS 미국양자컴퓨팅TOP10", {
    "IBM":"IBM","아이온큐":"IonQ","퀀텀 컴퓨팅":"Quantum Computing Inc","리게티 컴퓨팅":"Rigetti Computing" }],
  ["리튬·2차전지", "", {
    "리튬 배터리 글로벌엑":"Global X Lithium","리오 틴토(ADR)":"Rio Tinto","에너시스":"EnerSys",
    "알버말":"Albemarle","플루언스 에너지":"Fluence Energy","테슬라":"Tesla" }],
  ["바이오", "KoAct 미국바이오헬스케어액티브", {
    "머크":"Merck & Co","할로자임 테라퓨틱스":"Halozyme Therapeutics","길리어드 사이언스":"Gilead Sciences",
    "버텍스 파마슈티컬":"Vertex Pharmaceuticals","암젠":"Amgen","아제닉스(ADR)":"argenx",
    "레볼루션 메디신":"Revolution Medicines","바이오젠":"Biogen","나테라":"Natera",
    "비원 메디신(ADR)":"BioNTech","모더나":"Moderna","앨나일람 파마슈티컬":"Alnylam Pharmaceuticals",
    "인사이트":"Incyte","젠맵(ADR)":"Genmab","서밋 테라퓨틱스":"Summit Therapeutics" }],
];

/*
 * 검색 결과 첫 줄을 그냥 쓰면 엉뚱한 회사가 들어간다 — 실제로 "Energy Fuels" 를 치면
 * Clean Energy Fuels(CLNE) 가 먼저 나왔다. 티커가 확실한 것은 티커로 직접 찾는다.
 */
async function search(q) {
  const r = await fetch(`${API}/api/us-watch/search?q=${encodeURIComponent(q)}`);
  const { results = [] } = await r.json();
  return results[0] ?? null;
}

const write = process.argv.includes("--write");
const missing = [];
let total = 0;

for (const [name, memo, map] of GROUPS) {
  const picked = [];
  for (const [shown, query] of Object.entries(map)) {
    const hit = await search(query);
    if (!hit) { missing.push(`${name} / ${shown} (검색어: ${query})`); continue; }
    picked.push({ symbol: hit.symbol, name: shown, found: hit.name });
    await new Promise((r) => setTimeout(r, 120));
  }
  total += picked.length;
  console.log(`${name.padEnd(14)} ${picked.length}/${Object.keys(map).length}  ${picked.map(p=>p.symbol).join(" ")}`);

  if (write) {
    const g = await (await fetch(`${API}/api/us-watch/groups`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name, memo }),
    })).json();
    const raw = await (await fetch(`${API}/api/us-watch/raw`)).json();
    const id = raw.groups[raw.groups.length - 1].id;
    for (const p of picked) {
      await fetch(`${API}/api/us-watch/groups/${id}/stocks`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ symbol: p.symbol, name: p.name }),
      });
      await new Promise((r) => setTimeout(r, 90));
    }
  }
}

console.log(`\n총 ${GROUPS.length}그룹 · ${total}종목`);
if (missing.length) console.log(`\n[못 찾음]\n  ${missing.join("\n  ")}`);
console.log(write ? "\n담았습니다." : "\n(미리보기만. 실제로 담으려면 --write)");
