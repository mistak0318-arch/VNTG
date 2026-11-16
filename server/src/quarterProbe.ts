import { hantooGet, hantooReady } from "./hantooClient.js";
import { noteLife } from "./lifecycle.js";

/**
 * **분기 손익이 왜 「호출 전처리 오류」인가** — 한 번 쓰고 지울 진단 (2026-11-17).
 *
 * 벤티지: "분기실적 전처리 오류로 왜 못받아와" (삼성중공업 화면 캡처)
 *
 * ## 추측으로 고칠 자리가 아니다
 *
 * `quarterFinance.ts` 는 `FHKST66430200` 을 이렇게 부른다:
 *
 *     fid_cond_mrkt_div_code: "J"      ← 소문자
 *     fid_input_iscd: code             ← 소문자
 *     FID_DIV_CLS_CODE: "1"            ← 대문자, 1=분기
 *
 * 대소문자가 섞여 보이지만 **`financialRatio.ts` 가 똑같이 섞어 쓰고 잘 돈다** —
 * 거기는 `FID_DIV_CLS_CODE: "0"`(년)이다. 그러니 대소문자가 범인이라고 단정할 수 없다.
 *
 * 가를 것이 셋이다:
 *   ① 그 **종목**만인가 (삼성중공업 010140 vs 삼성전자 005930)
 *   ② **분기("1")** 값이 문제인가 (같은 TR 을 "0" 으로 불러 본다)
 *   ③ **대소문자**인가 (전부 대문자로 불러 본다)
 *
 * 넷을 돌려 보고 답을 `lifecycle.log` 에 적는다. 로컬에서 한투를 부르면 미니PC 토큰이
 * 끊기므로([[vntg-hts-hantoo-api]]) 서버에게 묻는다. 조회 네 건, 뜨고 한 번뿐이다.
 */

const PATH = "/uapi/domestic-stock/v1/finance/income-statement";
const TR = "FHKST66430200";
/* 한 끗 차이 형제 — 이게 되면 income-statement 쪽만의 문제다 */
const RATIO_PATH = "/uapi/domestic-stock/v1/finance/financial-ratio";
const RATIO_TR = "FHKST66430300";

type Case = { 이름: string; path: string; tr: string; params: Record<string, string> };

function cases(): Case[] {
  return [
    /* ⑤ **형제 TR** — 이게 되면 income-statement 쪽만의 문제, 안 되면 재무 묶음 전체다 */
    {
      이름: "⑤재무비율(형제TR)·삼성전자",
      path: RATIO_PATH,
      tr: RATIO_TR,
      params: { fid_cond_mrkt_div_code: "J", fid_input_iscd: "005930", FID_DIV_CLS_CODE: "0" },
    },
    {
      이름: "①지금그대로·삼성전자",
      path: PATH,
      tr: TR,
      params: { fid_cond_mrkt_div_code: "J", fid_input_iscd: "005930", FID_DIV_CLS_CODE: "1" },
    },
    /* ⑥ 경로는 그대로 두고 **TR 만 형제 것** — 짝이 안 맞으면 전처리에서 걸린다 */
    {
      이름: "⑥경로=손익·TR=비율",
      path: PATH,
      tr: RATIO_TR,
      params: { fid_cond_mrkt_div_code: "J", fid_input_iscd: "005930", FID_DIV_CLS_CODE: "1" },
    },
    /* ⑦ TR 은 그대로 두고 **경로만 형제 것** */
    {
      이름: "⑦경로=비율·TR=손익",
      path: RATIO_PATH,
      tr: TR,
      params: { fid_cond_mrkt_div_code: "J", fid_input_iscd: "005930", FID_DIV_CLS_CODE: "1" },
    },
  ];
}

export function probeQuarterOnce(delayMs = 120_000): void {
  setTimeout(() => {
    void (async () => {
      if (!hantooReady()) {
        noteLife("WARN", "분기손익 진단 건너뜀 — 한투가 준비 안 됨");
        return;
      }
      const out: string[] = [];
      for (const c of cases()) {
        try {
          const body = await hantooGet<{ output?: unknown[]; rt_cd?: string; msg1?: string }>(
            c.path,
            c.tr,
            c.params,
            "분기손익 진단",
          );
          const n = Array.isArray(body.output) ? body.output.length : 0;
          out.push(`${c.이름}=OK ${n}행`);
        } catch (e) {
          /* 실패 사유를 **그대로** 적는다 — 요약하면 다음 사람이 또 추측한다 */
          /* 사유 **코드까지** — 메시지만으로는 「전처리 오류」 넷이 다 같아 보인다 */
          const code = (e as { code?: string })?.code ?? "";
          out.push(`${c.이름}=✗ ${code ? code + " " : ""}${e instanceof Error ? e.message : String(e)}`);
        }
      }
      noteLife("START", `분기손익 진단 — ${out.join(" · ")}`);
    })();
  }, delayMs).unref?.();
}
