import { fileURLToPath } from 'node:url';
import path from 'node:path';

/** Repository root, whether running from `src/` (tsx) or `dist/` (node). */
export const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const migrationsDir = path.join(rootDir, 'migrations');
export const publicDir = path.join(rootDir, 'public');
