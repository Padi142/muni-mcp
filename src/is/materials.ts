import { load } from "cheerio";
import { IS_ORIGIN, type IsSession } from "./session.js";
import { contextUrl, fetchStudentContext, text, type StudentContext } from "./student.js";
import { parseIsDate, parseLocalIso } from "./time.js";

const MATERIALS_PATH = "/auth/student/studijni_materialy";

// Course labels read "FI:PA191 Advanced Computer Networking" (sometimes without the name).
function courseLabel(label: string) {
  const match = /^(?:(\S+?):)?(\S+)\s*(.*)$/.exec(label);
  return { faculty: match?.[1] ?? null, courseCode: match?.[2] ?? label, name: match?.[3] || null };
}

// File-manager links carry the folder as `furl=/el/fi/podzim2026/PA191/`.
const folderOf = (href: string | undefined) => /[?;&]furl=([^;&]+)/.exec(href ?? "")?.[1];

/** Parse the study-materials overview: unread files, interactive syllabi, open submission folders. */
export function parseMaterialsOverview(html: string) {
  const $ = load(html);
  const app = $("#app_content");
  if (app.length !== 1 || $('input[type="password"]').length) {
    throw new Error("Expected the authenticated study-materials page.");
  }
  // Each section is an <h2> followed by its list (or a "none" note); stay within the section.
  const listAfter = (prefix: string) => {
    const heading = app.find("h2").filter((_, h) => text($(h)).startsWith(prefix)).first();
    return heading.nextUntil("h2").filter("ul").first();
  };

  const courses = listAfter("Předměty mající vystavené").children("li").toArray().map((li) => {
    const link = $(li).find("a").first();
    return { ...courseLabel(text(link)), folder: decodeURIComponent(folderOf(link.attr("href")) ?? "") || null };
  });
  const unread = new Map(listAfter("Nové -- dosud nečtené -- soubory ve studijních").children("li").toArray().map((li) => {
    const count = /\((\d+)/.exec(text($(li)))?.[1];
    return [courseLabel(text($(li).find("a").first())).courseCode, Number(count ?? 0)] as const;
  }));

  // Nested lists: <li>FI:PA103</li><ul><li><a>Syllabus</a></li></ul>
  const syllabi = new Map<string, { title: string; url: string }[]>();
  let current = "";
  for (const node of listAfter("Interaktivní osnovy").children().toArray()) {
    if (node.tagName === "li") current = courseLabel(text($(node))).courseCode;
    else for (const a of $(node).find("a").toArray()) {
      const list = syllabi.get(current) ?? [];
      list.push({ title: text($(a)), url: new URL($(a).attr("href")!, `${IS_ORIGIN}${MATERIALS_PATH}`).href });
      syllabi.set(current, list);
    }
  }

  // <li>FI:PV021 Neural Networks</li><ul><li><a><b>Project</b></a> <b>(do 6. 12. 2026 vč.)</b></li></ul>
  const submissionFolders = [];
  current = "";
  for (const node of listAfter("Vám otevřené odevzdávárny").children().toArray()) {
    if (node.tagName === "li") current = courseLabel(text($(node))).courseCode;
    else for (const li of $(node).children("li").toArray()) {
      const link = $(li).find("a").first();
      const deadline = /do\s+([\d.\s:]+?)\s*vč/.exec(text($(li)))?.[1];
      submissionFolders.push({
        courseCode: current,
        title: text(link),
        until: deadline ? parseIsDate(deadline) : null,
        folder: decodeURIComponent(folderOf(link.attr("href")) ?? "") || null,
      });
    }
  }

  return {
    courses: courses.map((course) => ({
      ...course,
      unreadFiles: unread.get(course.courseCode) ?? 0,
      interactiveSyllabi: syllabi.get(course.courseCode) ?? [],
    })),
    submissionFolders,
  };
}

/** Parse one File Manager API response (`/auth/dok/fmgr_api?url=<folder>`): the folder, its subfolders and files. */
export function parseFolderXml(xml: string) {
  const $ = load(xml, { xml: true });
  const root = $("fmgr > uzel");
  if (root.length !== 1) throw new Error("Unexpected File Manager API response.");
  const files = (folder: ReturnType<typeof $>) => folder.children("objekty").children("objekt").toArray().map((element) => {
    const file = $(element);
    const value = (name: string) => file.children(name).text().trim() || null;
    const path = value("cesta") ?? "";
    return {
      name: value("jmeno_souboru") ?? path.split("/").pop() ?? "",
      path,
      mimeType: value("mime_type"),
      size: Number(value("velikost") ?? NaN),
      uploaded: parseLocalIso(value("vlozeno")),
      uploadedBy: value("vlozil_jmeno"),
      // Link objects (mime "my/url") store their target as the file name.
      url: value("mime_type") === "my/url" ? value("jmeno_souboru") : `${IS_ORIGIN}/auth${path}`,
    };
  });
  const folder = (node: ReturnType<typeof $>) => ({
    path: node.children("cesta").text().trim(),
    name: node.children("nazev").text().replace(/<[^>]+>/g, "").trim() || null,
    subfolderCount: Number(node.children("pocet_poduzlu").text() || 0),
    files: files(node),
  });
  return {
    ...folder(root),
    subfolders: root.children("poduzly").children("poduzel").toArray().map((node) => folder($(node))),
  };
}

/** Folder paths must stay inside a course's study materials, e.g. `/el/fi/podzim2026/PV157/`. */
const materialsFolder = /^\/el\/[a-z]+\/[a-z]+\d{4}\/[^/]+\//;

/**
 * Walk a course's materials through the File Manager API and return a flat file list.
 * Each response already includes its subfolders' files, so only folders with deeper
 * subfolders are fetched. Online-test definitions (`odp/`) are skipped. Bounded to `maxRequests`.
 */
export async function fetchCourseFiles(session: IsSession, folder: string, maxRequests = 30) {
  if (!materialsFolder.test(folder)) throw new Error("Not a course study-materials folder.");
  const files = [];
  const queue = [{ path: folder, label: "" }];
  let requests = 0;
  while (queue.length && requests < maxRequests) {
    const batch = queue.splice(0, Math.min(queue.length, 5, maxRequests - requests));
    requests += batch.length;
    const results = await Promise.all(batch.map(async (item) => {
      const page = await session.getPage(`${IS_ORIGIN}/auth/dok/fmgr_api?url=${encodeURI(item.path)}`);
      return { item, folder: parseFolderXml(page.html) };
    }));
    for (const { item, folder: parsed } of results) {
      files.push(...parsed.files.map((file) => ({ ...file, folder: item.label || null })));
      for (const sub of parsed.subfolders) {
        if (sub.path.endsWith("/odp/")) continue;
        // Numbered folders have no name; they inherit the parent's label.
        const label = [item.label, sub.name].filter(Boolean).join(" / ");
        files.push(...sub.files.map((file) => ({ ...file, folder: label || null })));
        if (sub.subfolderCount > 0) queue.push({ path: sub.path, label });
      }
    }
  }
  return { files, complete: queue.length === 0 };
}

export async function fetchMaterialsOverview(session: IsSession, context: StudentContext) {
  const page = await session.getPage(contextUrl(MATERIALS_PATH, context));
  return parseMaterialsOverview(page.html);
}

/** Fetch the materials overview, and the full file list for one course when `courseCode` is given. */
export async function fetchMaterials(session: IsSession, options: { courseCode?: string } = {}) {
  const { context } = await fetchStudentContext(session);
  const overview = await fetchMaterialsOverview(session, context);
  const wanted = options.courseCode?.trim().toUpperCase();
  if (!wanted) return { source: "is-mu" as const, ...overview };

  const course = overview.courses.find((c) => c.courseCode.toUpperCase() === wanted);
  if (!course?.folder) throw new Error(`No study materials found for ${options.courseCode}.`);
  const { files, complete } = await fetchCourseFiles(session, course.folder);
  return {
    source: "is-mu" as const,
    courses: [{ ...course, files, filesComplete: complete }],
    submissionFolders: overview.submissionFolders.filter((s) => s.courseCode.toUpperCase() === wanted),
  };
}
