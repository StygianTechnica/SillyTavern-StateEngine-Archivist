// When the compiler runs on its own - plain functions, so they can be
// tested on their own. Never on every message: it waits for enough NEW
// memories (or enough time with some), and not again right after a run.
//
//   manual          Compile now / Rebuild always run
//   nothing new     no new memories -> no run. (Memories only removed - a
//                   regenerate, a swipe - need no run: the compiled view
//                   already leaves out facts resting only on them, and
//                   brings them back on a swipe back.)
//   stability       compiled less than settings.compileMinGapMinutes ago -> no run
//   threshold       new (meaningful) memories >= compileThreshold -> run
//   time            at least compileIntervalMinutes since the last run, and
//                   at least one new memory -> run
//
// Noise: a new memory that nearly repeats another (word overlap) doesn't
// count toward the threshold - the effect of "raise the threshold while
// memories are repetitive".

export const NEAR_DUPLICATE = 0.8;

function wordSet(text) {
    return new Set(String(text ?? '').toLowerCase().match(/[a-z0-9']{3,}/g) ?? []);
}

// Jaccard overlap of two texts' words, 0..1.
export function similarity(a, b) {
    const x = wordSet(a);
    const y = wordSet(b);
    if (x.size === 0 || y.size === 0) return 0;
    let shared = 0;
    for (const w of x) if (y.has(w)) shared++;
    return shared / (x.size + y.size - shared);
}

// How many of `added` say something new: not a near-repeat of any memory
// before it (`existing`, then the added ones before it).
export function meaningfulCount(added, existing) {
    const seen = existing.map((r) => r.text);
    let count = 0;
    for (const record of added) {
        if (!seen.some((text) => similarity(text, record.text) >= NEAR_DUPLICATE)) count++;
        seen.push(record.text);
    }
    return count;
}

// -> { compile: boolean, reason }
export function shouldCompile({ meaningful, lastCompiledAt = null, now = Date.now(), settings, manual = false }) {
    if (manual) return { compile: true, reason: 'manual' };
    const changes = meaningful;
    if (changes === 0) return { compile: false, reason: 'nothing new' };
    const last = lastCompiledAt ? new Date(lastCompiledAt).getTime() : null;
    const minutesSince = last === null ? Infinity : (now - last) / 60000;
    if (minutesSince < (Number(settings.compileMinGapMinutes) || 0)) return { compile: false, reason: 'compiled recently' };
    if (changes >= (Number(settings.compileThreshold) || 15)) return { compile: true, reason: 'threshold' };
    if (last !== null && minutesSince >= (Number(settings.compileIntervalMinutes) || 30)) return { compile: true, reason: 'interval' };
    return { compile: false, reason: 'waiting for more memories' };
}
