import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Readers for the workflows, and the way their scripts run, shared by the tests of each
 * workflow. They read YAML as the workflows here write it, and fail the calling test on a
 * form they cannot read.
 */

export const root = fileURLToPath(new URL('..', import.meta.url));
export const read = (rel: string): string => readFileSync(`${root}${rel}`, 'utf8');

/** Every workflow in the repository, by file name, in the order of their names. */
export const workflowFiles = (): string[] =>
  readdirSync(`${root}.github/workflows`).filter((name) => /\.ya?ml$/.test(name)).sort();

/** A workflow's text, release.yml unless `file` names another. */
export const workflow = (file = 'release.yml'): string => read(`.github/workflows/${file}`);

/**
 * A workflow without comments or blank lines, release.yml unless `file` names another. Its
 * own prose says "this job holds id-token: write", so a presence check against the raw text
 * passes with the permission deleted. A YAML comment starts at a `#` preceded by whitespace,
 * and none of these workflows' values contain one.
 */
export const workflowCode = (file = 'release.yml'): string =>
  workflow(file)
    .split('\n')
    .map((line) => line.replace(/(^|\s)#.*$/, '').trimEnd())
    .filter((line) => line !== '')
    .join('\n');

/** The indentation of a block's shallowest lines, where its own keys sit. */
export const depthOf = (yaml: string): number | undefined => {
  const indents = yaml.split('\n').filter((line) => line.trim() !== '').map((line) => line.search(/\S/));
  return indents.length === 0 ? undefined : Math.min(...indents);
};

/**
 * The entry for `key:` where it is a direct child of `yaml`, a key at the block's shallowest
 * indentation, written plain or quoted: what follows the colon on its line, and the deeper
 * lines after it as they are written. Undefined when there is none. A deeper key of the same
 * name, such as a job's own `concurrency:`, does not count.
 */
export const entryOf = (yaml: string, key: string): { value: string; nested: string } | undefined => {
  const depth = depthOf(yaml);
  if (depth === undefined) return undefined;
  const entry = new RegExp(`^ {${depth}}(['"]?)${key}\\1: *(.*)\\n?((?: {${depth + 1},}.*(?:\\n|$))*)`, 'm').exec(yaml);
  return entry ? { value: entry[2]!, nested: entry[3]! } : undefined;
};

/**
 * The lines nested under `key:` where it is a direct child of `yaml`, as `entryOf` finds it, or
 * '' when there are none.
 */
export const under = (yaml: string, key: string): string => {
  const entry = entryOf(yaml, key);
  return entry?.value === '' ? entry.nested : '';
};

/**
 * What follows `key:` where it is a direct child of `yaml`, as `entryOf` finds it: the value
 * without the quotes YAML allows around it, '' when a nested block follows instead, only the
 * indicator of a block scalar such as `|`, or undefined when there is no such key. Deeper lines
 * continue any other value and are joined on with single spaces, as YAML folds a plain scalar,
 * so a continuation such as `|| true` stays part of the value.
 */
export const scalar = (yaml: string, key: string): string | undefined => {
  const entry = entryOf(yaml, key);
  if (entry === undefined || entry.value === '' || /^[|>][-+1-9]*$/.test(entry.value)) return entry?.value;
  const continuation = entry.nested.split('\n').filter((line) => line.trim() !== '').map((line) => line.trim());
  return [entry.value, ...continuation].join(' ').replace(/^(['"])(.*)\1$/, '$2');
};

/**
 * The direct children of `yaml`, each key with its value as `scalar` reads it: a mapping such as a job's
 * `outputs:` or `permissions:`, or a step's `env:` or `with:`. A child written in a form the pattern does
 * not read, or a key written twice, fails the calling test, so a comparison of the whole mapping cannot
 * pass on an entry it missed.
 */
export const mappingOf = (yaml: string): Record<string, string> => {
  const depth = depthOf(yaml);
  if (depth === undefined) return {};
  const keys = yaml
    .split('\n')
    .filter((line) => line.trim() !== '' && line.search(/\S/) === depth)
    .map((line) => {
      const key = /^([\w-]+):(?: |$)/.exec(line.trim())?.[1];
      assert.ok(key, `an entry is written in a form this test cannot read: ${line.trim()}`);
      return key;
    });
  assert.equal(new Set(keys).size, keys.length, `a key is written more than once: ${keys.join(', ')}`);
  return Object.fromEntries(keys.map((key) => [key, scalar(yaml, key)!]));
};

/** Every job in a workflow's code, as its name and the lines nested under its key. */
export const jobsIn = (code: string): Array<[string, string]> => {
  const jobs = under(code, 'jobs');
  const depth = depthOf(jobs);
  if (depth === undefined) return [];
  return [...jobs.matchAll(new RegExp(`^ {${depth}}(['"]?)([\\w-]+)\\1:`, 'gm'))].map(
    (match): [string, string] => [match[2]!, under(jobs, match[2]!)],
  );
};

/**
 * Every job in a workflow, release.yml unless `file` names another, as its name and the lines
 * nested under its key.
 */
export const workflowJobs = (file = 'release.yml'): Array<[string, string]> => jobsIn(workflowCode(file));

/** A job's steps, one string per list item. */
export const jobSteps = (job: string): string[] => {
  const steps = under(job, 'steps');
  const marker = /^ *- /.exec(steps)?.[0];
  return marker ? steps.split(new RegExp(`^(?=${marker})`, 'm')) : [];
};

export const isCheckout = (step: string): boolean => /^ *(?:- +)?uses: *actions\/checkout@/m.test(step);

export const isPnpmSetup = (step: string): boolean => /^ *(?:- +)?uses: *pnpm\/setup@/m.test(step);

/** A step with its list marker turned into spaces, so its first key sits at the depth of the others. */
export const stepBody = (step: string): string =>
  step.replace(/^( *)(- +)/, (_, indent: string, marker: string) => indent + ' '.repeat(marker.length));

/**
 * The script a step's `run:` hands to bash: the value as `scalar` reads it, continuation lines
 * folded on, or the lines of a `run: |` block without the block's indentation. Undefined for a
 * step that runs no script. It reads the step as `workflowCode` leaves it, so comment lines
 * inside a block are already gone.
 */
export const stepScript = (step: string): string | undefined => {
  const body = stepBody(step);
  const run = entryOf(body, 'run');
  if (run === undefined || !/^\|[-+]?$/.test(run.value)) return scalar(body, 'run');
  const lines = run.nested.split('\n').filter((line) => line.trim() !== '');
  const indent = Math.min(...lines.map((line) => line.search(/\S/)));
  return lines.map((line) => line.slice(indent)).join('\n');
};

/**
 * Runs a step's script the way a runner runs a `run:` step that sets no `shell:`, with
 * `bash -e`, and with nothing in its environment but PATH and `env`. A script still running
 * after 30 seconds is killed and fails the test, so a loop with no bound cannot hang the
 * suite, and a script that hangs is never taken for one that failed.
 */
export const bash = (script: string, env: Record<string, string>, cwd: string) => {
  const run = spawnSync('bash', ['-e', '-c', script], {
    cwd,
    env: { PATH: process.env['PATH'] ?? '', ...env },
    encoding: 'utf8',
    timeout: 30_000,
    killSignal: 'SIGKILL',
  });
  assert.equal(run.signal, null, `the script was still running after 30 seconds: ${script.split('\n')[0]}`);
  return run;
};

export const isAppToken = (step: string): boolean => /^ *(?:- +)?uses: *actions\/create-github-app-token@/m.test(step);

/**
 * A step's own condition, read as `scalar` reads a key at the depth of the step's keys. An `if:`
 * that is the step's first key, on its `- ` line, counts like any other, and one nested deeper,
 * such as an action input, is not the step's.
 */
export const stepIf = (step: string): string | undefined => scalar(stepBody(step), 'if');

export const stepName = (step: string): string =>
  /^ *(?:- +)?(?:name|id|uses|run): *(.*)$/m.exec(step)?.[1] ?? step.trim();

/**
 * The inputs under a step's `with:`. The runner takes an input whose key is capitalised or followed
 * by a space before its colon, and `scalar` finds neither. So each input has to be a lowercase key,
 * plain or quoted, written once, or the calling test fails, and a check that an input is absent
 * cannot pass on a spelling `scalar` misses.
 */
export const stepInputs = (step: string): string => {
  const inputs = under(stepBody(step), 'with');
  const depth = depthOf(inputs);
  const names = inputs
    .split('\n')
    .filter((line) => line.trim() !== '' && line.search(/\S/) === depth)
    .map((line) => line.trim().replace(/:.*$/, ''));
  for (const name of names) {
    assert.match(name, /^(['"]?)[a-z][a-z0-9-]*\1$/, `${stepName(step)} has an input written in a form this test cannot read: ${name}`);
  }
  const unquoted = names.map((name) => name.replace(/^(['"])(.*)\1$/, '$2'));
  assert.equal(new Set(unquoted).size, unquoted.length, `${stepName(step)} sets an input more than once`);
  return inputs;
};

/**
 * Fails when a shell is chosen for `step`, a step of `job`: by the step, in the job's defaults, or
 * in the defaults of the workflow, release.yml unless `file` names another. Only while none is does a runner run the step's script as `bash -e {0}`.
 */
export const assertDefaultShell = (job: string, step: string, file = 'release.yml'): void => {
  const name = stepName(step);
  assert.equal(scalar(stepBody(step), 'shell'), undefined, `${name} sets its own shell`);
  assert.equal(scalar(job, 'defaults'), undefined, `${name} runs in a job that sets defaults for its steps`);
  assert.equal(scalar(workflowCode(file), 'defaults'), undefined, 'the workflow sets defaults for its steps');
};

/** The action that mints a token of the tibia-sh App, pinned to the commit of its v3.2.0 tag. */
export const APP_TOKEN_ACTION = 'actions/create-github-app-token@bcd2ba49218906704ab6c1aa796996da409d3eb1';

/** The inputs that name the App to every token step: its client ID and key, and the organization. */
export const APP = {
  'client-id': '${{ vars.TIBIA_SH_APP_CLIENT_ID }}',
  'private-key': '${{ secrets.TIBIA_SH_APP_PRIVATE_KEY }}',
  owner: 'tibia-sh',
};

/** A job's one step that mints the App token. `name` names the job in a failure. */
export const appTokenStep = (job: string, name: string): string => {
  const steps = jobSteps(job).filter(isAppToken);
  assert.equal(steps.length, 1, `expected exactly one step of the ${name} job that mints the App token`);
  assert.equal(
    job.split('create-github-app-token@').length - 1,
    1,
    `a token step of the ${name} job is written in a form this test cannot read, such as a flow mapping`,
  );
  return steps[0]!;
};

/** The lines the fakes recorded in `file` of a run's directory, or none when they wrote nothing there. */
export const recorded = (dir: string, file: string): string[] =>
  existsSync(join(dir, file)) ? readFileSync(join(dir, file), 'utf8').split('\n').filter((line) => line !== '') : [];
