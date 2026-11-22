// What a task's own commands are told about it: its id, its folder and a port no other task in flight has.
// Two agents that each start a development server in the same project would otherwise fight over one port.
import { withTask } from './lock.mjs';
import { loadState, peekStates, saveState } from './state.mjs';

const FIRST_PORT = 41000;
const LAST_PORT = 41999;

/** Returns the lowest port in the range that no task in flight holds, or null when all are taken. */
export function freePort(states = peekStates()) {
  const taken = new Set(states.map((state) => state.port).filter(Number.isInteger));
  for (let port = FIRST_PORT; port <= LAST_PORT; port++) if (!taken.has(port)) return port;
  return null;
}

/** Returns the variables given to a task's setup, teardown and checks, and to the agent sessions on it. */
export function taskEnv(state) {
  return {
    CODEIGNITE_TASK_ID: String(state.id),
    CODEIGNITE_TASK_DIR: String(state.worktree || ''),
    ...(Number.isInteger(state.port) ? { CODEIGNITE_TASK_PORT: String(state.port) } : {}),
  };
}

/** Gives a task in flight a port when it has none, as tasks made before ports did not. Returns the port, or null. */
export function ensurePort(id) {
  return withTask(id, () => {
    const state = loadState(id);
    if (Number.isInteger(state.port)) return state.port;
    if (state.archived) return null;
    const port = freePort();
    if (port === null) return null;
    state.port = port;
    saveState(state);
    return port;
  });
}
