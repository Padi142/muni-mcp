import assert from "node:assert/strict";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { downloadMaterial, fetchCourseFiles, parseFolderXml, parseMaterialsOverview } from "./materials.js";
import type { IsSession } from "./session.js";

// Synthetic markup follows the observed structure without storing student HTML.
const link = (path: string, label: string) =>
  `<A HREF="../dok/rfmgr?fakulta=1;obdobi=2;studium=3;furl=${encodeURIComponent(path)}">${label}</A>`;

test("parses unread counts, syllabi, and submission folders without bleeding into the next section", () => {
  const result = parseMaterialsOverview(`<main id="app_content">
    <H2>Interaktivní osnovy předmětů</H2><table class="navodek"></table>
    <UL><li>FI:XY001</li><ul><LI><A HREF="../elearning/io/?qurl=x">Syllabus</A></LI></ul></UL>
    <H2>Nové -- dosud nečtené -- soubory ve studijních materiálech</H2>
    <UL><LI>${link("/el/fi/podzim2026/XY001/", "FI:XY001 Course one")} (3&nbsp;nové&nbsp;soubory)</LI></UL>
    <H2>Vám otevřené odevzdávárny</H2>
    <BLOCKQUOTE><I>Žádné.</I></BLOCKQUOTE>
    <H2>Předměty mající vystavené nějaké studijní materiály</H2>
    <UL><LI>${link("/el/fi/podzim2026/XY001/", "FI:XY001 Course one")}</LI><LI>${link("/el/fi/podzim2026/XY002/", "FI:XY002 Course two")}</LI></UL>
    </main>`);
  assert.deepEqual(result.courses.map((c) => [c.courseCode, c.unreadFiles, c.interactiveSyllabi.length, c.folder]), [
    ["XY001", 3, 1, "/el/fi/podzim2026/XY001/"], ["XY002", 0, 0, "/el/fi/podzim2026/XY002/"],
  ]);
  assert.deepEqual(result.submissionFolders, []);

  const withFolder = parseMaterialsOverview(`<main id="app_content"><H2>Vám otevřené odevzdávárny</H2>
    <UL><LI>FI:XY001 Course one</LI><UL><LI>${link("/el/fi/podzim2026/XY001/ode/9/", "<B>Project</B>")} <B>(do 6. 12. 2026 vč.)</B></LI></UL></UL></main>`);
  assert.deepEqual(withFolder.submissionFolders, [
    { courseCode: "XY001", title: "Project", until: "2026-12-06", folder: "/el/fi/podzim2026/XY001/ode/9/" },
  ]);
});

const xml = (path: string, inner: string) => `<?xml version="1.0"?><fmgr><uzel><nazev>Root</nazev><cesta>${path}</cesta>${inner}</uzel></fmgr>`;
const file = (name: string, path: string) =>
  `<objekt><jmeno_souboru>${name}</jmeno_souboru><mime_type>application/pdf</mime_type><velikost>10</velikost><vlozeno>2026-09-11T17:03:41</vlozeno><cesta>${path}</cesta></objekt>`;

test("walks course folders through the File Manager API, skipping online tests", async () => {
  const pages: Record<string, string> = {
    "/el/fi/podzim2026/XY001/": xml("/el/fi/podzim2026/XY001/", `<poduzly>
      <poduzel><nazev>Učební materiály</nazev><cesta>/el/fi/podzim2026/XY001/um/</cesta><pocet_poduzlu>1</pocet_poduzlu></poduzel>
      <poduzel><nazev>Odpovědníky</nazev><cesta>/el/fi/podzim2026/XY001/odp/</cesta><pocet_poduzlu>3</pocet_poduzlu></poduzel>
      </poduzly>`),
    "/el/fi/podzim2026/XY001/um/": xml("/el/fi/podzim2026/XY001/um/", `<poduzly>
      <poduzel><cesta>/el/fi/podzim2026/XY001/um/1/</cesta><pocet_poduzlu>0</pocet_poduzlu>
        <objekty>${file("L01.pdf", "/el/fi/podzim2026/XY001/um/L01.pdf")}</objekty></poduzel></poduzly>`),
  };
  const requested: string[] = [];
  const session = {
    getPage: async (url: string | URL) => {
      const path = decodeURI(new URL(url).searchParams.get("url") ?? "");
      requested.push(path);
      return { url: new URL(url), html: pages[path]! };
    },
  } satisfies Pick<IsSession, "getPage">;
  const { files, complete } = await fetchCourseFiles(session, "/el/fi/podzim2026/XY001/");
  assert.deepEqual(requested, ["/el/fi/podzim2026/XY001/", "/el/fi/podzim2026/XY001/um/"]);
  assert.equal(complete, true);
  assert.deepEqual(files.map((f) => [f.name, f.folder, f.uploaded, f.url]), [
    ["L01.pdf", "Učební materiály", "2026-09-11T17:03+02:00", "https://is.muni.cz/auth/el/fi/podzim2026/XY001/um/L01.pdf"],
  ]);
  assert.equal(parseFolderXml(pages["/el/fi/podzim2026/XY001/"]!).subfolders[1]?.name, "Odpovědníky");
  await assert.rejects(fetchCourseFiles(session, "/auth/other/"), /study-materials folder/);
});

