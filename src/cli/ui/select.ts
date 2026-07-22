import { createInterface } from 'node:readline/promises';
import { emitKeypressEvents } from 'node:readline';

import { screen, theme } from './theme.js';

export interface SelectItem<T> {
  label: string;
  hint?: string;
  icon?: string;
  value: T;
}

export interface SelectSeparator {
  separator: string;
}

export type SelectRow<T> = SelectItem<T> | SelectSeparator;

function isSeparator<T>(row: SelectRow<T>): row is SelectSeparator {
  return (row as SelectSeparator).separator !== undefined;
}

export interface SelectOptions<T> {
  header: string;
  items: SelectRow<T>[];
}

function renderList<T>(rows: SelectRow<T>[], active: number): string {
  const lines = rows.map((row, i) => {
    if (isSeparator(row)) {
      return `  ${theme.pinkDim(`── ${row.separator} ${'─'.repeat(Math.max(2, 22 - row.separator.length))}`)}`;
    }
    const icon = row.icon ? `${row.icon} ` : '';
    const label = `${icon}${row.label}`;
    const hint = row.hint ? `  ${theme.soft(row.hint)}` : '';
    if (i === active) {
      return `  ${theme.teal('›')} ${theme.teal.bold(label)}${hint}`;
    }
    return `    ${theme.white(label)}${hint}`;
  });
  return lines.join('\n');
}

function step<T>(rows: SelectRow<T>[], from: number, dir: 1 | -1): number {
  const n = rows.length;
  let i = from;
  for (let guard = 0; guard < n; guard += 1) {
    i = (i + dir + n) % n;
    if (!isSeparator(rows[i]!)) return i;
  }
  return from;
}

export function select<T>(opts: SelectOptions<T>): Promise<T | null> {
  const stdin = process.stdin;
  const stdout = process.stdout;
  if (!stdin.isTTY) return Promise.resolve(null);

  const rows = opts.items;
  let active = rows.findIndex((r) => !isSeparator(r));
  if (active < 0) return Promise.resolve(null);

  return new Promise<T | null>((resolve) => {
    const draw = (): void => {
      stdout.write(`${screen.reset}${opts.header}\n${renderList(rows, active)}\n`);
    };

    const cleanup = (): void => {
      stdin.removeListener('keypress', onKey);
      if (stdin.isTTY) stdin.setRawMode(false);
      stdin.pause();
      stdout.write(screen.showCursor);
    };

    const onKey = (_str: string | undefined, key: { name?: string; ctrl?: boolean }): void => {
      if (!key) return;
      if (key.ctrl && key.name === 'c') {
        cleanup();
        resolve(null);
        return;
      }
      switch (key.name) {
        case 'up':
        case 'k':
          active = step(rows, active, -1);
          draw();
          break;
        case 'down':
        case 'j':
          active = step(rows, active, 1);
          draw();
          break;
        case 'return':
        case 'enter':
          cleanup();
          resolve((rows[active] as SelectItem<T>).value);
          break;
        case 'escape':
        case 'q':
          cleanup();
          resolve(null);
          break;
        default:
          break;
      }
    };

    emitKeypressEvents(stdin);
    stdin.setRawMode(true);
    stdin.resume();
    stdout.write(screen.hideCursor);
    stdin.on('keypress', onKey);
    draw();
  });
}

export async function textPrompt(message: string, fallback = ''): Promise<string> {
  stdoutWrite(screen.clearStyle + '\n');
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const suffix = fallback ? theme.soft(` (${fallback})`) : '';
    const answer = await rl.question(`${theme.teal('?')} ${theme.white(message)}${suffix} `);
    return answer.trim() || fallback;
  } finally {
    rl.close();
  }
}

export async function pressEnter(message = 'Press Enter to return to the menu…'): Promise<void> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    await rl.question(`\n${theme.soft(message)}`);
  } finally {
    rl.close();
  }
}

function stdoutWrite(s: string): void {
  process.stdout.write(s);
}
