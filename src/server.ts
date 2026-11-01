import { readFileSync } from "node:fs";
import { McpServer } from "@modelcontextprotocol/server";
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import * as z from "zod";
import { fetchCourses } from "./is/courses.js";
import { fetchDeadlines } from "./is/deadlines.js";
import { fetchExams } from "./is/exams.js";
import { fetchGrades } from "./is/grades.js";
import { fetchMaterials } from "./is/materials.js";
import { fetchOnlineTests } from "./is/online-tests.js";
import { createIsSession } from "./is/session.js";

/** Read `NAME_FILE` (preferred, path to a private file) or fall back to `NAME`. */
function readSecret(name: string) {
  const path = process.env[`${name}_FILE`];
  const value = path ? readFileSync(path, "utf8") : process.env[name];
  if (!value?.trim()) throw new Error(`Set ${name}_FILE or ${name}.`);
  return value;
}

const session = createIsSession({
  username: readSecret("MUNI_USERNAME").trim(),
  password: readSecret("MUNI_PASSWORD").replace(/\r?\n$/, ""),
});

/** Tool results are returned as pretty JSON text. */
const json = (value: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }] });

const readOnly = { readOnlyHint: true, openWorldHint: true };
const courseCode = z.string().optional().describe("Only this course, e.g. PV157. Omit for all courses.");

serveStdio(() => {
  const server = new McpServer({ name: "muni-mcp", version: "0.1.0" }, { capabilities: { tools: {} } });

  server.registerTool(
    "list_courses",
    {
      title: "List IS MU courses",
      description:
        "The student's courses this semester from the IS MU student page: code, name, whether it is " +
        "already completed, grade, credits, completion type (zk = exam, k = colloquium, z = credit), " +
        "teachers, weekly schedule, unread study materials, and links.",
      annotations: readOnly,
    },
    async () => json(await fetchCourses(session)),
  );

  server.registerTool(
    "list_deadlines",
    {
      title: "List IS MU deadlines",
      description:
        "Deadlines and events from the IS MU student page: exam sign-off deadlines, exam dates, online tests " +
        "(odpovědníky) opening and closing, application periods, and similar. `section` is now (today), " +
        "upcoming, or recent (recent changes such as notebook updates or newly announced exam terms). " +
        "`start`/`end` are times on `day`; `range` is the inclusive validity period; `eventAt` is the referenced " +
        "date, e.g. an exam's start. `submissionFolders` lists open homework folders (odevzdávárny) with their " +
        "inclusive deadline. Times are Europe/Prague.",
      inputSchema: z.object({
        includeTimetable: z.boolean().optional().describe("Also include regular classes (Rozvrh). Default false."),
      }),
      annotations: readOnly,
    },
    async ({ includeTimetable }) => json(await fetchDeadlines(session, { includeTimetable })),
  );

  server.registerTool(
    "list_exams",
    {
      title: "List IS MU exams and exam terms",
      description:
        "Exam terms from IS MU exam registration: terms you are registered for, every exam series with " +
        "upcoming terms (time, room, capacity, registration deadlines, teacher note), and courses with no " +
        "upcoming terms. `action` says whether you can register (or unregister, if registered): " +
        "available, available-after-unregistering (concurrent-registration limit), or unavailable. " +
        "Times are Europe/Prague; date-only deadlines are inclusive. It cannot register you.",
      inputSchema: z.object({ courseCode }),
      annotations: readOnly,
    },
    async (args) => json(await fetchExams(session, args)),
  );

  server.registerTool(
    "list_grades",
    {
      title: "List IS MU grades and points",
      description:
        "This semester's grades (grade, date, passed, note such as 'uznáno' = recognised) and each course's " +
        "notebook entries (poznámkové bloky) where teachers record points and results. In notebook content, " +
        "`*N` means N points and `@X` a final grade; `points` sums the `*N` values of one entry, `content` is raw. " +
        "Entries may overlap (e.g. a total next to its parts), so judge from `content` before adding them up.",
      inputSchema: z.object({ courseCode }),
      annotations: readOnly,
    },
    async (args) => json(await fetchGrades(session, args)),
  );

  server.registerTool(
    "list_materials",
    {
      title: "List IS MU study materials",
      description:
        "Study materials: per course the number of unread files, interactive syllabi, and open homework " +
        "submission folders with deadlines. Pass `courseCode` to also list every file of that course " +
        "(name, folder, type, size, upload time, uploader, URL). Many lecture PDFs have a .txt text version next to them.",
      inputSchema: z.object({ courseCode }),
      annotations: readOnly,
    },
    async (args) => json(await fetchMaterials(session, args)),
  );

  server.registerTool(
    "list_online_tests",
    {
      title: "List IS MU online tests",
      description:
        "Online tests (odpovědníky) per course: name, status (e.g. opens later, can be started), when it opens " +
        "and closes, and your result. IS hides tests of courses with very many of them; those are listed in " +
        "`hiddenCourses` (their upcoming windows still appear in list_deadlines). This never opens or starts a test.",
      inputSchema: z.object({
        courseCode,
        includeInaccessible: z.boolean().optional().describe("Also list tests you have no access to. Default false."),
      }),
      annotations: readOnly,
    },
    async (args) => json(await fetchOnlineTests(session, args)),
  );

  return server;
});
