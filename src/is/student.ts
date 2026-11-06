import { load } from "cheerio";
import * as z from "zod";
import { IS_ORIGIN, type IsSession } from "./session.js";

export const STUDENT_URL = `${IS_ORIGIN}/auth/student/`;
const AJAX_URL = `${IS_ORIGIN}/auth/student/index_ajax`;

/** The student page's AJAX endpoints answer with `{ html }`. */
const ajaxResponse = z.object({ html: z.string() });

export function parseAjaxHtml(body: string) {
  return ajaxResponse.parse(JSON.parse(body)).html;
}

export const text = (node: { text(): string }) => node.text().replace(/\s+/g, " ").trim();

/** Load an IS page, rejecting anything but its authenticated app view (e.g. the login form). */
export function loadAppPage(html: string, what: string) {
  const $ = load(html);
  if ($("#app_content").length !== 1 || $('input[type="password"]').length) {
    throw new Error(`Expected the authenticated ${what} page.`);
  }
  return $;
}

/** Read the current study context (faculty, period, study) from the student page's search form. */
export function parseStudentContext(html: string) {
  const $ = load(html);
  if ($("#app_content").length !== 1 || $('input[type="password"]').length) {
    throw new Error("Expected the authenticated IS MU student page.");
  }
  const field = (name: string) => {
    const value = $(`form[role="search"] input[name="${name}"]`).attr("value");
    if (!value || !/^\d+$/.test(value)) throw new Error(`Student page is missing its ${name} context.`);
    return value;
  };
  return { facultyId: field("fakulta"), periodId: field("obdobi"), studyId: field("studium") };
}

export type StudentContext = ReturnType<typeof parseStudentContext>;

/**
 * Build an `index_ajax` URL. Only the read-only panels we use are allowed here;
 * the page also wires actions (like toggling favourites) through other endpoints.
 */
export function studentAjaxUrl(
  option: "predmet-option-info" | "udalosti-init",
  params: Record<string, string>,
) {
  const query = Object.entries({ ...params, option }).map(([key, value]) => `${key}=${encodeURIComponent(value)}`);
  return `${AJAX_URL}?${query.join(";")}`;
}

/** An IS page URL carrying the study context, e.g. `contextUrl("/auth/student/moje_znamky", context)`. */
export function contextUrl(path: string, context: StudentContext) {
  return `${IS_ORIGIN}${path}?fakulta=${context.facultyId};obdobi=${context.periodId};studium=${context.studyId}`;
}

/** Fetch the student page once to learn the current study context. */
export async function fetchStudentContext(session: Pick<IsSession, "getPage">) {
  const page = await session.getPage(STUDENT_URL);
  return { html: page.html, context: parseStudentContext(page.html) };
}
