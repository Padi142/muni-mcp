import { load } from "cheerio";
import type { IsSession } from "./session.js";
import { contextUrl, fetchStudentContext, text } from "./student.js";
import { parseIsDate } from "./time.js";

function assertPage(html: string, what: string) {
  const $ = load(html);
  if ($("#app_content").length !== 1 || $('input[type="password"]').length) {
    throw new Error(`Expected the authenticated ${what} page.`);
  }
  return $;
}

/** Parse "Moje známky" (`/auth/student/moje_znamky`) for the selected semester. */
export function parseGradesPage(html: string) {
  const $ = assertPage(html, "grades");
  const rows = $("table.data3 tr.elem_vybrane_obdobi").toArray().map((row) => $(row).children("td"))
    .filter((cells) => cells.length === 7);
  const courses = rows.map((cells) => {
    const [faculty = null, code = ""] = text(cells.eq(0).find("b a").first()).split(":");
    const grade = cells.eq(3).clone();
    grade.find(".show-for-sr").remove();
    const status = cells.eq(3).attr("class") ?? "";
    const entered = text(cells.eq(6));
    return {
      courseCode: code || faculty || "",
      faculty: code ? faculty : null,
      name: text(cells.eq(0)).replace(/^\S+\s*/, ""),
      credits: Number(text(cells.eq(1)).replace(",", ".")),
      completionType: text(cells.eq(2)) || null,
      grade: text(grade) || null,
      passed: /\bok\b/.test(status) ? true : /\bko\b/.test(status) ? false : null,
      gradedOn: parseIsDate(text(cells.eq(4))),
      note: text(cells.eq(5)) || null,
      enteredBy: entered.replace(/^[\d.\s:]+,\s*/, "") || null,
    };
  });
  const credits = /semestru:\s*(\d+)\s*z\s*(\d+)/.exec(text($(".elem_vybrane_obdobi_only")));
  return {
    semester: text($(".table_obdobi_nadpis").first()) || null,
    earnedCredits: credits ? Number(credits[1]) : null,
    enrolledCredits: credits ? Number(credits[2]) : null,
    courses,
  };
}

/**
 * Parse notebooks (`/auth/student/poznamkove_bloky_nahled`). By IS convention `*N` marks points
 * and `@X` a final grade; `points` sums every `*N` in one entry, raw `content` is always kept.
 */
export function parseNotebooksPage(html: string) {
  const $ = assertPage(html, "notebooks");
  return $("li.ipb-seznam-pol").toArray().map((item) => {
    const course = $(item);
    const title = text(course.find(".accordion-title .column").not(".shrink").first());
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
      };
    });
    return { courseCode: title.split(" ")[0] ?? "", name: title.replace(/^\S+\s*/, ""), entries };
  });
}

/** Fetch this semester's grades and notebook entries, merged per course. */
export async function fetchGrades(session: IsSession, options: { courseCode?: string } = {}) {
  const { context } = await fetchStudentContext(session);
  const [gradesPage, notebooksPage] = await Promise.all([
    session.getPage(contextUrl("/auth/student/moje_znamky", context)),
    session.getPage(contextUrl("/auth/student/poznamkove_bloky_nahled", context)),
  ]);
  const grades = parseGradesPage(gradesPage.html);
  const notebooks = parseNotebooksPage(notebooksPage.html);
  const key = (code: string) => code.toUpperCase();
  const notebooksByCourse = new Map(notebooks.map((n) => [key(n.courseCode), n.entries]));
  const graded = new Set(grades.courses.map((c) => key(c.courseCode)));
  const courses = [
    ...grades.courses.map((course) => ({ ...course, notebook: notebooksByCourse.get(key(course.courseCode)) ?? [] })),
    // Notebooks can exist for courses outside the selected semester's grade table.
    ...notebooks.filter((n) => !graded.has(key(n.courseCode))).map((n) => ({
      courseCode: n.courseCode, faculty: null, name: n.name, credits: null, completionType: null, grade: null,
      passed: null, gradedOn: null, note: null, enteredBy: null, notebook: n.entries,
    })),
  ];
  const wanted = options.courseCode?.trim().toUpperCase();
  return {
    source: "is-mu" as const,
    ...grades,
    courses: wanted ? courses.filter((c) => key(c.courseCode) === wanted) : courses,
  };
}
