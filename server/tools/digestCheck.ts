/** 업종 자금흐름 digest 의 단위 표기 확인 — 조회 0회 (창고만 읽는다) */
import { listSectorFlow } from "../src/sectorFlowStore.js";
import { toSectorFlowDigest } from "../src/sectorFlowStore.js";
const days = await listSectorFlow(14).catch(() => []);
const d = toSectorFlowDigest(days);
console.log(d ? d.split("\n").slice(0, 7).join("\n") : "(창고 비어 있음)");
process.exit(0);
