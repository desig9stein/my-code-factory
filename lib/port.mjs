// Names the local port of the board server; CODEIGNITE_PORT overrides it.
import { rootMark, setting } from './paths.mjs';

export const boardPort = () => Number(String(setting('PORT')).trim()) || 4317;

/**
 * Asks the board on a port who it is. Resolves to { board, pid }, where `board` is the mark of its data folder
 * (see rootMark), or to null when nothing answers. A board from before the mark said its folder; that is read too.
 */
export const pingBoard = (port) => fetch(`http://127.0.0.1:${port}/api/ping`, { signal: AbortSignal.timeout(3000) })
  .then((r) => r.json())
  .then((j) => (j && typeof j === 'object' ? { ...j, board: typeof j.board === 'string' ? j.board : typeof j.root === 'string' ? rootMark(j.root) : 'other' } : null))
  .catch(() => null);
