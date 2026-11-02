import type { IsSession } from "./session.js";
import { contextUrl, fetchStudentContext, loadAppPage, text } from "./student.js";
import { parseIsDate } from "./time.js";

/** Parse "Moje známky" (`/auth/student/moje_znamky`) for the selected semester. */
export function parseGradesPage(html: string) {
  const $ = loadAppPage(html, "grades");
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

/** Fetch this semester's grades, optionally for one course. */
export async function fetchGrades(session: IsSession, options: { courseCode?: string } = {}) {
  const { context } = await fetchStudentContext(session);
  const page = await session.getPage(contextUrl("/auth/student/moje_znamky", context));
  const grades = parseGradesPage(page.html);
  const wanted = options.courseCode?.trim().toUpperCase();
  return {
    source: "is-mu" as const,
    ...grades,
    courses: wanted ? grades.courses.filter((c) => c.courseCode.toUpperCase() === wanted) : grades.courses,
  };
}
