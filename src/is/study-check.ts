import type { AnyNode, Element } from "domhandler";
import type { CheerioAPI } from "cheerio";
import { IS_ORIGIN, type IsSession } from "./session.js";
import { fetchStudentContext, loadAppPage, text } from "./student.js";

const CHECK_PATH = "/auth/student/moje_kontrola_studia";

/** IS marks each row with a coloured "o"/"x" or a "?"; see the legend above the check. */
const statuses = { green: "met", red: "unmet", blue: "met-in-other-study" } as const;
type Status = (typeof statuses)[keyof typeof statuses] | "enrolled";

type Course = {
  type: "course";
  code: string;
  name: string;
  status: Status;
  /** What you got, or for enrolled courses what you are enrolled for, e.g. `{ completion: "zk", credits: 4 }`. */
  result: { completion: string; credits: number | null } | null;
  /** The template's own requirement, e.g. "[ pož. ukončení: z, kredity: 16 ]". */
  requiredCompletion: string | null;
  requiredCredits: number | null;
  url: string;
};
type Block = { type: "block"; name: string; status: Status; rule: string; items: Requirement[] };
export type Requirement = Course | Block;

/** The study's templates (kontrolní šablony) as checkbox fields of the check form. */
export function parseTemplates(html: string) {
  const $ = loadAppPage(html, "study check");
  const form = $(`form[action^="${CHECK_PATH}"]`);
  const study = form.find('input[type="hidden"][name="exppar_sabprokon"]').attr("value");
  if (form.length !== 1 || !study || !/^\d+$/.test(study)) throw new Error("The study check page has changed: no check form.");
  const templates = form.find('input[type="checkbox"][name^="sabprokon_"]').toArray().map((input) => ({
    field: $(input).attr("name") ?? "",
    id: $(input).attr("value") ?? "",
    name: text($(input).parent("label")),
    mandatory: $(input).attr("name") === "sabprokon_p",
  }));
  if (templates.some(({ field, id }) => !/^sabprokon_[a-z]+$/.test(field) || !/^\d+$/.test(id))) {
    throw new Error("The study check page has changed: unexpected template fields.");
  }
  return { study, templates };
}

/** The nodes of one result row: everything after its `<tt>` indent up to the next `<br>`. */
function rowNodes(tt: Element) {
  const nodes: AnyNode[] = [];
  for (let node = tt.nextSibling; node && !(node.type === "tag" && node.name.toLowerCase() === "br"); node = node.nextSibling) {
    nodes.push(node);
  }
  return nodes;
}

function rowStatus($: CheerioAPI, marker: AnyNode | undefined): Status {
  const $marker = marker ? $(marker) : null;
  if ($marker?.is("span.maybe")) return "enrolled";
  const color = $marker?.is("font") ? $marker.attr("color")?.toLowerCase() : undefined;
  const status = color && color in statuses ? statuses[color as keyof typeof statuses] : undefined;
  if (!status) throw new Error("The study check page has changed: unknown row marker.");
  return status;
}

function parseRow($: CheerioAPI, tt: Element): Requirement {
  const nodes = rowNodes(tt);
  const tags = nodes.filter((node): node is Element => node.type === "tag");
  const status = rowStatus($, tags[0]);
  const title = tags.find((node) => node.name.toLowerCase() === "b");
  if (!title) throw new Error("The study check page has changed: a row has no name.");
  const rest = text($(nodes.slice(nodes.indexOf(title) + 1)));
  const link = $(title).find("a").first();

  if (!link.length) {
    return { type: "block", name: text($(title)), status, rule: rest.replace(/^–\s*/, ""), items: [] };
  }
  const resultText = text($(tags.filter((node) => node.name.toLowerCase() === "i")));
  const result = /^(.*?)\s*\((\d+)\s*kr\.\)$/.exec(resultText);
  const requirement = /\[([^\]]*)\]/.exec(rest)?.[1] ?? "";
  const requiredCredits = /kredity:\s*(\d+)/.exec(requirement)?.[1];
  return {
    type: "course",
    code: text(link),
    name: rest.replace(/\[[^\]]*\]/, "").replace(resultText, "").trim(),
    status,
    result: resultText ? { completion: result?.[1] ?? resultText, credits: result ? Number(result[2]) : null } : null,
    requiredCompletion: /pož\. ukončení:\s*([^,]+)/.exec(requirement)?.[1]?.trim() ?? null,
    requiredCredits: requiredCredits ? Number(requiredCredits) : null,
    url: new URL(link.attr("href") ?? "", IS_ORIGIN).href,
  };
}

/**
 * Parse the check result: one row per line, indented by `<tt>` with two `&nbsp;` per level.
 * Returns the top-level rows (one per template) with their blocks and courses nested.
 */
export function parseStudyCheck(html: string) {
  const $ = loadAppPage(html, "study check");
  const rows = $(`form[action^="${CHECK_PATH}"] tt`).toArray();
  if (!rows.length) throw new Error("The study check page has changed: no check results.");
  const roots: Requirement[] = [];
  const open: Block[] = [];
  for (const tt of rows) {
    const depth = $(tt).text().length / 2;
    const row = parseRow($, tt);
    if (!Number.isInteger(depth) || depth > open.length) throw new Error("The study check page has changed: bad indentation.");
    open.length = depth;
    (open.at(-1)?.items ?? roots).push(row);
    if (row.type === "block") open.push(row);
  }
  return roots;
}

/** Check the current study against its templates, as the "Zkontrolovat studium" button does. */
export async function fetchStudyCheck(session: Pick<IsSession, "getPage">) {
  const { context } = await fetchStudentContext(session);
  const base = `${IS_ORIGIN}${CHECK_PATH}?fakulta=${context.facultyId};studium=${context.studyId}`;
  const { study, templates } = parseTemplates((await session.getPage(base)).html);
  if (!templates.length) return { source: "is-mu" as const, templates, requirements: [] };
  const fields = templates.map(({ field, id }) => `${field}=${id}`).join(";");
  const page = await session.getPage(`${base};exppar_sabprokon=${study};${fields};sabprokon_tl=Zkontrolovat%20studium`);
  return { source: "is-mu" as const, templates: templates.map(({ id, name, mandatory }) => ({ id, name, mandatory })), requirements: parseStudyCheck(page.html) };
}
