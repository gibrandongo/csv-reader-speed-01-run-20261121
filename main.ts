import { setFlagsFromString } from 'node:v8';
import { readFileSync, writeFileSync, mkdirSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';

// Same V8 tuning the house driver uses, applied before importing solve.js.
setFlagsFromString('--no-incremental-marking');

// The harness mounts the cases at /input and takes answers from /output; the
// process driver (local grading) instead points MAKEFUN_INPUT_DIR and
// MAKEFUN_OUTPUT_DIR at its own directories, so honour those when set and
// fall back to the mount points. (In the docker grading both variables name
// /input and /output, so the behaviour there is identical.)
const INPUT_DIR = process.env.MAKEFUN_INPUT_DIR ?? '/input';
const OUTPUT_DIR = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';

async function main() {
  const cases = JSON.parse(readFileSync(join(INPUT_DIR, 'cases.json'), 'utf8'));
  if (!Array.isArray(cases)) throw new Error('cases.json is not an array');
  const { run } = await import('./solve.js');

  // One answer per case, in order. run() is deterministic (no clock, no
  // randomness, no cross-case state), so JSON.stringify below is identical
  // on every execution of the same input.
  const answers = new Array(cases.length);
  for (let k = 0; k < cases.length; k++) {
    if (!cases[k] || typeof cases[k].input !== 'object') {
      throw new Error('case ' + k + ' has no input object');
    }
    answers[k] = run(cases[k].input);
  }

  // Create the output directory if needed and clear only its contents,
  // never the directory itself.
  mkdirSync(OUTPUT_DIR, { recursive: true });
  for (const name of readdirSync(OUTPUT_DIR)) {
    rmSync(join(OUTPUT_DIR, name), { recursive: true, force: true });
  }
  writeFileSync(join(OUTPUT_DIR, 'answers.json'), JSON.stringify(answers));
}

main();
