import { load } from "cheerio";
import type { IsSession } from "./session.js";
import { fetchStudentContext, parseAjaxHtml, studentAjaxUrl, text, type StudentContext } from "./student.js";

/** Parse the "Moje předměty" cards on the student page (`/auth/student/`). */
export function parseCourseCards(html: string) {
  const $ = load(html);
  const section = $("#tab-content-predmety-subcontent");
  if (section.length !== 1) throw new Error("Student page layout changed: missing the course list.");
  return section.find(".predmet_conteiner").toArray().map((element) => {
    const card = $(element);
    const header = card.find(".predmet_header_name");
    const courseId = /^predmet-button-(\d+)$/.exec(card.find("a.predmet_header_more").attr("id") ?? "")?.[1];
    const facultyId = /\/loga\/(\d+)\.svg$/.exec(header.find("img").attr("src") ?? "")?.[1];
    const code = text(header.find("strong"));
    if (!courseId || !facultyId || !code) throw new Error("Course card is missing its code or IDs.");
    return {
      courseId,
      facultyId,
      code,
      name: text(header).slice(code.length).trim(),
      completed: card.find(".isi-potvrzeni.ok").length > 0,
    };
  });
}

/** Parse a course's expanded info panel: teachers, schedule, grade, credits, and useful links. */
export function parseCourseInfo(html: string) {
  const $ = load(html);
  // Values sit next to screen-reader labels, e.g. `<span title="Počet kreditů"><span class="show-for-sr">…</span>4 kr.</span>`.
  const rated = (title: string) => {
    const span = $(`.hodnoceni span[title="${title}"]`).first().clone();
    span.find(".show-for-sr").remove();
    return text(span) || null;
  };
  const credits = rated("Počet kreditů")?.match(/^(\d+(?:[.,]\d+)?)/)?.[1];
  const materials = $("a[href*='/auth/el/']").first();
  const absolute = (href: string | undefined) => (href ? new URL(href, "https://is.muni.cz/auth/student/").href : null);
  const scheduleText = text($(".student_row_a .column").first());
  return {
    teachers: $(".vyucujici a").toArray().map((a) => text($(a))),
    schedule: /Rozvrh\s*(.+)$/.exec(scheduleText)?.[1] ?? null,
    grade: rated("Získané hodnocení"),
    credits: credits ? Number(credits.replace(",", ".")) : null,
    completionType: rated("Ukončení"),
    unreadMaterials: Number(text(materials.find(".pocet_nectene2")).match(/\d+/)?.[0] ?? 0),
    links: {
      materials: absolute(materials.attr("href")),
      forum: absolute($("a[href*='diskusni_forum_predmet']").attr("href")),
      catalogue: absolute($("a[href^='/predmet/']").attr("href")),
    },
  };
}

async function fetchCourseInfo(session: IsSession, context: StudentContext, course: { courseId: string; facultyId: string }) {
  const page = await session.getPage(studentAjaxUrl("predmet-option-info", {
    fakulta: course.facultyId,
    obdobi: context.periodId,
    studium: context.studyId,
    vsechna_studia: "0",
    predmet_id: course.courseId,
  }));
  return parseCourseInfo(parseAjaxHtml(page.html));
}

/** Fetch the current semester's courses from the student page, with each course's info panel. */
export async function fetchCourses(session: IsSession) {
  const { html, context } = await fetchStudentContext(session);
  const courses = await Promise.all(parseCourseCards(html).map(async (course) => ({
    ...course,
    ...(await fetchCourseInfo(session, context, course)),
  })));
  return { source: "is-mu" as const, ...context, courses };
}

export type Course = Awaited<ReturnType<typeof fetchCourses>>["courses"][number];
