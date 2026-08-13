import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { AiSummary } from "./aiSummary.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DIR = resolve(__dirname, "..", "data", "reports");

/**
 * 발행된 리포트 보관소.
 *
 * AI 요약은 화면을 열 때마다 만들면 안 된다. 같은 판(조간/장중/석간)인데 볼 때마다
 * 내용이 달라지고 비용도 예측이 안 된다. 정해진 시각에 한 번 만들어 저장하고,
 * 화면은 저장된 것을 읽기만 한다. 나중에 메일·텔레그램도 이 저장분을 그대로 보낸다.
 */

export type EditionKey = "morning" | "midday" | "closing" | "weekend";

export const EDITIONS: { key: EditionKey; label: string; hour: number }[] = [
  { key: "morning", label: "조간", hour: 7 },
  { key: "midday", label: "장중", hour: 12 },
  { key: "closing", label: "석간", hour: 18 },
];

/**
 * 주말판.
 *
 * 장이 안 열리니 지수·수급·장중흐름은 전부 어제 값이라 쓸 게 없다.
 * 대신 뉴스는 주말에도 계속 나오고, 오히려 평일에 묻혔던 것이 주말에 정리돼 나오기도 한다.
 * 그래서 주말에는 **뉴스와 관심종목 소식만** 담은 판을 하루 한 번 낸다.
 */
export const WEEKEND_EDITION = { key: "weekend" as EditionKey, label: "주말", hour: 9 };

export interface PublishedReport {
  /** YYYY-MM-DD */
  date: string;
  edition: EditionKey;
  label: string;
  /** 실제 발행된 시각 */
  publishedAt: string;
  summary: AiSummary;
}

function fileName(date: string, edition: EditionKey): string {
  return resolve(DIR, `${date}_${edition}.json`);
}

export function todayStr(d = new Date()): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

export async function saveReport(report: PublishedReport): Promise<void> {
  await mkdir(DIR, { recursive: true });
  await writeFile(fileName(report.date, report.edition), JSON.stringify(report, null, 2), "utf-8");
}

export async function loadReport(
  date: string,
  edition: EditionKey,
): Promise<PublishedReport | null> {
  try {
    return JSON.parse(await readFile(fileName(date, edition), "utf-8")) as PublishedReport;
  } catch {
    return null;
  }
}

/** 최근 발행분 목록 (날짜 내림차순) */
export async function listReports(limit = 30): Promise<{ date: string; edition: EditionKey }[]> {
  try {
    const files = await readdir(DIR);
    return files
      .filter((f) => f.endsWith(".json"))
      .map((f) => {
        const [date, rest] = f.replace(/\.json$/, "").split("_");
        return { date, edition: rest as EditionKey };
      })
      .sort((a, b) => b.date.localeCompare(a.date))
      .slice(0, limit);
  } catch {
    return [];
  }
}

/**
 * 지금 시점에서 "가장 최근에 발행됐어야 할" 판.
 * 07시 전이면 아직 오늘 조간이 안 나왔으므로 전날 석간이 최신이다.
 */
export function latestEdition(now = new Date()): { date: string; edition: EditionKey } {
  const h = now.getHours();
  if (h < 7) {
    const y = new Date(now);
    y.setDate(y.getDate() - 1);
    return { date: todayStr(y), edition: "closing" };
  }
  if (h < 12) return { date: todayStr(now), edition: "morning" };
  if (h < 18) return { date: todayStr(now), edition: "midday" };
  return { date: todayStr(now), edition: "closing" };
}
