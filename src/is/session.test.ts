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
    assert.equal(requested.length, 3);
  } finally {
    globalThis.fetch = realFetch;
  }
});

test("Moji známí can list and send requests, but never end a friendship or cancel a request", async () => {
  const realFetch = globalThis.fetch;
  const requested: string[] = [];
  globalThis.fetch = (async (url: string | URL | Request) => {
    requested.push(String(url));
    return new Response('<main id="app_content">ok</main>', { status: 200 });
  }) as typeof fetch;
  try {
    const session = createIsSession({ username: "x", password: "y" });
    for (const path of [
      "/auth/lide/lide_znami?cafr=1",
      "/auth/lide/lide_znami?care=1",
      "/auth/lide/lide_znami?care_ok=1;care=1;x=t",
      "/auth/lide/lide_znami?cafr_ok=1;cafr=1;x=t",
      "/auth/lide/lide_znami?mafr=1;cafr=2",
      "/auth/lide/lide_znami.pl?mafr=1",
      "/auth/lide/lide_znami.pl?cafr=1",
      "/auth/lide/%6Cide_znami?cafr=1",
      "/AUTH/LIDE/LIDE_ZNAMI?cafr=1",
    ]) {
      await assert.rejects(session.getPage(path), /Refusing/, path);
    }
    assert.deepEqual(requested, []);

    await session.getPage("/auth/lide/lide_znami");
    await session.getPage("/auth/lide/lide_znami?mafr_ok=1;mafr=1;x=t");
    assert.equal(requested.length, 3);
  } finally {
    globalThis.fetch = realFetch;
  }
});

test("the course catalogue can only search, never star courses or edit the selection", async () => {
  const realFetch = globalThis.fetch;
  const requested: string[] = [];
  globalThis.fetch = (async (url: string | URL | Request) => {
    requested.push(String(url));
    return new Response('<main id="app_content">ok</main>', { status: 200 });
  }) as typeof fetch;
  try {
    const session = createIsSession({ username: "x", password: "y" });
    for (const path of [
      "/auth/predmety/predmety_ajax.pl?akce=oblib;fakulta=1;kod=X",
      "/auth/predmety/predmety_ajax.pl?operace=add_course;course_id=1",
      "/auth/predmety/predmety_ajax.pl?operace=get_courses;operace=hvezdicka",
      "/auth/predmety/predmety_ajax.pl?operace=get_courses;pvysl=1",
      "/auth/predmety/predmety_ajax?operace=get_courses",
      "/auth/predmety/%70redmety_ajax.pl?operace=add_course",
      "/auth/predmety/predmety_ajax.pl?%6Fperace=add_course",
      "/auth/predmety/predmety_ajax.pl?operace=get%5Fcourses%",
      "/auth/predmety/katalog?operace=get_courses",
      "/auth/student/?%6Fperace=x",
    ]) {
      await assert.rejects(session.getPage(path), /Refusing/, path);
    }
    assert.deepEqual(requested, []);

    await session.getPage("/auth/predmety/predmety_ajax.pl?operace=get_courses;filters=%7B%7D;search_text=PA015");
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
    () => new Response('<main id="app_content">ok</main>', { status: 200 }),
  ];
  let calls = 0;
  globalThis.fetch = (async () => replies[calls++]!()) as typeof fetch;
  try {
    const session = createIsSession({ username: "x", password: "y" });
    const page = await session.getPage("https://is.muni.cz/auth/student/");
    // Three tries for the login check, then the page itself.
    assert.equal(calls, 4);
    assert.match(page.html, /ok/);
  } finally {
    globalThis.fetch = realFetch;
  }
});

test("parallel requests share one login, since each new login form invalidates the older ones", async () => {
  const realFetch = globalThis.fetch;
  let form = 0;
  let loggedIn = false;
  const posts: string[] = [];
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    if (url.origin === "https://is.muni.cz") {
      if (!loggedIn) return new Response(null, { status: 302, headers: { location: "https://muni.islogin.cz/login" } });
      return new Response(`<main id="app_content">${url.pathname}</main>`);
    }
    if (init?.method === "POST") {
      const token = new URLSearchParams(String(init.body)).get("token") ?? "";
      posts.push(token);
      if (token !== String(form)) return new Response("<p>expired form</p>");
      loggedIn = true;
      return new Response(null, { status: 302, headers: { location: "https://is.muni.cz/auth/student/" } });
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
    return new Response(`<form method="post" action="/login"><input type="hidden" name="token" value="${++form}">
      <input name="credential_0"><input type="password" name="credential_1"></form>`);
  }) as typeof fetch;
  try {
    const session = createIsSession({ username: "x", password: "y" });
    const pages = await Promise.all(["/auth/a", "/auth/b", "/auth/c"].map((path) => session.getPage(path)));
    assert.deepEqual(pages.map((page) => page.url.pathname), ["/auth/a", "/auth/b", "/auth/c"]);
    assert.deepEqual(posts, ["1"]);
  } finally {
    globalThis.fetch = realFetch;
  }
});
