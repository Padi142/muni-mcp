import { load, type Cheerio } from "cheerio";
import type { Element } from "domhandler";
import { fetchMaterialsOverview } from "./materials.js";
import type { IsSession } from "./session.js";
import { fetchStudentContext, parseAjaxHtml, studentAjaxUrl, text } from "./student.js";
import { parseIsDate, pragueToday } from "./time.js";

const months = ["ledna", "února", "března", "dubna", "května", "června",
  "července", "srpna", "září", "října", "listopadu", "prosince"];

/** Day headings omit the year ("Středa 4. listopadu"); pick the year that keeps them near today. */
function headingDate(heading: string, today: string) {
  const match = /(\d{1,2})\.\s*(\p{L}+)/u.exec(heading);
  const month = months.indexOf(match?.[2]?.toLowerCase() ?? "") + 1;
  if (!match || !month) throw new Error(`Unrecognized event day heading: ${heading}`);
  const day = Number(match[1]);
  const [year = 0] = today.split("-").map(Number);
  const candidate = (y: number) => `${y}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
  const sixtyDaysAgo = new Date(Date.parse(today) - 60 * 86_400_000).toISOString().slice(0, 10);
  return candidate(year) < sixtyDaysAgo ? candidate(year + 1) : candidate(year);
}

// "do 1. 11. 2026 vč." or "od 2. 11. 2026 do 15. 11. 2026 vč." (inclusive)
function parseRange(range: string) {
  if (!range) return null;
  const from = /od\s+([\d.\s:]+?)(?=\s+do|\s*vč|$)/.exec(range)?.[1];
  const until = /do\s+([\d.\s:]+?)(?=\s*vč|$)/.exec(range)?.[1];
  return { from: from ? parseIsDate(from) : null, until: until ? parseIsDate(until) : null };
}

const sections = [
  [".stud_udalosti-ted", "now"],
  [".stud_udalosti-ceka", "upcoming"],
  [".stud_udalosti-posledni", "recent"],
] as const;

// Recent changes use month headings ("Říjen 2026") and day labels ("Neděle 25. 10.").
function recentDate(label: string, year: string | null) {
  const match = /(\d{1,2})\.\s*(\d{1,2})\./.exec(label);
  if (!match || !year) throw new Error(`Unrecognized recent-change day: ${label}`);
  return `${year}-${match[2]!.padStart(2, "0")}-${match[1]!.padStart(2, "0")}`;
}

/**
 * Parse the student page's event panel: "Co se právě děje" (now), "Co Vás čeká" (upcoming) and
 * "Poslední studijní události" (recent changes, e.g. notebook updates or new exam terms).
 * Each event has a day, a category (Zkoušky, Odpovědníky, Rozvrh…; null for recent changes), a title,
 * and optional times on that day plus an inclusive date range. `today` (YYYY-MM-DD) resolves years.
 */
export function parseStudentEvents(html: string, today: string) {
  const $ = load(html);
  if (!$(".stud_udalosti-ted, .stud_udalosti-ceka").length) {
    throw new Error("Student events layout changed: no current or upcoming panel.");
  }
  const absolute = (href: string | undefined) => (href ? new URL(href, "https://is.muni.cz/auth/student/").href : null);
  const field = (column: Cheerio<Element>, name: string) => {
    const node = column.find(`.stud_udalosti-${name}`).first().clone();
    node.find(".stud_udalosti-rozsah").remove();
    // Rooms read "(A217, <range>)"; drop the outer parentheses and the range's separator.
    return text(node).replace(/^\(|\)$/g, "").replace(/[,\s]+$/, "").trim() || null;
  };

  return sections.flatMap(([selector, section]) => {
    const events = [];
    let day: string | null = null;
    let year: string | null = null;
    for (const block of $(selector).children().toArray().map((element) => $(element))) {
      if (block.is("h3")) {
        if (section === "recent") year = /\d{4}/.exec(text(block))?.[0] ?? null;
        else day = headingDate(text(block), today);
        continue;
      }
      if (!block.is(".row")) continue;
      const label = text(block.children(".column").first());
      if (section === "recent") day = recentDate(label, year);
      const category = section === "recent" ? null : label;
      let header: { title: string; url: string | null } | null = null;
      for (const row of block.find(".stud_udalosti-box > .row").toArray().map((element) => $(element))) {
        const [timeColumn, detailColumn] = [row.children(".column").eq(0), row.children(".column").eq(1)];
        if (row.hasClass("stud_udalosti_header")) {
          const link = detailColumn.find("a").first();
          header = { title: text(detailColumn), url: absolute(link.attr("href")) };
          continue;
        }
        if (!day) throw new Error("Student event appears before any day heading.");
        const lead = detailColumn.children("span").first();
        const leadIsTitle = !header;
        const at = (time: string) => (time ? parseIsDate(`${day!.split("-").reverse().join(". ")} ${time}`) : null);
        events.push({
          section,
          day,
          category,
          title: header?.title ?? text(lead),
          course: field(detailColumn, "predmet"),
          start: at(text(timeColumn.find(".stud_udalosti-od"))),
          end: at(text(timeColumn.find(".stud_udalosti-do"))),
          range: parseRange(text(detailColumn.find(".stud_udalosti-rozsah"))),
          eventAt: leadIsTitle ? null : parseIsDate(text(lead)),
          location: field(detailColumn, "mistnost"),
          person: field(detailColumn, "osoba")?.replace(/,\s*učo\s*\d+$/, "") ?? null,
          period: field(detailColumn, "obdobi"),
          faculty: field(detailColumn, "fakulta"),
          url: header?.url ?? absolute(lead.find("a").attr("href")),
        });
        header = null;
      }
    }
    return events;
  });
}

/**
 * Fetch deadlines: the student page's events (now, upcoming, recent changes) plus open
 * homework submission folders from the study-materials page. Timetable entries are opt-in.
 */
export async function fetchDeadlines(session: IsSession, options: { includeTimetable?: boolean } = {}) {
  const { context } = await fetchStudentContext(session);
  const [page, materials] = await Promise.all([
    session.getPage(studentAjaxUrl("udalosti-init", { obdobi: context.periodId, studium: context.studyId })),
    fetchMaterialsOverview(session, context),
  ]);
  const today = pragueToday();
  const events = parseStudentEvents(parseAjaxHtml(page.html), today)
    .filter((event) => options.includeTimetable || event.category !== "Rozvrh");
  return { source: "is-mu" as const, today, events, submissionFolders: materials.submissionFolders };
}

export type StudentEvent = ReturnType<typeof parseStudentEvents>[number];
