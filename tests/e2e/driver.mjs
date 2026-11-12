// Minimal W3C WebDriver client for tauri-driver (DEC-027): only what the journeys use, with
// polling so tests wait for results instead of sleeping.
import { spawn } from 'node:child_process';

const SERVER = 'http://127.0.0.1:4444';
const ELEMENT = 'element-6066-11e4-a52e-4f735466cecf';
const TIMEOUT_MS = 15_000;
const started = Date.now();

/** Progress on stderr, so a stuck run shows where it stopped. */
export const log = (message) =>
  console.error(`[e2e ${((Date.now() - started) / 1000).toFixed(1)}s] ${message}`);

// Every request has a deadline: a session waits for the app to start, and an app that never
// starts must fail the run, not hang it.
async function call(method, path, body, timeoutMs = 20_000) {
  const response = await fetch(`${SERVER}${path}`, {
    method,
    headers: { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const { value } = await response.json();
  if (!response.ok) throw new Error(`${method} ${path}: ${value?.error}: ${value?.message}`);
  return value;
}

/** Retries `check` until it returns a truthy value or passes without throwing. */
export async function until(check, what) {
  const deadline = Date.now() + TIMEOUT_MS;
  let last;
  while (Date.now() < deadline) {
    try {
      const result = await check();
      if (result) return result;
      last = `got ${JSON.stringify(result)}`;
    } catch (error) {
      last = error.message;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`timed out waiting for ${what}: ${last}`);
}

/** Starts tauri-driver and the app; `env` reaches the app (test paths, isolated config). */
export async function launch(application, env) {
  log(`starting tauri-driver for ${application}`);
  const driver = spawn('tauri-driver', { stdio: 'inherit', env: { ...process.env, ...env } });
  let exited = null;
  driver.on('exit', (code, signal) => (exited = `tauri-driver exited (${code ?? signal})`));
  await until(() => {
    if (exited) throw new Error(exited);
    return fetch(`${SERVER}/status`, { signal: AbortSignal.timeout(1_000) }).then((r) => r.ok);
  }, 'tauri-driver');
  log('tauri-driver is up; starting the app');
  const { sessionId } = await call(
    'POST',
    '/session',
    { capabilities: { alwaysMatch: { browserName: 'wry', 'tauri:options': { application } } } },
    60_000,
  );
  log(`app started (session ${sessionId})`);
  const session = (method, path, body) => call(method, `/session/${sessionId}${path}`, body);
  const run = (script, ...args) => session('POST', '/execute/sync', { script, args });
  const find = async (css) => {
    const element = await session('POST', '/element', { using: 'css selector', value: css });
    return element[ELEMENT];
  };
  return {
    run,
    /** Clicks the first element matching `css` whose text or aria-label contains `label`. */
    click: (css, label = '') =>
      until(async () => {
        const element = await run(
          `return [...document.querySelectorAll(arguments[0])].find((node) =>
             ((node.getAttribute('aria-label') ?? '') + node.textContent).includes(arguments[1])) ?? null;`,
          css,
          label,
        );
        if (!element) return false;
        await session('POST', `/element/${element[ELEMENT]}/click`, {});
        return true;
      }, `${css} "${label}"`),
    /** Replaces an input's value by real key presses. */
    type: async (css, text) => {
      const element = await until(() => find(css), css);
      await session('POST', `/element/${element}/clear`, {});
      await session('POST', `/element/${element}/value`, { text });
    },
    /** Waits until the text of `css` (all matches) satisfies `predicate`. */
    text: (css, predicate, what = css) =>
      until(async () => {
        const text = await run(
          `return [...document.querySelectorAll(arguments[0])].map((node) => node.textContent).join('\\n');`,
          css,
        );
        if (!predicate(text)) throw new Error(`the text was ${JSON.stringify(text.slice(0, 300))}`);
        return text;
      }, what),
    /** Waits until the tag table's row keys (`Group:Tag`, as drawn) satisfy `predicate`. */
    rows: (predicate, what) =>
      until(async () => {
        const keys = await run(
          `return [...document.querySelectorAll('tr[data-key]')].map((row) => row.dataset.key);`,
        );
        if (!predicate(keys)) throw new Error(`the rows were ${JSON.stringify(keys.slice(0, 20))}`);
        return keys;
      }, what),
    screenshot: () => session('GET', '/screenshot'),
    setSize: (width, height) => session('POST', '/window/rect', { width, height }),
    close: async () => {
      await call('DELETE', `/session/${sessionId}`).catch(() => undefined);
      driver.kill();
    },
  };
}
