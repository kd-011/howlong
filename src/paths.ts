import { homedir } from 'node:os';
import { join } from 'node:path';

export function dataDir(env = process.env): string {
  if (env.HOWLONG_HOME) return env.HOWLONG_HOME;
  return join(env.XDG_DATA_HOME || join(homedir(), '.local', 'share'), 'howlong');
}

export function configFile(env = process.env): string {
  return join(env.XDG_CONFIG_HOME || join(homedir(), '.config'), 'howlong', 'config.json');
}
