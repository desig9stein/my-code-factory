// Lists the models a step can ask for, by the coding harness in use.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Aliases resolve to the newest model of each family, so the list does not age with releases.
const PROVIDERS = [
  {
    id: 'claude',
    label: 'Claude Code',
    detect: () => fs.existsSync(process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude')),
    models: [
      { id: 'fable', label: 'Fable', note: 'most capable, slowest' },
      { id: 'opus', label: 'Opus', note: 'hard reasoning and review' },
      { id: 'sonnet', label: 'Sonnet', note: 'balanced, good for implementation' },
      { id: 'haiku', label: 'Haiku', note: 'fastest, for simple steps' },
    ],
  },
];

/** Returns the detected provider and its models; the first provider when none is detected. */
export function modelChoices() {
  const provider = PROVIDERS.find((p) => p.detect()) || PROVIDERS[0];
  return { provider: provider.id, label: provider.label, models: provider.models };
}
