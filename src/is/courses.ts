import { load } from "cheerio";
import { IS_ORIGIN, type IsSession } from "./session.js";

const sections = [
  { id: "rpa-predmety-pripraveno", sourceStatus: "pripraveno", status: "prepared" },
  { id: "rpa-predmety-zaregistrovano", sourceStatus: "zaregistrovano", status: "registered" },
  { id: "rpa-predmety-zapsano", sourceStatus: "zapsano", status: "enrolled" },
] as const;

function requireValue(value: string | undefined, field: string): string {
  const text = value?.trim();
  if (!text) throw new Error(`Course page is missing ${field}.`);
  return text;
}

function requireIdentifier(value: string | undefined, field: string): string {
  const identifier = requireValue(value, field);
  if (!/^\d+$/.test(identifier)) throw new Error(`Course page has an invalid ${field}.`);
  return identifier;
}

/** Parse only the student's three course sections, excluding catalogues and hidden dialogs. */
export function parseCoursesPage(html: string, sourceUrl: string) {
  const source = new URL(sourceUrl);
  if (source.origin !== "https://is.muni.cz" || source.pathname !== "/auth/student/zapis") {
    throw new Error("Expected the IS MU course-enrolment URL.");
  }
  source.searchParams.delete("save_obd_pref");
  const $ = load(html);
  const app = $("#app_content .registrace-predmetu-app");
  if (app.length !== 1 || $('input[type="password"]').length) {
    throw new Error("Expected an authenticated course-enrolment page.");
  }
  const courses = sections.flatMap((section) => {
    const container = app.find(`#${section.id}`);
    if (container.length !== 1) {
      throw new Error(`Course page layout changed: missing ${section.id}.`);
    }
    return container.find(".rpa-predmet").toArray().map((element) => {
      const card = $(element);
      if (card.attr("data-stav") !== section.sourceStatus) {
        throw new Error("Course status disagrees with its enrolment section.");
      }
      const codeLink = card.find(".nazev-predmet a.jen-kod").first();
      const url = new URL(requireValue(codeLink.attr("href"), "course link"), source);
      if (url.origin !== source.origin || !url.pathname.startsWith("/auth/predmet/")) {
        throw new Error("Course link has an unexpected destination.");
      }
      const creditsText = requireValue(card.find(".kr-aktualne").text(), "credits");
      if (!/^\d+(?:[.,]\d+)?$/.test(creditsText)) {
        throw new Error("Course page has an unrecognized credit value.");
      }
      return {
        courseId: requireIdentifier(card.attr("data-predmet-id"), "course ID"),
        facultyId: requireIdentifier(card.attr("data-fakulta-id"), "faculty ID"),
        code: requireValue(codeLink.text(), "course code"),
        name: requireValue(card.find(".nazev-predmet .jen-nazev").text(), "course name")
          .replace(/\s+/g, " "),
        status: section.status,
        credits: Number(creditsText.replace(",", ".")),
        completionType: requireValue(card.attr("data-ukonceni"), "completion type"),
        url: url.href,
      };
    });
  });
  const identities = courses.map((course) => `${course.facultyId}:${course.courseId}`);
  if (new Set(identities).size !== identities.length) {
    throw new Error("Course page contains duplicate course offerings.");
  }
  return {
    source: "is-mu" as const,
    sourceUrl: source.href,
    studyId: source.searchParams.get("studium"),
    periodId: source.searchParams.get("obdobi"),
    courses,
    counts: {
      prepared: courses.filter((course) => course.status === "prepared").length,
      registered: courses.filter((course) => course.status === "registered").length,
      enrolled: courses.filter((course) => course.status === "enrolled").length,
    },
    enrolledCredits: courses.reduce((total, course) =>
      total + (course.status === "enrolled" ? course.credits : 0), 0),
  };
}

/** Fetch and parse the course-enrolment page. Without query params IS picks the current study and period. */
export async function fetchCourses(session: IsSession, pageUrl = `${IS_ORIGIN}/auth/student/zapis`) {
  const url = new URL(pageUrl);
  // This flag persists a UI preference in IS; reading the page doesn't need it.
  url.searchParams.delete("save_obd_pref");
  const page = await session.getPage(url);
  return parseCoursesPage(page.html, page.url.href);
}

export type CoursesPage = ReturnType<typeof parseCoursesPage>;
export type Course = CoursesPage["courses"][number];
