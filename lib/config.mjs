// Reads and writes config.json, the machine's own settings.
import { withSettings } from './lock.mjs';
import fs from 'node:fs';
import { configPath } from './paths.mjs';
import { writeJson } from './store.mjs';

/** Returns the settings of this machine; a file that cannot be read is named in the error. */
export function readConfig() {
  if (!fs.existsSync(configPath())) return {};
  let config;
  try {
    config = JSON.parse(fs.readFileSync(configPath(), 'utf8'));
  } catch (err) {
    throw new Error(`${configPath()} is not valid JSON (${err.message}). Fix the file; nothing was changed.`);
  }
  return config && typeof config === 'object' && !Array.isArray(config) ? config : {};
}

/** Merges fields into config.json through a temporary file. */
export const writeConfig = (fields) => withSettings(() => writeConfigNow(fields));

function writeConfigNow(fields) {
  writeJson(configPath(), { ...readConfig(), ...fields });
}

/** Returns the shared project settings that wait for a checkout: { key: entry }. */
export const pendingProjects = () => readConfig().pendingProjects || {};

/** Returns [key, entry] of the waiting settings for a GitHub remote, or null. */
export function pendingFor(remote) {
  return Object.entries(pendingProjects()).find(([, entry]) => String(entry.remote).toLowerCase() === String(remote).toLowerCase()) || null;
}
