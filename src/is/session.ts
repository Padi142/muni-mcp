import { setTimeout as sleep } from "node:timers/promises";
import { load } from "cheerio";
import makeFetchCookie from "fetch-cookie";

export const IS_ORIGIN = "https://is.muni.cz";
const LOGIN_ORIGIN = "https://muni.islogin.cz";
const allowedOrigins = new Set([IS_ORIGIN, LOGIN_ORIGIN]);

export type Credentials = { username: string; password: string };
type Page = { url: URL; html: string };

const MAX_CONCURRENT = 4;
const RETRIES = 2;
const PAGE_TIMEOUT_MS = 30_000;
// Covers reading the whole body, so it has to allow for large files on a slow connection.
const FILE_TIMEOUT_MS = 10 * 60_000;
// IS occasionally drops keep-alive sockets or briefly refuses a request; both succeed on retry.
const retryableStatus = new Set([409, 502, 503, 504]);

// Parameters that act wherever they appear: exam (un)registration, and actions such as starring a course.
const actionParam = /^(?:prihlasit|odhlasit|operace)$/i;

type GuardedArea = {
  area: RegExp;
  paths: Set<string>;
  params: Set<string>;
  /** `operace` values allowed here despite `actionParam`. */
  operations?: Set<string>;
};

// These areas change data through plain GET links, so only the listed paths and parameters are reachable.
// Mail deletes and sends (`akce=drop_message`, `akce=empty_trash`, `mail_posli`). Moji známí ends friendships and
// cancels requests (`cafr`, `care`), which stay blocked; `mafr`, `mafr_ok` and `x` are send_friend_request's steps.
// The course catalogue's AJAX also stars courses (`akce=oblib`) and edits the course selection
// (`operace=add_course`…); only its search, `operace=get_courses`, is reachable.
const guardedAreas: GuardedArea[] = [
  {
    area: /^\/+auth\/+mail\b/i,
    paths: new Set(["/auth/mail/", "/auth/mail/download"]),
    params: new Set(["folder_id", "order_by", "desc", "all", "slozka", "select-mail", "download"]),
  },
  {
    area: /^\/+auth\/+lide\/+lide_znami\b/i,
    paths: new Set(["/auth/lide/lide_znami"]),
    params: new Set(["mafr", "mafr_ok", "x"]),
  },
  {
    area: /^\/+auth\/+predmety\/+predmety_ajax\b/i,
    paths: new Set(["/auth/predmety/predmety_ajax.pl"]),
    params: new Set(["operace", "filters", "search_text"]),
    operations: new Set(["get_courses"]),
  },
];

const decodeParam = (part: string) => decodeURIComponent(part.replace(/\+/g, " "));

/** Query parameters as decoded `[name, value]` pairs, so `%6Fperace=` counts as `operace=`. IS accepts `;` and `&`. */
function queryParams(target: URL) {
  return target.search.slice(1).split(/[;&]/).filter(Boolean).map((part) => {
    const [name = "", value = ""] = part.split(/=(.*)/s);
    return [decodeParam(name), decodeParam(value)] as const;
  });
}

/** Which rule refuses this URL, if any. Malformed escapes are refused too. */
function refusal(target: URL) {
  try {
    // Decoded, so an encoded path such as /auth/%6Dail/ can't slip past the check.
    const path = decodeURIComponent(target.pathname);
    const guarded = guardedAreas.find(({ area }) => area.test(path));
    const params = queryParams(target);
    if (params.some(([name, value]) => actionParam.test(name) && !(name === "operace" && guarded?.operations?.has(value)))) {
      return "Refusing to request an IS MU URL that changes data.";
    }
    if (guarded && (!guarded.paths.has(target.pathname) || params.some(([name]) => !guarded.params.has(name)))) {
      return "Refusing to request an IS MU URL that may change data.";
    }
    return null;
  } catch {
    return "Refusing to request a malformed IS MU URL.";
  }
}

const LOGIN_FAILED = "IS MU login failed. Check credentials; MFA or another login step may be required.";

function hasPasswordField(html: string) {
  return load(html)('input[type="password"]').length > 0;
}

/**
 * An authenticated IS MU reader. Cookies live in memory only.
 * It logs in lazily on the first request and again whenever IS redirects to the login form
 * (e.g. after the session expires). The only POST it ever sends is the login form, and the
 * only change it can make beyond read status is send_friend_request's GET links.
 */
