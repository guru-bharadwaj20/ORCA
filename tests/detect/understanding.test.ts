import { describe, it, expect } from 'vitest';

import {
  assessUnderstanding,
  describeUnderstanding,
  CONFIDENT_THRESHOLD,
} from '../../src/detect/understanding.js';
import type { DetectionResult } from '../../src/detect/types.js';

/** A placed, well-corroborated detection — the `confident` baseline. */
function detection(over: Partial<DetectionResult> = {}): DetectionResult {
  return {
    repoPath: '/repo',
    languages: ['javascript'],
    packageManagers: ['npm'],
    frontend: null,
    backend: null,
    databases: [],
    isSupported: true,
    confidence: 0.9,
    reasoning: [],
    warnings: [],
    insights: {
      frameworks: [],
      runtimes: ['node'],
      monorepoTools: [],
      ciCommands: [{ command: 'npm run build', kind: 'build' }],
      ciRuntimeVersions: [],
      ciProviders: [],
      dockerfiles: [],
      taskCommands: [],
      scriptSources: [],
      ecosystemComponents: [],
      ...(over.insights ?? {}),
    },
    ...over,
  } as DetectionResult;
}

describe('assessUnderstanding', () => {
  it('grades a placed, corroborated, confident repo as confident', () => {
    const u = assessUnderstanding(detection());

    expect(u.level).toBe('confident');
    expect(u.gaps).toEqual([]);
    expect(u.shouldEscalate).toBe(false);
  });

  it('grades an unplaceable repo as none and preserves the hard-stop condition', () => {
    const u = assessUnderstanding(detection({ isSupported: false, confidence: 0 }));

    expect(u.level).toBe('none');
    expect(u.shouldEscalate).toBe(true);
  });

  it('grades a placed but low-confidence repo as partial', () => {
    // The case the old boolean gate could not express: placed, so `isSupported` is true,
    // yet barely understood — it would have gone straight to a likely-broken build.
    const u = assessUnderstanding(detection({ confidence: 0.3 }));

    expect(u.level).toBe('partial');
    expect(u.shouldEscalate).toBe(true);
    expect(u.gaps.join(' ')).toContain('confidence');
  });

  it('flags a repo where nothing declares how it is built', () => {
    const u = assessUnderstanding(
      detection({
        insights: {
          ...detection().insights,
          ciCommands: [],
        },
      })
    );

    expect(u.level).toBe('partial');
    expect(u.gaps.join(' ')).toContain('declares how it is built');
  });

  it('flags an ecosystem component placed without a recipe', () => {
    const u = assessUnderstanding(
      detection({
        insights: {
          ...detection().insights,
          ecosystemComponents: [
            { rootDir: 'svc', runtime: 'go', recipeId: '', role: 'backend' },
          ] as never,
        },
      })
    );

    expect(u.gaps.join(' ')).toContain("'svc' was placed without a matched recipe");
  });

  it('treats the threshold as inclusive', () => {
    const at = assessUnderstanding(detection({ confidence: CONFIDENT_THRESHOLD }));
    const below = assessUnderstanding(detection({ confidence: CONFIDENT_THRESHOLD - 0.01 }));

    expect(at.level).toBe('confident');
    expect(below.level).toBe('partial');
  });

  it('accumulates several gaps rather than reporting only the first', () => {
    const u = assessUnderstanding(
      detection({ confidence: 0.2, insights: { ...detection().insights, ciCommands: [] } })
    );

    expect(u.gaps.length).toBeGreaterThan(1);
  });
});

describe('describeUnderstanding', () => {
  it('summarizes a confident result without noise', () => {
    expect(describeUnderstanding(assessUnderstanding(detection()))).toBe(
      'understood with confidence 0.90'
    );
  });

  it('names the gaps for a partial result', () => {
    const text = describeUnderstanding(assessUnderstanding(detection({ confidence: 0.3 })));

    expect(text).toContain('partial understanding');
    expect(text).toContain('confidence');
  });
});

describe('partial placement', () => {
  /**
   * The defect: `isSupported` asks whether ANYTHING placed, never whether EVERYTHING did,
   * so a repo with a dropped component reported full success and shipped a partial stack.
   */
  const unplaced = (rootDir: string) => ({
    code: 'unplaced-component',
    message: `'${rootDir}' declares a manifest but nothing was placed for it — it will be missing from the generated stack.`,
    detector: 'index',
  });

  it('grades a repo with a dropped component as partial', () => {
    const u = assessUnderstanding(detection({ warnings: [unplaced('legacy')] }));

    expect(u.level).toBe('partial');
    expect(u.shouldEscalate).toBe(true);
  });

  it('names the dropped roots in the gap', () => {
    const u = assessUnderstanding(detection({ warnings: [unplaced('legacy'), unplaced('tools')] }));

    // The reviewer needs to know WHICH directory is missing, not just that one is.
    expect(u.gaps.some((g) => g.includes('legacy, tools'))).toBe(true);
    expect(u.gaps.some((g) => g.includes('2 detected component(s)'))).toBe(true);
  });

  it('leaves a fully-placed repo confident', () => {
    // The guard that keeps this from grading every ordinary repo as partial.
    expect(assessUnderstanding(detection()).level).toBe('confident');
  });

  it('does not grade a deliberately unplaced library as a dropped component', () => {
    // A workspace root or a shared package is not a MISS — detection resolved its role and
    // correctly containerized nothing for it. Reporting it as `unplaced-component` made
    // every monorepo fixture in the suite grade `partial` and escalate to tier-3 inference
    // over a `{ private, workspaces }` file, so those roots carry their own code now.
    const u = assessUnderstanding(
      detection({
        warnings: [
          {
            code: 'library-component',
            message: "'.' is imported rather than run…",
            detector: 'index',
          },
        ],
      })
    );

    expect(u.level).toBe('confident');
    expect(u.shouldEscalate).toBe(false);
  });

  it('ignores the coarser unrecognized-component warning', () => {
    // `unrecognized-component` fires whenever the SEED path can't classify a root — even
    // for roots the ecosystem path then placed successfully. Grading on it would report
    // a complete stack as partial.
    const u = assessUnderstanding(
      detection({
        warnings: [
          { code: 'unrecognized-component', message: "'api' has a manifest…", detector: 'index' },
        ],
      })
    );

    expect(u.level).toBe('confident');
  });
});
