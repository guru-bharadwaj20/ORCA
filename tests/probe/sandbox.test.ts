/**
 * PHASE G — the ISOLATION BOUNDARY (security-contract clause 1).
 *
 * These assert the flag list itself, because that list IS the contract. A change that
 * drops `--network none` or lets swap double the memory cap is a security regression that
 * no behavioural test would catch: the probe would keep working, just less safely.
 *
 * Hermetic, like every test here — nothing below starts Docker.
 */
import { describe, expect, it } from 'vitest';

import { DEFAULT_SETTINGS, loadSettings } from '../../src/config/settings.js';
import { isolationArgs } from '../../src/probe/sandbox.js';

/** The flag list as pairs, so assertions read as `--flag value`. */
function flagValue(args: string[], flag: string): string | undefined {
  const index = args.indexOf(flag);
  return index === -1 ? undefined : args[index + 1];
}

describe('probe sandbox isolation flags', () => {
  const args = isolationArgs(DEFAULT_SETTINGS);

  it('denies the container a network', () => {
    // Clause 1: no host network. Also why ports are read from /proc rather than by
    // connecting to them — there is nothing to connect over.
    expect(flagValue(args, '--network')).toBe('none');
  });

  it('gives the container a read-only root with a noexec scratch dir', () => {
    expect(args).toContain('--read-only');
    expect(flagValue(args, '--tmpfs')).toBe('/tmp:rw,noexec,nosuid,size=64m');
  });

  it('drops every capability and forbids regaining privileges', () => {
    expect(flagValue(args, '--cap-drop')).toBe('ALL');
    expect(flagValue(args, '--security-opt')).toBe('no-new-privileges');
  });

  it('caps memory AND swap to the same value', () => {
    // Without --memory-swap, Docker grants swap equal to memory, silently doubling the
    // real cap. Equal values mean the limit is the limit.
    expect(flagValue(args, '--memory')).toBe(DEFAULT_SETTINGS.probeMemory);
    expect(flagValue(args, '--memory-swap')).toBe(DEFAULT_SETTINGS.probeMemory);
  });

  it('caps CPU and process count', () => {
    expect(flagValue(args, '--cpus')).toBe(String(DEFAULT_SETTINGS.probeCpus));
    // The fork-bomb guard.
    expect(flagValue(args, '--pids-limit')).toBe(String(DEFAULT_SETTINGS.probePidsLimit));
  });

  it('mounts no host path at all', () => {
    // A repo cannot write to the machine analysing it. The image already carries the
    // repo's code (compose built it), so there is nothing a bind mount would add.
    expect(args).not.toContain('--volume');
    expect(args).not.toContain('-v');
    expect(args.some((a) => a.startsWith('--mount'))).toBe(false);
  });

  it('carries every limit into the flag list when settings override the defaults', () => {
    const custom = isolationArgs({
      ...DEFAULT_SETTINGS,
      probeMemory: '128m',
      probeCpus: 2,
      probePidsLimit: 32,
    });

    expect(flagValue(custom, '--memory')).toBe('128m');
    expect(flagValue(custom, '--memory-swap')).toBe('128m');
    expect(flagValue(custom, '--cpus')).toBe('2');
    expect(flagValue(custom, '--pids-limit')).toBe('32');
  });
});

describe('the opt-in flag (clause 2)', () => {
  it('is off by default', () => {
    expect(DEFAULT_SETTINGS.enableProbing).toBe(false);
    expect(loadSettings({}).enableProbing).toBe(false);
  });

  it('turns on only for an explicit affirmative value', () => {
    expect(loadSettings({ ORCA_ENABLE_PROBING: '1' }).enableProbing).toBe(true);
    expect(loadSettings({ ORCA_ENABLE_PROBING: 'true' }).enableProbing).toBe(true);
    expect(loadSettings({ ORCA_ENABLE_PROBING: 'TRUE' }).enableProbing).toBe(true);
  });

  it('stays off for anything else, including a plausible-looking typo', () => {
    // The flag that decides whether repo code executes must not be forgiving.
    for (const value of ['0', 'false', 'no', 'yes', 'on', '', 'ture']) {
      expect(loadSettings({ ORCA_ENABLE_PROBING: value }).enableProbing).toBe(false);
    }
  });
});
