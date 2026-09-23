#!/usr/bin/env node
/*
 * `yarn dev` -- `yarn start`, plus the one thing it does not tell you.
 *
 * THE PROBLEM THIS SOLVES, measured on this repo 2026-09-23:
 *
 *   t=0       `yarn start`. Rspack begins compiling.
 *   t~1s      webpack-dev-server answers on :3000. There is no backend
 *             process at all yet.
 *   t=143s    "Listening on :7007". Plugin initialization starts, so every
 *             plugin route -- /api/auth, /api/catalog, /api/fleet -- returns
 *             404 for the next few seconds.
 *   t=148s    Plugins finish. Everything answers.
 *
 * So for roughly two and a half minutes the portal looks alive and is not.
 * Loading the page inside that window fails, and the app does NOT recover
 * when the backend appears: a tab that was open across the restart sits on
 * "Could not fetch catalog entities", and a tab loaded during the window sits
 * on the sign-in page. Only a reload, or an explicit sign-in, after the
 * backend is up puts it right -- which is why "log out and log back in"
 * looked like an auth fix when it was really just elapsed time.
 *
 * This script does not change the app. It watches for the moment the backend
 * genuinely serves requests and says so, so nobody loads the page early.
 *
 * WHY IT DOES NOT PROBE THE PORT OR /health. Two obvious gates are both
 * wrong here, and both were measured:
 *
 *   - The PORT opens at t=143s, five seconds before any route works. This is
 *     the gate `playwright.config.ts` uses (`port: 7007`), and it is why an
 *     e2e run can in principle start against a 404-ing backend.
 *   - READINESS still returned 503 at t=148s, when auth, catalog and fleet
 *     were all already answering 200. It reports the whole backend's state,
 *     which lags the routes being usable.
 *
 * The honest question is "has a plugin mounted its routes", so that is what
 * is asked. An unauthenticated GET of a real plugin route answers it:
 * 401 means the catalog is mounted and wants credentials, which is exactly
 * the state the browser needs. 404 means the router is up but the plugin is
 * not yet registered.
 */

const { spawn } = require('child_process');
const http = require('http');

const HOST = 'localhost';
const PORT = 7007;

/**
 * A plugin route, deliberately, rather than a health endpoint.
 *
 * The catalog is the right one to watch: it is what the landing page loads,
 * and it is the plugin whose absence produces the reported error.
 */
const PROBE_PATH = '/api/catalog/entities?limit=1';

const POLL_MS = 1000;

/**
 * `down` -- nothing is listening yet (still compiling).
 * `starting` -- listening, but this plugin has not mounted its routes.
 * `ready` -- the route answered. 401 is a success here: it means the
 *            catalog is mounted and enforcing auth, which is the state a
 *            browser needs. Treating only 200 as ready would wait forever,
 *            because an unauthenticated probe never gets one.
 */
function probe() {
  return new Promise(resolve => {
    const req = http.request(
      {
        host: HOST,
        port: PORT,
        path: PROBE_PATH,
        method: 'GET',
        timeout: 2000,
      },
      res => {
        res.resume();
        if (res.statusCode === 404) {
          resolve('starting');
        } else if (res.statusCode >= 200 && res.statusCode < 500) {
          resolve('ready');
        } else {
          resolve('starting');
        }
      },
    );
    req.on('error', () => resolve('down'));
    req.on('timeout', () => {
      req.destroy();
      resolve('down');
    });
    req.end();
  });
}

const started = Date.now();
const elapsed = () => `${((Date.now() - started) / 1000).toFixed(0)}s`;

// Run the CLI's own entry point with this same Node binary, rather than
// shelling out to `yarn`.
//
// `spawn('yarn', args, { shell: true })` is the obvious version and is wrong
// twice over: on Windows `yarn` is a .cmd shim that Node 24 refuses to exec
// without a shell, and passing args alongside `shell: true` earns a runtime
// DeprecationWarning (DEP0190) because the arguments are concatenated rather
// than escaped. Resolving the bin and running it directly needs no shell, so
// neither problem arises and any argument survives verbatim.
//
// stdio is inherited so the normal Backstage output, and its colours, come
// through untouched.
const child = spawn(
  process.execPath,
  [
    require.resolve('@backstage/cli/bin/backstage-cli'),
    'repo',
    'start',
    ...process.argv.slice(2),
  ],
  { stdio: 'inherit' },
);

let announced = false;
let lastPhase = null;

/**
 * Whether a probe is still in flight.
 *
 * `setInterval` fires on its own schedule regardless of whether the previous
 * async callback has finished, and `announced` is only set *after* the await.
 * Without this second guard two ticks both pass the `announced` check while
 * the first is still waiting on the socket, and the banner prints twice --
 * which it duly did on the first run of this script. Set synchronously,
 * before any await, or it has the same hole it is closing.
 */
let probing = false;

const timer = setInterval(async () => {
  if (announced || probing) return;
  probing = true;

  const phase = await probe().finally(() => {
    probing = false;
  });

  // One line when the port first opens, so the gap between "listening" and
  // "usable" is visible rather than mysterious.
  if (phase === 'starting' && lastPhase !== 'starting') {
    process.stdout.write(
      `\n[dev] :${PORT} is listening at ${elapsed()}, plugins still registering...\n`,
    );
  }
  lastPhase = phase;

  if (phase !== 'ready') return;

  announced = true;
  clearInterval(timer);

  // Padding is computed from the longest line rather than counted by hand.
  // Hand-counted box drawing goes ragged the moment any wording changes, and
  // the elapsed time is variable width anyway.
  const body = [
    `PORTAL READY after ${elapsed()}`,
    `Open http://localhost:3000`,
    '',
    'Loading it before this line appears is the startup race:',
    'the page will not recover on its own.',
  ];
  const width = Math.max(...body.map(l => l.length)) + 4;
  const rule = '─'.repeat(width);
  const rows = body.map(l => `│  ${l.padEnd(width - 4)}  │`).join('\n');
  process.stdout.write(`\n┌${rule}┐\n${rows}\n└${rule}┘\n\n`);
}, POLL_MS);

const stop = signal => () => {
  clearInterval(timer);
  if (!child.killed) child.kill(signal);
};
process.on('SIGINT', stop('SIGINT'));
process.on('SIGTERM', stop('SIGTERM'));

child.on('exit', code => {
  clearInterval(timer);
  process.exit(code ?? 0);
});
