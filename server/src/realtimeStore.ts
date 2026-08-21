import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { RealtimeClient, RealtimeFrame } from "./realtimeClient.js";

/**
 * 실시간으로 받은 값을 **쌓아 둔다.**
 *
 * ## 왜 쌓나
 *
 * 화면은 켜졌다 꺼진다. 거래원 시간대별이 쓸모없어진 이유가 그것이다 —
 * 보고 있을 때만 점이 찍히니 장 끝난 뒤엔 같은 값이 몇 줄 남았다.
 * **서버가 하루 종일 물고 쌓아야** 「10시에 누가 사고 있었나」에 답할 수 있다.
 *
 * ## 무엇을 쌓고 무엇을 안 쌓나
 *
 * **다 쌓으면 안 된다.** 체결(`0B`)은 초당 수십 건이라 하루면 수백만 줄이 되는데,
 * 화면이 원하는 건 「지금 값」이지 「모든 틱」이 아니다. 그건 **최신값만** 둔다.
 *
 * 시계열이 필요한 것은 **누적값이 시간에 따라 어떻게 변했나**를 묻는 것들이다 —
 * 프로그램매매(`0w`)와 거래원(`0F`). 이건 30초에 한 점씩 남긴다.
 * 그 정도면 하루 700점 남짓이라 그림이 되면서 파일도 감당된다.
 *
 * ## 파일로 남기는 이유
 *
 * 서버가 다시 뜨면 메모리는 비지만 **흘러간 시간은 안 돌아온다.** 폴링이면 나중에
 * 다시 물어보면 되는데 실시간은 놓치면 끝이다. 그래서 주기적으로 디스크에 적고,
 * 뜰 때 그날 것을 도로 읽는다.
 *
 * 날짜가 바뀌면 새 파일이다 — 하루가 분석의 단위다.
 */

const here = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = join(here, "..", "data", "realtime");

/** 시계열로 남길 TR — 나머지는 최신값만 */
const SERIES_TYPES = new Set(["0w", "0F"]);
/**
 * VI 는 **값이 아니라 사건**이다.
 *
 * 30초에 한 점씩 찍으면 그 사이에 걸린 VI 를 통째로 놓친다. 오는 족족 기록한다.
 * 하루 수백 건이라 그래도 감당된다.
 *
 * `1h` 는 종목을 지정해도 **전체 종목**이 온다(문서 명시). 한 번만 걸면 시장 전체다.
 */
const VI_TYPE = "1h";
/** 몇 초에 한 점 */
const SAMPLE_SEC = 30;

export interface ViEvent {
  /** 우리가 받은 시각 HHmmss */
  at: string;
  code: string;
  name: string;
  /** VI발동구분 */
  kind: string;
  /** 정적/동적/동적+정적 */
  apply: string;
  /** VI 발동가격 */
  price: number;
  /** 기준가격(정적) */
  base: number;
  market: string;
  firedAt: string;
  /** 채워져 있으면 해제 */
  clearedAt: string;
}

export interface Point {
  /** HHmmss */
  t: string;
  /** FID → 값 */
  v: Record<string, string>;
}

interface Latest {
  at: number;
  values: Record<string, string>;
}

/** `type:item` → 값 */
type SeriesMap = Record<string, Point[]>;

/** 한국시간 HHmmss */
function hhmmss(now = new Date()): string {
  const k = new Date(now.getTime() + 9 * 3600 * 1000);
  return k.toISOString().slice(11, 19).replace(/:/g, "");
}

function kstDate(now = new Date()): string {
  const k = new Date(now.getTime() + 9 * 3600 * 1000);
  return k.toISOString().slice(0, 10);
}

export class RealtimeStore {
  private readonly latest = new Map<string, Latest>();
  private series: SeriesMap = {};
  private vi: ViEvent[] = [];
  /** 키별 마지막 샘플 시각(ms) — 30초 간격을 지키는 기준 */
  private readonly sampledAt = new Map<string, number>();
  private day = kstDate();
  private dirty = false;

  constructor(private readonly client: RealtimeClient) {}

  async start(): Promise<void> {
    await this.load();
    this.client.onFrame((f) => this.take(f));
    // 흘러간 시간은 안 돌아온다 — 자주 적되 바뀐 게 있을 때만
    setInterval(() => void this.save(), 20_000);
  }

  private file(day = this.day): string {
    return join(DATA_DIR, `${day}.json`);
  }

  private async load(): Promise<void> {
    try {
      const raw = JSON.parse(await readFile(this.file(), "utf-8")) as {
        series?: SeriesMap;
        vi?: ViEvent[];
      };
      // 예전 파일은 시계열만 담겨 있었다 — 그 모양도 읽는다
      this.series = raw.series ?? (raw as unknown as SeriesMap);
      this.vi = raw.vi ?? [];
    } catch {
      this.series = {};
      this.vi = [];
    }
  }

