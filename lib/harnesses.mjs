// Lists the coding harnesses the factory can start by itself. Each adapter turns one stage of a task into a
// command and turns the lines that command prints into the few events the runner understands.
//
// An adapter is an object with:
//   id, label            the stored name and the name shown to the user
//   install              one sentence telling the user how to get the harness
//   permissionModes      [{ id, label, about }] the choices offered for an unattended session; the first is the default
//   accounts             [{ id, label, about }] where the session's credentials come from; the first is the default
//   version()            the installed version as text, or null when the program is missing
//   command(options)     { cmd, args, env } for one session; options are { prompt, model, permission, allow, deny, dirs, account };
//                        dirs are folders outside the working directory the session reads and writes
//   parse(line)          the events of one printed line, as a list (empty for lines the runner ignores):
//                          { type: 'session', sessionId, model, account }
//                          { type: 'text', text }
//                          { type: 'tool', kind, label, detail }      names only, like the activity record
//                          { type: 'limit', status, resetsAt }       the account's usage limit refused or warned
//                          { type: 'result', ok, reason, text, turns, costUsd, denials }
//   transcript(cwd, sessionId)   the file the harness wrote the session to, or null; used for token counts
//
// To add a harness, write such an object in its own file and add it to HARNESSES. Nothing else names Claude Code.
import { claude } from './harness-claude.mjs';

const HARNESSES = [claude];

/** Returns every harness the factory can start. */
export const harnesses = () => HARNESSES;

/** Returns the adapter with this id; throws with the known ids for any other. */
export function harness(id = HARNESSES[0].id) {
  const found = HARNESSES.find((item) => item.id === id);
  if (!found) throw new Error(`Unknown coding harness "${id}". Known: ${HARNESSES.map((item) => item.id).join(', ')}.`);
  return found;
}
