// Adds one line per stage milestone to WORK_LOG.md under today's heading.
import fs from 'node:fs';
import { workLogPath } from './paths.mjs';
import { head } from './state.mjs';

const today = () => new Date().toLocaleDateString('en-CA');

export function addWorkLogLine(state, repo, status) {
  const file = workLogPath();
  if (!fs.existsSync(file)) return false;
  if (state.kind === 'review') {
    const text = `- \`${repo.key}\` — review of [#${state.issue}](${state.prUrl}) — ${state.title}; checked at \`${(head(state) || '').slice(0, 8)}\` — ${status}.`;
    return insertLine(file, text);
  }
  const slug = repo.remote;
  const issue = `[#${state.issue}](https://github.com/${slug}/issues/${state.issue})`;
  const pr = state.prUrl ? `[#${state.prUrl.split('/').pop()}](${state.prUrl}) for ` : '';
  const gates = repo.gates.map((g) => g.name).join(', ') || 'none';
  const sha = (head(state) || '').slice(0, 8);
  const line = `- \`${repo.key}\` — ${pr}${issue} — branch \`${state.branch}\`; ${state.title}; factory gates (${gates}) and verifier pass at \`${sha}\` — ${status}.`;
  return insertLine(file, line);
}

// Inserts the line under today's heading, creating the heading above the newest one.
function insertLine(file, line) {
  const lines = fs.readFileSync(file, 'utf8').split('\n');
  const heading = `## ${today()}`;
  const first = lines.findIndex((l) => l.startsWith('## '));
  if (first !== -1 && lines[first].trim() === heading) lines.splice(first + 1, 0, line);
  else if (first !== -1) lines.splice(first, 0, heading, line, '');
  else lines.push('', heading, line);
  fs.writeFileSync(file, lines.join('\n'));
  return true;
}
