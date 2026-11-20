// Reads and writes config.json, the machine's own settings.
import fs from 'node:fs';
import { configPath } from './paths.mjs';

export const readConfig = () => (fs.existsSync(configPath()) ? JSON.parse(fs.readFileSync(configPath(), 'utf8')) : {});

/** Merges fields into config.json through a temporary file. */
export function writeConfig(fields) {
  const tmp = `${configPath()}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify({ ...readConfig(), ...fields }, null, 2)}\n`);
  fs.renameSync(tmp, configPath());
}

/** Returns the shared project settings that wait for a checkout: { key: entry }. */
export const pendingProjects = () => readConfig().pendingProjects || {};

/** Returns [key, entry] of the waiting settings for a GitHub remote, or null. */
export function pendingFor(remote) {
  return Object.entries(pendingProjects()).find(([, entry]) => String(entry.remote).toLowerCase() === String(remote).toLowerCase()) || null;
}
