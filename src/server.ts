import { readFileSync } from "node:fs";
import { McpServer } from "@modelcontextprotocol/server";
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import * as z from "zod";
import { fetchCourses } from "./is/courses.js";
import { fetchExams } from "./is/exams.js";
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

serveStdio(() => {
  const server = new McpServer({ name: "muni-mcp", version: "0.1.0" }, { capabilities: { tools: {} } });

  server.registerTool(
    "list_courses",
    {
      title: "List IS MU courses",
      description:
        "List the student's courses for the current semester from IS MU (prepared, registered, enrolled), " +
        "with credits, completion type, and links to course pages. Read-only.",
      inputSchema: z.object({
        status: z.enum(["prepared", "registered", "enrolled"]).optional()
          .describe("Only return courses in this state. Omit for all."),
        pageUrl: z.url().optional()
          .describe("A specific https://is.muni.cz/auth/student/zapis URL for another study or semester."),
      }),
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ status, pageUrl }) => {
      const page = await fetchCourses(session, pageUrl ?? process.env.MUNI_COURSES_URL);
      const result = status ? { ...page, courses: page.courses.filter((c) => c.status === status) } : page;
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    },
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
        "Times are Europe/Prague; date-only deadlines are inclusive. Read-only: it cannot register you.",
      inputSchema: z.object({
        courseCode: z.string().optional().describe("Only this course, e.g. PV157. Omit for all courses."),
      }),
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ courseCode }) => {
      const exams = await fetchExams(session, { courseCode });
      return { content: [{ type: "text", text: JSON.stringify(exams, null, 2) }] };
    },
  );

  return server;
});
