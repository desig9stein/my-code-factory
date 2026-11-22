// Says how the user types the command on this machine. "codeignite" works only when it is on the PATH and
// points at this installation ("npm link" does that); otherwise the full form with node always works.
import fs from 'node:fs';
import path from 'node:path';
import { codeRoot } from './paths.mjs';

const entry = () => path.join(codeRoot(), 'bin', 'codeignite.mjs');
let known = null;

/** Returns true when typing "codeignite" in a terminal starts this installation. */
export function commandLinked() {
  if (known && Date.now() - known.at < 60_000) return known.value;
  let value = false;
  for (const dir of String(process.env.PATH || '').split(path.delimiter).filter(Boolean)) {
    try {
      if (fs.realpathSync(path.join(dir, 'codeignite')) === fs.realpathSync(entry())) {
        value = true;
        break;
      }
    } catch {
      // Not in this folder.
    }
  }
  known = { at: Date.now(), value };
  return value;
}

/** Returns the command as the user can type it here: "codeignite", or the full form when that name is not set up. */
export const commandText = () => (commandLinked() ? 'codeignite' : `node '${entry()}'`);
