import { describe, expect, it } from 'vitest';

import { DEFAULT_SETTINGS, loadSettings } from '../../src/config/settings.js';

describe('loadSettings', () => {
  it('returns the defaults for an empty environment', () => {
    expect(loadSettings({})).toEqual(DEFAULT_SETTINGS);
  });

  it('applies every ORCA_* override', () => {
    const settings = loadSettings({
      ORCA_MODEL: 'claude-sonnet-5',
      ORCA_QWEN_MODEL: 'qwen3-coder-flash',
      QWEN_BASE_URL: 'http://localhost:11434/v1/',
      ORCA_PRIMARY_PROVIDER: 'anthropic',
      ORCA_FALLBACK_PROVIDER: 'qwen',
      ORCA_MAX_PRIMARY_ATTEMPTS: '3',
      ORCA_COST_CAP_USD: '0.25',
      ORCA_MAX_HEAL_ATTEMPTS: '5',
    });

    expect(settings.model).toBe('claude-sonnet-5');
    expect(settings.qwenModel).toBe('qwen3-coder-flash');
    expect(settings.qwenBaseUrl).toBe('http://localhost:11434/v1');
    expect(settings.primaryProvider).toBe('anthropic');
    expect(settings.fallbackProvider).toBe('qwen');
    expect(settings.maxPrimaryAttempts).toBe(3);
    expect(settings.costCapUsd).toBe(0.25);
    expect(settings.maxHealAttempts).toBe(5);
  });

  it('disables fallback with ORCA_FALLBACK_PROVIDER=none', () => {
    expect(loadSettings({ ORCA_FALLBACK_PROVIDER: 'none' }).fallbackProvider).toBeNull();
  });

  it('falls back to defaults on invalid values instead of crashing', () => {
    const settings = loadSettings({
      ORCA_PRIMARY_PROVIDER: 'openai',
      ORCA_MAX_PRIMARY_ATTEMPTS: 'lots',
      ORCA_COST_CAP_USD: '-3',
      ORCA_MAX_HEAL_ATTEMPTS: '0',
    });

    expect(settings.primaryProvider).toBe(DEFAULT_SETTINGS.primaryProvider);
    expect(settings.maxPrimaryAttempts).toBe(DEFAULT_SETTINGS.maxPrimaryAttempts);
    expect(settings.costCapUsd).toBe(DEFAULT_SETTINGS.costCapUsd);
    expect(settings.maxHealAttempts).toBe(DEFAULT_SETTINGS.maxHealAttempts);
  });

  it('returns a frozen object', () => {
    expect(Object.isFrozen(loadSettings({}))).toBe(true);
  });
});
