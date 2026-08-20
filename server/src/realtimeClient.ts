import type { KiwoomClient } from "./kiwoomClient.js";

/**
 * 키움 실시간시세(웹소켓) — **서버가 하나만 물고 있는다.**
 *
 * ## 왜 서버가 무나
 *
 * 화면이 직접 붙으면 **창을 열 때만 쌓이고**, 창이 여럿이면 연결도 여럿이 된다.
 * 거래원 시간대별이 쓸모없어진 이유가 정확히 그것이다 — 보고 있을 때만 점이 찍히니
 * 장 끝난 뒤엔 같은 값이 여러 줄 남았다. 서버가 하루 종일 물고 쌓아야 시계열이 된다.
 *
 * ## 토큰은 REST 와 **같은 것**을 쓴다
 *
 * 키움은 앱키 하나에 토큰 하나만 살려 둔다. 여기서 따로 발급받으면 REST 쪽이 통째로
 * 죽는다(8005). 그래서 `KiwoomClient.accessToken()` 을 통해서만 가져온다.
 *
 * ## 접속 규약은 **문서에 없다**
 *
 * 받은 문서(344 시트)에는 REG/REMOVE/REAL 만 있고 로그인·PING 규약이 없다.
 * 그래서 **추측하지 않고 서버가 하는 말을 그대로 기록한다** — `onFrame` 으로 들어오는
 * 모든 프레임을 남겨서, 무엇을 요구하는지 눈으로 보고 맞춘다.
 * 아래 `LOGIN` 은 **확인된 규약이 아니라 첫 시도**다. 응답을 보고 고칠 자리.
 *
 * ## 재연결이 기능의 절반이다
 *
 * 하루 종일 물고 있어야 하므로 끊김이 정상 상태다. 끊기면 점점 뜸하게 다시 붙고,
 * 붙으면 **구독을 다시 건다** — 안 그러면 조용히 아무것도 안 오는 상태가 된다.
 */

const WS_URL = "wss://api.kiwoom.com:10000/api/dostk/websocket";

export interface RealtimeFrame {
  trnm?: string;
  return_code?: number;
  return_msg?: string;
  data?: {
    type?: string;
    name?: string;
    item?: string;
    values?: Record<string, string>;
  }[];
  [k: string]: unknown;
}

type Listener = (f: RealtimeFrame) => void;

export class RealtimeClient {
  private ws: WebSocket | null = null;
  private readonly listeners = new Set<Listener>();
  /** 구독 중인 것 — 다시 붙었을 때 그대로 되건다 */
  private readonly subs = new Map<string, Set<string>>();
  private retry = 0;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private closed = false;

  /** 최근 프레임 — 무엇이 오는지 눈으로 보려고 남긴다 */
  readonly log: { at: string; dir: "→" | "←"; text: string }[] = [];

  constructor(private readonly kiwoom: KiwoomClient) {}

  onFrame(fn: Listener): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private note(dir: "→" | "←", text: string): void {
    this.log.push({ at: new Date().toISOString(), dir, text: text.slice(0, 600) });
    // 오래된 건 버린다 — 진단용이지 저장소가 아니다
    if (this.log.length > 200) this.log.splice(0, this.log.length - 200);
  }

  private send(obj: unknown): void {
    const text = JSON.stringify(obj);
    this.note("→", text);
    this.ws?.send(text);
  }

  async connect(): Promise<void> {
    this.closed = false;
    if (this.ws) return;

    const token = await this.kiwoom.accessToken();
    const ws = new WebSocket(WS_URL);
    this.ws = ws;

    ws.onopen = () => {
      this.retry = 0;
      this.note("←", "(연결됨)");
      /*
       * 문서에 없는 부분이다. 이 모양이 아니면 서버가 뭐라고든 답할 것이고,
       * 그 답이 `log` 에 남는다 — 그걸 보고 고친다.
       */
      this.send({ trnm: "LOGIN", token });
    };

    ws.onmessage = (ev: MessageEvent) => {
      const text = typeof ev.data === "string" ? ev.data : String(ev.data);
      this.note("←", text);
      let frame: RealtimeFrame;
      try {
        frame = JSON.parse(text) as RealtimeFrame;
      } catch {
        return;
      }

      // 살아 있는지 묻는 프레임은 **그대로 돌려준다**. 안 돌려주면 끊긴다
      if (frame.trnm === "PING") {
        this.send(frame);
        return;
      }

      // 로그인이 끝나면 걸어 둔 구독을 올린다
      if (frame.trnm === "LOGIN" && frame.return_code === 0) this.resubscribe();

      for (const l of this.listeners) l(frame);
    };

    ws.onclose = () => {
      this.note("←", "(끊김)");
      this.ws = null;
      this.scheduleRetry();
    };

    ws.onerror = () => {
      this.note("←", "(오류)");
    };
  }

  /**
   * 다시 붙었을 때 구독을 되건다.
   * 이걸 빠뜨리면 **연결은 살아 있는데 아무것도 안 오는** 상태가 된다 — 제일 알아채기 어렵다.
   */
  private resubscribe(): void {
    for (const [type, items] of this.subs) {
      if (items.size === 0) continue;
      this.send({
        trnm: "REG",
        grp_no: "1",
        refresh: "1",
        data: [{ item: [...items], type: [type] }],
      });
    }
  }

  private scheduleRetry(): void {
    if (this.closed || this.timer) return;
    // 점점 뜸하게 — 끊긴 이유가 우리 쪽이 아닐 때 두들기면 더 나빠진다
    const wait = Math.min(2000 * 2 ** this.retry, 60_000);
    this.retry += 1;
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.connect();
    }, wait);
  }

  /** 종목 하나를 어떤 TR 로 구독한다 (`0w` 종목프로그램매매 등) */
  subscribe(type: string, item: string): void {
    let set = this.subs.get(type);
    if (!set) {
      set = new Set();
      this.subs.set(type, set);
    }
    if (set.has(item)) return;
    set.add(item);
    if (this.ws && this.ws.readyState === 1) {
      this.send({ trnm: "REG", grp_no: "1", refresh: "1", data: [{ item: [item], type: [type] }] });
    }
  }

  unsubscribe(type: string, item: string): void {
    this.subs.get(type)?.delete(item);
    if (this.ws && this.ws.readyState === 1) {
      this.send({ trnm: "REMOVE", grp_no: "1", data: [{ item: [item], type: [type] }] });
    }
  }

  close(): void {
    this.closed = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.ws?.close();
    this.ws = null;
  }

  get state(): string {
    if (!this.ws) return "끊김";
    return ["연결 중", "연결됨", "닫는 중", "닫힘"][this.ws.readyState] ?? "알 수 없음";
  }
}
