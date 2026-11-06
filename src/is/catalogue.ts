import { type Cheerio, load } from "cheerio";
import type { AnyNode } from "domhandler";
import * as z from "zod";
import { IS_ORIGIN, type IsSession } from "./session.js";
import { loadAppPage, text } from "./student.js";

const SEARCH_URL = `${IS_ORIGIN}/auth/predmety/predmety_ajax.pl`;
// IS returns at most this many courses per search; the rest needs the browser app's selection state.
const MAX_RESULTS = 300;
export const DEFAULT_COURSE_PAGE_SIZE = 50;

/** IS's faculty IDs, which the catalogue filters by. They have not changed in decades. */
export const FACULTIES = {
  LF: "1411", FaF: "1416", FF: "1421", PrF: "1422", FSS: "1423", PřF: "1431",
  FI: "1433", PdF: "1441", FSpS: "1451", ESF: "1456", CST: "1490",
} as const;
export type Faculty = keyof typeof FACULTIES;

const termNames: Record<string, string> = { jaro: "jaro", spring: "jaro", podzim: "podzim", autumn: "podzim", fall: "podzim", léto: "léto", summer: "léto" };

/** Normalise "jaro 2027", "Spring2027" or "fall 2026" to IS's "jaro 2027". */
export function parseTerm(input: string) {
  const match = /^\s*(\p{L}+)\s*(\d{4})\s*$/u.exec(input);
  const season = match?.[1] && termNames[match[1].toLowerCase()];
  if (!match || !season) throw new Error(`Unknown term "${input}". Use e.g. "podzim 2026" or "jaro 2027".`);
  return `${season} ${match[2]}`;
}

const searchResponse = z.object({ count: z.coerce.number(), table_tr: z.array(z.string()).default([]) });

/** One row of the catalogue's search results. */
export function parseCourseRow(html: string) {
  const $ = load(html);
  const link = $("a.course_link").first();
  const href = link.attr("href") ?? "";
  const label = /^(.*) \(([^()]+)\)$/.exec(text($(".radek-nazev-label").first()));
  const [prefix, code] = text(link).includes(":") ? text(link).split(":", 2) : [null, text(link)];
  if (!code || !label || !/^\/auth\/predmet\/[\w-]+\/[\w-]+\/[\w-]+$/.test(href)) {
    throw new Error("The course catalogue's results have changed.");
  }
  const teachers = $(".td_teachers [title]").first().attr("title") ?? "";
  return {
    code,
    faculty: prefix ?? null,
    name: label[1] ?? "",
    term: label[2] ?? "",
    teachers: teachers.split("\n").map((name) => name.trim()).filter(Boolean),
    url: `${IS_ORIGIN}${href}`,
  };
}

export type CourseSearch = { query?: string; faculty?: Faculty; term?: string; page?: number; pageSize?: number };

/** Search the course catalogue (`/auth/predmety/`) by code, name or text, optionally per faculty and term. */
export async function searchCourses(session: Pick<IsSession, "getPage">, search: CourseSearch) {
  const { query = "", faculty, page = 1, pageSize = DEFAULT_COURSE_PAGE_SIZE } = search;
  const term = search.term ? parseTerm(search.term) : undefined;
  if (!query.trim() && !faculty && !term) throw new Error("Give a query, a faculty or a term.");
  const filters = { ...(faculty && { faculties: [FACULTIES[faculty]] }), ...(term && { terms: [term] }) };
  const url = `${SEARCH_URL}?operace=get_courses;filters=${encodeURIComponent(JSON.stringify(filters))};search_text=${encodeURIComponent(query.trim())}`;
  const { count, table_tr: rows } = searchResponse.parse(JSON.parse((await session.getPage(url)).html));
  const courses = rows.map(parseCourseRow).map((course) => ({ ...course, faculty: course.faculty ?? faculty ?? null }));
  return {
    source: "is-mu" as const,
    total: count,
    page,
    pageSize,
    totalPages: Math.ceil(courses.length / pageSize),
    // IS lists at most MAX_RESULTS courses; past that, the search has to be narrowed.
    complete: courses.length >= count,
    courses: courses.slice((page - 1) * pageSize, page * pageSize),
  };
}

