/**
 * "Placed nothing" and "could not place" are DIFFERENT outcomes.
 *
 * Suppressing the phantom service on workspace roots left a warning behind. A root that
 * nothing was placed for still got `unplaced-component`, and `assessUnderstanding` grades
 * every one of those as "the generated stack is incomplete" — so a monorepo ORCA
 * understood COMPLETELY (every real component placed, the parents correctly recognized as
 * libraries) came out `partial` with `shouldEscalate: true` and spent a tier-3 inference
 * call on a `{ private, workspaces }` file.
 *
 * Every monorepo fixture in the suite did this, which is the point worth keeping: the
 * fixtures' own tests assert PLACEMENT, and placement was right the whole time. Nothing
 * asserted what the grader made of the leftovers.
 */
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { detectStack } from '../../src/detect/index.js';
import { assessUnderstanding } from '../../src/detect/understanding.js';
import type { DetectionResult } from '../../src/detect/types.js';

const fixture = (name: string): string =>
  fileURLToPath(new URL(`../fixtures/${name}`, import.meta.url));

/** Roots named by warnings carrying `code`. */
const rootsWarned = (result: DetectionResult, code: string): string[] =>
  result.warnings
    .filter((w) => w.code === code)
    .map((w) => /'([^']+)'/.exec(w.message)?.[1] ?? '')
    .sort();

describe('a deliberately unplaced library', () => {
  it('is recorded as a decision, not left to look like a miss', async () => {
    const result = await detectStack(fixture('mixed-roles-repo'));

    // The workspace root and the shared package: both resolved to `library`, both
    // deliberately not placed.
    expect(result.insights.unrunnableRoots.sort()).toEqual(['.', 'lib']);
  });

  it('still surfaces, under a code that says why', async () => {
    const result = await detectStack(fixture('mixed-roles-repo'));

    // The user should know ORCA containerized nothing for these directories — the fix is
    // about what the message CLAIMS, not about hiding them.
    expect(rootsWarned(result, 'library-component')).toEqual(['.', 'lib']);
    expect(rootsWarned(result, 'unplaced-component')).toEqual([]);
  });

  it('grades the repo as fully understood instead of escalating', async () => {
    const understanding = assessUnderstanding(await detectStack(fixture('mixed-roles-repo')));

    expect(understanding.level).toBe('confident');
    expect(understanding.shouldEscalate).toBe(false);
    expect(understanding.gaps).toEqual([]);
  });

  it('clears the same false escalation on every monorepo fixture', async () => {
    // Not specific to one fixture's shape: all three have graded `partial` since the
    // workspace-root suppression landed.
    for (const name of ['react-express-nodb-repo', 'pnpm-packages-repo']) {
      const result = await detectStack(fixture(name));

      expect(rootsWarned(result, 'unplaced-component')).toEqual([]);
      expect(assessUnderstanding(result).shouldEscalate).toBe(false);
    }
  });
});

describe('the guard this must not weaken', () => {
  it('still reports a root ORCA genuinely could not place', async () => {
    // `bare-runtime-repo`'s `legacy` is a candidate root (manage.py) that nothing places
    // and no role explains. That is a real gap and must keep escalating — the whole
    // reason `unplaced-component` exists.
    const result = await detectStack(fixture('bare-runtime-repo'));

    expect(rootsWarned(result, 'unplaced-component')).toEqual(['legacy']);
    expect(result.insights.unrunnableRoots).not.toContain('legacy');
    expect(assessUnderstanding(result).shouldEscalate).toBe(true);
  });
});
