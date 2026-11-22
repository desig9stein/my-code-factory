// Names the local port of the board server; CODEIGNITE_PORT overrides it.
import { setting } from './paths.mjs';

export const boardPort = () => Number(setting('PORT') || 4317);
