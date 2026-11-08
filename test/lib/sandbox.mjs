// Imported first by every test file. It gives the test process a home of its own, so that no test reads or writes the real home folder,
// the real per-user cache (where  faultline setup  keeps the Python checker), or the settings of any other program.
//
//   HOME, USERPROFILE, LOCALAPPDATA, APPDATA, XDG_CACHE_HOME, XDG_DATA_HOME and XDG_CONFIG_HOME point into one new temporary folder, and TEMP / TMP / TMPDIR
//   point at a folder inside it (the new folder itself is made in the temp folder you already use, and is removed when the process ends).
//   The checker is found only through FAULTLINE_TOOLS, which this file leaves alone: set it to the folder  faultline setup  reports and the tests
//   that need the checker run; leave it out and they skip, saying what they need.
//   The one browser test (FAULTLINE_E2E_BROWSER=1) keeps the browser cache it would have found, because that is not part of the home folder's settings.
//
// Child processes (the command line the tests start) inherit all of this.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

if (!process.env.FAULTLINE_TEST_HOME) {
  const e = process.env;
  if (e.FAULTLINE_E2E_BROWSER === '1' && !e.PLAYWRIGHT_BROWSERS_PATH) {
    const real = process.platform === 'win32' ? path.join(e.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'), 'ms-playwright')
      : process.platform === 'darwin' ? path.join(os.homedir(), 'Library', 'Caches', 'ms-playwright')
        : path.join(e.XDG_CACHE_HOME || path.join(os.homedir(), '.cache'), 'ms-playwright');
    e.PLAYWRIGHT_BROWSERS_PATH = real;
  }
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'fl-home-'));
  e.FAULTLINE_TEST_HOME = home;
  e.HOME = home;
  e.USERPROFILE = home;
  e.LOCALAPPDATA = path.join(home, 'AppData', 'Local');
  e.APPDATA = path.join(home, 'AppData', 'Roaming');
  e.XDG_CACHE_HOME = path.join(home, '.cache');
  e.XDG_DATA_HOME = path.join(home, '.local', 'share');
  e.XDG_CONFIG_HOME = path.join(home, '.config');
  // Scratch folders are made inside it too, so a search upward from any of them ends at this home and never reaches the real one.
  const tmp = path.join(home, 'tmp');
  fs.mkdirSync(tmp);
  e.TEMP = tmp; e.TMP = tmp; e.TMPDIR = tmp;
  // The folder and the scratch the test made in it are removed when the process ends (FAULTLINE_KEEP_TEST_HOME=1 keeps them, to look at a failure).
  process.on('exit', () => { if (e.FAULTLINE_KEEP_TEST_HOME === '1') return; try { fs.rmSync(home, { recursive: true, force: true, maxRetries: 2, retryDelay: 100 }); } catch { /* a file still in use: the temp folder keeps it */ } });
}

export const testHome = process.env.FAULTLINE_TEST_HOME;
/** Why a test that needs a tool is skipped: what it needs and how to give it. */
export function needs(cap, ...what) {
  const how = {
    python: 'Python 3.10 or newer on the path',
    checker: 'the Python checker ty (run  faultline setup , then set FAULTLINE_TOOLS to the folder it reports)',
    typescript: 'the typescript package (npm install)',
    lua: 'the Lua grammar (npm install, optional dependency)',
  };
  const miss = what.filter((w) => !cap[w]);
  return miss.length ? { skip: `needs ${miss.map((w) => how[w] || w).join(' and ')}` } : {};
}