  private async save(): Promise<void> {
    if (!this.dirty) return;
    this.dirty = false;
    try {
      await mkdir(DATA_DIR, { recursive: true });
      await writeFile(this.file(), JSON.stringify({ series: this.series, vi: this.vi }), "utf-8");
    } catch {
      /* 못 적어도 메모리에는 남아 있다 */
    }
  }

  /** 프레임 하나를 받아 넣는다 */
  private take(f: RealtimeFrame): void {
    if (f.trnm !== "REAL" || !Array.isArray(f.data)) return;

    // 날짜가 넘어가면 새 파일로 — 하루가 분석의 단위다
    const today = kstDate();
    if (today !== this.day) {
      void this.save();
      this.day = today;
      this.series = {};
      this.vi = [];
      this.sampledAt.clear();
    }

    for (const d of f.data) {
      const type = d.type;
      const item = d.item;
      const values = d.values;
      if (!type || !item || !values) continue;

      const key = `${type}:${item}`;
      this.latest.set(key, { at: Date.now(), values });

      if (type === VI_TYPE) {
        this.takeVi(values);
        continue;
      }

      if (!SERIES_TYPES.has(type)) continue;

      /*
       * 30초에 한 점. 매 프레임을 남기면 하루에 수십만 줄이 되는데,
       * **그림으로 볼 때 30초보다 촘촘할 이유가 없다.**
       */
      const now = Date.now();
      const last = this.sampledAt.get(key) ?? 0;
      if (now - last < SAMPLE_SEC * 1000) continue;
      this.sampledAt.set(key, now);

      const arr = (this.series[key] ??= []);
      /*
       * 시각은 **프레임이 주면 그걸, 없으면 우리 시계**를 쓴다.
       *
       * 체결(`0B`)·프로그램매매(`0w`)는 체결시각(FID 20)을 주는데
       * **거래원(`0F`)은 안 준다.** 그걸 모르고 `values["20"]` 만 쓰면
       * 시각이 빈 점만 쌓여서 그림을 못 그린다.
       */
      arr.push({ t: values["20"] || hhmmss(), v: values });
      this.dirty = true;
    }
  }

  /**
   * VI 한 건.
   *
   * 발동과 해제가 **같은 TR 로** 온다 — `VI해제시각`(1224)이 채워져 있으면 해제다.
   * 같은 종목이 하루에 여러 번 걸리므로 종목 기준으로 덮어쓰면 안 되고, 줄줄이 쌓는다.
   */
  private takeVi(v: Record<string, string>): void {
    const raw = String(v["9001"] ?? "").trim();
    if (!raw) return;
    /*
     * **거래소마다 한 번씩 온다.** 같은 VI 가 `094480` 과 `094480_AL` 로 두 줄 들어온다 —
     * 그대로 쌓으면 화면에 모든 VI 가 두 번씩 보인다.
     * 접미사를 떼고, 같은 종목·같은 시각·같은 상태면 한 번만 남긴다.
     */
    const code = raw.replace(/^A/, "").replace(/_(AL|NX)$/i, "");
    const fired = String(v["1223"] ?? "").trim();
    const cleared = String(v["1224"] ?? "").trim();
    const last = this.vi[this.vi.length - 1];
    if (last && last.code === code && last.firedAt === fired && last.clearedAt === cleared) return;
    this.vi.push({
      at: hhmmss(),
      code,
      name: String(v["302"] ?? "").trim(),
      kind: String(v["9068"] ?? "").trim(),
      apply: String(v["1225"] ?? "").trim(),
      price: Number(v["1221"]) || 0,
      base: Number(v["1236"]) || 0,
      market: String(v["9008"] ?? "").trim(),
      firedAt: fired,
      clearedAt: cleared,
    });
    // 하루치만 — 오래된 것부터 버린다
    if (this.vi.length > 3000) this.vi.splice(0, this.vi.length - 3000);
    this.dirty = true;
  }

  /** 오늘 걸린 VI — 최근 것부터 */
  getVi(limit = 100): ViEvent[] {
    return this.vi.slice(-limit).reverse();
  }

  /** 지금 값 */
  getLatest(type: string, item: string): Latest | null {
    return this.latest.get(`${type}:${item}`) ?? null;
  }

  /** 하루치 시계열 */
  getSeries(type: string, item: string): Point[] {
    return this.series[`${type}:${item}`] ?? [];
  }

  /** 무엇이 쌓이고 있나 — 진단용 */
  get summary(): { key: string; points: number }[] {
    return Object.entries(this.series).map(([key, pts]) => ({ key, points: pts.length }));
  }
}
