import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PACKAGE_VERSION, tempDirs } from './harness.ts';

/**
 * The release workflow cannot run inside the suite, and every property pinned here
 * breaks publishing silently: the mistake surfaces when a release PR merges, usually
 * after the tag already exists. Each one is checkable from the files alone.
 */

const root = fileURLToPath(new URL('..', import.meta.url));
const read = (rel: string): string => readFileSync(`${root}${rel}`, 'utf8');

/** Every workflow in the repository, by file name. */
const workflowFiles = (): string[] => readdirSync(`${root}.github/workflows`).filter((name) => /\.ya?ml$/.test(name));

/** A workflow's text, release.yml unless `file` names another. */
const workflow = (file = 'release.yml'): string => read(`.github/workflows/${file}`);

/**
 * A workflow without comments or blank lines, release.yml unless `file` names another. Its
 * own prose says "this job holds id-token: write", so a presence check against the raw text
 * passes with the permission deleted. A YAML comment starts at a `#` preceded by whitespace,
 * and none of these workflows' values contain one.
 */
const workflowCode = (file = 'release.yml'): string =>
  workflow(file)
    .split('\n')
    .map((line) => line.replace(/(^|\s)#.*$/, '').trimEnd())
    .filter((line) => line !== '')
    .join('\n');

/** The indentation of a block's shallowest lines, where its own keys sit. */
const depthOf = (yaml: string): number | undefined => {
  const indents = yaml.split('\n').filter((line) => line.trim() !== '').map((line) => line.search(/\S/));
  return indents.length === 0 ? undefined : Math.min(...indents);
};

/**
 * The entry for `key:` where it is a direct child of `yaml`, a key at the block's shallowest
 * indentation, written plain or quoted: what follows the colon on its line, and the deeper
 * lines after it as they are written. Undefined when there is none. A deeper key of the same
 * name, such as a job's own `concurrency:`, does not count.
 */
const entryOf = (yaml: string, key: string): { value: string; nested: string } | undefined => {
  const depth = depthOf(yaml);
  if (depth === undefined) return undefined;
  const entry = new RegExp(`^ {${depth}}(['"]?)${key}\\1: *(.*)\\n?((?: {${depth + 1},}.*(?:\\n|$))*)`, 'm').exec(yaml);
  return entry ? { value: entry[2]!, nested: entry[3]! } : undefined;
};

/**
 * The lines nested under `key:` where it is a direct child of `yaml`, as `entryOf` finds it, or
 * '' when there are none.
 */
const under = (yaml: string, key: string): string => {
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
const scalar = (yaml: string, key: string): string | undefined => {
  const entry = entryOf(yaml, key);
  if (entry === undefined || entry.value === '' || /^[|>][-+1-9]*$/.test(entry.value)) return entry?.value;
  const continuation = entry.nested.split('\n').filter((line) => line.trim() !== '').map((line) => line.trim());
  return [entry.value, ...continuation].join(' ').replace(/^(['"])(.*)\1$/, '$2');
};

const releaseJob = (): string => under(under(workflowCode(), 'jobs'), 'release');

const registryJob = (): string => under(under(workflowCode(), 'jobs'), 'registry');

/**
 * Every job in a workflow, release.yml unless `file` names another, as its name and the lines
 * nested under its key.
 */
const workflowJobs = (file = 'release.yml'): Array<[string, string]> => {
  const jobs = under(workflowCode(file), 'jobs');
  const depth = depthOf(jobs);
  if (depth === undefined) return [];
  return [...jobs.matchAll(new RegExp(`^ {${depth}}(['"]?)([\\w-]+)\\1:`, 'gm'))].map(
    (match): [string, string] => [match[2]!, under(jobs, match[2]!)],
  );
};

/**
 * The release job's own permissions block. It replaces the workflow-level block instead
 * of adding to it, so every grant the job needs has to sit here.
 */
const releaseJobPermissions = (): string => under(releaseJob(), 'permissions');

/** A job's steps, one string per list item. */
const jobSteps = (job: string): string[] => {
  const steps = under(job, 'steps');
  const marker = /^ *- /.exec(steps)?.[0];
  return marker ? steps.split(new RegExp(`^(?=${marker})`, 'm')) : [];
};

/** The release job's steps, one string per list item. */
const releaseJobSteps = (): string[] => jobSteps(releaseJob());

/** The registry job's steps, one string per list item. */
const registryJobSteps = (): string[] => jobSteps(registryJob());

const isCheckout = (step: string): boolean => /^ *(?:- +)?uses: *actions\/checkout@/m.test(step);

const isPnpmSetup = (step: string): boolean => /^ *(?:- +)?uses: *pnpm\/setup@/m.test(step);

/** A step with its list marker turned into spaces, so its first key sits at the depth of the others. */
const stepBody = (step: string): string =>
  step.replace(/^( *)(- +)/, (_, indent: string, marker: string) => indent + ' '.repeat(marker.length));

/**
 * The script a step's `run:` hands to bash: the value as `scalar` reads it, continuation lines
 * folded on, or the lines of a `run: |` block without the block's indentation. Undefined for a
 * step that runs no script. It reads the step as `workflowCode` leaves it, so comment lines
 * inside a block are already gone.
 */
const stepScript = (step: string): string | undefined => {
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
const bash = (script: string, env: Record<string, string>, cwd: string) => {
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

const scratch = tempDirs('twmcp-release-workflow-');

/** The steps that follow the release-please step in the release job. */
const stepsAfterReleasePlease = (): string[] => {
  const steps = releaseJobSteps();
  const releasePlease = steps.findIndex((step) =>
    /^ *(?:- +)?uses: *googleapis\/release-please-action@/m.test(step),
  );
  assert.notEqual(releasePlease, -1, 'the release job has no release-please step');
  return steps.slice(releasePlease + 1);
};

/**
 * A step's own condition, read as `scalar` reads a key at the depth of the step's keys. An `if:`
 * that is the step's first key, on its `- ` line, counts like any other, and one nested deeper,
 * such as an action input, is not the step's.
 */
const stepIf = (step: string): string | undefined => scalar(stepBody(step), 'if');

const stepName = (step: string): string =>
  /^ *(?:- +)?(?:name|id|uses|run): *(.*)$/m.exec(step)?.[1] ?? step.trim();

/**
 * The inputs under a step's `with:`. The runner takes an input whose key is capitalised or followed
 * by a space before its colon, and `scalar` finds neither. So each input has to be a lowercase key,
 * plain or quoted, written once, or the calling test fails, and a check that an input is absent
 * cannot pass on a spelling `scalar` misses.
 */
const stepInputs = (step: string): string => {
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
 * in the workflow's. Only while none is does a runner run the step's script as `bash -e {0}`.
 */
const assertDefaultShell = (job: string, step: string): void => {
  const name = stepName(step);
  assert.equal(scalar(stepBody(step), 'shell'), undefined, `${name} sets its own shell`);
  assert.equal(scalar(job, 'defaults'), undefined, `${name} runs in a job that sets defaults for its steps`);
  assert.equal(scalar(workflowCode(), 'defaults'), undefined, 'the workflow sets defaults for its steps');
};

/** The condition every building and publishing step carries. */
const PUBLISH_GATE = '${{ steps.release.outputs.release_created && steps.release.outputs.sha == github.sha }}';

/** Its opposite: a release was created, but this run was triggered at another commit. */
const DIVERGED = '${{ steps.release.outputs.release_created && steps.release.outputs.sha != github.sha }}';

/** The step that fails a diverged run: on the diverged condition, with no publish and no action. */
const isAlarm = (step: string): boolean =>
  stepIf(step) === DIVERGED && !/\bnpm publish\b/.test(step) && !/^ *(?:- +)?uses:/m.test(step);

/** A push run that created no release, the only run that can leave a merged release PR unreleased. */
const UNRELEASED = "${{ github.event_name == 'push' && !steps.release.outputs.release_created }}";

/**
 * The step that fails a run while a merged release PR is left unreleased: on the unreleased
 * condition, with no publish and no action.
 */
const isReleaseCheck = (step: string): boolean =>
  stepIf(step) === UNRELEASED && !/\bnpm publish\b/.test(step) && !/^ *(?:- +)?uses:/m.test(step);

/** The release job's one step on the unreleased condition. */
const releaseCheckStep = (): string => {
  const checks = releaseJobSteps().filter((step) => stepIf(step) === UNRELEASED);
  assert.equal(checks.length, 1, 'expected exactly one release job step on the unreleased condition');
  return checks[0]!;
};

/**
 * Every `run:` script in the raw workflow text, block scalars included. Comments stay in,
 * because GitHub substitutes `${{ }}` inside a block scalar's comment lines too.
 */
const runScripts = (yaml: string): string[] => {
  const lines = yaml.split('\n');
  return lines.flatMap((line, index) => {
    const match = /^( *(?:- +)?)(?:run|"run"|'run'):(.*)$/.exec(line);
    if (!match) return [];
    const script = [match[2]!];
    for (const next of lines.slice(index + 1)) {
      if (next.trim() !== '' && next.search(/\S/) <= match[1]!.length) break;
      script.push(next);
    }
    return [script.join('\n')];
  });
};

type ExtraFile = string | { type: string; path: string; jsonpath?: string };
type ReleaserConfig = { 'include-component-in-tag'?: unknown; 'extra-files'?: ExtraFile[] };
type ReleasePleaseConfig = ReleaserConfig & { packages: Record<string, ReleaserConfig> };

/**
 * A setting as release-please applies it to the root package: the package's own value
 * wins and the config root is only the fallback, the same `??` merge release-please runs.
 */
const rootPackageSetting = <K extends keyof ReleaserConfig>(key: K): ReleaserConfig[K] => {
  const { packages, ...defaults } = JSON.parse(read('release-please-config.json')) as ReleasePleaseConfig;
  return packages['.']?.[key] ?? defaults[key];
};

/** Whether a release of the root package rewrites the version at `jsonpath` in `path`. */
const releaseBumps = (path: string, jsonpath: string): boolean =>
  (rootPackageSetting('extra-files') ?? []).some(
    (file) =>
      typeof file !== 'string' && file.type === 'json' && file.path === path && file.jsonpath === jsonpath,
  );

/**
 * The value `jsonpath` selects in the JSON file at `path`, or undefined when it selects
 * nothing. Each step follows an own property, as jsonpath-plus does for a `.key` or an
 * `[index]`, the only steps walked here. Any other syntax fails the test rather than
 * resolve differently from release-please.
 */
const valueAt = (path: string, jsonpath: string): unknown => {
  assert.match(jsonpath, /^\$(?:\.\w+|\[\d+\])+$/, `${jsonpath} is not a path of .key and [index] steps`);
  let value: unknown = JSON.parse(read(path));
  for (const [, key, index] of jsonpath.matchAll(/\.(\w+)|\[(\d+)\]/g)) {
    const step = key ?? index!;
    if (typeof value !== 'object' || value === null || !Object.hasOwn(value, step)) return undefined;
    value = (value as Record<string, unknown>)[step];
  }
  return value;
};

test('the release job can mint the OIDC token npm publish authenticates with', () => {
  // Without it npm publish fails ENEEDAUTH.
  assert.match(releaseJobPermissions(), /^ *id-token: *write$/m, 'the release job has no id-token: write');
});

test('the release job can create the release', () => {
  // release-please commits the release PR's changes to its branch, and creates the GitHub release
  // and with it the tag. Both write the repository's contents, so without this grant nothing is
  // released.
  assert.match(releaseJobPermissions(), /^ *contents: *write$/m, 'the release job has no contents: write');
});

test('the release job can open the release PR', () => {
  // release-please opens the release PR and updates it as commits land. Without this grant no
  // release PR opens, and nothing is released.
  assert.match(releaseJobPermissions(), /^ *pull-requests: *write$/m, 'the release job has no pull-requests: write');
});

test('the release job can label the release PR', () => {
  // release-please labels its PR autorelease: pending through the Issues API and finds the
  // merged PR by that label. A merged PR without it is skipped, and nothing is released.
  assert.match(releaseJobPermissions(), /^ *issues: *write$/m, 'the release job has no issues: write');
});

test('no npm token appears anywhere in the workflow', () => {
  // A token here silently undoes the move to trusted publishing. _authToken is the npmrc
  // key token auth is written to, whatever the variable carrying it is called.
  assert.doesNotMatch(workflow(), /NODE_AUTH_TOKEN|NPM_TOKEN|_authToken/i);
});

test('provenance is left to trusted publishing', () => {
  // Trusted publishing generates the provenance attestation by itself. The flag is
  // redundant at best, and the env var set to false turns the attestation off.
  assert.doesNotMatch(workflow(), /--provenance|NPM_CONFIG_PROVENANCE/i);
});

test('every action is pinned to a full commit SHA', () => {
  // A step written as a flow mapping, `- { uses: ... }`, counts as much as a block one.
  const refs = [...workflowCode().matchAll(/(?:^|[{,]) *(?:- +)?uses: *([^\s,}]+)/gm)].map(
    (match) => match[1]!,
  );
  assert.ok(refs.length > 0, 'the workflow uses no actions, so this check proves nothing');
  for (const ref of refs) {
    assert.match(ref, /@[0-9a-f]{40}$/, `${ref} is not pinned to a full commit SHA`);
  }
});

test('no run script interpolates an expression', () => {
  // GitHub pastes an expression's value into the script before the shell parses it, so a
  // value carrying quotes or $(...) runs as code. Values reach a script through env: instead.
  const scripts = runScripts(workflow());
  assert.ok(scripts.length > 0, 'the workflow has no run: scripts, so this check proves nothing');
  for (const script of scripts) {
    const line = script.split('\n').find((text) => text.includes('${{'));
    assert.equal(line, undefined, `a run: script interpolates an expression: ${line?.trim()}`);
  }
});

test('release-please takes its settings from the config files, not action inputs', () => {
  // Given release-type as an input, the action ignores both files: the manifest seed and
  // every extra-files entry drop out without an error.
  assert.doesNotMatch(workflow(), /release-type/);
});

/** The first npm that supports trusted publishing, as [major, minor, patch]. */
const TRUSTED_PUBLISHING_NPM = [11, 5, 1];

test('the npm that publishes is installed at an exact version that supports trusted publishing', () => {
  // The job holds id-token: write, so a floating install is the one unpinned thing in it.
  // Each global install of npm is checked, not just the first, because the last one wins.
  // An npm too old for trusted publishing fails the publish, which runs after the tag exists.
  const specs = [...workflowCode().matchAll(/\bnpm +(?:install|i|add)\b([^\n;&|]*)/g)]
    .map((match) => match[1]!.trim().split(/ +/))
    .filter((args) => args.includes('-g') || args.includes('--global'))
    .flatMap((args) => args.filter((arg) => /^npm(@|$)/.test(arg)));
  assert.ok(specs.length > 0, 'no step installs the npm that trusted publishing needs');
  for (const spec of specs) {
    const version = /^npm@(\d+)\.(\d+)\.(\d+)$/.exec(spec)?.slice(1).map(Number);
    assert.ok(version, `${spec} is not an exact version`);
    // Part by part and as numbers, because as text 11.10.0 sorts before 11.5.1.
    const part = version.findIndex((value, index) => value !== TRUSTED_PUBLISHING_NPM[index]);
    assert.ok(
      part === -1 || version[part]! > TRUSTED_PUBLISHING_NPM[part]!,
      `${spec} is older than npm@${TRUSTED_PUBLISHING_NPM.join('.')}, the first that supports trusted publishing`,
    );
  }
});

test('the workflow file has the exact name the npm trusted publisher is registered with', () => {
  // npm matches the filename exactly and does not validate it when saved, so a rename
  // breaks publishing with no warning. readdir rather than an existence check, because
  // a case-insensitive disk would also find Release.yml.
  assert.ok(
    readdirSync(`${root}.github/workflows`).includes('release.yml'),
    '.github/workflows/release.yml is missing',
  );
});

test('pnpm is set up before npm publish runs prepublishOnly', () => {
  // prepublishOnly is `pnpm test`. Without pnpm on PATH the publish fails after the tag exists.
  const code = workflowCode();
  const setup = code.search(/uses: *pnpm\/setup@/);
  const publish = code.search(/\bnpm publish\b/);
  assert.notEqual(setup, -1, 'the workflow never sets up pnpm');
  assert.notEqual(publish, -1, 'the workflow never runs npm publish');
  assert.ok(setup < publish, 'pnpm/setup runs after npm publish');
});

test('the release job restores no dependency cache', () => {
  // A restored cache is input no one reviewed, in a job holding id-token: write. The pinned
  // setup-node restores one by itself whenever package.json names a packageManager, so the input
  // has to switch it off by name. The one cache pnpm/setup keeps here is its lockfile-verification
  // record, which holds no package. It saves the record right after its frozen install, and its
  // post step tries again at the end of the job only when that save does not go through.
  const steps = releaseJobSteps();
  const nodes = steps.filter((step) => /^ *(?:- +)?uses: *actions\/setup-node@/m.test(step));
  assert.ok(nodes.length > 0, 'the release job never sets up node');
  for (const step of nodes) {
    const inputs = stepInputs(step);
    assert.equal(scalar(inputs, 'package-manager-cache'), 'false', 'setup-node caches the package manager store');
    assert.equal(scalar(inputs, 'cache'), undefined, 'setup-node restores a dependency cache');
  }
  const pnpms = steps.filter(isPnpmSetup);
  assert.ok(pnpms.length > 0, 'the release job never sets up pnpm with pnpm/setup');
  for (const step of pnpms) {
    assert.notEqual(scalar(stepInputs(step), 'cache'), 'true', 'pnpm/setup restores the pnpm store');
  }
});

/**
 * Every pnpm/setup step in every workflow, with the file and the job it runs in. A pnpm/setup step
 * the readers above cannot find, such as one written as a flow mapping, fails the calling test.
 */
const pnpmSetupSteps = (): Array<{ file: string; job: string; step: string }> => {
  const found = workflowFiles().flatMap((file) =>
    workflowJobs(file).flatMap(([job, body]) => jobSteps(body).filter(isPnpmSetup).map((step) => ({ file, job, step }))),
  );
  const written = workflowFiles().reduce((count, file) => count + workflowCode(file).split('pnpm/setup@').length - 1, 0);
  assert.equal(found.length, written, 'a pnpm/setup step is written in a form this test cannot read, such as a flow mapping');
  return found;
};

test('every pnpm/setup step runs a frozen install, and takes the pnpm version and Node from elsewhere', () => {
  // With install and require-lockfile, the action runs `pnpm install --frozen-lockfile` itself and
  // saves its lockfile-verification record right after it. With `install: false` the record is
  // saved only at the end of the job, after the tests. A version input would be a second source
  // for the pnpm version beside packageManager. A runtime input would put a second Node on PATH,
  // ahead of the one setup-node installs.
  const setups = pnpmSetupSteps();
  assert.ok(setups.length > 0, 'no workflow sets up pnpm with pnpm/setup, so this check proves nothing');
  for (const { file, job, step } of setups) {
    const inputs = stepInputs(step);
    const where = `pnpm/setup in the ${job} job of ${file}`;
    assert.equal(scalar(inputs, 'install'), 'true', `${where} does not set install: true`);
    assert.equal(scalar(inputs, 'require-lockfile'), 'true', `${where} does not set require-lockfile: true`);
    assert.equal(scalar(inputs, 'version'), undefined, `${where} sets a pnpm version beside packageManager`);
    assert.equal(scalar(inputs, 'runtime'), undefined, `${where} installs a runtime`);
  }
});

test('only the ci.yml test job caches the pnpm store', () => {
  // pnpm/setup saves the store at the end of the job, after everything the job ran, and restores it
  // in every job that asks. The ci.yml test job can only read the repository and publishes nothing.
  // In the release job a restored store would be input no one reviewed, beside id-token: write.
  const cached = pnpmSetupSteps().flatMap(({ file, job, step }) => {
    const cache = scalar(stepInputs(step), 'cache');
    return cache === undefined ? [] : [`${file} ${job} cache: ${cache}`];
  });
  assert.deepEqual(cached, ['ci.yml test cache: true'], 'pnpm/setup caches the store somewhere other than the ci.yml test job');
});

test('the release job checks out the commit release-please tagged', () => {
  // Without a ref, checkout takes the commit that triggered the run, and that run can be a
  // later push creating the release for an earlier merge. The tests and the publish would
  // then use code the tag does not point at, under a version npm never lets be reused.
  const checkouts = releaseJobSteps().filter(isCheckout);
  assert.ok(checkouts.length > 0, 'the release job never checks out the code it publishes');
  assert.equal(
    checkouts.length,
    releaseJob().split('actions/checkout@').length - 1,
    'a checkout step is written in a form this test cannot read, such as a flow mapping',
  );
  for (const step of checkouts) {
    assert.equal(/^ *ref: *(.*)$/m.exec(step)?.[1], '${{ steps.release.outputs.sha }}');
  }
});

test('only a run triggered at the tagged commit builds and publishes', () => {
  // npm provenance names the commit that triggered the run, whatever is checked out. A run
  // triggered at any other commit would publish under an attestation naming the wrong one,
  // on a version npm never lets be reused, so every step after release-please needs both
  // conditions. The alarm and the merged release PR check below are the only steps exempt.
  const after = stepsAfterReleasePlease();
  assert.ok(after.some((step) => /\bnpm publish\b/.test(step)), 'no step after release-please runs npm publish');
  for (const step of after.filter((step) => !isAlarm(step) && !isReleaseCheck(step))) {
    assert.equal(stepIf(step), PUBLISH_GATE, `${stepName(step)} is not gated on both conditions`);
  }
});

test('a run that cannot publish the release it created fails loudly', () => {
  // Gated out of publishing, such a run would otherwise stay green while the tag exists and
  // npm has nothing for it.
  const alarms = stepsAfterReleasePlease().filter((step) => stepIf(step) === DIVERGED);
  assert.equal(alarms.length, 1, 'expected exactly one step on the diverged condition');
  const alarm = alarms[0]!;
  assert.match(alarm, /::error(?: [^\n]*?)?::/, 'the alarm emits no ::error:: annotation');
  assert.match(alarm, /^ *exit 1$/m, 'the alarm does not exit 1');
  assert.doesNotMatch(alarm, /\bnpm publish\b/, 'the alarm runs npm publish');
  assert.doesNotMatch(alarm, /^ *(?:- +)?uses:/m, 'the alarm runs an action');
});

test('a push run that creates no release checks for a merged release PR left unreleased', () => {
  // release-please moves a release PR from autorelease: pending to autorelease: tagged right after
  // it creates the release. A merged PR still pending was never released, and without this check
  // that run and every run after it end green with nothing tagged or published.
  const check = releaseCheckStep();
  assert.ok(stepsAfterReleasePlease().includes(check), 'the check runs before release-please');
  // The checks below run the script under `bash -e`, as a runner does only while no shell is chosen.
  assertDefaultShell(releaseJob(), check);
  assert.doesNotMatch(check, /^ *(?:- +)?uses:/m, 'the check runs an action');
  assert.equal(scalar(under(stepBody(check), 'env'), 'GH_TOKEN'), '${{ github.token }}', 'gh gets no token from the step env');
  const script = stepScript(check) ?? '';
  assert.match(script, /\bgh +api +graphql\b/, 'the check does not query through gh api graphql');
  // gh pr list --label goes through the search API, and search lags behind a relabel.
  assert.doesNotMatch(script, /\bgh +pr +list\b/, 'the check runs gh pr list');
  assert.doesNotMatch(script, /\bsearch\b/i, 'the check uses search');
});

test('the released output is true only once npm accepted the publish', () => {
  // A job output is a string, so an expression that evaluates to false arrives as 'false',
  // which a bare if: treats as true. The publish step writes released=true after npm publish,
  // and the default bash -e stops the script at a failed publish, so the output is 'true'
  // or empty. The script is pinned whole, because an edit such as `|| true` or `set +e`, or a
  // shell chosen without -e, lets the write follow a failed publish.
  const publishing = releaseJobSteps().filter((step) => /\bnpm publish\b/.test(step));
  assert.equal(publishing.length, 1, 'expected exactly one step that runs npm publish');
  const step = publishing[0]!;
  const id = /^ *(?:- +)?id: *(\S+)$/m.exec(step)?.[1];
  assert.ok(id, 'the npm publish step has no id');
  const released = /^ *released: *(.*)$/m.exec(under(releaseJob(), 'outputs'))?.[1];
  assert.equal(released, `\${{ steps.${id}.outputs.released }}`, 'released does not read the publish step');
  assert.equal(
    stepScript(step),
    'npm publish\necho "released=true" >> "$GITHUB_OUTPUT"',
    'the publish step runs something besides npm publish, then the released=true write',
  );
  assertDefaultShell(releaseJob(), step);
});

test('release runs take turns, and none is cancelled or dropped', () => {
  // A run cancelled between creating the tag and npm publish leaves a version tagged but
  // never published. The default queue holds one waiting run and cancels it when another
  // arrives, which can drop the release PR merge's own run for a later one the gate above
  // stops from publishing.
  const concurrency = under(workflowCode(), 'concurrency');
  assert.match(concurrency, /^ *group: *\S/m, 'the workflow has no concurrency group');
  assert.match(concurrency, /^ *cancel-in-progress: *false$/m, 'cancel-in-progress is not false');
  assert.match(concurrency, /^ *queue: *max$/m, 'queue is not max, so a waiting run can be replaced');
});

test('a release bumps both versions server.json carries', () => {
  // The node release type bumps package.json but not these, and identity.test.ts pins both
  // to it, so without them the first release fails its own gate after tagging. The MCP
  // registry reads packages[0].
  assert.ok(releaseBumps('server.json', '$.version'), 'server.json $.version is not bumped');
  assert.ok(
    releaseBumps('server.json', '$.packages[0].version'),
    'server.json $.packages[0].version is not bumped',
  );
});

test('release tags carry no component, so the v0.2.0 anchor is recognised', () => {
  // The default is true: tags become tibiawiki-mcp-v0.3.0, the v0.2.0 tag stops matching,
  // and the first changelog takes in the entire history.
  assert.equal(rootPackageSetting('include-component-in-tag'), false);
});

test('the workflow can be dispatched by hand with an existing release tag', () => {
  // The recovery path for a failed registry publish runs through this dispatch, and
  // nothing shows its absence until that publish has already failed.
  const inputs = under(under(under(workflowCode(), 'on'), 'workflow_dispatch'), 'inputs');
  assert.match(inputs, /^ *tag:/m, 'workflow_dispatch has no tag input');
});

test('a release bumps the plugin manifest version', () => {
  // identity.test.ts pins this one to package.json's version too, with the same
  // post-tag failure when it is left behind.
  assert.ok(
    releaseBumps('.claude-plugin/plugin.json', '$.version'),
    '.claude-plugin/plugin.json $.version is not bumped',
  );
});

test('a release bumps the package version the plugin runs', () => {
  // .mcp.json starts the server through npx as alias@npm:name@version. A pin left behind
  // runs the previous release under a plugin manifest that names the new one.
  const pin = '$.mcpServers.tibiawiki.args[1]';
  assert.ok(releaseBumps('.mcp.json', pin), `.mcp.json ${pin} is not bumped`);
  // release-please skips a path that selects nothing, a value that is not a string and a
  // string with no version in it, and the release PR stays green.
  const spec = valueAt('.mcp.json', pin);
  assert.ok(typeof spec === 'string', `.mcp.json ${pin} is not a string`);
  // In a string it rewrites the first match of its version pattern, reproduced here with
  // the g flag, so the pin has to be the only match.
  const { name, version } = JSON.parse(read('package.json')) as { name: string; version: string };
  const versions = spec.match(/\d+\.\d+\.\d+(?:-[\w.]+)?(?:\+[-\w.]+)?/g) ?? [];
  assert.deepEqual(versions, [version], `.mcp.json ${pin} must hold one version, the pinned ${version}`);
  assert.equal(spec, `tibiawiki-mcp@npm:${name}@${version}`, `.mcp.json ${pin} is not the pinned package`);
});

test('a dispatched run releases nothing', () => {
  // A dispatch retries the MCP registry publish for a tag npm already has. release-please does
  // not look at the event, so a dispatch that found a merged release PR would release it and
  // publish it to npm, while its registry job published the dispatched tag instead.
  const steps = releaseJobSteps().filter((step) =>
    /^ *(?:- +)?uses: *googleapis\/release-please-action@/m.test(step),
  );
  assert.equal(steps.length, 1, 'expected exactly one release-please step');
  assert.equal(stepIf(steps[0]!), "${{ github.event_name == 'push' }}", 'release-please runs on a dispatch');
});

/** The condition the registry job runs on. */
const REGISTRY_GATE = "${{ needs.release.outputs.released == 'true' || github.event_name == 'workflow_dispatch' }}";

test('the MCP registry publish is a job of its own, run once npm accepted the release', () => {
  // `released` is 'true' or empty, and a red release job skips this one. A dispatch releases
  // nothing, so without the second condition the retry it exists for would be skipped too.
  const registry = registryJob();
  assert.notEqual(registry, '', 'the workflow has no registry job');
  assert.equal(scalar(registry, 'needs'), 'release');
  assert.equal(scalar(registry, 'if'), REGISTRY_GATE);
  assert.doesNotMatch(releaseJob(), /mcp-publisher/, 'the release job runs mcp-publisher');
});

test('only the registry job names the environment that holds the registry key', () => {
  // A job gets an environment's secrets only by naming it, and naming one adds an environment
  // claim to that job's OIDC token. npm's trusted publisher is registered with no environment,
  // so the claim on the release job would break npm publish.
  assert.equal(scalar(registryJob(), 'environment'), 'mcp-registry');
  assert.equal(scalar(releaseJob(), 'environment'), undefined, 'the release job names an environment');
});

test('the registry job can only read the repository', () => {
  // The registry authenticates the job through DNS, so it needs no OIDC token, and nothing it
  // runs has anything to write.
  const permissions = under(registryJob(), 'permissions')
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '');
  assert.deepEqual(permissions, ['contents: read']);
});

test('the registry job publishes the tag its run released, or the tag a dispatch names', () => {
  // A dispatch releases nothing, so its release job has no tag to hand over.
  assert.equal(
    scalar(under(registryJob(), 'env'), 'TAG'),
    "${{ github.event_name == 'workflow_dispatch' && inputs.tag || needs.release.outputs.tag }}",
  );
});

test('the registry job checks the tag before it checks anything out', () => {
  // A dispatch input is free text. Checked first, it can only be a release tag by the time
  // anything is checked out.
  const steps = registryJobSteps();
  const check = steps.findIndex((step) => stepScript(step)?.includes('^v[0-9]+\\.[0-9]+\\.[0-9]+$'));
  assert.notEqual(check, -1, 'no step checks the tag against ^v[0-9]+\\.[0-9]+\\.[0-9]+$');
  const checkout = steps.findIndex(isCheckout);
  assert.notEqual(checkout, -1, 'the registry job checks nothing out');
  assert.ok(check < checkout, 'the tag is checked after the checkout');
  const script = stepScript(steps[check]!)!;
  for (const tag of ['v0.3.0', 'v10.20.300']) {
    assert.equal(bash(script, { TAG: tag }, scratch()).status, 0, `${tag} is rejected`);
  }
  for (const tag of ['', '0.3.0', 'v0.3', 'v0.3.0.1', 'v0.3.0-rc.1', 'v0.3.0\n', 'refs/tags/v0.3.0', 'v0.3.0; true']) {
    assert.notEqual(bash(script, { TAG: tag }, scratch()).status, 0, `${JSON.stringify(tag)} is accepted`);
  }
});

test('the registry job checks out the tag it publishes', () => {
  // Without a ref, a dispatch checks out the tip of main instead. Fully qualified, the ref
  // cannot resolve to a branch that shares the tag's name.
  const checkouts = registryJobSteps().filter(isCheckout);
  assert.equal(checkouts.length, 1, 'expected exactly one checkout in the registry job');
  assert.equal(
    registryJob().split('actions/checkout@').length - 1,
    1,
    'a checkout step is written in a form this test cannot read, such as a flow mapping',
  );
  const inputs = under(stepBody(checkouts[0]!), 'with');
  assert.equal(scalar(inputs, 'ref'), 'refs/tags/${{ env.TAG }}');
  assert.equal(scalar(inputs, 'persist-credentials'), 'false');
});

test("the registry job publishes only a server.json that carries the tag's version", () => {
  // mcp-publisher registers whatever version server.json names, and the registry never takes a
  // version twice. A release commit with a missed bump would register the wrong one for good.
  const steps = registryJobSteps();
  const check = steps.findIndex((step) => /\bserver\.json\b/.test(stepScript(step) ?? ''));
  assert.notEqual(check, -1, 'no step reads server.json');
  const checkout = steps.findIndex(isCheckout);
  assert.ok(checkout !== -1 && checkout < check, 'server.json is read before the tag is checked out');
  const publisher = steps.findIndex((step) => /\bmcp-publisher +(?:login|publish)\b/.test(stepScript(step) ?? ''));
  assert.ok(publisher !== -1 && check < publisher, 'server.json is checked after mcp-publisher runs');
  const script = stepScript(steps[check]!)!;
  const status = (server: unknown): number | null => {
    const dir = scratch();
    writeFileSync(join(dir, 'server.json'), JSON.stringify(server));
    return bash(script, { TAG: 'v1.2.3' }, dir).status;
  };
  const matching = { version: '1.2.3', packages: [{ version: '1.2.3' }] };
  assert.equal(status(matching), 0, 'a server.json that matches the tag fails');
  assert.notEqual(status({ ...matching, version: '1.2.4' }), 0, 'a wrong .version passes');
  assert.notEqual(status({ ...matching, packages: [{ version: '1.2.4' }] }), 0, 'a wrong .packages[0].version passes');
  assert.notEqual(status({ version: '1.2.3' }), 0, 'a server.json with no package passes');
  // Command substitution drops trailing newlines, so a comparison in the shell passes these.
  assert.notEqual(status({ ...matching, version: '1.2.3\n' }), 0, 'a .version with a trailing newline passes');
  assert.notEqual(
    status({ ...matching, packages: [{ version: '1.2.3\n' }] }),
    0,
    'a .packages[0].version with a trailing newline passes',
  );
  const current = bash(script, { TAG: `v${PACKAGE_VERSION}` }, root);
  assert.equal(current.status, 0, `server.json fails for v${PACKAGE_VERSION}: ${current.stdout}${current.stderr}`);
});

test('mcp-publisher is an exact release, checked against a pinned sha256 before it is unpacked', () => {
  // This job holds the registry key. A checksums file fetched from the same release at run time
  // proves nothing the download does not, so the sha256 sits here as a literal.
  const urls = workflowCode().match(/https?:\/\/[^\s"']+/g) ?? [];
  for (const url of urls) assert.doesNotMatch(url, /latest/, `${url} is not an exact release`);
  const release = /https:\/\/github\.com\/modelcontextprotocol\/registry\/releases\/download\/v\d+\.\d+\.\d+\//;
  const lines = registryJob().split('\n');
  const download = lines.findIndex(
    (line) => /\bcurl\b/.test(line) && new RegExp(`${release.source}mcp-publisher_linux_amd64\\.tar\\.gz(?: |$)`).test(line),
  );
  assert.notEqual(download, -1, 'no curl downloads mcp-publisher_linux_amd64.tar.gz from an exact release');
  assert.match(lines[download]!, /\bcurl +-fsSL\b/, 'the download is not curl -fsSL, which fails on an HTTP error');
  const archive = / -o +(\S+)/.exec(lines[download]!)?.[1];
  assert.ok(archive, 'the download names no output file');
  const verify = lines.findIndex((line) => /\b[0-9a-f]{64}\b/.test(line) && line.includes(archive));
  assert.notEqual(verify, -1, `no sha256 literal is paired with ${archive}`);
  assert.match(
    lines[verify]!,
    /\bsha256sum +(?:-c|--check)(?: +-)?$/,
    'the sha256 is not checked by sha256sum -c, or a mismatch is ignored',
  );
  const unpack = lines.findIndex((line) => /(?:^|[;&|]) *tar +/.test(line) && line.includes(archive));
  assert.notEqual(unpack, -1, `nothing unpacks ${archive}`);
  assert.match(lines[unpack]!, /\btar +(?:-?[a-zA-Z]*x[a-zA-Z]*|--extract)\b/, 'the tar command does not extract');
  assert.match(lines[unpack]!, / mcp-publisher$/, 'the unpack takes more than mcp-publisher');
  assert.ok(download < verify && verify < unpack, 'the archive is not verified between its download and its unpacking');
  // The commands `mcp-publisher --help` lists at 1.8.1.
  const runs = lines.flatMap((line, index) =>
    /\bmcp-publisher +(?:init|login|logout|publish|status|validate)\b/.test(line) ? [index] : [],
  );
  assert.ok(runs.length > 0, 'nothing runs mcp-publisher');
  for (const index of runs) {
    assert.ok(index > unpack, `mcp-publisher runs before it is verified: ${lines[index]!.trim()}`);
    // tar unpacks into the working directory. Any other path runs a binary nobody checked.
    assert.match(lines[index]!, /(?:^|[\s;&|])\.\/mcp-publisher +[a-z]/, `not the verified binary: ${lines[index]!.trim()}`);
  }
});

/** The registry job steps that poll npm, found by the endpoint their scripts read. */
const npmWaitSteps = (): string[] =>
  registryJobSteps().filter((step) => (stepScript(step) ?? '').includes('https://registry.npmjs.org/'));

/** The registry job's one step that runs mcp-publisher, which logs in and publishes. */
const registryPublishStep = (): string => {
  const steps = registryJobSteps().filter((step) => /\bmcp-publisher +(?:login|publish)\b/.test(stepScript(step) ?? ''));
  assert.equal(steps.length, 1, 'expected exactly one registry job step that runs mcp-publisher');
  return steps[0]!;
};

/**
 * A stand-in for curl, reading and writing a run's files in $FAKE_RUN. Call N answers with line N
 * of `responses`, and the last line repeats once they run out. `STATUS FILE` is an HTTP response
 * with that body, and `exit CODE` is a transfer that failed with no response, such as a timeout.
 * `STATUS FILE CODE` is a transfer that failed with exit CODE after the body arrived, as curl exits
 * 18 when the connection closes early. It follows real curl where the steps rely on it: with -f an
 * HTTP error fails the call and writes no body, and --write-out still prints the status, or 000 when
 * no response came. Each call's arguments go to `calls`, one call per line, and the call goes to
 * `events` as `curl`. An option it does not know fails the call, so a changed command cannot pass
 * on a guess.
 */
const FAKE_CURL = `#!/usr/bin/env bash
here="$FAKE_RUN"
printf '%s\\n' "$*" >> "$here/calls"
echo curl >> "$here/events"
fail='' output='' format=''
while [ "$#" -gt 0 ]; do
  case "$1" in
    -o | --output) output="$2"; shift ;;
    -w | --write-out) format="$2"; shift ;;
    -m | --max-time) shift ;;
    --fail) fail=1 ;;
    --silent | --show-error | https://*) ;;
    -*[!fsS]*) echo "fake curl: unsupported option $1" >&2; exit 2 ;;
    -*f*) fail=1 ;;
    -*) ;;
    *) echo "fake curl: unexpected argument $1" >&2; exit 2 ;;
  esac
  shift
done
case "$format" in
  '' | '%{http_code}') ;;
  *) echo "fake curl: unsupported write-out $format" >&2; exit 2 ;;
esac
count=0
while IFS= read -r line; do count=$((count + 1)); done < "$here/calls"
n=0
while IFS= read -r line; do
  n=$((n + 1))
  response="$line"
  if [ "$n" -eq "$count" ]; then break; fi
done < "$here/responses"
set -- $response
if [ "$1" = exit ]; then
  echo "curl: ($2) the transfer failed" >&2
  if [ -n "$format" ]; then printf 000; fi
  exit "$2"
fi
if [ -n "$fail" ] && [ "$1" -ge 400 ]; then
  echo "curl: (22) The requested URL returned error: $1" >&2
  if [ -n "$format" ]; then printf '%s' "$1"; fi
  exit 22
fi
if [ -n "$output" ]; then cat "$here/$2" > "$output"; else cat "$here/$2"; fi
if [ -n "$format" ]; then printf '%s' "$1"; fi
if [ -n "$3" ]; then
  echo "curl: ($3) the transfer failed after the body" >&2
  exit "$3"
fi
`;

/**
 * A stand-in for sleep that returns at once, and records what it was asked for in the run's `sleeps`,
 * and as `sleep` and its arguments in the run's `events`.
 */
const FAKE_SLEEP = `#!/usr/bin/env bash
printf '%s\\n' "$*" >> "$FAKE_RUN/sleeps"
printf 'sleep %s\\n' "$*" >> "$FAKE_RUN/events"
`;

/**
 * A stand-in for GNU timeout. It takes only `--kill-after=10 120` and a command, and runs the command
 * with BOUNDED_BY_TIMEOUT set. It exits with the command's status, or with 124 when the fake
 * mcp-publisher hung, as timeout does once it has stopped a command that ran too long. Other
 * arguments fail with 125, timeout's own failure, so a changed bound cannot pass on a guess.
 */
const FAKE_TIMEOUT = `#!/usr/bin/env bash
if [ "$#" -lt 3 ] || [ "$1" != --kill-after=10 ] || [ "$2" != 120 ]; then
  echo "fake timeout: unsupported arguments: $1 $2" >&2
  exit 125
fi
shift 2
BOUNDED_BY_TIMEOUT=1 "$@"
status=$?
if [ -e "$FAKE_RUN/hung" ]; then
  rm "$FAKE_RUN/hung"
  exit 124
fi
exit "$status"
`;

/**
 * A stand-in for mcp-publisher, reading and writing a run's files in $FAKE_RUN. It takes only `login`
 * and `publish`, and runs only under the fake timeout, so a command without its bound fails. Each call
 * goes to `events` as `mcp-publisher` and its arguments. Call N answers with line N of `answers`, and
 * a call with no line fails. `CODE TEXT` prints TEXT and exits CODE, with TEXT on stdout for 0 and on
 * stderr otherwise, as mcp-publisher prints its errors. `hang` is a call that never returns, which the
 * fake timeout stops.
 */
const FAKE_MCP_PUBLISHER = `#!/usr/bin/env bash
here="$FAKE_RUN"
if [ "$BOUNDED_BY_TIMEOUT" != 1 ]; then
  echo "fake mcp-publisher: $1 run without timeout" >&2
  exit 2
fi
case "$1" in
  login | publish) ;;
  *) echo "fake mcp-publisher: unsupported command $1" >&2; exit 2 ;;
esac
printf 'mcp-publisher %s\\n' "$*" >> "$here/events"
count=0
while IFS= read -r line; do
  case "$line" in 'mcp-publisher '*) count=$((count + 1)) ;; esac
done < "$here/events"
n=0
answer=''
while IFS= read -r line; do
  n=$((n + 1))
  if [ "$n" -eq "$count" ]; then answer="$line"; break; fi
done < "$here/answers"
if [ -z "$answer" ]; then
  echo "fake mcp-publisher: no answer for call $count" >&2
  exit 2
fi
if [ "$answer" = hang ]; then
  : > "$here/hung"
  exit 143
fi
code="\${answer%% *}"
if [ "$code" -eq 0 ]; then
  printf '%s\\n' "\${answer#* }"
else
  printf '%s\\n' "\${answer#* }" >&2
fi
exit "$code"
`;

/**
 * A stand-in for gh, reading and writing a run's files in $GH_RUN. It takes only `api graphql` with
 * string fields, given as `-f key=value` or `--raw-field key=value`, and writes each value to
 * `field-KEY`. A changed command, a typed field or a second call fails, so none passes on a guess.
 * It prints `response` and exits with `exit`, as gh prints the body even when it exits 1 for a
 * GraphQL error.
 */
const FAKE_GH = `#!/usr/bin/env bash
here="$GH_RUN"
if [ "$#" -lt 2 ] || [ "$1" != api ] || [ "$2" != graphql ]; then
  echo "fake gh: unsupported command: $*" >&2
  exit 2
fi
shift 2
while [ "$#" -gt 0 ]; do
  case "$1" in
    -f | --raw-field) field="$2"; shift ;;
    *) echo "fake gh: unsupported argument $1" >&2; exit 2 ;;
  esac
  shift
  key="\${field%%=*}"
  case "$key" in
    '' | *[!a-zA-Z]*) echo "fake gh: unsupported field $field" >&2; exit 2 ;;
  esac
  if [ "$key" = "$field" ] || [ -e "$here/field-$key" ]; then
    echo "fake gh: unsupported field $field" >&2
    exit 2
  fi
  printf '%s' "\${field#*=}" > "$here/field-$key"
done
cat "$here/response"
exit "$(cat "$here/exit")"
`;

/**
 * The directory holding the fake curl, sleep, timeout and gh, written once for the file. macOS scans
 * a new executable the first time it runs, which costs a fresh set about 400 ms on every run.
 */
let fakes: string | undefined;
const fakeBin = (): string => {
  if (fakes === undefined) {
    fakes = scratch();
    writeFileSync(join(fakes, 'curl'), FAKE_CURL, { mode: 0o755 });
    writeFileSync(join(fakes, 'sleep'), FAKE_SLEEP, { mode: 0o755 });
    writeFileSync(join(fakes, 'timeout'), FAKE_TIMEOUT, { mode: 0o755 });
    writeFileSync(join(fakes, 'gh'), FAKE_GH, { mode: 0o755 });
  }
  return fakes;
};

/**
 * The fake mcp-publisher, written once like the fakes above but kept off PATH, because the step runs
 * the verified binary as ./mcp-publisher. Each run links to it from its own directory.
 */
let publisher: string | undefined;
const fakePublisher = (): string => {
  if (publisher === undefined) {
    publisher = join(scratch(), 'mcp-publisher');
    writeFileSync(publisher, FAKE_MCP_PUBLISHER, { mode: 0o755 });
  }
  return publisher;
};

/** An HTTP response with a JSON body, whose transfer failed with `curlExit` after the body when one is given. */
type HttpResponse = { status: number; body: unknown; curlExit?: number };

/** One curl call's outcome: an HTTP response, or the curl exit code of a transfer that failed with no response. */
type CurlResponse = HttpResponse | { curlExit: number };

/** Writes `responses` into a run's directory, for the fake curl to answer its calls with in order. */
const writeCurlResponses = (dir: string, responses: CurlResponse[]): void => {
  const lines = responses.map((response, index) => {
    if (!('status' in response)) return `exit ${response.curlExit}`;
    writeFileSync(join(dir, `body-${index}`), JSON.stringify(response.body));
    return `${response.status} body-${index}${response.curlExit === undefined ? '' : ` ${response.curlExit}`}`;
  });
  writeFileSync(join(dir, 'responses'), `${lines.join('\n')}\n`);
};

/** The lines the fakes recorded in `file` of a run's directory, or none when they wrote nothing there. */
const recorded = (dir: string, file: string): string[] =>
  existsSync(join(dir, file)) ? readFileSync(join(dir, file), 'utf8').split('\n').filter((line) => line !== '') : [];

/**
 * Runs the registry job's npm wait for v1.2.3, as the checks above run their scripts, with the
 * fake curl and sleep first on PATH. jq and everything else is real.
 */
const runNpmWait = (responses: CurlResponse[]) => {
  const waits = npmWaitSteps();
  assert.equal(waits.length, 1, 'expected exactly one registry job step that polls npm');
  const dir = scratch();
  writeCurlResponses(dir, responses);
  const env = { TAG: 'v1.2.3', PATH: `${fakeBin()}:${process.env['PATH'] ?? ''}`, FAKE_RUN: dir };
  const run = bash(stepScript(waits[0]!)!, env, dir);
  return {
    status: run.status,
    stdout: run.stdout,
    output: `${run.stdout}${run.stderr}`,
    calls: recorded(dir, 'calls'),
    sleeps: recorded(dir, 'sleeps'),
  };
};

/** npm's manifest for v1.2.3 of the package server.json registers, as the registry reads it. */
const publishedManifest = () => {
  const server = JSON.parse(read('server.json')) as { name: string; packages: { identifier: string }[] };
  return { name: server.packages[0]!.identifier, version: '1.2.3', mcpName: server.name };
};

/** npm's answer for a version it does not serve. */
const NOT_FOUND: CurlResponse = { status: 404, body: 'version not found: 1.2.3' };

test('the registry job waits for npm after it checks the tag and before it logs in', () => {
  // The registry reads the version from npm once, with no retry, and the publish runs after the
  // login. The login's token lasts 5 minutes and the publish never renews it, so a wait between
  // the two could outlast the token. The wait puts TAG in a URL, so the tag is checked first.
  const steps = registryJobSteps();
  const waits = npmWaitSteps();
  assert.equal(waits.length, 1, 'expected exactly one registry job step that polls npm');
  const wait = steps.indexOf(waits[0]!);
  const check = steps.findIndex((step) => stepScript(step)?.includes('^v[0-9]+\\.[0-9]+\\.[0-9]+$'));
  assert.ok(check !== -1 && check < wait, 'npm is polled before the tag is checked');
  const login = steps.indexOf(registryPublishStep());
  assert.ok(wait < login, 'npm is polled after the login, where the wait can outlast its token');
});

test("the npm wait passes once npm serves the tag's version with the server's mcpName", () => {
  const manifest = publishedManifest();
  const served = runNpmWait([{ status: 200, body: manifest }]);
  assert.equal(served.status, 0, served.output);
  assert.equal(served.calls.length, 1, 'a version npm already serves is polled more than once');
  assert.deepEqual(served.sleeps, [], 'a version npm already serves is waited for');
  const late = runNpmWait([NOT_FOUND, NOT_FOUND, { status: 200, body: manifest }]);
  assert.equal(late.status, 0, late.output);
  assert.equal(late.calls.length, 3, 'the wait does not poll until npm serves the version');
  assert.deepEqual(late.sleeps, ['15', '15'], 'the tries are not 15 seconds apart');
  // A failed transfer or a server error only means another try.
  const flaky = runNpmWait([{ curlExit: 28 }, { status: 503, body: 'Service Unavailable' }, { status: 200, body: manifest }]);
  assert.equal(flaky.status, 0, flaky.output);
  assert.equal(flaky.calls.length, 3, 'a failed try ends the wait');
  // Each try reads the URL the registry reads, which Go's url.PathEscape builds: the scope's slash
  // escaped, its @ kept. Each try stops within the registry's own 10 seconds, so no try can
  // stretch the bound.
  const url = `https://registry.npmjs.org/${manifest.name.replace('/', '%2F')}/1.2.3`;
  for (const call of [...served.calls, ...late.calls, ...flaky.calls]) {
    assert.equal(call.split(' ').find((arg) => arg.startsWith('https://')), url, `a try reads another URL: curl ${call}`);
    const seconds = Number(/(?:^| )(?:--max-time|-m) +(\d+)(?: |$)/.exec(call)?.[1]);
    assert.ok(seconds >= 1 && seconds <= 10, `a try is not limited to 10 seconds or less: curl ${call}`);
  }
});

test('the npm wait gives up after 40 tries 15 seconds apart', () => {
  // About 10 minutes, twice the lag npm has shown. The annotation names the version and the
  // section of the runbook that recovers it.
  const missing = runNpmWait([NOT_FOUND]);
  assert.notEqual(missing.status, 0, 'a version npm never serves passes');
  assert.equal(missing.calls.length, 40, 'the wait is not 40 tries');
  assert.deepEqual(missing.sleeps, Array<string>(40).fill('15'), 'the tries are not 15 seconds apart');
  const section = /^::error::.*@1\.2\.3\b.*"([^"]+)" in docs\/RELEASING\.md/m.exec(missing.stdout)?.[1];
  assert.ok(section, `no ::error:: names the version and a section of docs/RELEASING.md: ${missing.output}`);
  assert.ok(read('docs/RELEASING.md').split('\n').includes(`## ${section}`), `docs/RELEASING.md has no section "${section}"`);
});

test('the npm wait passes nothing the registry would reject', () => {
  // The registry needs a 200 whose mcpName is the server's name. A version with another mcpName
  // never passes, however long npm serves it.
  const manifest = publishedManifest();
  const foreign = runNpmWait([{ status: 200, body: { ...manifest, mcpName: 'sh.tibia/another' } }]);
  assert.notEqual(foreign.status, 0, 'a manifest with another mcpName passes');
  assert.match(foreign.stdout, /^::error::/m, `the wait stops with no ::error::: ${foreign.output}`);
  // Each of these is only another try, so the wait passes on the try after it.
  const rejected: Array<[string, CurlResponse]> = [
    ['a manifest for another version', { status: 200, body: { ...manifest, version: '1.2.4' } }],
    ['a status other than 200', { status: 203, body: manifest }],
    ['a body that is not a manifest', { status: 200, body: 'version not found: 1.2.3' }],
  ];
  for (const [what, response] of rejected) {
    const run = runNpmWait([response, { status: 200, body: manifest }]);
    assert.equal(run.status, 0, run.output);
    assert.equal(run.calls.length, 2, `${what} passes`);
  }
});

test("the registry key reaches only the login command, through its step's env", () => {
  // Written into a run script, the key would be pasted into the shell as code. In a step's env it is
  // a variable only the processes of that step see, and the step's script names it only in the login.
  const references = workflowCode().split('\n').filter((line) => /\bsecrets\b/.test(line));
  assert.equal(references.length, 1, `expected one reference to a secret: ${references.join(' |')}`);
  const steps = registryJobSteps().filter((step) => /\bsecrets\b/.test(step));
  assert.equal(steps.length, 1, 'no registry job step references the secret');
  const step = steps[0]!;
  assert.equal(step, registryPublishStep(), 'the secret reaches a step that does not run mcp-publisher');
  assert.match(
    under(stepBody(step), 'env'),
    /^ *MCP_PRIVATE_KEY: *\$\{\{ secrets\.MCP_PRIVATE_KEY \}\}$/m,
    'the secret does not reach the step through its env',
  );
  const elsewhere = workflowCode()
    .split('\n')
    .filter((line) => line.includes('MCP_PRIVATE_KEY') && !step.split('\n').includes(line));
  assert.deepEqual(elsewhere, [], 'a step other than the publish names the key');
  const uses = (stepScript(step) ?? '').split('\n').filter((line) => line.includes('MCP_PRIVATE_KEY'));
  assert.equal(uses.length, 1, `the script names the key more than once: ${uses.length}`);
  assert.ok(
    uses[0]!.includes('./mcp-publisher login dns --domain tibia.sh --private-key "$MCP_PRIVATE_KEY"'),
    'the script passes the key to something besides the login',
  );
});

test('the registry job publishes after it logs in', () => {
  // Without the publish the job goes green and registers nothing.
  const lines = (stepScript(registryPublishStep()) ?? '').split('\n');
  const login = lines.findIndex((line) => /\.\/mcp-publisher login\b/.test(line));
  const publish = lines.filter((line) => /\.\/mcp-publisher publish\b/.test(line));
  assert.equal(publish.length, 1, 'expected exactly one line that runs ./mcp-publisher publish');
  assert.ok(login !== -1 && login < lines.indexOf(publish[0]!), 'the publish runs before the login');
});

test('the registry publish makes at most 3 attempts, and timeout bounds each mcp-publisher command', () => {
  // mcp-publisher has no retry and no timeout of its own, so a hung request would hold the job, and the
  // key with it, until the 6-hour job limit. timeout stops a command after 120 seconds and kills it 10
  // seconds later if it ignores that. 3 attempts of a lookup (10 s), a login and a publish, 30 seconds
  // apart, and a final lookup take at most 880 seconds, inside the step's own 20 minutes.
  const step = registryPublishStep();
  assert.equal(scalar(stepBody(step), 'timeout-minutes'), '20', 'the step does not carry timeout-minutes: 20');
  const lines = (stepScript(step) ?? '').split('\n');
  const loops = lines.filter((line) => /^ *(?:for|while|until)\b/.test(line));
  assert.deepEqual(loops, ['for attempt in 1 2 3; do'], 'the step does not loop over exactly 3 attempts');
  const commands = lines.filter((line) => /\bmcp-publisher\b/.test(line));
  assert.equal(commands.length, 2, `expected one login and one publish: ${commands.join(' |')}`);
  for (const command of commands) {
    assert.match(
      command,
      /(?:^|[\s(])timeout --kill-after=10 120 \.\/mcp-publisher (?:login|publish)\b/,
      `not bounded by timeout --kill-after=10 120: ${command.trim()}`,
    );
  }
});

test('the registry publish looks the version up in each attempt and once more at the end', () => {
  // The lookup reads the registry's entry for the tag's version, and a 404 or a failed lookup goes on to
  // the login. mcp-publisher 1.8.1 rejects a duplicate with `invalid version: cannot publish duplicate
  // version`, and the registry's main branch appends the name and version, so the check matches the
  // substring. After the loop come only the final lookup, the error and exit 1. A command chained onto
  // the loop, such as `|| true`, turns off -e for every command inside it, and a pipe runs the loop in a
  // subshell, where exit 0 does not end the step.
  const lines = (stepScript(registryPublishStep()) ?? '').split('\n');
  const start = lines.indexOf('registered() {');
  assert.notEqual(start, -1, 'the script defines no registered() lookup');
  const lookup = lines.slice(start + 1, lines.indexOf('}', start)).join('\n');
  assert.ok(
    lookup.includes('curl -fsS --max-time 10 "https://registry.modelcontextprotocol.io/v0.1/servers/sh.tibia%2Ftibiawiki-mcp/versions/$version" |'),
    `registered() does not read the version's registry entry: ${lookup}`,
  );
  assert.ok(
    lookup.includes(`jq -e --arg version "$version" '.server.version == $version' > /dev/null`),
    `registered() does not check that the entry's .server.version is the version: ${lookup}`,
  );
  assert.ok(
    lines.some((line) => line.includes('"cannot publish duplicate version"')),
    'the script does not check the publish output for cannot publish duplicate version',
  );
  const end = lines.indexOf('done');
  assert.notEqual(end, -1, 'the attempts do not end on a line of their own');
  assert.match(
    lines.slice(end + 1).join('\n'),
    /^if registered; then\n +exit 0\nfi\necho "::error::[^\n]*"\nexit 1$/,
    'after its attempts the step does more than one final lookup, the error and exit 1',
  );
});

/** The key the registry publish runs with in these checks. No fake needs a real one. */
const REGISTRY_KEY = 'fake-registry-key';

/** An mcp-publisher call that returns: its exit code and the line it prints. */
type PublisherReply = { code: number; text: string };

/** One mcp-publisher call's answer: a reply, or a call that hangs until timeout stops it. */
type PublisherAnswer = PublisherReply | 'hang';

/**
 * Runs the registry job's publish step for v1.2.3, as the checks above run their scripts, with the fake
 * curl, sleep and timeout first on PATH and the fake mcp-publisher linked as ./mcp-publisher. jq and
 * everything else is real. `lookups` answer the step's curl calls in order, and `answers` its
 * mcp-publisher calls. The step holds the key in its env, so any command that prints it, such as an
 * environment dump or a trace, fails every run.
 */
const runRegistryPublish = (lookups: CurlResponse[], answers: PublisherAnswer[]) => {
  const dir = scratch();
  writeCurlResponses(dir, lookups);
  const lines = answers.map((answer) => (answer === 'hang' ? 'hang\n' : `${answer.code} ${answer.text}\n`));
  writeFileSync(join(dir, 'answers'), lines.join(''));
  symlinkSync(fakePublisher(), join(dir, 'mcp-publisher'));
  const env = {
    TAG: 'v1.2.3',
    MCP_PRIVATE_KEY: REGISTRY_KEY,
    PATH: `${fakeBin()}:${process.env['PATH'] ?? ''}`,
    FAKE_RUN: dir,
  };
  const run = bash(stepScript(registryPublishStep())!, env, dir);
  assert.ok(!`${run.stdout}${run.stderr}`.includes(REGISTRY_KEY), 'the publish step printed the registry key');
  return {
    status: run.status,
    stdout: run.stdout,
    output: `${run.stdout}${run.stderr}`,
    errors: run.stdout.split('\n').filter((line) => line.startsWith('::error::')),
    events: recorded(dir, 'events'),
    lookups: recorded(dir, 'calls'),
  };
};

/** What the fakes record for each command the publish step runs. */
const LOOKUP = 'curl';
const LOGIN = `mcp-publisher login dns --domain tibia.sh --private-key ${REGISTRY_KEY}`;
const PUBLISH = 'mcp-publisher publish';
const PAUSE = 'sleep 30';

/**
 * The registry's answer to the lookup of a version it has: server.json at that version, with the
 * registry's own metadata, as the registry answered for 0.3.1.
 */
const registryEntry = (version = '1.2.3'): HttpResponse => {
  const server = JSON.parse(read('server.json')) as { packages: Array<Record<string, unknown>> };
  const at = '2026-09-13T17:02:58.553533Z';
  return {
    status: 200,
    body: {
      server: { ...server, version, packages: server.packages.map((entry) => ({ ...entry, version })) },
      _meta: {
        'io.modelcontextprotocol.registry/official': {
          status: 'active',
          statusChangedAt: at,
          publishedAt: at,
          updatedAt: at,
          isLatest: true,
        },
      },
    },
  };
};

/** The registry's answer to the lookup of a version it does not have. */
const UNREGISTERED: CurlResponse = { status: 404, body: { title: 'Not Found', status: 404, detail: 'Server not found' } };

/** mcp-publisher 1.8.1's replies, as it prints them. */
const LOGGED_IN: PublisherReply = { code: 0, text: '✓ Successfully logged in' };
const PUBLISHED: PublisherReply = { code: 0, text: '✓ Successfully published' };
const LOGIN_UNREACHABLE: PublisherReply = {
  code: 1,
  text: 'Error: failed to get token: failed to exchange dns signature: failed to send request: Post "https://registry.modelcontextprotocol.io/v0/auth/dns": dial tcp 34.61.200.254:443: i/o timeout',
};
const PUBLISH_UNREACHABLE: PublisherReply = {
  code: 1,
  text: 'Error: publish failed: error sending request: Post "https://registry.modelcontextprotocol.io/v0/publish": dial tcp 34.61.200.254:443: i/o timeout',
};
const REGISTRY_FAILED: PublisherReply = { code: 1, text: 'Error: publish failed: server returned status 503: Service Unavailable' };
const DUPLICATE: PublisherReply = {
  code: 1,
  text: 'Error: publish failed: server returned status 400: {"title":"Bad Request","status":400,"detail":"Failed to publish server","errors":[{"message":"invalid version: cannot publish duplicate version"}]}',
};

test('the registry publish logs in and publishes once when its first attempt succeeds', () => {
  const run = runRegistryPublish([UNREGISTERED], [LOGGED_IN, PUBLISHED]);
  assert.equal(run.status, 0, run.output);
  assert.deepEqual(run.events, [LOOKUP, LOGIN, PUBLISH]);
  assert.ok(run.stdout.includes(PUBLISHED.text), `the publish output is not echoed: ${run.output}`);
});

test('the registry publish tries again 30 seconds after a failure on the network', () => {
  const run = runRegistryPublish(
    [{ curlExit: 28 }, UNREGISTERED],
    [LOGIN_UNREACHABLE, LOGGED_IN, PUBLISH_UNREACHABLE, LOGGED_IN, PUBLISHED],
  );
  assert.equal(run.status, 0, run.output);
  assert.deepEqual(run.events, [LOOKUP, LOGIN, PAUSE, LOOKUP, LOGIN, PUBLISH, PAUSE, LOOKUP, LOGIN, PUBLISH]);
});

test('the registry publish fails after 3 attempts and a final lookup, and names the last failure', () => {
  // The login fails, then the publish, then the third attempt's login hangs until timeout stops it with
  // 124. The annotation names the version, that last failure and the runbook section.
  const run = runRegistryPublish([UNREGISTERED], [LOGIN_UNREACHABLE, LOGGED_IN, REGISTRY_FAILED, 'hang']);
  assert.equal(run.status, 1, run.output);
  assert.deepEqual(run.events, [LOOKUP, LOGIN, PAUSE, LOOKUP, LOGIN, PUBLISH, PAUSE, LOOKUP, LOGIN, LOOKUP]);
  // A command that timeout stops prints nothing itself, so the log says what failed in each attempt.
  assert.deepEqual(
    run.stdout.split('\n').filter((line) => line.startsWith('In attempt ')),
    ['In attempt 1, the login exited 1.', 'In attempt 2, the publish exited 1.', 'In attempt 3, the login exited 124.'],
    `the log does not say what failed in each attempt: ${run.output}`,
  );
  assert.equal(run.errors.length, 1, `expected exactly one ::error::: ${run.output}`);
  const error = run.errors[0]!;
  assert.match(error, /@1\.2\.3\b/, `the error does not name the version: ${error}`);
  assert.match(error, /\blogin\b[^.]*\b124\b/, `the error does not name the last failure: ${error}`);
  const section = /"([^"]+)" in docs\/RELEASING\.md/.exec(error)?.[1];
  assert.ok(section, `the error names no section of docs/RELEASING.md: ${error}`);
  assert.ok(read('docs/RELEASING.md').split('\n').includes(`## ${section}`), `docs/RELEASING.md has no section "${section}"`);
  // Each lookup reads the registry's entry for the version, with the slash in the server's name escaped,
  // and stops within 10 seconds.
  const { name } = JSON.parse(read('server.json')) as { name: string };
  const url = `https://registry.modelcontextprotocol.io/v0.1/servers/${encodeURIComponent(name)}/versions/1.2.3`;
  for (const call of run.lookups) {
    assert.equal(call.split(' ').find((arg) => arg.startsWith('https://')), url, `a lookup reads another URL: curl ${call}`);
    assert.match(call, /(?:^| )--max-time 10(?: |$)/, `a lookup is not limited to 10 seconds: curl ${call}`);
  }
});

test('the registry publish stops at a lookup that finds the version after a failed publish', () => {
  // A publish that timeout stopped can still have registered the version.
  const run = runRegistryPublish([UNREGISTERED, registryEntry()], [LOGGED_IN, 'hang']);
  assert.equal(run.status, 0, run.output);
  assert.deepEqual(run.events, [LOOKUP, LOGIN, PUBLISH, PAUSE, LOOKUP]);
});

test('the registry publish neither logs in nor publishes when the registry already has the version', () => {
  const run = runRegistryPublish([registryEntry()], []);
  assert.equal(run.status, 0, run.output);
  assert.deepEqual(run.events, [LOOKUP]);
});

test('a login that timeout stops fails its attempt', () => {
  const run = runRegistryPublish([UNREGISTERED], ['hang', LOGGED_IN, PUBLISHED]);
  assert.equal(run.status, 0, run.output);
  assert.deepEqual(run.events, [LOOKUP, LOGIN, PAUSE, LOOKUP, LOGIN, PUBLISH]);
});

test('a publish rejected as a duplicate ends the registry publish green, even when the lookups fail', () => {
  const run = runRegistryPublish([{ curlExit: 7 }], [LOGGED_IN, DUPLICATE]);
  assert.equal(run.status, 0, run.output);
  assert.deepEqual(run.events, [LOOKUP, LOGIN, PUBLISH]);
  assert.ok(run.stdout.includes(DUPLICATE.text), `the publish error is not echoed: ${run.output}`);
});

test('the final lookup passes a version the registry has after the third failed attempt', () => {
  const run = runRegistryPublish(
    [UNREGISTERED, UNREGISTERED, UNREGISTERED, registryEntry()],
    [LOGGED_IN, 'hang', LOGGED_IN, 'hang', LOGGED_IN, 'hang'],
  );
  assert.equal(run.status, 0, run.output);
  assert.deepEqual(run.events, [LOOKUP, LOGIN, PUBLISH, PAUSE, LOOKUP, LOGIN, PUBLISH, PAUSE, LOOKUP, LOGIN, PUBLISH, LOOKUP]);
  assert.deepEqual(run.errors, [], `a registered version ends with an error: ${run.output}`);
});

test("the registry publish skips the login only for a lookup that fully returns the tag's version", () => {
  // A lookup error goes on to the login even after the entry arrived, as when the connection closes
  // before the transfer ends.
  const misses: Array<[string, CurlResponse]> = [
    ['an entry for another version', registryEntry('1.2.4')],
    ['a body that is not an entry', { status: 200, body: 'Server not found' }],
    ['a server error', { status: 503, body: 'Service Unavailable' }],
    ['an entry whose transfer then failed', { ...registryEntry(), curlExit: 18 }],
  ];
  for (const [what, response] of misses) {
    const run = runRegistryPublish([response], [LOGGED_IN, PUBLISHED]);
    assert.equal(run.status, 0, run.output);
    assert.deepEqual(run.events, [LOOKUP, LOGIN, PUBLISH], `${what} counts as registered`);
  }
});

test('every registry job step runs, and any failure stops the job', () => {
  // A check skipped by its own `if:`, or a failure let through by a shell without -e or `set +e`,
  // lets the job publish past a check that did not hold. So would `continue-on-error`, which the
  // next test rules out for every job and step. The checks above run each script under `bash -e`
  // for the same reason.
  const registry = registryJob();
  for (const step of registryJobSteps()) {
    assert.equal(stepIf(step), undefined, `${stepName(step)} sets if`);
    assertDefaultShell(registry, step);
    assert.doesNotMatch(stepScript(step) ?? '', /\bset +\+[a-z]*e|\bset +\+o +errexit\b/, `${stepName(step)} turns off -e`);
  }
});

test('no job or step lets its own failure through', () => {
  // continue-on-error turns a failed step or job green. On the publish step, a failed npm publish
  // still stops the script before released=true, so the registry job is skipped, but the release
  // job ends green while the tag exists and npm has nothing, and the merged release PR check does
  // not run, because release_created is set. Anywhere else it lets a run end green past a failure,
  // or lets the registry job publish past a check that did not hold.
  const jobs = workflowJobs();
  assert.ok(jobs.length > 0, 'the workflow has no jobs, so this check proves nothing');
  for (const [name, job] of jobs) {
    assert.equal(scalar(job, 'continue-on-error'), undefined, `the ${name} job lets its own failure through`);
    for (const step of jobSteps(job)) {
      assert.equal(scalar(stepBody(step), 'continue-on-error'), undefined, `${stepName(step)} lets its own failure through`);
    }
  }
});

test('no step traces the commands it runs', () => {
  // A trace prints each command with its variables expanded, and the login command carries the key.
  assert.doesNotMatch(workflowCode(), /\bset +-[a-z]*x|\bxtrace\b|\bbash +-[a-z]*x/);
});

/**
 * The query the merged release PR check must send: the merged pull requests that still carry
 * release-please's pending label, read from the repository itself rather than through search.
 */
const RELEASE_CHECK_QUERY =
  'query($owner: String!, $name: String!) { repository(owner: $owner, name: $name) { pullRequests(states: MERGED, labels: ["autorelease: pending"], first: 100) { totalCount nodes { number } } } }';

/** GitHub's answer to that query when the given pull requests are merged and still pending. */
const pendingPullRequests = (...numbers: number[]): string =>
  JSON.stringify({
    data: { repository: { pullRequests: { totalCount: numbers.length, nodes: numbers.map((number) => ({ number })) } } },
  });

/**
 * Runs the merged release PR check as a push run of octo-org/octo-repo, with the fake gh first on
 * PATH answering `response` and exiting with `exit`. jq and everything else is real.
 */
const runReleaseCheck = (response: string, exit = 0) => {
  const dir = scratch();
  writeFileSync(join(dir, 'response'), response);
  writeFileSync(join(dir, 'exit'), `${exit}\n`);
  const env = { GITHUB_REPOSITORY: 'octo-org/octo-repo', PATH: `${fakeBin()}:${process.env['PATH'] ?? ''}`, GH_RUN: dir };
  const run = bash(stepScript(releaseCheckStep())!, env, dir);
  const fields = Object.fromEntries(
    readdirSync(dir)
      .filter((file) => file.startsWith('field-'))
      .map((file) => [file.slice('field-'.length), readFileSync(join(dir, file), 'utf8')]),
  );
  return {
    status: run.status,
    output: `${run.stdout}${run.stderr}`,
    errors: run.stdout.split('\n').filter((line) => line.startsWith('::error::')),
    fields,
  };
};

test('the merged release PR check passes when no merged PR still carries autorelease: pending', () => {
  // The job checks nothing out unless it releases, so gh has no repository to infer. The run's own
  // repository reaches the query as its variables.
  const run = runReleaseCheck(pendingPullRequests());
  assert.equal(run.status, 0, run.output);
  assert.deepEqual(run.fields, { query: RELEASE_CHECK_QUERY, owner: 'octo-org', name: 'octo-repo' });
});

test('the merged release PR check fails and names every merged PR still carrying autorelease: pending', () => {
  // The one annotation names the PRs and the section of the runbook that recovers them.
  for (const numbers of [[8], [8, 12]]) {
    const run = runReleaseCheck(pendingPullRequests(...numbers));
    assert.equal(run.status, 1, run.output);
    assert.equal(run.errors.length, 1, `expected exactly one ::error::: ${run.output}`);
    const error = run.errors[0]!;
    for (const number of numbers) assert.match(error, new RegExp(`#${number}\\b`), `the error does not name #${number}`);
    const section = /"([^"]+)" in docs\/RELEASING\.md/.exec(error)?.[1];
    assert.ok(section, `the error names no section of docs/RELEASING.md: ${error}`);
    assert.ok(read('docs/RELEASING.md').split('\n').includes(`## ${section}`), `docs/RELEASING.md has no section "${section}"`);
  }
});

test('the merged release PR check fails closed on an answer it cannot read', () => {
  // A check that passed without a readable answer would turn the stall green again.
  const passing = JSON.parse(pendingPullRequests()) as Record<string, unknown>;
  const unreadable: Array<[string, string, number]> = [
    // gh exits 1 on a GraphQL error even though it prints the body.
    ['gh exiting non-zero', pendingPullRequests(), 1],
    ['no output', '', 0],
    ['output that is not JSON', 'Service Unavailable', 0],
    // jq reads every document in its input, and the last one would decide.
    ['a second JSON document', `${pendingPullRequests(8)}\n${pendingPullRequests()}`, 0],
    ['no repository', JSON.stringify({ data: {} }), 0],
    ['a null repository', JSON.stringify({ data: { repository: null } }), 0],
    ['no totalCount', JSON.stringify({ data: { repository: { pullRequests: { nodes: [] } } } }), 0],
    ['a totalCount that is not a number', JSON.stringify({ data: { repository: { pullRequests: { totalCount: '0', nodes: [] } } } }), 0],
    ['GraphQL errors', JSON.stringify({ ...passing, errors: [{ message: 'Something went wrong while executing your query.' }] }), 0],
  ];
  for (const [what, response, exit] of unreadable) {
    const run = runReleaseCheck(response, exit);
    assert.equal(run.status, 1, `${what} does not fail the check with exit 1: ${run.output}`);
    assert.equal(run.errors.length, 1, `${what} fails without exactly one ::error::: ${run.output}`);
    // Such a failure says nothing about the release PRs, so it must not send you to the stall's recovery.
    assert.doesNotMatch(run.errors[0]!, / in docs\/RELEASING\.md/, `${what} is reported as a PR left unreleased: ${run.output}`);
  }
});
