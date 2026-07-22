import { mkdir, readdir, readFile, writeFile as fsWriteFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

export const DEFAULT_WALK_IGNORE: string[] = [
  'node_modules',
  '.git',
  'dist',
  'build',
  'coverage',
  '__pycache__',
  '.venv',
  'venv',
  '.orca',
  '.orca-golden',
];

export async function readFileIfExists(path: string): Promise<string | null> {
  try {
    return await readFile(path, 'utf8');
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT' || code === 'EISDIR') return null;
    throw err;
  }
}

export async function readJson<T>(path: string): Promise<T> {
  const raw = await readFile(path, 'utf8');
  return JSON.parse(raw) as T;
}

export async function walk(dir: string, ignore: string[] = DEFAULT_WALK_IGNORE): Promise<string[]> {
  const out: string[] = [];
  const entries = await readdir(dir, { withFileTypes: true });
  entries.sort((a, b) => a.name.localeCompare(b.name));
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (!ignore.includes(entry.name)) out.push(...(await walk(full, ignore)));
    } else if (entry.isFile()) {
      out.push(full);
    }
  }
  return out;
}

export async function ensureDir(dir: string): Promise<void> {
  await mkdir(dir, { recursive: true });
}

export async function writeFile(path: string, contents: string): Promise<void> {
  await ensureDir(dirname(path));
  await fsWriteFile(path, contents, 'utf8');
}