/** A `<dd>` as plain text, keeping line breaks and list items but not the HTML source's own wrapping. */
function sectionText(dd: Cheerio<AnyNode>) {
  const copy = dd.clone();
  copy.find("*").addBack().contents().each((_, node) => {
    if (node.type === "text") node.data = node.data.replace(/\s+/g, " ");
  });
  copy.find("br").replaceWith("\n");
  copy.find("li").prepend("- ");
  copy.find("ul, ol").prepend("\n");
  copy.find("p, ul, ol, div, li").append("\n");
  return copy.text().split("\n").map((line) => line.trim()).join("\n").replace(/\n{3,}/g, "\n\n").trim();
}

/** Parse a course's catalogue page (`/predmet/<faculty>/<term>/<code>`): its `dt`/`dd` sections, keyed by title. */
export function parseCoursePage(html: string) {
  const $ = loadAppPage(html, "course");
  const main = $("#app_content");
  const heading = main.children("h2").first().clone();
  heading.find("span").remove();
  const [code = "", ...name] = text(heading).split(" ");
  const list = main.children("dl").first();
  if (!code || !list.length) throw new Error("The course page has changed: no heading or sections.");
  // The faculty is in <b>, followed by the term as plain text before the <dl>.
  const faculty = main.children("b").first();
  const nodes = main.contents().toArray();
  const header = nodes.slice(nodes.indexOf(faculty[0] ?? list[0]!) + 1, nodes.indexOf(list[0]!));
  const term = header.flatMap((node) => (node.type === "text" && node.data.trim() ? [node.data.trim()] : []))[0] ?? null;
  const sections = Object.fromEntries(
    list.children("dt").toArray().map((dt) => [text($(dt)), sectionText($(dt).next("dd"))]),
  );
  const permalink = main.find("span.nedurazne").toArray().map((span) => text($(span))).find((t) => t.startsWith(`${IS_ORIGIN}/`));
  const materials = list.find('a[href^="/auth/el/"]').first().attr("href");
  return {
    code,
    name: name.join(" "),
    faculty: text(faculty) || null,
    term,
    url: permalink ?? null,
    materials: materials ? `${IS_ORIGIN}${materials}` : null,
    sections,
  };
}

/**
 * Look up a course by code ("PA015" or "FI:PA015"), in one term or the catalogue's current offer.
 * The catalogue search finds its faculty and term, so callers don't need IS's URL slugs.
 */
export async function fetchCourse(session: Pick<IsSession, "getPage">, { code, term }: { code: string; term?: string }) {
  const parsed = /^\s*(?:([^:\s]+):)?([\w-]+)\s*$/u.exec(code);
  const prefix = parsed?.[1];
  const faculty = prefix ? (Object.keys(FACULTIES) as Faculty[]).find((f) => f.toLowerCase() === prefix.toLowerCase()) : undefined;
  if (!parsed?.[2] || (prefix && !faculty)) throw new Error(`Unknown course code "${code}". Use e.g. PA015 or FI:PA015.`);
  const wanted = parsed[2].toLowerCase();
  const found = await searchCourses(session, { query: parsed[2], faculty, term, pageSize: MAX_RESULTS });
  const matches = found.courses.filter((course) => course.code.toLowerCase() === wanted);
  const faculties = [...new Set(matches.map((course) => course.faculty))];
  const [match] = matches;
  if (!match) throw new Error(`No course ${code} in the catalogue${term ? ` for ${parseTerm(term)}` : ""}. Try search_courses.`);
  if (faculties.length > 1) throw new Error(`${parsed[2]} exists at several faculties: ${faculties.join(", ")}. Add one, e.g. ${faculties[0]}:${parsed[2]}.`);
  const course = parseCoursePage((await session.getPage(match.url)).html);
  return { source: "is-mu" as const, ...course, otherTerms: matches.slice(1).map((other) => other.term) };
}
