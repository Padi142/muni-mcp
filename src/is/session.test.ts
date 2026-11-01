import assert from "node:assert/strict";
import test from "node:test";
import { createIsSession } from "./session.js";

test("GETs retry once IS drops a connection or briefly refuses, then succeed", async () => {
  const realFetch = globalThis.fetch;
  const replies: (() => Response)[] = [
    () => { throw new TypeError("fetch failed"); },
    () => new Response("busy", { status: 409 }),
    () => new Response('<main id="app_content">ok</main>', { status: 200 }),
  ];
  let calls = 0;
  globalThis.fetch = (async () => replies[calls++]!()) as typeof fetch;
  try {
    const session = createIsSession({ username: "x", password: "y" });
    const page = await session.getPage("https://is.muni.cz/auth/student/");
    assert.equal(calls, 3);
    assert.match(page.html, /ok/);
  } finally {
    globalThis.fetch = realFetch;
  }
});
