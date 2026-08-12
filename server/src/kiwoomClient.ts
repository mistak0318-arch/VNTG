import { recordApiCall } from "./apiUsage.js";

const PROD_URL = "https://api.kiwoom.com";
const MOCK_URL = "https://mockapi.kiwoom.com";

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function parseExpiresDt(s: string): number {
  const y = Number(s.slice(0, 4));
  const mo = Number(s.slice(4, 6)) - 1;
  const d = Number(s.slice(6, 8));
  const h = Number(s.slice(8, 10));
  const mi = Number(s.slice(10, 12));
  const se = Number(s.slice(12, 14));
  return new Date(y, mo, d, h, mi, se).getTime();
}

export class KiwoomApiError extends Error {
  constructor(
    public readonly returnCode: number,
    message: string,
    public readonly raw: unknown,
  ) {
    super(message);
    this.name = "KiwoomApiError";
  }
}

interface TokenState {
  token: string;
  expiresAt: number; // epoch ms
}

export class KiwoomClient {
  private readonly baseUrl: string;
  private readonly appKey: string;
  private readonly appSecret: string;
  private tokenState: TokenState | null = null;
  private tokenPromise: Promise<string> | null = null;

  constructor(opts: { appKey: string; appSecret: string; isMock: boolean }) {
    this.appKey = opts.appKey;
    this.appSecret = opts.appSecret;
    this.baseUrl = opts.isMock ? MOCK_URL : PROD_URL;
  }

  /** 접근토큰발급 (au10001) — 캐시된 토큰이 유효하면 재사용 */
  private async getToken(): Promise<string> {
    if (this.tokenState && this.tokenState.expiresAt > Date.now() + 30_000) {
      return this.tokenState.token;
    }
    if (!this.tokenPromise) {
      this.tokenPromise = this.issueToken().finally(() => {
        this.tokenPromise = null;
      });
    }
    return this.tokenPromise;
  }

  private async issueToken(): Promise<string> {
    const res = await fetch(`${this.baseUrl}/oauth2/token`, {
      method: "POST",
      headers: { "Content-Type": "application/json;charset=UTF-8" },
      body: JSON.stringify({
        grant_type: "client_credentials",
        appkey: this.appKey,
        secretkey: this.appSecret,
      }),
    });
    if (!res.ok) {
      throw new Error(`토큰 발급 실패: HTTP ${res.status} ${await res.text()}`);
    }
    const data = (await res.json()) as Record<string, unknown>;
    const token = data.token as string | undefined;
    if (!token) {
      throw new Error(`토큰 발급 응답에 토큰이 없습니다: ${JSON.stringify(data)}`);
    }
    // 응답의 expires_dt는 "YYYYMMDDHHMMSS" 형식의 만료 일시 (로컬 시간 기준)
    const expiresDt = data.expires_dt as string | undefined;
    const expiresAt = expiresDt ? parseExpiresDt(expiresDt) : Date.now() + 23 * 3600 * 1000;
    this.tokenState = { token, expiresAt };
    return token;
  }

  /**
   * 키움 REST API POST 호출 공통 래퍼.
   * resourceUrl 예: /api/dostk/acnt, api-id 예: kt00018
   */
  async request<T = Record<string, unknown>>(
    resourceUrl: string,
    apiId: string,
    body: Record<string, unknown> = {},
    opts: { contYn?: string; nextKey?: string } = {},
  ): Promise<{ data: T; contYn: string; nextKey: string }> {
    const token = await this.getToken();
    const maxRetries = 6;

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      const res = await fetch(`${this.baseUrl}${resourceUrl}`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json;charset=UTF-8",
          "api-id": apiId,
          "cont-yn": opts.contYn ?? "N",
          "next-key": opts.nextKey ?? "",
          authorization: `Bearer ${token}`,
        },
        body: JSON.stringify(body),
      });

      // HTTP 429: "허용된 요청 개수를 초과하였습니다" - 잠시 대기 후 재시도
      if (res.status === 429) {
        void recordApiCall("kiwoom", apiId, "rateLimited");
        if (attempt < maxRetries) {
          await sleep(400 * (attempt + 1));
          continue;
        }
      }

      if (!res.ok) {
        void recordApiCall("kiwoom", apiId, "failed");
        const text = await res.text();
        throw new Error(`키움 API 호출 실패 (${apiId}): HTTP ${res.status} ${text}`);
      }

      const data = (await res.json()) as Record<string, unknown>;
      const returnCode = typeof data.return_code === "number" ? data.return_code : 0;

      // return_code 5: 레이트리밋 초과 (문서상 HTTP 200으로도 내려올 수 있음)
      if (returnCode === 5) {
        void recordApiCall("kiwoom", apiId, "rateLimited");
        if (attempt < maxRetries) {
          await sleep(400 * (attempt + 1));
          continue;
        }
      }
      if (returnCode !== 0) {
        void recordApiCall("kiwoom", apiId, "failed");
        throw new KiwoomApiError(returnCode, String(data.return_msg ?? "알 수 없는 오류"), data);
      }

      void recordApiCall("kiwoom", apiId, "ok");
      return {
        data: data as T,
        contYn: (res.headers.get("cont-yn") ?? (data.cont_yn as string) ?? "N") as string,
        nextKey: (res.headers.get("next-key") ?? (data.next_key as string) ?? "") as string,
      };
    }

    throw new Error(`키움 API 호출 실패 (${apiId}): 재시도 횟수를 초과했습니다 (레이트리밋)`);
  }
}

export function createKiwoomClientFromEnv(): KiwoomClient {
  const appKey = process.env.KIWOOM_APP_KEY;
  const appSecret = process.env.KIWOOM_APP_SECRET;
  if (!appKey || !appSecret) {
    throw new Error(
      "KIWOOM_APP_KEY / KIWOOM_APP_SECRET 환경변수가 설정되지 않았습니다. server/.env 파일을 확인하세요.",
    );
  }
  const isMock = process.env.KIWOOM_IS_MOCK === "true";
  return new KiwoomClient({ appKey, appSecret, isMock });
}
