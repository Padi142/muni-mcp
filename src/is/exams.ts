import { load, type Cheerio, type CheerioAPI } from "cheerio";
import type { Element } from "domhandler";
import { IS_ORIGIN, type IsSession } from "./session.js";
import { parseIsDate } from "./time.js";

const EXAMS_PATH = "/auth/student/prihl_na_zkousky";
// Only these query keys are ever copied into URLs we request. Links on these pages also carry
// `prihlasit`/`odhlasit`, which register/unregister via plain GET; we never follow page links directly.
const safeKeys = ["fakulta", "obdobi", "studium", "predmet", "serie", "zkt"] as const;
type SafeKey = (typeof safeKeys)[number];

// IS MU separates query parameters with ";" which URLSearchParams does not understand.
function isParams(href: string, base: string) {
  const url = new URL(href, base);
  const params = new Map<string, string>();
  for (const pair of url.search.slice(1).split(/[;&]/)) {
    const [key, value = ""] = pair.split("=");
    if (key) params.set(decodeURIComponent(key), decodeURIComponent(value));
  }
  return params;
}

function examsUrl(params: Map<string, string>, keys: readonly SafeKey[]) {
  const query = keys
    .filter((key) => /^\d+$/.test(params.get(key) ?? ""))
    .map((key) => `${key}=${params.get(key)}`)
    .join(";");
  return `${IS_ORIGIN}${EXAMS_PATH}${query ? `?${query}` : ""}`;
}

function assertExamsPage($: CheerioAPI, sourceUrl: string) {
  const url = new URL(sourceUrl);
  if (url.origin !== IS_ORIGIN || url.pathname !== EXAMS_PATH) {
    throw new Error("Expected the IS MU exam-registration URL.");
  }
  if ($("#app_content").length !== 1 || $('input[type="password"]').length) {
    throw new Error("Expected an authenticated exam-registration page.");
  }
}

const text = (node: { text(): string }) => node.text().replace(/\s+/g, " ").trim();

/** IS colours a term by whether you can act on it: register, or unregister if already registered. */
const actions = {
  ok: "available",
  stav1: "available-after-unregistering", // a concurrent-registration limit blocks it
  ko: "unavailable",
} as const;

function parseWindow(line: string, verb: string) {
  const date = String.raw`\S+\s+\d{1,2}\.\s*\d{1,2}\.\s*\d{4}(?:\s+\d{1,2}:\d{2})?`;
  const match = new RegExp(`(?:^|,)\\s*${verb}(?:\\s+od\\s+(${date}))?\\s+do\\s+(${date})`).exec(line);
  return match ? { from: match[1] ? parseIsDate(match[1]) : null, until: parseIsDate(match[2]!) } : null;
}

/**
 * Parse one term: the status cell (class + "podrobně" link) and the details cell, which reads
 * `<b>Po 2. 11. 2026 08:25 A217</b> (type), přihlášeno N, max. M<br><font>deadlines</font><br><font>note</font>…`
 */
function parseTerm($: CheerioAPI, statusCell: Cheerio<Element>, details: Cheerio<Element>, sourceUrl: string, registered: boolean) {
  const link = statusCell.find("a").first().attr("href");
  const params = isParams(link ?? "", sourceUrl);
  const termId = params.get("zkt");
  if (!termId || !/^\d+$/.test(termId)) throw new Error("Exam term is missing its ID.");

  const heading = text(details.children("b").first());
  const when = /^\S+\s+(\d{1,2}\.\s*\d{1,2}\.\s*\d{4}(?:\s+\d{1,2}:\d{2})?)\s*(.*)$/.exec(heading);
  if (!when) throw new Error("Exam term has an unrecognized date.");
  const firstLine = text(load(details.html()?.split(/<br\s*\/?>/i)[0] ?? "").root());
  const summary = firstLine.startsWith(heading) ? firstLine.slice(heading.length) : "";
  const type = /^\s*\(([^)]+)\)/.exec(summary)?.[1] ?? null;
  const counts = /přihlášeno\s+(\d+)(?:,\s*max\.\s*(\d+))?/.exec(summary);

  let registration: ReturnType<typeof parseWindow> = null;
  let unregistration: ReturnType<typeof parseWindow> = null;
  let announced: string | null = null;
  const notes: string[] = [];
  for (const font of details.children("font").toArray().map((element) => $(element))) {
    const line = text(font);
    if (line.startsWith("Zadáno:")) announced = line.replace(/^Zadáno:\s*/, "").replace(/,\s*učo\s*\d+$/, "");
    else if (/^(přihlásit|odhlásit)\s/.test(line)) {
      registration = parseWindow(line, "přihlásit");
      unregistration = parseWindow(line, "odhlásit");
    } else if (line && line !== text(font.find("a"))) notes.push(line); // skip pure action links
  }

  return {
    termId,
    start: parseIsDate(when[1]!),
    location: when[2] || null,
    type,
    registered,
    action: actions[statusCell.attr("class") as keyof typeof actions] ?? null,
    registeredCount: counts ? Number(counts[1]) : null,
    capacity: counts?.[2] ? Number(counts[2]) : null,
    registration,
    unregistration,
    note: notes.join("\n") || null,
    announced,
    url: examsUrl(params, ["fakulta", "obdobi", "studium", "predmet", "zkt"]),
  };
}

