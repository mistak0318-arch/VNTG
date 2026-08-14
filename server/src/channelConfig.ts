import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * 텔레그램 동향 설정.
 *
 * 「선별 발송」은 AI를 안 쓰므로 **토큰 비용이 0**이다. 그래서 자주 돌려도 되는데,
 * 관건은 텔레그램 쪽 호출량이었다 — 채널마다 조회하면 FLOOD_WAIT 이 걸린다.
 * getDialogs 로 새 글이 있는 채널만 골라 읽도록 바꾼 뒤로는 5분 주기도 감당된다.
 *
 * AI 정리는 호출당 비용이 있어 지금처럼 사람이 누를 때만 돈다.
 */

const here = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = join(here, "..", "data");
const FILE = join(DATA_DIR, "channelConfig.json");

export interface PickAutoConfig {
  enabled: boolean;
  /** 발송 주기(분) */
  intervalMin: number;
  /** 몇 시간치를 훑을지 */
  windowHours: number;
  /** 텔레그램으로 보낼지 */
  telegram: boolean;
  /** 메일로 보낼지 */
  mail: boolean;
  /**
   * 장이 열린 날에만 보낼지.
   * 주말에도 채널은 돌지만 대부분 잡담이라 기본은 평일만.
   */
  weekdayOnly: boolean;
  /** 보내는 시간대 (KST, 시 단위). 새벽에 알림이 울리면 안 된다 */
  startHour: number;
  endHour: number;
}

export interface ChannelConfig {
  pickAuto: PickAutoConfig;
}

export const DEFAULT_CONFIG: ChannelConfig = {
  pickAuto: {
    enabled: false,
    intervalMin: 10,
    windowHours: 2,
    telegram: true,
    mail: false,
    weekdayOnly: true,
    startHour: 7,
    endHour: 20,
  },
};

/** 주기는 아무 값이나 받지 않는다 — 너무 짧으면 텔레그램 쪽이 버티지 못한다 */
export const INTERVAL_CHOICES = [5, 10, 20, 30, 60];

function clampInt(v: unknown, min: number, max: number, fallback: number): number {
  const n = Math.floor(Number(v));
  if (!Number.isFinite(n)) return fallback;
  return Math.min(Math.max(n, min), max);
}

function normalize(input: unknown): ChannelConfig {
  const p = (input as ChannelConfig)?.pickAuto;
  if (!p) return DEFAULT_CONFIG;
  const d = DEFAULT_CONFIG.pickAuto;
  const interval = clampInt(p.intervalMin, 5, 240, d.intervalMin);
  return {
    pickAuto: {
      enabled: p.enabled === true,
      // 목록에 없는 값이 들어오면 가장 가까운 것으로 맞춘다
      intervalMin: INTERVAL_CHOICES.includes(interval)
        ? interval
        : INTERVAL_CHOICES.reduce((a, b) => (Math.abs(b - interval) < Math.abs(a - interval) ? b : a)),
      windowHours: clampInt(p.windowHours, 1, 48, d.windowHours),
      telegram: p.telegram !== false,
      mail: p.mail === true,
      weekdayOnly: p.weekdayOnly !== false,
      startHour: clampInt(p.startHour, 0, 23, d.startHour),
      endHour: clampInt(p.endHour, 0, 23, d.endHour),
    },
  };
}

let cache: ChannelConfig | null = null;

export async function getChannelConfig(): Promise<ChannelConfig> {
  if (cache) return cache;
  try {
    cache = normalize(JSON.parse(await readFile(FILE, "utf-8")));
  } catch {
    cache = DEFAULT_CONFIG;
  }
  return cache;
}

export async function saveChannelConfig(input: unknown): Promise<ChannelConfig> {
  const next = normalize(input);
  await mkdir(DATA_DIR, { recursive: true });
  await writeFile(FILE, JSON.stringify(next, null, 2), "utf-8");
  cache = next;
  return next;
}

/** 지금 보내도 되는 시각인가 */
export function withinWindow(cfg: PickAutoConfig, now = new Date()): boolean {
  const kst = new Date(now.getTime() + (9 * 60 + now.getTimezoneOffset()) * 60_000);
  const day = kst.getDay();
  if (cfg.weekdayOnly && (day === 0 || day === 6)) return false;
  const h = kst.getHours();
  // 종료 시각이 시작보다 작으면 자정을 넘긴 구간으로 본다 (예: 22시~2시)
  return cfg.startHour <= cfg.endHour
    ? h >= cfg.startHour && h < cfg.endHour
    : h >= cfg.startHour || h < cfg.endHour;
}