export function createIsSession(credentials: Credentials) {
  const cookieFetch = makeFetchCookie(fetch);
  let active = 0;
  const waiting: (() => void)[] = [];
  // Every visit to the login page issues a new form that invalidates the previous ones, so parallel
  // requests must not each log in. They wait for one shared login, which fetches its own form.
  let authenticated = false;
  let loggingIn: Promise<void> | undefined;

  // One HTTP exchange: at most MAX_CONCURRENT at a time; GETs retry on network errors and
  // retryable statuses. The login POST is never retried.
  async function send(url: URL, form?: URLSearchParams, timeoutMs = PAGE_TIMEOUT_MS) {
    while (active >= MAX_CONCURRENT) await new Promise<void>((resolve) => waiting.push(resolve));
    active++;
    try {
      for (let attempt = 0; ; attempt++) {
        const canRetry = !form && attempt < RETRIES;
        try {
          const response = await cookieFetch(url, {
            method: form ? "POST" : "GET",
            body: form,
            redirect: "manual",
            signal: AbortSignal.timeout(timeoutMs),
          });
          if (!canRetry || !retryableStatus.has(response.status)) return response;
          await response.body?.cancel();
        } catch (error) {
          // fetch reports network failures as TypeError; timeouts and other errors are final.
          if (!canRetry || !(error instanceof TypeError)) throw error;
        }
        await sleep(500 * (attempt + 1));
      }
    } finally {
      active--;
      waiting.shift()?.();
    }
  }

  // Follow redirects manually so every hop stays on the two known HTTPS origins.
  async function open(url: URL, body?: URLSearchParams, timeoutMs?: number) {
    let current = url;
    let form = body;
    for (let redirects = 0; redirects <= 12; redirects++) {
      if (!allowedOrigins.has(current.origin)) {
        throw new Error("IS MU redirected to an unexpected origin.");
      }
      const response = await send(current, form, timeoutMs);
      if ([301, 302, 303, 307, 308].includes(response.status)) {
        const location = response.headers.get("location");
        if (!location) throw new Error("A redirect did not provide a destination.");
        const next = new URL(location, current);
        if ([301, 302, 303].includes(response.status)) form = undefined;
        if (form && next.origin !== current.origin) {
          throw new Error("Refusing to forward login credentials across origins.");
        }
        await response.body?.cancel();
        current = next;
        continue;
      }
      if (!response.ok) throw new Error(`IS MU request failed: HTTP ${response.status}.`);
      return { url: current, response };
    }
    throw new Error("IS MU exceeded the redirect limit.");
  }

  async function request(url: URL, body?: URLSearchParams): Promise<Page> {
    const { url: finalUrl, response } = await open(url, body);
    return { url: finalUrl, html: await response.text() };
  }

  // Submit the observed muni.islogin.cz form: hidden fields + credential_0 (UČO) + credential_1 (password).
  async function submitLogin(loginPage: Page): Promise<Page> {
    const $ = load(loginPage.html);
    const form = $('input[type="password"]').closest("form");
    if (form.length !== 1 || loginPage.url.origin !== LOGIN_ORIGIN) {
      throw new Error("The expected IS MU login form was not found.");
    }
    const action = new URL(form.attr("action") || loginPage.url.href, loginPage.url);
    if (action.origin !== LOGIN_ORIGIN || form.attr("method")?.toLowerCase() !== "post") {
      throw new Error("The login form has an unexpected submission target.");
    }
    if (!form.find('[name="credential_0"]').length || !form.find('[name="credential_1"]').length) {
      throw new Error("The IS MU login form fields have changed.");
    }
    const payload = new URLSearchParams();
    form.find('input[type="hidden"][name]').each((_, element) => {
      const name = $(element).attr("name");
      if (name) payload.append(name, $(element).val()?.toString() ?? "");
    });
    const submit = form.find('button[type="submit"][name]').first();
    const submitName = submit.attr("name");
    if (submitName) payload.set(submitName, submit.val()?.toString() ?? "");
    payload.set("credential_0", credentials.username);
    payload.set("credential_1", credentials.password);
    return request(action, payload);
  }

  function isTarget(input: string | URL) {
    const target = new URL(input, IS_ORIGIN);
    if (target.origin !== IS_ORIGIN) throw new Error("Only IS MU pages can be requested.");
    const refused = refusal(target);
    if (refused) throw new Error(refused);
    return target;
  }

  /** Log in, or join the login already in progress. */
  function logIn() {
    loggingIn ??= (async () => {
      const start = await request(new URL("/auth/student/", IS_ORIGIN));
      const page = start.url.origin === LOGIN_ORIGIN ? await submitLogin(start) : start;
      if (page.url.origin !== IS_ORIGIN || hasPasswordField(page.html)) throw new Error(LOGIN_FAILED);
      authenticated = true;
    })().finally(() => {
      loggingIn = undefined;
    });
    return loggingIn;
  }

  /** GET an authenticated IS MU page, logging in first when needed. */
  async function getPage(input: string | URL): Promise<Page> {
    const target = isTarget(input);
    if (!authenticated) await logIn();
    let page = await request(target);
    if (page.url.origin === LOGIN_ORIGIN) {
      // The session expired.
      authenticated = false;
      await logIn();
      page = await request(target);
    }
    if (page.url.origin !== IS_ORIGIN || hasPasswordField(page.html)) {
      throw new Error(LOGIN_FAILED);
    }
    return page;
  }

  /** GET an authenticated IS MU file as an unread `Response`, so callers can stream its body. */
  async function getFile(input: string | URL) {
    const target = isTarget(input);
    // Logging in returns to the requested URL as text, which would buffer the whole file,
    // so make sure the session is live using a small page first.
    await getPage("/auth/student/");
    const { url, response } = await open(target, undefined, FILE_TIMEOUT_MS);
    if (url.origin !== IS_ORIGIN) {
      await response.body?.cancel();
      throw new Error("The IS MU session expired during the download. Try again.");
    }
    return response;
  }

  return { getPage, getFile };
}

export type IsSession = ReturnType<typeof createIsSession>;
