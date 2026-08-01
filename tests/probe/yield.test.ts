/**
 * The two things that decided whether probing observes anything real.
 *
 *   - The isolation that makes a probe SAFE also makes it mostly useless: `--read-only`
 *     kills any image that writes a cache or pid file at startup, and `--network none`
 *     kills anything that needs a database. Both stay on by default — they are the
 *     contract — but a user debugging an empty reading now has a supported way to widen
 *     one for a single run instead of editing the isolation boundary.
 *   - A fixed settle was wrong in both directions: too long for a fast app, too short for
 *     a slow one, and in the slow case it recorded "binds nothing" as if it were a fact.
 *
 * The defaults are the assertion that matters here: relaxing must be a deliberate,
 * explicit act, and a typo must leave the strict setting in place.
 */
import { describe, expect, it } from 'vitest';

import { DEFAULT_SETTINGS, loadSettings } from '../../src/config/settings.js';
import { isolationArgs } from '../../src/probe/sandbox.js';

function flagValue(args: string[], flag: string): string | undefined {
  const index = args.indexOf(flag);
  return index === -1 ? undefined : args[index + 1];
}

describe('the strict posture is the default', () => {
  it('ships network-isolated and read-only', () => {
    expect(DEFAULT_SETTINGS.probeNetwork).toBe('none');
    expect(DEFAULT_SETTINGS.probeReadOnlyRootfs).toBe(true);

    const args = isolationArgs(DEFAULT_SETTINGS);
    expect(flagValue(args, '--network')).toBe('none');
    expect(args).toContain('--read-only');
  });

  it('keeps every unconditional guard when the two relaxable ones are relaxed', () => {
    // Widening the network or the root filesystem must not quietly drop the rest of the
    // contract along with them.
    const relaxed = isolationArgs({
      ...DEFAULT_SETTINGS,
      probeNetwork: 'bridge',
      probeReadOnlyRootfs: false,
    });

    expect(relaxed).not.toContain('--read-only');
    expect(flagValue(relaxed, '--network')).toBe('bridge');
    expect(flagValue(relaxed, '--cap-drop')).toBe('ALL');
    expect(flagValue(relaxed, '--security-opt')).toBe('no-new-privileges');
    expect(flagValue(relaxed, '--pids-limit')).toBe(String(DEFAULT_SETTINGS.probePidsLimit));
    expect(flagValue(relaxed, '--memory')).toBe(DEFAULT_SETTINGS.probeMemory);
    expect(flagValue(relaxed, '--memory-swap')).toBe(DEFAULT_SETTINGS.probeMemory);
    expect(relaxed).not.toContain('--volume');
  });
});

describe('relaxing takes an explicit value', () => {
  it('only turns the read-only root off for a real negative', () => {
    expect(loadSettings({}).probeReadOnlyRootfs).toBe(true);
    expect(loadSettings({ ORCA_PROBE_READONLY: '0' }).probeReadOnlyRootfs).toBe(false);
    expect(loadSettings({ ORCA_PROBE_READONLY: 'false' }).probeReadOnlyRootfs).toBe(false);
  });

  it('leaves it on for anything ambiguous, including a typo', () => {
    for (const value of ['', 'no', 'off', 'flase', '1', 'true']) {
      expect(loadSettings({ ORCA_PROBE_READONLY: value }).probeReadOnlyRootfs).toBe(true);
    }
  });

  it('takes a network name verbatim but falls back to none when unset', () => {
    expect(loadSettings({ ORCA_PROBE_NETWORK: 'bridge' }).probeNetwork).toBe('bridge');
    expect(loadSettings({ ORCA_PROBE_NETWORK: '' }).probeNetwork).toBe('none');
    expect(loadSettings({}).probeNetwork).toBe('none');
  });
});
