// Writes files so that a reader never sees half of one, and two writers never share a temporary file.
import fs from 'node:fs';
import path from 'node:path';
import { threadId } from 'node:worker_threads';

let count = 0;

/** Replaces a file with the text, through a temporary file of its own beside it. */
export function writeText(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  // The process id, the thread and a counter keep the name apart from every other writer; the ".tmp" ending keeps it out of the board's change notices.
  const tmp = `${file}.${process.pid}.${threadId}.${++count}.tmp`;
  try {
    fs.writeFileSync(tmp, text);
    fs.renameSync(tmp, file);
  } catch (err) {
    fs.rmSync(tmp, { force: true });
    throw err;
  }
}

/** Replaces a file with the data as indented JSON. */
export const writeJson = (file, data) => writeText(file, `${JSON.stringify(data, null, 2)}\n`);