const sectionHeadings = [
  ["Nyní jste přihlášen", "registered"],
  ["Předměty a jejich série", "series"],
  ["Předměty, ke kterým nejsou", "withoutTerms"],
] as const;

/** Parse the exam-registration overview: current registrations, series with future terms, courses without. */
export function parseExamOverview(html: string, sourceUrl: string) {
  const $ = load(html);
  assertExamsPage($, sourceUrl);
  const app = $("#app_content");

  const registered = app.find("tr[id^='tr_odhl_']").toArray().map((element) => {
    const id = element.attribs.id!.slice("tr_odhl_".length);
    const cells = app.find(`#tr_odhl2_${id}`).children("td");
    if (cells.length !== 2) throw new Error("Exam registration row has an unexpected layout.");
    return { title: text($(element)), ...parseTerm($, cells.eq(0), cells.eq(1), sourceUrl, true) };
  });

  // Section headings and their lists are siblings in loose HTML; walk in document order.
  const series = [];
  const withoutTerms = [];
  const found = new Set<string>();
  let section: (typeof sectionHeadings)[number][1] | null = null;
  for (const element of app.find("b, ul").toArray()) {
    if (element.tagName === "b") {
      const label = text($(element));
      const heading = sectionHeadings.find(([prefix]) => label.startsWith(prefix));
      if (heading) found.add((section = heading[1]));
      continue;
    }
    for (const item of $(element).children("li").toArray().map((li) => $(li))) {
      if (section === "series") {
        const params = isParams(item.find("a").attr("href") ?? "", sourceUrl);
        if (!params.get("predmet") || !params.get("serie")) throw new Error("Exam series is missing its IDs.");
        const title = text(item.find("b").first());
        series.push({
          courseCode: title.split(" ")[0]!,
          title,
          courseId: params.get("predmet")!,
          seriesId: params.get("serie")!,
          termCount: Number(/počet termínů:\s*(\d+)/.exec(text(item))?.[1] ?? NaN),
          url: examsUrl(params, ["fakulta", "obdobi", "studium", "predmet", "serie"]),
        });
      } else if (section === "withoutTerms") {
        const [code = "", ...name] = text(item).split(" ");
        withoutTerms.push({ courseCode: code, name: name.join(" "), hasPastTerms: item.find("a").length > 0 });
      }
    }
  }
  if (!found.has("series") && !found.has("withoutTerms") && registered.length === 0) {
    throw new Error("Exam page layout changed: no known sections found.");
  }
  return { source: "is-mu" as const, sourceUrl, registered, series, withoutTerms };
}

/** Parse one series page (opened from the overview): its limit and every listed future term. */
export function parseExamSeries(html: string, sourceUrl: string) {
  const $ = load(html);
  assertExamsPage($, sourceUrl);
  const app = $("#app_content");
  const title = text(app.find("h2").first());
  if (!title) throw new Error("Exam series page is missing its title.");
  const limit = /souběžných přihlášení v budoucnosti:\s*(\d+)/.exec(text(app))?.[1];
  const terms = app.find("table.data1 tr").toArray().map((row) => {
    const cells = $(row).children("td");
    if (cells.length !== 3) throw new Error("Exam term row has an unexpected layout.");
    const registered = !/nejste/.test(text(cells.eq(0)));
    return parseTerm($, cells.eq(1), cells.eq(2), sourceUrl, registered);
  });
  return { title, maxConcurrentRegistrations: limit ? Number(limit) : null, terms };
}

/**
 * Fetch the exam overview, then each series page (optionally only for one course code).
 * Without query params IS picks the current study and period.
 */
export async function fetchExams(session: IsSession, options: { courseCode?: string } = {}) {
  const overviewPage = await session.getPage(`${IS_ORIGIN}${EXAMS_PATH}`);
  const overview = parseExamOverview(overviewPage.html, overviewPage.url.href);
  const wanted = options.courseCode?.trim().toUpperCase();
  const matches = (code: string) => !wanted || code.toUpperCase() === wanted;
  const series = await Promise.all(overview.series.filter((s) => matches(s.courseCode)).map(async (s) => {
    const page = await session.getPage(s.url);
    const { maxConcurrentRegistrations, terms } = parseExamSeries(page.html, page.url.href);
    return { ...s, maxConcurrentRegistrations, terms };
  }));
  return {
    ...overview,
    registered: overview.registered.filter((term) => matches(term.title.split(" ")[0]!)),
    series,
    withoutTerms: overview.withoutTerms.filter((course) => matches(course.courseCode)),
  };
}

export type Exams = Awaited<ReturnType<typeof fetchExams>>;
export type ExamTerm = Exams["series"][number]["terms"][number];
