// Ties the board to a browser the user opened from their own terminal. Without it any program on the machine
// could load the page, read its request token and act as the user.
//
// "factory board" reads a key only this user's files hold, asks the running board for a one-time code and opens
// the browser on it. The board answers that code with a cookie, and serves the page, its data and its actions
// only to a browser that carries the cookie. The key never appears in an address or in the page.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { factoryRoot } from './paths.mjs';

const CODE_MS = 120_000;
const YEAR_S = 365 * 24 * 3600;

/** The file that holds the pairing key of this data folder. */
export const keyPath = () => path.join(factoryRoot(), '.board-key');

/** Returns the pairing key, creating it for this user only when it does not exist. */
export function boardKey() {
  try {
    const key = fs.readFileSync(keyPath(), 'utf8').trim();
    if (/^[0-9a-f]{64}$/.test(key)) return key;
  } catch {
    // Created below.
  }
  fs.mkdirSync(factoryRoot(), { recursive: true });
  const key = crypto.randomBytes(32).toString('hex');
  fs.writeFileSync(keyPath(), `${key}\n`, { mode: 0o600 });
  fs.chmodSync(keyPath(), 0o600);
  return key;
}

/** Returns the key when it exists, or null; a caller that only wants to pair does not create one. */
export function readKey() {
  try {
    const key = fs.readFileSync(keyPath(), 'utf8').trim();
    return /^[0-9a-f]{64}$/.test(key) ? key : null;
  } catch {
    return null;
  }
}

const same = (a, b) => a.length === b.length && crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));

/** Keeps the pairing of one running board: its cookie and its one-time codes. */
export function createPairing(port) {
  const key = boardKey();
  // Cookies are shared between ports of one host, so each board has a cookie of its own name.
  const name = `factory_pair_${port}`;
  // The cookie is derived from the key, so a paired browser stays paired when the board restarts.
  const value = crypto.createHmac('sha256', key).update(`paired:${port}`).digest('hex');
  const codes = new Map();
  return {
    /** True when the request carries this board's cookie. */
    paired(req) {
      const found = String(req.headers.cookie || '').split(';').map((part) => part.trim().split('=')).find(([cookie]) => cookie === name);
      return Boolean(found && same(String(found[1] || ''), value));
    },
    /** Returns a one-time code for a caller that proves it holds the key, or null. */
    start(given) {
      if (typeof given !== 'string' || !same(given, key)) return null;
      const now = Date.now();
      for (const [code, until] of codes) if (until < now) codes.delete(code);
      const code = crypto.randomBytes(24).toString('hex');
      codes.set(code, now + CODE_MS);
      return code;
    },
    /** Uses up a code and returns the Set-Cookie header for it, or null when the code is unknown or too old. */
    redeem(code) {
      const until = codes.get(code);
      codes.delete(code);
      if (!until || until < Date.now()) return null;
      return `${name}=${value}; Path=/; Max-Age=${YEAR_S}; HttpOnly; SameSite=Strict`;
    },
  };
}

/** The page a browser without the cookie gets: no data, no token, and how to pair. */
export const unpairedPage = (expired = false) => `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="dark"><title>Codeignite</title><style>body{margin:0;background:#141615;color:#e8e6df;font:16px/1.55 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}main{max-width:560px;margin:14vh auto;padding:0 24px}h1{font-size:23px;font-weight:500;margin:0 0 12px}p{margin:0 0 14px;color:#b5b2a8}code{background:#0f1110;border:1px solid #33362f;border-radius:6px;padding:2px 7px;color:#e8e6df;font:14px ui-monospace,SFMono-Regular,monospace}</style></head><body><main><h1>${expired ? 'This pairing link is no longer valid' : 'This browser is not paired with the board'}</h1><p>The board shows your tasks and lets you approve them, so it only answers a browser you opened from your own terminal.</p><p>Run <code>factory board</code> in a terminal. It opens this page paired; the browser then stays paired.</p></main></body></html>`;
