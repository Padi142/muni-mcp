import { IS_ORIGIN, type IsSession } from "./session.js";
import { loadAppPage, text } from "./student.js";
import { parseIsDate } from "./time.js";

const NOTEBOOKS_URL = `${IS_ORIGIN}/auth/student/poznamkove_bloky_nahled`;

/**
 * Parse notebooks (`/auth/student/poznamkove_bloky_nahled`). By IS convention `*N` marks points
 * and `@X` a final grade; `points` sums every `*N` in one entry, raw `content` is always kept.
 */
export function parseNotebooksPage(html: string) {
  const $ = loadAppPage(html, "notebooks");
  return $("li.ipb-seznam-pol").toArray().map((item) => {
    const course = $(item);
    const title = text(course.find(".accordion-title .column").not(".shrink").first());
    const id = course.attr("id");
    const entries = course.find(".ipb-pol").toArray().map((element) => {
      const entry = $(element);
      const content = entry.find(".ipb-obsah .obsah pre").first().text().trim();
      const stars = [...content.matchAll(/\*\s*(-?\d+(?:[.,]\d+)?)/g)].map((m) => Number(m[1]!.replace(",", ".")));
      const changed = entry.find(".ipb-zmeneno div");
      return {
        name: text(entry.find(".ipb-nazev")),
        content,
        points: stars.length ? stars.reduce((sum, value) => sum + value, 0) : null,
        finalGrade: /@\s*(\S+)/.exec(content)?.[1] ?? null,
        changed: parseIsDate(text(changed.eq(0))),
        changedBy: text(changed.eq(1)) || null,
        // The student's files in the submission folder attached to this notebook.
        submittedFiles: entry.find(".ipb-obsah-feedback a[href^='/auth/el/']").toArray().map((a) => ({
          name: text($(a)),
          path: decodeURIComponent($(a).attr("href")!.slice("/auth".length)),
        })),
      };
    });
    return {
      courseCode: title.split(" ")[0] ?? "",
      name: title.replace(/^\S+\s*/, ""),
      url: id ? `${NOTEBOOKS_URL}#${id}` : NOTEBOOKS_URL,
      entries,
    };
  });
}

/** Fetch notebooks, optionally for one course. IS only lists courses that have a notebook. */
export async function fetchNotebooks(session: IsSession, options: { courseCode?: string } = {}) {
  const page = await session.getPage(NOTEBOOKS_URL);
  const courses = parseNotebooksPage(page.html);
  const wanted = options.courseCode?.trim().toUpperCase();
  return {
    source: "is-mu" as const,
    courses: wanted ? courses.filter((c) => c.courseCode.toUpperCase() === wanted) : courses,
  };
}
