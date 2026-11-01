import { load } from "cheerio";
import type { IsSession } from "./session.js";
import { contextUrl, fetchStudentContext, text } from "./student.js";
import { parseIsDate } from "./time.js";

const TESTS_PATH = "/auth/elearning/test_pruchod_el_student";

/**
 * Parse the online-tests (odpovědníky) overview. IS hides tests of courses with very many
 * of them unless an expensive recount runs; those courses are reported in `hiddenCourses`.
 * Test links only select a test; nothing here ever opens or starts one.
 */
export function parseOnlineTests(html: string) {
  const $ = load(html);
  if ($("#app_content").length !== 1 || $('input[type="password"]').length) {
    throw new Error("Expected the authenticated online-tests page.");
  }
  const hiddenCourses = $(".zdurazneni.upozorneni li").toArray()
    .map((li) => text($(li)).split(":")[0]!.trim());
  const courses = $(".seznam-odp-predmet").toArray().map((block) => {
    const course = $(block);
    const title = text(course.find(".seznam-odp-head h2").first());
    const tests = course.find("table.data3 tbody tr").toArray().map((row) => {
      const cells = $(row);
      const link = cells.find("td.uzel a").first();
      // The window reads "od <date>" / "do <date>", each in its own wrapper; either may be missing.
      const window = new Map(cells.find(".poznamka .odp_date_time").toArray().map((element) => {
        const date = $(element);
        return [text(date.parent()).replace(text(date), "").trim(), parseIsDate(text(date))] as const;
      }));
      const note = cells.find("td.poznamka").clone();
      note.find(".odp_date_time").parent().remove();
      return {
        name: text(link),
        status: cells.find("td.budik i").attr("title")?.replace(/\.$/, "") ?? null,
        accessible: !cells.hasClass("odp_bez_prav"),
        opens: window.get("od") ?? null,
        closes: window.get("do") ?? null,
        result: text(cells.find("td.hodn-pb")) || null,
        note: text(note) || null,
        url: link.attr("href") ? new URL(link.attr("href")!, `https://is.muni.cz${TESTS_PATH}`).href : null,
      };
    });
    return { courseCode: title.split(" ")[0] ?? "", name: title.replace(/^\S+\s*/, ""), tests };
  });
  return { courses, hiddenCourses };
}

/** Fetch online tests. Tests you have no access to are dropped unless `includeInaccessible`. */
export async function fetchOnlineTests(
  session: IsSession,
  options: { courseCode?: string; includeInaccessible?: boolean } = {},
) {
  const { context } = await fetchStudentContext(session);
  const page = await session.getPage(contextUrl(TESTS_PATH, context));
  const { courses, hiddenCourses } = parseOnlineTests(page.html);
  const wanted = options.courseCode?.trim().toUpperCase();
  return {
    source: "is-mu" as const,
    courses: courses
      .filter((c) => !wanted || c.courseCode.toUpperCase() === wanted)
      .map((c) => ({ ...c, tests: c.tests.filter((t) => options.includeInaccessible || t.accessible) }))
      .filter((c) => c.tests.length > 0),
    hiddenCourses: hiddenCourses.filter((code) => !wanted || code.toUpperCase() === wanted),
  };
}