test("flags links and recorded lectures as not downloadable and removes repeated listings", async () => {
  const video = `<objekt><jmeno_souboru>video.fi.muni.cz?id=1;file=L.mp4</jmeno_souboru><mime_type>video/mp4</mime_type><cesta>/el/fi/podzim2026/XY001/um/vi/9/</cesta></objekt>`;
  const syllabus = file("index.qwarp", "/el/fi/podzim2026/XY001/index.qwarp");
  const body = xml("/el/fi/podzim2026/XY001/", `<poduzly>
    <poduzel><nazev>A</nazev><cesta>/el/fi/podzim2026/XY001/a/</cesta><objekty>${syllabus}${video}</objekty></poduzel>
    <poduzel><nazev>A</nazev><cesta>/el/fi/podzim2026/XY001/b/</cesta><objekty>${syllabus}</objekty></poduzel></poduzly>`);
  const session = { getPage: async (url: string | URL) => ({ url: new URL(url), html: body }) };
  const { files } = await fetchCourseFiles(session, "/el/fi/podzim2026/XY001/");
  assert.deepEqual(files.map((f) => [f.name, f.size, f.downloadable]), [
    ["index.qwarp", 10, true],
    ["video.fi.muni.cz?id=1;file=L.mp4", null, false],
  ]);
});

test("downloads a file to its mirrored path, encoding the URL", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "muni-mcp-test-"));
  t.after(() => rm(directory, { recursive: true }));
  const requested: string[] = [];
  const session = {
    getFile: async (url: string | URL) => {
      requested.push(String(url));
      return new Response("hello", { headers: { "content-type": "text/plain" } });
    },
  };
  const result = await downloadMaterial(session, "/el/fi/podzim2026/XY001/um/a b?.txt", { directory, maxBytes: 100 });
  assert.deepEqual(requested, ["https://is.muni.cz/auth/el/fi/podzim2026/XY001/um/a%20b%3F.txt"]);
  assert.equal(result.bytes, 5);
  assert.equal(result.savedTo, join(directory, "fi/podzim2026/XY001/um/a b?.txt"));
  assert.equal(await readFile(result.savedTo, "utf8"), "hello");
});

test("refuses paths outside study materials without requesting them", async () => {
  const session = { getFile: async (): Promise<Response> => assert.fail("must not request") };
  const options = { directory: "/nonexistent", maxBytes: 100 };
  for (const path of [
    "/auth/student/",
    "/el/fi/podzim2026/XY001/../../../../../student/x",
    "/el/fi/podzim2026/XY001/um/",
    "/el/fi/podzim2026/XY001/um//x.pdf",
    "/el/fi/podzim2026/XY001/um\\..\\x.pdf",
  ]) {
    await assert.rejects(downloadMaterial(session, path, options), /Not a file path/, path);
  }
  await assert.rejects(downloadMaterial(session, "/el/fi/podzim2026/XY001/odp/q.qdesc", options), /Online-test/);
});

test("leaves nothing behind when a file exceeds the limit", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "muni-mcp-test-"));
  t.after(() => rm(directory, { recursive: true }));
  const path = "/el/fi/podzim2026/XY001/big.bin";
  const options = { directory, maxBytes: 3 };
  const declared = { getFile: async () => new Response("hello", { headers: { "content-length": "5" } }) };
  await assert.rejects(downloadMaterial(declared, path, options), /limit/);
  // No declared length: the limit has to apply while streaming.
  const stream = new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode("hello")); c.close(); } });
  await assert.rejects(downloadMaterial({ getFile: async () => new Response(stream) }, path, options), /limit/);
  assert.deepEqual(await readdir(join(directory, "fi/podzim2026/XY001")), []);
});
