import assert from "node:assert/strict";
import test from "node:test";
import { createIsSession } from "./session.js";

test("only the mail folder view and raw-message download are reachable", async () => {
  const realFetch = globalThis.fetch;
  const requested: string[] = [];
  globalThis.fetch = (async (url: string | URL | Request) => {
    requested.push(String(url));
    return new Response('<main id="app_content">ok</main>', { status: 200 });
  }) as typeof fetch;
  try {
    const session = createIsSession({ username: "x", password: "y" });
    for (const path of [
      "/auth/mail/mail_ajax?akce=empty_trash",
      "/auth/mail/mail_ajax.pl?ajax=1",
      "/auth/mail/?akce=drop_message;mail_id=1",
      "/auth/mail/?folder_id=1;%61kce=drop_message",
      "/auth/mail/?mail_handle_action=drop;mark=1",
      "/auth/mail/mail_posli?to=a@example.org",
      "/auth/%6Dail/mail_ajax?akce=empty_trash",
      "/AUTH/MAIL/mail_ajax?akce=empty_trash",
    ]) {
      await assert.rejects(session.getPage(path), /Refusing/, path);
    }
    assert.deepEqual(requested, []);

    await session.getPage("/auth/mail/?folder_id=1;order_by=datum;desc=1;all=1");
    await session.getPage("/auth/mail/download?slozka=1;select-mail=2;download=1");
    assert.equal(requested.length, 2);
  } finally {
    globalThis.fetch = realFetch;
  }
});

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
