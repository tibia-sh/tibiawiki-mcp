import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
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

/**
 * The direct children of `yaml`, each key with its value as `scalar` reads it: a mapping such as a job's
 * `outputs:` or `permissions:`, or a step's `env:` or `with:`. A child written in a form the pattern does
 * not read, or a key written twice, fails the calling test, so a comparison of the whole mapping cannot
 * pass on an entry it missed.
 */
const mappingOf = (yaml: string): Record<string, string> => {
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

const pleaseJob = (): string => under(under(workflowCode(), 'jobs'), 'please');

const releaseJob = (): string => under(under(workflowCode(), 'jobs'), 'release');

const registryJob = (): string => under(under(workflowCode(), 'jobs'), 'registry');

const hostingJob = (): string => under(under(workflowCode(), 'jobs'), 'hosting');

/** Every job in a workflow's code, as its name and the lines nested under its key. */
const jobsIn = (code: string): Array<[string, string]> => {
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
const workflowJobs = (file = 'release.yml'): Array<[string, string]> => jobsIn(workflowCode(file));

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

/** The please job's steps, one string per list item. */
const pleaseJobSteps = (): string[] => jobSteps(pleaseJob());

/** The release job's steps, one string per list item. */
const releaseJobSteps = (): string[] => jobSteps(releaseJob());

/** The registry job's steps, one string per list item. */
const registryJobSteps = (): string[] => jobSteps(registryJob());

/** The hosting job's steps, one string per list item. */
const hostingJobSteps = (): string[] => jobSteps(hostingJob());

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

const isReleasePlease = (step: string): boolean => /^ *(?:- +)?uses: *googleapis\/release-please-action@/m.test(step);

const isAppToken = (step: string): boolean => /^ *(?:- +)?uses: *actions\/create-github-app-token@/m.test(step);

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

/**
 * The condition every building and publishing step carries. A job output is a string, and
 * release-please sets release_created to 'true' or not at all, so it is compared with 'true'.
 */
const PUBLISH_GATE = "${{ needs.please.outputs.release_created == 'true' && needs.please.outputs.sha == github.sha }}";

/** Its opposite: a release was created, but this run was triggered at another commit. */
const DIVERGED = "${{ needs.please.outputs.release_created == 'true' && needs.please.outputs.sha != github.sha }}";

/** The step that fails a diverged run: on the diverged condition, with no publish and no action. */
const isAlarm = (step: string): boolean =>
  stepIf(step) === DIVERGED && !/\bnpm publish\b/.test(step) && !/^ *(?:- +)?uses:/m.test(step);

/** A push run that created no release, the only run that can leave a merged release PR unreleased. */
const UNRELEASED = "${{ github.event_name == 'push' && needs.please.outputs.release_created != 'true' }}";

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

/** The action that mints a token of the tibia-sh App, pinned to the commit of its v3.2.0 tag. */
const APP_TOKEN_ACTION = 'actions/create-github-app-token@bcd2ba49218906704ab6c1aa796996da409d3eb1';

/** The inputs that name the App to every token step: its client ID and key, and the organization. */
const APP = {
  'client-id': '${{ vars.TIBIA_SH_APP_CLIENT_ID }}',
  'private-key': '${{ secrets.TIBIA_SH_APP_PRIVATE_KEY }}',
  owner: 'tibia-sh',
};

/** What release-please's token may do: this repository alone, and the three grants it writes with. */
const PLEASE_TOKEN_INPUTS = {
  ...APP,
  repositories: 'tibiawiki-mcp',
  'permission-contents': 'write',
  'permission-pull-requests': 'write',
  'permission-issues': 'write',
};

/** What the hosting dispatch's token may do: the hosting repository alone, and a repository_dispatch. */
const HOSTING_TOKEN_INPUTS = { ...APP, repositories: 'mcp.tibia.sh', 'permission-contents': 'write' };

/** A job's one step that mints the App token. `name` names the job in a failure. */
const appTokenStep = (job: string, name: string): string => {
  const steps = jobSteps(job).filter(isAppToken);
  assert.equal(steps.length, 1, `expected exactly one step of the ${name} job that mints the App token`);
  assert.equal(
    job.split('create-github-app-token@').length - 1,
    1,
    `a token step of the ${name} job is written in a form this test cannot read, such as a flow mapping`,
  );
  return steps[0]!;
};

/** The token step's inputs. */
const pleaseTokenInputs = (): Record<string, string> => mappingOf(stepInputs(appTokenStep(pleaseJob(), 'please')));

test("release-please's token can create the release", () => {
  // release-please commits the release PR's changes to its branch, and creates the GitHub release
  // and with it the tag. Both write the repository's contents, so without this grant nothing is
  // released.
  assert.equal(pleaseTokenInputs()['permission-contents'], 'write', 'the token has no contents: write');
});

test("release-please's token can open the release PR", () => {
  // release-please opens the release PR and updates it as commits land, and the please job turns on
  // its auto-merge. Without this grant no release PR opens, and nothing is released.
  assert.equal(pleaseTokenInputs()['permission-pull-requests'], 'write', 'the token has no pull-requests: write');
});

test("release-please's token can label the release PR", () => {
  // release-please labels its PR autorelease: pending through the Issues API and finds the
  // merged PR by that label. A merged PR without it is skipped, and nothing is released.
  assert.equal(pleaseTokenInputs()['permission-issues'], 'write', 'the token has no issues: write');
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
  // A step written as a flow mapping, `- { uses: ... }`, counts as much as a block one. Every
  // workflow counts, and release.yml has to use some, so the check cannot pass on nothing.
  const refs = workflowFiles().flatMap((file) =>
    [...workflowCode(file).matchAll(/(?:^|[{,]) *(?:- +)?uses: *([^\s,}]+)/gm)].map((match) => `${file} ${match[1]!}`),
  );
  assert.ok(refs.some((ref) => ref.startsWith('release.yml ')), 'release.yml uses no actions, so this check proves nothing');
  for (const ref of refs) {
    assert.match(ref, /@[0-9a-f]{40}$/, `${ref} is not pinned to a full commit SHA`);
  }
});

test('no run script interpolates an expression', () => {
  // GitHub pastes an expression's value into the script before the shell parses it, so a
  // value carrying quotes or $(...) runs as code. Values reach a script through env: instead.
  // That holds for a job output such as release-please's pr, and for alert.yml's event fields.
  for (const file of workflowFiles()) {
    const scripts = runScripts(workflow(file));
    assert.ok(scripts.length > 0, `${file} has no run: scripts, so this check proves nothing`);
    for (const script of scripts) {
      const line = script.split('\n').find((text) => text.includes('${{'));
      assert.equal(line, undefined, `a run: script of ${file} interpolates an expression: ${line?.trim()}`);
    }
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
  // Without a runtime input, pnpm/setup installs every runtime package.json declares in
  // devEngines.runtime, so a runtime declared there lands on PATH ahead of setup-node's Node too.
  const manifest = JSON.parse(read('package.json')) as { devEngines?: { runtime?: unknown } };
  assert.equal(manifest.devEngines?.runtime, undefined,
    'package.json declares devEngines.runtime, which pnpm/setup installs ahead of setup-node');
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
    assert.equal(/^ *ref: *(.*)$/m.exec(step)?.[1], '${{ needs.please.outputs.sha }}');
  }
});

test('only a run triggered at the tagged commit builds and publishes', () => {
  // npm provenance names the commit that triggered the run, whatever is checked out. A run
  // triggered at any other commit would publish under an attestation naming the wrong one,
  // on a version npm never lets be reused, so every step of the release job needs both
  // conditions. The alarm and the merged release PR check below are the only steps exempt.
  const steps = releaseJobSteps();
  assert.ok(steps.some((step) => /\bnpm publish\b/.test(step)), 'no step of the release job runs npm publish');
  for (const step of steps.filter((step) => !isAlarm(step) && !isReleaseCheck(step))) {
    assert.equal(stepIf(step), PUBLISH_GATE, `${stepName(step)} is not gated on both conditions`);
  }
});

test('a run that cannot publish the release it created fails loudly', () => {
  // Gated out of publishing, such a run would otherwise stay green while the tag exists and
  // npm has nothing for it.
  const alarms = releaseJobSteps().filter((step) => stepIf(step) === DIVERGED);
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
  // The release job waits for the please job, so the check reads the labels release-please left.
  const check = releaseCheckStep();
  assert.equal(scalar(releaseJob(), 'needs'), 'please', 'the check does not wait for release-please');
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

test('a release bumps the tag the marketplace installs the plugin from', () => {
  // A ref left behind keeps every new install on the previous release.
  const ref = '$.plugins[0].source.ref';
  assert.ok(releaseBumps('.claude-plugin/marketplace.json', ref), `.claude-plugin/marketplace.json ${ref} is not bumped`);
  // Another plugin from this repository, listed first, would sit at the same tag, and the release
  // would bump its ref instead.
  const name = valueAt('.claude-plugin/plugin.json', '$.name');
  assert.equal(
    valueAt('.claude-plugin/marketplace.json', '$.plugins[0].name'),
    name,
    `.claude-plugin/marketplace.json $.plugins[0] is not the ${name} plugin`,
  );
  // release-please rewrites the version inside the string the path selects, so the v in front of it
  // stays. A path that selects nothing or another value leaves the tag behind, and the release PR
  // stays green.
  assert.equal(
    valueAt('.claude-plugin/marketplace.json', ref),
    `v${PACKAGE_VERSION}`,
    `.claude-plugin/marketplace.json ${ref} is not the tag of the current release, v${PACKAGE_VERSION}`,
  );
});

/** The condition every step of the please job carries, alone or first: a push, never a dispatch. */
const ON_PUSH = "${{ github.event_name == 'push' }}";

test('a dispatched run releases nothing', () => {
  // A dispatch retries the MCP registry publish for a tag npm already has. release-please does
  // not look at the event, so a dispatch that found a merged release PR would release it and
  // publish it to npm, while its registry job published the dispatched tag instead. The gate sits
  // on the steps, not on the job, because a skipped please job would skip the jobs after it, the
  // registry job among them. A dispatch mints no App token either.
  const steps = pleaseJobSteps().filter(isReleasePlease);
  assert.equal(steps.length, 1, 'expected exactly one release-please step');
  assert.equal(stepIf(steps[0]!), ON_PUSH, 'release-please runs on a dispatch');
  assert.equal(stepIf(appTokenStep(pleaseJob(), 'please')), ON_PUSH, 'the App token is minted on a dispatch');
  assert.equal(workflowCode().split('release-please-action@').length - 1, 1, 'a release-please step sits outside the please job');
});

/** What the please job hands on: release-please's release, and the release PR whose auto-merge it turned on. */
const PLEASE_OUTPUTS = {
  release_created: '${{ steps.release.outputs.release_created }}',
  tag: '${{ steps.release.outputs.tag_name }}',
  sha: '${{ steps.release.outputs.sha }}',
  pr_number: '${{ steps.merge.outputs.pr_number }}',
};

/** release-please as the please job runs it: with the App token, and its settings from the config files. */
const RELEASE_PLEASE_INPUTS = {
  token: '${{ steps.token.outputs.token }}',
  'config-file': 'release-please-config.json',
  'manifest-file': '.release-please-manifest.json',
};

/** The please job's step that turns on the release PR's auto-merge, found by its name. */
const autoMergeStep = (): string => {
  const steps = pleaseJobSteps().filter((step) => scalar(stepBody(step), 'name') === 'Turn on auto-merge for the release PR');
  assert.equal(steps.length, 1, 'expected exactly one please job step named Turn on auto-merge for the release PR');
  return steps[0]!;
};

test('release-please runs as the App in its own job, which checks nothing out that runs', () => {
  // A release PR opened with GITHUB_TOKEN starts no CI, and one opened as the App does, so it can
  // merge itself. Every job that mints the App's token runs in the release-trigger environment, and
  // naming that environment in the publishing job would put an environment claim in its OIDC token,
  // which npm's trusted publisher rejects, so release-please runs in a job of its own. That job runs nothing from
  // the repository or a dependency: no checkout, no setup, no cache, only the token action,
  // release-please and gh. Its GITHUB_TOKEN can do nothing, and it has no job-level if, so a
  // dispatch runs it and the jobs after it.
  const please = pleaseJob();
  assert.notEqual(please, '', 'the workflow has no please job');
  assert.equal(scalar(please, 'runs-on'), 'ubuntu-latest');
  assert.equal(scalar(please, 'environment'), 'release-trigger');
  assert.equal(scalar(please, 'permissions'), '{}', 'the please job grants its GITHUB_TOKEN something');
  assert.equal(scalar(please, 'if'), undefined, 'the please job has a job-level if');
  assert.equal(scalar(please, 'needs'), undefined, 'the please job waits for another job');
  assert.deepEqual(mappingOf(under(please, 'outputs')), PLEASE_OUTPUTS);
  const steps = pleaseJobSteps();
  assert.equal(steps.length, 3, 'expected the token step, release-please and the auto-merge step');
  const [token, release, merge] = steps as [string, string, string];
  assert.equal(please.split('uses:').length - 1, 2, 'the please job runs an action besides the token action and release-please');
  assert.equal(token, appTokenStep(please, 'please'), 'the token is not minted first');
  assert.equal(scalar(stepBody(token), 'uses'), APP_TOKEN_ACTION);
  assert.equal(scalar(stepBody(token), 'id'), 'token');
  assert.deepEqual(mappingOf(stepInputs(token)), PLEASE_TOKEN_INPUTS);
  assert.equal(under(stepBody(token), 'env'), '', 'the token step has an env');
  assert.equal(scalar(stepBody(release), 'uses'), 'googleapis/release-please-action@45996ed1f6d02564a971a2fa1b5860e934307cf7');
  assert.equal(scalar(stepBody(release), 'id'), 'release');
  assert.deepEqual(mappingOf(stepInputs(release)), RELEASE_PLEASE_INPUTS);
  assert.equal(under(stepBody(release), 'env'), '', 'the release-please step has an env');
  assert.equal(merge, autoMergeStep(), 'the auto-merge step is not the last');
  // The token reaches release-please and the auto-merge step, the two that write, and nothing else.
  const readers = workflowCode()
    .split('\n')
    .filter((line) => /\bsteps\.token\b/.test(line))
    .map((line) => line.trim());
  assert.deepEqual(readers, [
    'token: ${{ steps.token.outputs.token }}',
    'GH_TOKEN: ${{ steps.token.outputs.token }}',
    'GH_TOKEN: ${{ steps.token.outputs.token }}',
  ]);
  assert.ok(release.includes(readers[0]!) && merge.includes(readers[1]!), 'the token reaches another step of the please job');
});

/** How a job ends in the walk: every job that runs succeeds, unless the scenario fails it. */
type JobResult = 'success' | 'skipped' | 'failure';

/** A value of an expression the walk reads. */
type ExpressionValue = string | boolean | null;

/**
 * A run for the walk: the event that started it, the outputs of the jobs that set any, by job and
 * output name, and the jobs that fail once they run. An output left out is empty, as GitHub hands on
 * the output of a step that was skipped.
 */
type Scenario = { event: string; outputs?: Record<string, Record<string, string>>; failing?: string[] };

/**
 * Evaluates a GitHub expression with `lookup` for a context path and `status` for a status function.
 * It reads what the job conditions here are written with: ||, &&, ==, !=, !, parentheses, quoted
 * strings, context paths and status functions. Anything else fails the calling test, so the walk never
 * passes on a condition it misread. == compares strings without case, as GitHub does.
 */
const evaluate = (
  expression: string,
  lookup: (path: string) => ExpressionValue,
  status: (name: string) => boolean,
): ExpressionValue => {
  const tokens: string[] = [];
  const pattern = /\s*(\|\||&&|==|!=|!|\(|\)|'(?:[^']|'')*'|[A-Za-z_][\w-]*(?:\.[A-Za-z_][\w-]*)*(?:\(\))?)\s*/y;
  while (pattern.lastIndex < expression.length) {
    const at = pattern.lastIndex;
    const match = pattern.exec(expression);
    assert.ok(match, `the walk cannot read ${expression.slice(at)}`);
    tokens.push(match[1]!);
  }
  const truthy = (value: ExpressionValue): boolean => value !== null && value !== false && value !== '';
  let at = 0;
  const primary = (): ExpressionValue => {
    const token = tokens[at++];
    assert.ok(token !== undefined, `${expression} ends early`);
    if (token === '(') {
      const value = or();
      assert.equal(tokens[at++], ')', `${expression} leaves a parenthesis open`);
      return value;
    }
    if (token === '!') return !truthy(primary());
    if (token.startsWith("'")) return token.slice(1, -1).replaceAll("''", "'");
    if (token.endsWith('()')) return status(token.slice(0, -2));
    if (token === 'true' || token === 'false') return token === 'true';
    if (token === 'null') return null;
    return lookup(token);
  };
  const comparison = (): ExpressionValue => {
    const left = primary();
    const operator = tokens[at];
    if (operator !== '==' && operator !== '!=') return left;
    at += 1;
    const right = primary();
    assert.ok(typeof left === 'string' && typeof right === 'string', `the walk compares only strings: ${expression}`);
    return (left.toLowerCase() === right.toLowerCase()) === (operator === '==');
  };
  const and = (): ExpressionValue => {
    let value = comparison();
    while (tokens[at] === '&&') {
      at += 1;
      const right = comparison();
      value = truthy(value) ? right : value;
    }
    return value;
  };
  const or = (): ExpressionValue => {
    let value = and();
    while (tokens[at] === '||') {
      at += 1;
      const right = and();
      value = truthy(value) ? value : right;
    }
    return value;
  };
  const value = or();
  assert.equal(at, tokens.length, `the walk cannot read ${expression}`);
  return value;
};

/**
 * Which jobs of a workflow's code run in `scenario`, as GitHub decides it: a job waits for what it
 * needs, and its job-level if decides whether it runs. An if with no status function counts as
 * `success() && (if)`, and a job without one as `success()`. success() holds only while every job
 * the job needs, directly or through another, succeeded, so a skipped job skips every job after it,
 * however each of them is gated. A condition may read only the event and the declared outputs of the
 * jobs it needs.
 */
const walk = (code: string, scenario: Scenario): Record<string, JobResult> => {
  const jobs = new Map(
    jobsIn(code).map(([name, body]) => {
      const needs = scalar(body, 'needs');
      const list = needs === undefined ? [] : /^\[(.*)\]$/.exec(needs)?.[1]?.split(',').map((need) => need.trim()) ?? [needs];
      for (const need of list) assert.match(need, /^[\w-]+$/, `the ${name} job's needs is written in a form the walk cannot read`);
      return [name, { needs: list, if: scalar(body, 'if'), outputs: Object.keys(mappingOf(under(body, 'outputs'))) }];
    }),
  );
  for (const [job, outputs] of Object.entries(scenario.outputs ?? {})) {
    for (const output of Object.keys(outputs)) {
      assert.ok(jobs.get(job)?.outputs.includes(output), `the scenario sets ${job}.${output}, which no job declares`);
    }
  }
  const results = new Map<string, JobResult>();
  const upstream = (name: string, seen = new Set<string>()): string[] => {
    for (const need of jobs.get(name)!.needs) {
      if (!seen.has(need)) {
        seen.add(need);
        upstream(need, seen);
      }
    }
    return [...seen];
  };
  const resolve = (name: string, path: string[] = []): JobResult => {
    const known = results.get(name);
    if (known) return known;
    const job = jobs.get(name);
    assert.ok(job, `a job needs ${name}, which does not exist`);
    assert.ok(!path.includes(name), `the jobs need each other in a cycle: ${[...path, name].join(' -> ')}`);
    for (const need of job.needs) resolve(need, [...path, name]);
    const before = upstream(name).map((need) => results.get(need)!);
    const status = (fn: string): boolean => {
      if (fn === 'success') return before.every((result) => result === 'success');
      if (fn === 'failure') return before.some((result) => result === 'failure');
      if (fn === 'always') return true;
      if (fn === 'cancelled') return false;
      return assert.fail(`the ${name} job's if calls ${fn}(), which the walk does not know`);
    };
    const lookup = (context: string): ExpressionValue => {
      if (context === 'github.event_name') return scenario.event;
      const read = /^needs\.([\w-]+)\.outputs\.([\w-]+)$/.exec(context);
      assert.ok(read, `the ${name} job's if reads ${context}, which the walk does not know`);
      const need = read[1]!;
      const output = read[2]!;
      assert.ok(job.needs.includes(need), `the ${name} job's if reads ${context}, but it does not need ${need}`);
      assert.ok(jobs.get(need)!.outputs.includes(output), `the ${name} job's if reads ${context}, which ${need} does not declare`);
      return results.get(need) === 'success' ? (scenario.outputs?.[need]?.[output] ?? '') : '';
    };
    const condition = /^\$\{\{(.*)\}\}$/s.exec(job.if ?? '')?.[1] ?? job.if ?? 'success()';
    const explicit = /\b(?:success|failure|always|cancelled)\(\)/.test(condition);
    const value = evaluate(explicit ? condition : `success() && (${condition})`, lookup, status);
    const runs = value !== null && value !== false && value !== '';
    const result: JobResult = !runs ? 'skipped' : scenario.failing?.includes(name) ? 'failure' : 'success';
    results.set(name, result);
    return result;
  };
  return Object.fromEntries([...jobs.keys()].map((name) => [name, resolve(name)]));
};

test('a workflow_dispatch still reaches registry', () => {
  // The dispatch that retries a registry publish runs the whole graph. Every step of please and
  // release is gated so that it does nothing, but the jobs themselves have to run: a skipped job
  // skips every job after it, and the registry job with it.
  const code = workflowCode();
  assert.deepEqual(walk(code, { event: 'workflow_dispatch' }), {
    please: 'success',
    release: 'success',
    registry: 'success',
    hosting: 'skipped',
  });
  // A push that published reaches both jobs after the publish, and one that released nothing neither.
  const released = {
    please: { release_created: 'true', tag: 'v1.2.3', sha: '0123456789abcdef0123456789abcdef01234567' },
    release: { released: 'true', tag: 'v1.2.3' },
  };
  assert.deepEqual(walk(code, { event: 'push', outputs: released }), {
    please: 'success',
    release: 'success',
    registry: 'success',
    hosting: 'success',
  });
  assert.deepEqual(walk(code, { event: 'push', outputs: { please: { pr_number: '42' } } }), {
    please: 'success',
    release: 'success',
    registry: 'skipped',
    hosting: 'skipped',
  });
  // A failed please job publishes nothing.
  assert.deepEqual(walk(code, { event: 'push', outputs: released, failing: ['please'] }), {
    please: 'failure',
    release: 'skipped',
    registry: 'skipped',
    hosting: 'skipped',
  });
  // The walk follows the graph, not one gate: the push gate moved from the steps to the please job
  // skips the registry job two jobs later, although that job's own if lets a dispatch through.
  const gated = code.replace(/^ {2}please:\n/m, "  please:\n    if: github.event_name == 'push'\n");
  assert.notEqual(gated, code, 'the please job could not be gated for the check');
  assert.deepEqual(walk(gated, { event: 'workflow_dispatch' }), {
    please: 'skipped',
    release: 'skipped',
    registry: 'skipped',
    hosting: 'skipped',
  });
});

test('the publishing job holds no App token and no environment', () => {
  // npm's trusted publisher is keyed to this workflow file with no environment, so the job that runs
  // npm publish names none, and so it gets no environment secret, the App's key among them. Its
  // GITHUB_TOKEN reads the tagged commit and the pending label, and writes nothing. It hands on the
  // tag release-please created, for the registry and hosting jobs.
  const release = releaseJob();
  assert.equal(scalar(release, 'needs'), 'please');
  assert.equal(scalar(release, 'environment'), undefined, 'the release job names an environment');
  assert.equal(scalar(release, 'if'), undefined, 'the release job has a job-level if');
  assert.deepEqual(mappingOf(releaseJobPermissions()), { contents: 'read', 'pull-requests': 'read', 'id-token': 'write' });
  assert.deepEqual(mappingOf(under(release, 'outputs')), {
    released: '${{ steps.publish.outputs.released }}',
    tag: '${{ needs.please.outputs.tag }}',
  });
  assert.doesNotMatch(release, /create-github-app-token|\bsteps\.token\b|\bsecrets\b|\bvars\b/, 'the release job reaches the App');
  // Only the release PR check calls gh, with GITHUB_TOKEN.
  const tokens = release.split('\n').filter((line) => /\bGH_TOKEN\b/.test(line)).map((line) => line.trim());
  assert.deepEqual(tokens, ['GH_TOKEN: ${{ github.token }}']);
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

/** The hosting job's one step that sends the dispatch, found by the endpoint its script posts to. */
const hostingDispatchStep = (): string => {
  const steps = hostingJobSteps().filter((step) => /\bgh +api +repos\/tibia-sh\/mcp\.tibia\.sh\/dispatches\b/.test(stepScript(step) ?? ''));
  assert.equal(steps.length, 1, 'expected exactly one hosting job step that runs gh api repos/tibia-sh/mcp.tibia.sh/dispatches');
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
 * A stand-in for gh, reading and writing a run's files in $GH_RUN. Every call goes to `events` as `gh`
 * and its arguments before anything else, so a call the fake then rejects still shows. It takes the
 * commands below, and any other fails, so a changed command cannot pass on a guess.
 *
 * `api graphql` takes string fields, given as `-f key=value` or `--raw-field key=value`, and writes
 * each value to `field-KEY`. A typed field or a second call fails. It prints `response` and exits with
 * `exit`, as gh prints the body even when it exits 1 for a GraphQL error.
 *
 * `api repos/{owner}/{repo}/pulls/N --jq .auto_merge` prints `auto-merge`, what gh prints for the pull
 * request's auto_merge, and exits with `pull-exit`. `pr merge N --auto --rebase` exits 0. Both need
 * GH_REPO, from which gh fills in {owner}/{repo} and finds the pull request outside a checkout, and
 * GH_TOKEN, or they fail.
 *
 * `api repos/{owner}/{repo}/actions/workflows/release.yml/runs?event=push&head_sha=SHA` answers call N,
 * counting every gh call in `events`, with `runs-N`, what GitHub answers with the release workflow's
 * push runs for SHA, and exits with `runs-exit-N`. It needs GH_REPO and GH_TOKEN too, and a call with no
 * `runs-N` fails.
 *
 * `api repos/tibia-sh/mcp.tibia.sh/dispatches --input -` runs only under the fake timeout, so a call
 * without its bound fails. It writes its stdin, the body gh would send, to `body-N` for call N, counting
 * every gh call in `events`. Call N answers with line N of `answers`, and a call with no line fails. `0`
 * is a dispatch GitHub accepted, which prints nothing, as gh prints nothing for a 204. `CODE TEXT` prints
 * TEXT on stderr and exits CODE, as gh prints the error of a request that failed.
 */
const FAKE_GH = `#!/usr/bin/env bash
here="$GH_RUN"
printf 'gh %s\\n' "$*" >> "$here/events"
pull_request() {
  if [ -z "$GH_REPO" ] || [ -z "$GH_TOKEN" ]; then
    echo "fake gh: $1 without GH_REPO or GH_TOKEN" >&2
    exit 2
  fi
  case "$2" in
    '' | *[!0-9]*) echo "fake gh: unsupported pull request $2" >&2; exit 2 ;;
  esac
}
if [ "$#" -eq 4 ] && [ "$1" = api ] && [ "\${2%/*}" = 'repos/{owner}/{repo}/pulls' ] && [ "$3" = --jq ] && [ "$4" = .auto_merge ]; then
  pull_request api "\${2##*/}"
  cat "$here/auto-merge"
  exit "$(cat "$here/pull-exit")"
fi
if [ "$#" -eq 5 ] && [ "$1" = pr ] && [ "$2" = merge ] && [ "$4" = --auto ] && [ "$5" = --rebase ]; then
  pull_request merge "$3"
  exit 0
fi
if [ "$#" -eq 2 ] && [ "$1" = api ] && [ "\${2%%head_sha=*}" = 'repos/{owner}/{repo}/actions/workflows/release.yml/runs?event=push&' ]; then
  count=0
  while IFS= read -r line; do
    case "$line" in 'gh '*) count=$((count + 1)) ;; esac
  done < "$here/events"
  if [ -z "$GH_REPO" ] || [ -z "$GH_TOKEN" ] || [ ! -e "$here/runs-$count" ]; then
    echo "fake gh: release runs without GH_REPO, GH_TOKEN or an answer for call $count" >&2
    exit 2
  fi
  cat "$here/runs-$count"
  exit "$(cat "$here/runs-exit-$count")"
fi
if [ "$#" -ge 2 ] && [ "$1" = api ] && [ "$2" = graphql ]; then
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
fi
if [ "$#" -ne 4 ] || [ "$1" != api ] || [ "$2" != repos/tibia-sh/mcp.tibia.sh/dispatches ] || [ "$3" != --input ] || [ "$4" != - ]; then
  echo "fake gh: unsupported command: $*" >&2
  exit 2
fi
if [ "$BOUNDED_BY_TIMEOUT" != 1 ]; then
  echo "fake gh: $2 run without timeout" >&2
  exit 2
fi
count=0
while IFS= read -r line; do
  case "$line" in 'gh '*) count=$((count + 1)) ;; esac
done < "$here/events"
cat > "$here/body-$count"
n=0
answer=''
while IFS= read -r line; do
  n=$((n + 1))
  if [ "$n" -eq "$count" ]; then answer="$line"; break; fi
done < "$here/answers"
if [ -z "$answer" ]; then
  echo "fake gh: no answer for call $count" >&2
  exit 2
fi
code="\${answer%% *}"
if [ "$code" -ne 0 ]; then
  printf '%s\\n' "\${answer#* }" >&2
fi
exit "$code"
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

/**
 * The one secret each environment job holds: the step of the job it reaches, and the entry of that
 * step's `env:` or `with:` that takes it. The token action takes the App's key only as an input.
 */
const JOB_SECRETS: Array<{ job: string; secret: string; block: 'env' | 'with'; key: string; step: () => string }> = [
  { job: 'please', secret: 'TIBIA_SH_APP_PRIVATE_KEY', block: 'with', key: 'private-key', step: () => appTokenStep(pleaseJob(), 'please') },
  { job: 'registry', secret: 'MCP_PRIVATE_KEY', block: 'env', key: 'MCP_PRIVATE_KEY', step: registryPublishStep },
  { job: 'hosting', secret: 'TIBIA_SH_APP_PRIVATE_KEY', block: 'with', key: 'private-key', step: () => appTokenStep(hostingJob(), 'hosting') },
];

test("each environment job's secret reaches one of its steps, and the registry key only the login command", () => {
  // Written into a run script, a secret would be pasted into the shell as code. In a step's env it is
  // a variable only the processes of that step see, and in a step's with: an input only that action
  // reads. The please and hosting jobs each hand the App's key to their token step, the registry job
  // holds the registry key in one step, and no other line of the workflow references a secret.
  const references = workflowCode().split('\n').filter((line) => /\bsecrets\b/.test(line));
  assert.equal(references.length, JOB_SECRETS.length, `expected ${JOB_SECRETS.length} references to a secret: ${references.join(' |')}`);
  const jobs = Object.fromEntries(workflowJobs());
  for (const { job, secret, block, key, step } of JOB_SECRETS) {
    const steps = jobSteps(jobs[job] ?? '').filter((text) => /\bsecrets\b/.test(text));
    assert.equal(steps.length, 1, `expected exactly one ${job} job step that references a secret`);
    assert.equal(steps[0], step(), `the ${job} job's secret reaches another step`);
    assert.equal(
      scalar(under(stepBody(steps[0]!), block), key),
      `\${{ secrets.${secret} }}`,
      `${secret} does not reach the ${job} job's step through its ${block} as ${key}`,
    );
  }
  for (const secret of new Set(JOB_SECRETS.map(({ secret }) => secret))) {
    const holders = JOB_SECRETS.filter((entry) => entry.secret === secret).flatMap(({ step }) => step().split('\n'));
    const elsewhere = workflowCode()
      .split('\n')
      .filter((line) => line.includes(secret) && !holders.includes(line));
    assert.deepEqual(elsewhere, [], `a line outside the steps that hold ${secret} names it`);
  }
  // The registry publish's script names the key only in the login. gh reads GH_TOKEN by itself, so the
  // hosting dispatch's script never names its token.
  const uses = (stepScript(registryPublishStep()) ?? '').split('\n').filter((line) => line.includes('MCP_PRIVATE_KEY'));
  assert.equal(uses.length, 1, `the script names the key more than once: ${uses.length}`);
  assert.ok(
    uses[0]!.includes('./mcp-publisher login dns --domain tibia.sh --private-key "$MCP_PRIVATE_KEY"'),
    'the script passes the key to something besides the login',
  );
  assert.doesNotMatch(stepScript(hostingDispatchStep()) ?? '', /GH_TOKEN|\btoken\b/, 'the hosting dispatch script names its token');
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

/** The condition the hosting job runs on. `released` is 'true' or empty, and a dispatched run releases nothing. */
const HOSTING_GATE = "${{ needs.release.outputs.released == 'true' }}";

test('the hosting dispatch is a job of its own, run beside the registry job once npm accepted the release', () => {
  // Every job that mints the App's token runs in the release-trigger environment, and naming that
  // environment in the release job would put an environment claim in its OIDC token, which npm's
  // trusted publisher rejects. The job needs only the release job, so a red registry
  // job does not stop it, and a dispatched run, which releases nothing, skips it. It runs no action but
  // the token action, and checks nothing out. Its dispatch runs under the default shell with -e, as the
  // checks below run its script.
  const hosting = hostingJob();
  assert.notEqual(hosting, '', 'the workflow has no hosting job');
  assert.equal(scalar(hosting, 'needs'), 'release');
  assert.equal(scalar(hosting, 'if'), HOSTING_GATE);
  assert.equal(scalar(hosting, 'runs-on'), 'ubuntu-latest');
  assert.equal(scalar(hosting, 'environment'), 'release-trigger');
  assert.equal(scalar(hosting, 'timeout-minutes'), '8');
  const permissions = under(hosting, 'permissions')
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '');
  assert.deepEqual(permissions, ['contents: read']);
  assert.equal(scalar(under(hosting, 'env'), 'TAG'), '${{ needs.release.outputs.tag }}');
  assert.equal(hosting.split('uses:').length - 1, 1, 'the hosting job runs an action besides the token action');
  const steps = hostingJobSteps();
  assert.equal(steps.length, 2, 'expected the token step, then the dispatch');
  const [token, step] = steps as [string, string];
  assert.equal(token, appTokenStep(hosting, 'hosting'), 'the hosting job does not mint its token first');
  assert.equal(step, hostingDispatchStep(), 'the hosting job step does not send the dispatch');
  // docs/RELEASING.md names the step.
  assert.equal(scalar(stepBody(step), 'name'), 'Tell mcp.tibia.sh about the release');
  assert.equal(stepIf(token), undefined, `${stepName(token)} sets if`);
  assert.equal(stepIf(step), undefined, `${stepName(step)} sets if`);
  assertDefaultShell(hosting, step);
  assert.doesNotMatch(stepScript(step) ?? '', /\bset +\+[a-z]*e|\bset +\+o +errexit\b/, `${stepName(step)} turns off -e`);
});

/** The token the hosting dispatch runs with in these checks. The fake gh reads no token. */
const HOSTING_TOKEN = 'fake-hosting-token';

/** A gh call's answer: its exit code, and the error it prints when that is not 0. */
type GhReply = { code: number; text: string };

/** A dispatch GitHub accepted: gh exits 0 and prints nothing for the 204. */
const DISPATCHED: GhReply = { code: 0, text: '' };

/** gh's errors, as it prints them: a request that never connected, and HTTP errors with their status. */
const HOSTING_UNREACHABLE: GhReply = {
  code: 1,
  text: 'Post "https://api.github.com/repos/tibia-sh/mcp.tibia.sh/dispatches": dial tcp 140.82.121.6:443: i/o timeout',
};
const GITHUB_FAILED: GhReply = { code: 1, text: 'gh: Server Error (HTTP 502)' };
const TOKEN_REJECTED: GhReply = { code: 1, text: 'gh: Bad credentials (HTTP 401)' };

/** The body the dispatch sends for `version`, as bump.yml in the hosting repo reads it. */
const dispatchBody = (version: string): unknown => ({
  event_type: 'first-party-release',
  client_payload: { package: '@tibia.sh/tibiawiki-mcp', version },
});

/** `body` as GitHub would read it: one JSON document, or the test fails. */
const json = (body: string): unknown => {
  try {
    return JSON.parse(body);
  } catch {
    return assert.fail(`a body is not one JSON document: ${body}`);
  }
};

/**
 * Runs the hosting job's dispatch step for `tag`, as the checks above run their scripts, with the fake
 * gh, sleep and timeout first on PATH. jq and everything else is real. `answers` answer the step's gh
 * calls in order. The step holds the token in its env, so any command that prints it, such as an
 * environment dump or a trace, fails every run.
 */
const runHostingDispatch = (tag: string, answers: GhReply[]) => {
  const dir = scratch();
  writeFileSync(join(dir, 'answers'), answers.map(({ code, text }) => `${code} ${text}\n`).join(''));
  const env = { TAG: tag, GH_TOKEN: HOSTING_TOKEN, PATH: `${fakeBin()}:${process.env['PATH'] ?? ''}`, FAKE_RUN: dir, GH_RUN: dir };
  const run = bash(stepScript(hostingDispatchStep())!, env, dir);
  assert.ok(!`${run.stdout}${run.stderr}`.includes(HOSTING_TOKEN), 'the dispatch step printed the token');
  return {
    status: run.status,
    stdout: run.stdout,
    output: `${run.stdout}${run.stderr}`,
    errors: run.stdout.split('\n').filter((line) => line.startsWith('::error::')),
    events: recorded(dir, 'events'),
    /** What each gh call read on stdin, in the order of the calls. */
    bodies: readdirSync(dir)
      .filter((file) => /^body-\d+$/.test(file))
      .sort()
      .map((file) => readFileSync(join(dir, file), 'utf8')),
  };
};

/** What the fakes record for the dispatch the step sends. */
const DISPATCH = 'gh api repos/tibia-sh/mcp.tibia.sh/dispatches --input -';

/** The line the step prints once a dispatch of `version` got through, in attempt `attempt`. */
const told = (version: string, attempt: number): string =>
  `Told tibia-sh/mcp.tibia.sh about @tibia.sh/tibiawiki-mcp ${version} in attempt ${attempt}.`;

test('the hosting dispatch rejects a tag that is not a release tag, before it calls gh', () => {
  // The tag decides what bump.yml pins, and the error line names what this run had instead.
  for (const tag of ['', '0.6.1', 'v0.6', 'v0.6.1-rc.1', 'v0.6.1; true']) {
    const run = runHostingDispatch(tag, [DISPATCHED]);
    assert.equal(run.status, 1, `${JSON.stringify(tag)} is accepted: ${run.output}`);
    assert.deepEqual(run.errors, [`::error::The released tag must look like v1.2.3, and this run has "${tag}".`]);
    assert.deepEqual(run.events, [], `${JSON.stringify(tag)} reaches gh or sleep`);
  }
});

test("the hosting dispatch tells the hosting repo about the tag's version once when its first attempt succeeds", () => {
  // The body is the event bump.yml is triggered by, with the version the tag names, without its v.
  for (const version of ['0.6.1', '10.20.300']) {
    const run = runHostingDispatch(`v${version}`, [DISPATCHED]);
    assert.equal(run.status, 0, run.output);
    assert.deepEqual(run.events, [DISPATCH]);
    assert.deepEqual(run.bodies.map(json), [dispatchBody(version)]);
    assert.ok(run.stdout.split('\n').includes(told(version, 1)), `the log does not say the dispatch got through: ${run.output}`);
    assert.deepEqual(run.errors, [], `a dispatch that got through ends with an error: ${run.output}`);
  }
});

test('the hosting dispatch tries again 30 seconds after a failure, and stops at the attempt that got through', () => {
  // A dispatch that got through twice is harmless, because bump.yml finds the version pinned or its
  // pull request open, so a failed attempt is only tried again, with the same body.
  const second = runHostingDispatch('v0.6.1', [GITHUB_FAILED, DISPATCHED]);
  assert.equal(second.status, 0, second.output);
  assert.deepEqual(second.events, [DISPATCH, PAUSE, DISPATCH]);
  assert.deepEqual(second.bodies.map(json), [dispatchBody('0.6.1'), dispatchBody('0.6.1')]);
  assert.ok(second.stdout.split('\n').includes(told('0.6.1', 2)), `the log does not say which attempt got through: ${second.output}`);
  assert.deepEqual(second.errors, [], `a dispatch that got through ends with an error: ${second.output}`);
  const third = runHostingDispatch('v0.6.1', [HOSTING_UNREACHABLE, GITHUB_FAILED, DISPATCHED]);
  assert.equal(third.status, 0, third.output);
  assert.deepEqual(third.events, [DISPATCH, PAUSE, DISPATCH, PAUSE, DISPATCH]);
  assert.deepEqual(third.bodies.map(json), [dispatchBody('0.6.1'), dispatchBody('0.6.1'), dispatchBody('0.6.1')]);
  assert.ok(third.stdout.split('\n').includes(told('0.6.1', 3)), `the log does not say which attempt got through: ${third.output}`);
  assert.deepEqual(third.errors, [], `a dispatch that got through ends with an error: ${third.output}`);
});

test('the hosting dispatch fails after 3 attempts, 30 seconds apart, and names the runbook section with the manual command', () => {
  // The publish already happened, so the job ends red with the version and the recovery, and gh's
  // own errors say why each attempt failed.
  const failures = [HOSTING_UNREACHABLE, TOKEN_REJECTED, GITHUB_FAILED];
  const run = runHostingDispatch('v0.6.1', failures);
  assert.equal(run.status, 1, run.output);
  assert.deepEqual(run.events, [DISPATCH, PAUSE, DISPATCH, PAUSE, DISPATCH]);
  assert.deepEqual(run.errors, [
    '::error::Could not tell tibia-sh/mcp.tibia.sh about @tibia.sh/tibiawiki-mcp 0.6.1 in 3 attempts, 30 seconds apart. Run bump.yml there by hand, as "The hosting dispatch" in docs/RELEASING.md describes.',
  ]);
  assert.doesNotMatch(run.stdout, /^Told /m, `the log says the dispatch got through: ${run.output}`);
  for (const { text } of failures) {
    assert.ok(run.output.includes(text), `the log does not carry gh's error: ${text}`);
  }
  const section = /"([^"]+)" in docs\/RELEASING\.md/.exec(run.errors[0]!)![1]!;
  const lines = read('docs/RELEASING.md').split('\n');
  const start = lines.indexOf(`## ${section}`);
  assert.notEqual(start, -1, `docs/RELEASING.md has no section "${section}"`);
  const end = lines.findIndex((line, index) => index > start && line.startsWith('## '));
  assert.ok(
    lines.slice(start, end === -1 ? undefined : end).includes('gh workflow run bump.yml -R tibia-sh/mcp.tibia.sh --ref main -f package=@tibia.sh/tibiawiki-mcp -f version=X.Y.Z'),
    `"${section}" in docs/RELEASING.md does not give the manual command`,
  );
});

test('the hosting dispatch uses an App token limited to mcp.tibia.sh', () => {
  // The token dispatches to the hosting repository and nowhere else: one repository, contents write,
  // which a repository_dispatch needs, and nothing more. It expires within the hour, and only the
  // dispatch step reads it, through its env, where gh finds it by itself.
  const hosting = hostingJob();
  const token = appTokenStep(hosting, 'hosting');
  assert.equal(scalar(stepBody(token), 'uses'), APP_TOKEN_ACTION);
  assert.equal(scalar(stepBody(token), 'id'), 'token');
  assert.deepEqual(mappingOf(stepInputs(token)), HOSTING_TOKEN_INPUTS);
  assert.equal(under(stepBody(token), 'env'), '', 'the token step has an env');
  assert.deepEqual(mappingOf(under(stepBody(hostingDispatchStep()), 'env')), { GH_TOKEN: '${{ steps.token.outputs.token }}' });
  const readers = hosting.split('\n').filter((line) => /\bsteps\.token\b/.test(line));
  assert.equal(readers.length, 1, 'the token reaches another step of the hosting job');
  assert.ok(hostingDispatchStep().split('\n').includes(readers[0]!), 'the token reaches another step of the hosting job');
});

/** The auto-merge step's condition: a push run where release-please reported a PR and created no release. */
const AUTO_MERGE_IF =
  "${{ github.event_name == 'push' && steps.release.outputs.pr && steps.release.outputs.release_created != 'true' }}";

/** What the auto-merge step's env holds: the App token, the repository for gh, and release-please's PR. */
const AUTO_MERGE_ENV = {
  GH_TOKEN: '${{ steps.token.outputs.token }}',
  GH_REPO: '${{ github.repository }}',
  PR: '${{ steps.release.outputs.pr }}',
};

/**
 * The auto-merge step's script, word for word. It holds the App token, and a job output is data, so the
 * number is taken from release-please's JSON only when it is a JSON number whose text is digits alone,
 * and nothing else reaches gh. gh api runs in an assignment of its own, so a failed read stops the
 * script instead of reading as auto-merge off. A change here has to change this test on purpose.
 */
const AUTO_MERGE_SCRIPT = String.raw`if ! number="$(jq -r '.number | numbers' <<< "$PR")" || [[ ! $number =~ ^[0-9]+$ ]]; then
  echo "::error::release-please reported a release PR without a plain number, so its auto-merge was not turned on."
  exit 1
fi
echo "pr_number=$number" >> "$GITHUB_OUTPUT"
auto_merge="$(gh api "repos/{owner}/{repo}/pulls/$number" --jq .auto_merge)"
if [[ -z $auto_merge ]]; then
  gh pr merge "$number" --auto --rebase
else
  echo "Auto-merge is already on for pull request $number."
fi`;

/**
 * Runs the auto-merge step with `pr` as release-please's output, as the checks above run their scripts,
 * with the fake gh first on PATH. `autoMerge` is what gh prints for the pull request's auto_merge: an
 * empty line for null, or the object. jq and everything else is real.
 */
const runAutoMerge = (pr: string, autoMerge = '\n', pullExit = 0) => {
  const dir = scratch();
  writeFileSync(join(dir, 'auto-merge'), autoMerge);
  writeFileSync(join(dir, 'pull-exit'), `${pullExit}\n`);
  writeFileSync(join(dir, 'github-output'), '');
  const env = {
    PR: pr,
    GH_TOKEN: 'fake-app-token',
    GH_REPO: 'octo-org/octo-repo',
    GITHUB_OUTPUT: join(dir, 'github-output'),
    PATH: `${fakeBin()}:${process.env['PATH'] ?? ''}`,
    GH_RUN: dir,
  };
  const run = bash(stepScript(autoMergeStep())!, env, dir);
  return {
    status: run.status,
    output: `${run.stdout}${run.stderr}`,
    errors: run.stdout.split('\n').filter((line) => line.startsWith('::error::')),
    events: recorded(dir, 'events'),
    outputs: recorded(dir, 'github-output'),
  };
};

/** release-please's pr output for pull request `number`, as @actions/core writes the object: its JSON. */
const releasePullRequest = (number: unknown): string =>
  JSON.stringify({
    headBranchName: 'release-please--branches--main--components--tibiawiki-mcp',
    baseBranchName: 'main',
    number,
    title: 'chore(main): release 1.2.3',
    body: ':robot: I have created a release *beep* *boop*',
    labels: ['autorelease: pending'],
    files: [],
  });

test('a release PR gets auto-merge, and only a validated number reaches gh', () => {
  // The release PR merges itself once its checks pass, and the merge is the push that publishes.
  // release-please names the PR in its pr output, and auto-merge is turned on only when it is off, as
  // bump.ts does, since a second request would be refused. A run that created a release has no PR to
  // merge. The step's condition, env and script are pinned whole.
  const step = autoMergeStep();
  assert.equal(stepIf(step), AUTO_MERGE_IF);
  assert.deepEqual(mappingOf(under(stepBody(step), 'env')), AUTO_MERGE_ENV);
  assert.equal(scalar(stepBody(step), 'id'), 'merge');
  assert.equal(stepScript(step), AUTO_MERGE_SCRIPT);
  assertDefaultShell(pleaseJob(), step);
  const read = 'gh api repos/{owner}/{repo}/pulls/42 --jq .auto_merge';
  const off = runAutoMerge(releasePullRequest(42));
  assert.equal(off.status, 0, off.output);
  assert.deepEqual(off.events, [read, 'gh pr merge 42 --auto --rebase']);
  assert.deepEqual(off.outputs, ['pr_number=42']);
  const on = runAutoMerge(releasePullRequest(42), '{"enabled_by":{"login":"tibia-sh-bot[bot]"},"merge_method":"rebase"}\n');
  assert.equal(on.status, 0, on.output);
  assert.deepEqual(on.events, [read], 'auto-merge is turned on a second time');
  // A read that fails is not auto-merge off.
  const failed = runAutoMerge(releasePullRequest(42), 'gh: Server Error (HTTP 502)\n', 1);
  assert.notEqual(failed.status, 0, 'a failed read passes');
  assert.deepEqual(failed.events, [read], 'a failed read turns on auto-merge');
  // Only a JSON number whose text is digits alone passes, and nothing else reaches gh.
  const invalid: Array<[string, string]> = [
    ['a number as a string', releasePullRequest('42')],
    ['a string with a trailing newline', releasePullRequest('42\n')],
    ['a string that runs a command', releasePullRequest('42; true')],
    ['a negative number', releasePullRequest(-42)],
    ['a fraction', releasePullRequest(4.2)],
    ['no number', releasePullRequest(null)],
    ['a list', JSON.stringify([JSON.parse(releasePullRequest(42))])],
    ['two documents', `${releasePullRequest(42)}\n${releasePullRequest(43)}`],
    ['no output', ''],
    ['text that is not JSON', 'pull request 42'],
  ];
  for (const [what, pr] of invalid) {
    const run = runAutoMerge(pr);
    assert.equal(run.status, 1, `${what} does not fail the step with exit 1: ${run.output}`);
    assert.equal(run.errors.length, 1, `${what} fails without exactly one ::error::: ${run.output}`);
    assert.deepEqual(run.events, [], `${what} reaches gh`);
    assert.deepEqual(run.outputs, [], `${what} is handed on`);
  }
});

test('no workflow reads a PAT secret', () => {
  // The secrets any workflow references are the App's key, once in each job that mints a token, and
  // the registry key. The App's client ID is the one variable. Everything that writes to GitHub runs
  // as the App or with GITHUB_TOKEN, and ci.yml and alert.yml reference no secret at all.
  const context = (name: string): string[] =>
    workflowFiles().flatMap((file) =>
      workflowCode(file)
        .split('\n')
        .filter((line) => new RegExp(`(?<![\\w.-])${name}(?![\\w-])`).test(line))
        .map((line) => `${file} ${line.trim()}`),
    );
  assert.deepEqual(context('secrets'), [
    'release.yml private-key: ${{ secrets.TIBIA_SH_APP_PRIVATE_KEY }}',
    'release.yml MCP_PRIVATE_KEY: ${{ secrets.MCP_PRIVATE_KEY }}',
    'release.yml private-key: ${{ secrets.TIBIA_SH_APP_PRIVATE_KEY }}',
  ]);
  assert.deepEqual(context('vars'), [
    'release.yml client-id: ${{ vars.TIBIA_SH_APP_CLIENT_ID }}',
    'release.yml client-id: ${{ vars.TIBIA_SH_APP_CLIENT_ID }}',
  ]);
});

/** The condition of alert.yml's job: a run that did not pass, of an event other than a pull request. */
const ALERT_IF =
  "github.event.workflow_run.conclusion != 'success' && github.event.workflow_run.conclusion != 'skipped' && " +
  "github.event.workflow_run.conclusion != 'neutral' && github.event.workflow_run.event != 'pull_request'";

/**
 * alert.yml's script, word for word: it comments on the open issue titled `Automation needs a look`,
 * found by its exact title rather than a search, or opens that issue assigned to drptbl.
 */
const ALERT_SCRIPT = String.raw`title='Automation needs a look'
body="$WORKFLOW $CONCLUSION: $RUN_URL"
number=$(TITLE=$title gh issue list --state open --limit 1000 --json number,title \
  --jq 'map(select(.title == env.TITLE) | .number) | min // empty')
if [[ -n $number ]]; then
  gh issue comment "$number" --body "$body"
else
  gh issue create --title "$title" --assignee drptbl --body "$body"
fi`;

test('alert comments on failed release runs', () => {
  // workflow_run matches a workflow by its name:, so the name is read from release.yml. alert.yml reads
  // no code and grants nothing at the top, and its one job writes the issue with GITHUB_TOKEN. Every
  // workflow that writes the issue waits its turn in one group, and none replaces another's waiting run.
  const code = workflowCode('alert.yml');
  assert.equal(scalar(code, 'name'), 'alert');
  const on = under(code, 'on');
  assert.deepEqual(Object.keys(mappingOf(on)), ['workflow_run'], 'alert.yml has another trigger');
  assert.deepEqual(mappingOf(under(on, 'workflow_run')), { workflows: `[${scalar(workflowCode(), 'name')}]`, types: '[completed]' });
  assert.equal(scalar(workflowCode(), 'name'), 'release');
  assert.equal(scalar(code, 'permissions'), '{}', 'alert.yml grants something at the top');
  const jobs = workflowJobs('alert.yml');
  assert.deepEqual(jobs.map(([name]) => name), ['alert']);
  const alert = jobs[0]![1];
  assert.equal(scalar(alert, 'if'), ALERT_IF);
  assert.equal(scalar(alert, 'runs-on'), 'ubuntu-latest');
  assert.equal(scalar(alert, 'timeout-minutes'), '5');
  assert.deepEqual(mappingOf(under(alert, 'permissions')), { issues: 'write' });
  assert.deepEqual(mappingOf(under(alert, 'concurrency')), { group: 'automation-alert', 'cancel-in-progress': 'false', queue: 'max' });
  // No checkout and no action: gh alone, on this repository.
  assert.doesNotMatch(alert, /\buses:/, 'the alert job runs an action');
  const steps = jobSteps(alert);
  assert.equal(steps.length, 1, 'expected exactly one alert step');
  assert.deepEqual(mappingOf(under(stepBody(steps[0]!), 'env')), {
    GH_TOKEN: '${{ github.token }}',
    GH_REPO: '${{ github.repository }}',
    WORKFLOW: '${{ github.event.workflow_run.name }}',
    CONCLUSION: '${{ github.event.workflow_run.conclusion }}',
    RUN_URL: '${{ github.event.workflow_run.html_url }}',
  });
  assert.equal(stepScript(steps[0]!), ALERT_SCRIPT);
});

test('ci.yml runs the required test job on pull requests and in the merge queue', () => {
  // main's ruleset requires the check test, and its merge queue tests every entry, bot or human, on top
  // of the latest main before it merges. A queue entry reports only the checks of workflows that run on
  // merge_group, so without that trigger every entry waits for a test that never comes. The check takes
  // its name from the job: a name:, a matrix or an if would rename or skip it. Nothing in the workflow
  // reads context a merge_group event lacks, such as the pull request or its head and base refs.
  const code = workflowCode('ci.yml');
  const on = under(code, 'on');
  assert.deepEqual(mappingOf(on), { push: '', pull_request: '', merge_group: '' });
  assert.deepEqual(mappingOf(under(on, 'push')), { branches: '[main]' });
  assert.equal(under(on, 'pull_request'), '', 'pull_request is filtered');
  assert.equal(under(on, 'merge_group'), '', 'merge_group is filtered');
  const jobs = workflowJobs('ci.yml');
  assert.deepEqual(jobs.map(([name]) => name), ['test'], 'ci.yml runs a job besides test, the check the ruleset requires');
  const job = jobs[0]![1];
  for (const key of ['name', 'if', 'strategy', 'needs']) {
    assert.equal(scalar(job, key), undefined, `the test job sets ${key}, which renames, skips or delays the required check`);
  }
  assert.doesNotMatch(code, /\bgithub\.(?:event\.pull_request|head_ref|base_ref)\b|\bGITHUB_(?:HEAD|BASE)_REF\b/, 'ci.yml reads pull request context');
  // The workflow grants nothing at the top. The test job reads the repository, and main's release runs
  // for the queue check.
  assert.equal(scalar(code, 'permissions'), '{}', 'ci.yml grants something at the top');
  assert.deepEqual(mappingOf(under(job, 'permissions')), { contents: 'read', actions: 'read' });
});

/** The name of ci.yml's step that keeps a release PR older than main out of the merge queue. */
const QUEUE_CHECK = 'Keep a release PR older than main out of the queue';

/**
 * What the queue check reads, through env: the merge group's base commit and ref, from the event, and the
 * job's token and repository, for gh to read main's release run.
 */
const QUEUE_CHECK_ENV = {
  BASE_SHA: '${{ github.event.merge_group.base_sha }}',
  HEAD_REF: '${{ github.event.merge_group.head_ref }}',
  GH_TOKEN: '${{ github.token }}',
  GH_REPO: '${{ github.repository }}',
};

/**
 * The queue check's script, word for word. A queue entry that changes the manifest release-please
 * bumps is a release PR. release-please builds that PR as one commit on main's tip, so its head's parent
 * has to be the merge group's base, or its version and changelog miss what lands on main before it. The
 * merge group's ref, gh-readonly-queue/<branch>/pr-<number>-<base sha>, names the PR and the group's
 * base, which has to be the base the event names. The PR's head comes from refs/pull/<number>/head, and
 * the entry's tree has to be that head's, so an entry built from an older head fails. release-please
 * computes the PR from main before it reads main's head to commit onto, so the release workflow's newest
 * push run for the base has to have completed with success too: its please job rebuilt the PR from the
 * base. A run that is missing or has not completed is read again every POLL_SECONDS, until
 * DEADLINE_SECONDS of waiting have passed. Every value is checked whole before git or the error reads it,
 * and an answer about the run the step cannot read fails it at once. A change here has to change this
 * test on purpose.
 */
const QUEUE_CHECK_SCRIPT = String.raw`[[ $BASE_SHA =~ ^[0-9a-f]{40}$ ]] || { echo "::error::The merge group names no base commit, so this check cannot tell whether a release PR is older than main."; exit 1; }
git fetch --quiet --no-tags --depth=1 origin "$BASE_SHA"
status=0
git diff --quiet "$BASE_SHA" "$GITHUB_SHA" -- .release-please-manifest.json || status=$?
case $status in
  0) echo "This entry leaves .release-please-manifest.json as main has it, so it is no release PR."; exit 0 ;;
  1) ;;
  *) exit "$status" ;;
esac
if [[ ! $HEAD_REF =~ ^refs/heads/gh-readonly-queue/.+/pr-([0-9]+)-([0-9a-f]{40})$ ]]; then
  echo "::error::The merge group's ref names no pull request and base commit, so this check cannot tell whether the release PR is older than main."
  exit 1
fi
number="${'${'}BASH_REMATCH[1]}"
if [[ ${'${'}BASH_REMATCH[2]} != "$BASE_SHA" ]]; then
  echo "::error::The merge group's ref names the base ${'${'}BASH_REMATCH[2]}, but its event names $BASE_SHA, so this check cannot tell whether the release PR is older than main."
  exit 1
fi
git fetch --quiet --no-tags --depth=2 origin "refs/pull/$number/head"
parent="$(git rev-parse --verify FETCH_HEAD^)"
if [[ $parent != "$BASE_SHA" ]]; then
  echo "::error::The release PR was built on $parent, not on $BASE_SHA, the commit this queue entry merges onto, so its version and changelog miss what lands on main before it. release-please rebuilds it on main's tip on the next push to main, and its auto-merge adds it to the queue again."
  exit 1
fi
entry_tree="$(git rev-parse --verify "$GITHUB_SHA^{tree}")"
head_tree="$(git rev-parse --verify "FETCH_HEAD^{tree}")"
if [[ $entry_tree != "$head_tree" ]]; then
  echo "::error::This queue entry does not match the release PR's current head, so it was built from an older head. The PR joins the queue again once release-please's update of it lands."
  exit 1
fi
query="repos/{owner}/{repo}/actions/workflows/release.yml/runs?event=push&head_sha=$BASE_SHA"
poll=${'${'}POLL_SECONDS:-20}
limit=${'${'}DEADLINE_SECONDS:-1200}
if [[ ! $poll =~ ^[1-9][0-9]*$ || ! $limit =~ ^(0|[1-9][0-9]*)$ ]]; then
  echo "::error::POLL_SECONDS has to be a whole number of seconds above 0, and DEADLINE_SECONDS a whole number of seconds."
  exit 1
fi
waited=0
while :; do
  if ! response="$(gh api "$query")" ||
    ! run="$(jq -ser --arg sha "$BASE_SHA" 'if length == 1 then .[0].workflow_runs | arrays | map(select(.event == "push" and .head_sha == $sha)) | if length == 0 then "none" else max_by(.run_number) | "\(.status) \(.conclusion)" end else error("not one document") end' <<< "$response")" ||
    [[ ! $run =~ ^(none|([a-z_]+)\ ([a-z_]+))$ ]]; then
    echo "::error::Could not read main's release run for $BASE_SHA, so this check cannot tell whether release-please has rebuilt the release PR since that commit."
    exit 1
  fi
  run_status="${'${'}BASH_REMATCH[2]}"
  conclusion="${'${'}BASH_REMATCH[3]}"
  if [[ $run_status == completed ]]; then
    break
  fi
  if ((waited >= limit)); then
    echo "::error::main's release run for $BASE_SHA has not finished yet, so release-please may not have rebuilt this PR on that commit. release-please rebuilds it on main's tip in that run, or else on the next push to main, and its auto-merge adds it to the queue again."
    exit 1
  fi
  echo "main's release run for $BASE_SHA has not finished yet, so it is read again in $poll seconds."
  sleep "$poll"
  waited=$((waited + poll))
done
if [[ $conclusion != success ]]; then
  echo "::error::main's release run for $BASE_SHA ended $conclusion, not success, so release-please may not have rebuilt this PR on that commit. release-please rebuilds it on main's tip on the next push to main, and its auto-merge adds it to the queue again, which takes it once that push's release run has succeeded."
  exit 1
fi
echo "The release PR was built on $BASE_SHA, the commit this queue entry merges onto."`;

/** ci.yml's queue check step. */
const queueCheckStep = (): string => {
  const steps = jobSteps(under(under(workflowCode('ci.yml'), 'jobs'), 'test')).filter(
    (step) => scalar(stepBody(step), 'name') === QUEUE_CHECK,
  );
  assert.equal(steps.length, 1, `expected exactly one ci.yml step named ${QUEUE_CHECK}`);
  return steps[0]!;
};

test('the merge queue refuses a release PR older than main', () => {
  // A release PR and another PR can wait in the queue together. The queue merges the other one, then
  // tests the release PR on top of it, and test passes, so the release PR would merge with a version and
  // changelog that miss what just merged, and publish that under the wrong version, or leave a release
  // tagged at another commit with nothing on npm. So the required test job refuses such an entry itself,
  // in a step that runs on merge_group alone, right after the checkout and before anything installs.
  const job = under(under(workflowCode('ci.yml'), 'jobs'), 'test');
  const steps = jobSteps(job);
  const step = queueCheckStep();
  assert.ok(isCheckout(steps[0]!) && steps[1] === step, 'the queue check does not follow the checkout directly');
  assert.equal(stepIf(step), "${{ github.event_name == 'merge_group' }}");
  assert.deepEqual(mappingOf(under(stepBody(step), 'env')), QUEUE_CHECK_ENV);
  assert.equal(stepScript(step), QUEUE_CHECK_SCRIPT);
  assertDefaultShell(job, step);
});

/**
 * Runs git in `dir` with a fixed identity and none of the user's or the system's config. `env` adds to
 * that, such as a committer date.
 */
const gitIn = (dir: string, args: string[], env: Record<string, string> = {}): string =>
  execFileSync('git', args, {
    cwd: dir,
    encoding: 'utf8',
    env: {
      PATH: process.env['PATH'] ?? '',
      HOME: dir,
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_AUTHOR_NAME: 'Release Test',
      GIT_AUTHOR_EMAIL: 'release-test@example.com',
      GIT_COMMITTER_NAME: 'Release Test',
      GIT_COMMITTER_EMAIL: 'release-test@example.com',
      ...env,
    },
  }).trim();

/** A pull request's head commit, as origin serves it at refs/pull/<number>/head. */
type QueuePr = { number: number; head: string };

/**
 * A repository served as origin, as GitHub serves one to a merge_group run.
 * - main is at `base`, one feature merged since `old`.
 * - Each pull request's head is at refs/pull/<number>/head:
 *   - `fresh`, a release PR built on `base`, as release-please builds one;
 *   - `stale`, a release PR built on `old`;
 *   - `other`, a PR that leaves the manifest alone;
 *   - `moved`, a release PR release-please rebuilt on `base` after the queue took its older head.
 * - `entry` holds the merge group commits, each a PR's head rebased onto the group's base, at its
 *   queue ref gh-readonly-queue/main/pr-<number>-<base>:
 *   - `fresh`, `stale` and `other`, each alone in the queue, on `base`;
 *   - `stacked`, the fresh release PR queued behind `other`, on other's group commit;
 *   - `moved`, built from the moved PR's older head, which was built on `old`, on `base`.
 */
type QueueRepo = {
  origin: string;
  old: string;
  base: string;
  fresh: QueuePr;
  stale: QueuePr;
  other: QueuePr;
  moved: QueuePr;
  entry: Record<'fresh' | 'stale' | 'other' | 'stacked' | 'moved', string>;
};

let queueRepo: QueueRepo | undefined;
const queueFixture = (): QueueRepo => {
  if (queueRepo !== undefined) return queueRepo;
  const origin = scratch();
  gitIn(origin, ['init', '--quiet', '--bare', '--initial-branch=main']);
  gitIn(origin, ['config', 'uploadpack.allowAnySHA1InWant', 'true']);
  const src = scratch();
  gitIn(src, ['init', '--quiet', '--initial-branch=main']);
  const commit = (message: string, files: Record<string, string>): string => {
    for (const [path, text] of Object.entries(files)) writeFileSync(join(src, path), text);
    gitIn(src, ['add', '--all']);
    gitIn(src, ['commit', '--quiet', '--message', message]);
    return gitIn(src, ['rev-parse', 'HEAD']);
  };
  const release = { '.release-please-manifest.json': '{\n  ".": "1.1.0"\n}\n', 'CHANGELOG.md': '## 1.1.0\n' };
  const old = commit('chore: start', { '.release-please-manifest.json': '{\n  ".": "1.0.0"\n}\n', 'README.md': 'start\n' });
  const base = commit('feat: merged while the release PR waited', { 'feature.txt': 'x\n' });
  /** Pull request `number`'s head, one commit on `on`. */
  const pr = (number: number, on: string, message: string, files: Record<string, string>): QueuePr => {
    gitIn(src, ['switch', '--quiet', '--detach', on]);
    return { number, head: commit(message, files) };
  };
  const fresh = pr(7, base, 'chore(main): release 1.1.0', release);
  const stale = pr(8, old, 'chore(main): release 1.1.0', release);
  const other = pr(9, base, 'docs: reword the README', { 'README.md': 'reworded\n' });
  /**
   * The merge group commit the queue builds for `of` on `onto`, at its queue ref. The queue's rebase
   * always writes a new commit, so it carries its own committer date, and never equals the PR's head.
   */
  const queued: string[] = [];
  const group = (of: QueuePr, onto: string): string => {
    gitIn(src, ['switch', '--quiet', '--detach', onto]);
    gitIn(src, ['cherry-pick', of.head], { GIT_COMMITTER_DATE: '2030-01-01T00:00:00Z' });
    const sha = gitIn(src, ['rev-parse', 'HEAD']);
    queued.push(`${sha}:refs/heads/gh-readonly-queue/main/pr-${of.number}-${onto}`);
    return sha;
  };
  const otherEntry = group(other, base);
  // The queue took pull request 10 while its head was built on old. release-please then rebuilt it on
  // base, with the feature in its changelog, so origin serves the new head.
  const movedEntry = group(pr(10, old, 'chore(main): release 1.1.0', release), base);
  const moved = pr(10, base, 'chore(main): release 1.1.0', { ...release, 'CHANGELOG.md': '## 1.1.0\n\n- merged while the release PR waited\n' });
  const entry = { fresh: group(fresh, base), stale: group(stale, base), other: otherEntry, stacked: group(fresh, otherEntry), moved: movedEntry };
  const pulls = [fresh, stale, other, moved].map(({ number, head }) => `${head}:refs/pull/${number}/head`);
  gitIn(src, ['push', '--quiet', origin, `${base}:refs/heads/main`, ...pulls, ...queued]);
  queueRepo = { origin, old, base, fresh, stale, other, moved, entry };
  return queueRepo;
};

/** What gh prints for the release workflow's push runs of a commit, and the status it exits with. */
type RunsAnswer = { response: string; exit?: number };

/** One run of the release workflow as GitHub lists it, with only the fields the queue check reads. */
type ReleaseRun = { run_number: number; status: string; conclusion: string | null; event?: string; head_sha?: string };

/**
 * GitHub's answer listing the release workflow's runs, in the order given, each a push run for `sha`
 * unless it says otherwise.
 */
const releaseRuns = (sha: string, ...runs: ReleaseRun[]): RunsAnswer => ({
  response: JSON.stringify({
    total_count: runs.length,
    workflow_runs: runs.map((run) => ({ id: 9000 + run.run_number, name: 'release', event: 'push', head_sha: sha, ...run })),
  }),
});

/**
 * Runs the queue check as the test job runs it on merge_group: in a checkout of the merge group's
 * commit alone, as actions/checkout leaves it, with origin serving every commit, and the fake gh and
 * sleep first on PATH. gh answers its reads of the release runs with `runs` in order, and a read past
 * them fails. `env` adds to the step's environment, such as the poll interval. git and jq are real.
 */
const runQueueCheck = (base: string, entry: string, headRef: string, runs: RunsAnswer[] = [], extra: Record<string, string> = {}) => {
  const { origin } = queueFixture();
  const work = scratch();
  gitIn(work, ['init', '--quiet']);
  gitIn(work, ['remote', 'add', 'origin', origin]);
  gitIn(work, ['fetch', '--quiet', '--no-tags', '--depth=1', 'origin', entry]);
  gitIn(work, ['switch', '--quiet', '--detach', entry]);
  const gh = scratch();
  runs.forEach((answer, index) => {
    writeFileSync(join(gh, `runs-${index + 1}`), answer.response);
    writeFileSync(join(gh, `runs-exit-${index + 1}`), String(answer.exit ?? 0));
  });
  const env = {
    BASE_SHA: base,
    HEAD_REF: headRef,
    GITHUB_SHA: entry,
    GH_TOKEN: 'ghs_ci',
    GH_REPO: 'tibia-sh/tibiawiki-mcp',
    GH_RUN: gh,
    FAKE_RUN: gh,
    PATH: `${fakeBin()}:${process.env['PATH'] ?? ''}`,
    HOME: work,
    GIT_CONFIG_NOSYSTEM: '1',
    ...extra,
  };
  const run = bash(stepScript(queueCheckStep())!, env, work);
  const has = (sha: string): boolean => spawnSync('git', ['cat-file', '-e', `${sha}^{commit}`], { cwd: work }).status === 0;
  return {
    status: run.status,
    stdout: run.stdout,
    output: `${run.stdout}${run.stderr}`,
    errors: run.stdout.split('\n').filter((line) => line.startsWith('::error::')),
    /** gh's calls and sleep's, in order. */
    events: recorded(gh, 'events'),
    has,
  };
};

/** The gh call the queue check reads the release workflow's push runs for `base` with. */
const runsQuery = (base: string): string => `gh api repos/{owner}/{repo}/actions/workflows/release.yml/runs?event=push&head_sha=${base}`;

/**
 * The merge group ref the queue gives pull request `number` on `base`. The sha in it is the group's
 * base, the commit the entry merges onto, as in real runs: vaadin/flow's pr-25835 group was named for
 * ad8a33a8, main's tip when the group was created, and its own commit 29eb9bff has that parent. A group
 * queued behind another is based on that group's commit: vaadin/flow's pr-25952 group was named for
 * d0d29740, the group commit of pr-25951, created at 16:23:20 before pr-25951 merged at 16:42:33.
 */
const queueRef = (number: number, base: string): string => `refs/heads/gh-readonly-queue/main/pr-${number}-${base}`;

test('the queue check passes a release PR built on its base, refuses one built on an older main or queued behind another PR, and skips any other PR', () => {
  const repo = queueFixture();
  const fresh = runQueueCheck(
    repo.base,
    repo.entry.fresh,
    queueRef(repo.fresh.number, repo.base),
    [releaseRuns(repo.base, { run_number: 4, status: 'completed', conclusion: 'success' })],
  );
  assert.equal(fresh.status, 0, fresh.output);
  assert.ok(fresh.stdout.split('\n').includes(`The release PR was built on ${repo.base}, the commit this queue entry merges onto.`), fresh.output);
  assert.deepEqual(fresh.events, [runsQuery(repo.base)]);
  const refused = (parent: string, base: string): string[] => [
    `::error::The release PR was built on ${parent}, not on ${base}, the commit this queue entry merges onto, so its version and changelog miss what lands on main before it. release-please rebuilds it on main's tip on the next push to main, and its auto-merge adds it to the queue again.`,
  ];
  const stale = runQueueCheck(repo.base, repo.entry.stale, queueRef(repo.stale.number, repo.base));
  assert.equal(stale.status, 1, stale.output);
  assert.deepEqual(stale.errors, refused(repo.old, repo.base));
  assert.deepEqual(stale.events, [], 'the check read the release runs for a release PR it refuses anyway');
  // Merge groups are built in parallel, so a release PR queued behind another PR is tested on that PR's
  // group commit, which main has not taken yet.
  const stacked = runQueueCheck(repo.entry.other, repo.entry.stacked, queueRef(repo.fresh.number, repo.entry.other));
  assert.equal(stacked.status, 1, stacked.output);
  assert.deepEqual(stacked.errors, refused(repo.base, repo.entry.other));
  assert.deepEqual(stacked.events, [], 'the check read the release runs for a release PR it refuses anyway');
  // A PR that leaves the manifest alone is no release PR, whatever it was built on, and its head is
  // never fetched.
  const other = runQueueCheck(repo.base, repo.entry.other, queueRef(repo.other.number, repo.base));
  assert.equal(other.status, 0, other.output);
  assert.deepEqual(other.errors, [], other.output);
  assert.ok(!other.has(repo.other.head), 'the check fetched the head of a PR that is no release PR');
  assert.deepEqual(other.events, [], 'the check called gh for a PR that is no release PR');
});

test('the queue check refuses an entry built from an older head of the release PR', () => {
  // The step reads the PR's current head, so an entry the queue built before release-please moved the
  // head would pass the parent check alone. The queue's rebase of a one-commit PR onto its own parent
  // keeps the head's tree, so the entry's tree has to be the current head's.
  const repo = queueFixture();
  const moved = runQueueCheck(repo.base, repo.entry.moved, queueRef(repo.moved.number, repo.base));
  assert.equal(moved.status, 1, moved.output);
  assert.ok(!moved.output.includes('was built on'), `the parent check refused the moved head: ${moved.output}`);
  assert.deepEqual(moved.errors, [
    "::error::This queue entry does not match the release PR's current head, so it was built from an older head. The PR joins the queue again once release-please's update of it lands.",
  ]);
  assert.deepEqual(moved.events, [], 'the check read the release runs for an entry it refuses anyway');
});

test("the queue check waits for main's release run for the base to succeed", () => {
  // release-please computes the release PR from main as it first reads it, then commits it onto main's
  // head as it reads it again. A feature merged in between makes the PR one commit on the feature whose
  // notes miss it, which the parent and tree checks pass. The release run for the base rebuilds the PR
  // from the base, so the entry passes only once that run has completed with success. The newest run
  // counts, by run number, wherever GitHub lists it. A run that is missing, as a push's run can be for a
  // moment, or has not completed is read again every POLL_SECONDS until DEADLINE_SECONDS of waiting
  // have passed. The fake sleep returns at once, so the defaults, 20 and 1200, are shortened only to
  // keep the reads few.
  const repo = queueFixture();
  const wait = { DEADLINE_SECONDS: '60' };
  const check = (answers: ReleaseRun[][], env: Record<string, string> = wait) =>
    runQueueCheck(repo.base, repo.entry.fresh, queueRef(repo.fresh.number, repo.base), answers.map((runs) => releaseRuns(repo.base, ...runs)), env);
  const read = runsQuery(repo.base);
  const pause = 'sleep 20';
  const unfinished = `::error::main's release run for ${repo.base} has not finished yet, so release-please may not have rebuilt this PR on that commit. release-please rebuilds it on main's tip in that run, or else on the next push to main, and its auto-merge adds it to the queue again.`;
  const ended = (conclusion: string): string =>
    `::error::main's release run for ${repo.base} ended ${conclusion}, not success, so release-please may not have rebuilt this PR on that commit. release-please rebuilds it on main's tip on the next push to main, and its auto-merge adds it to the queue again, which takes it once that push's release run has succeeded.`;
  const outcome = (what: string, run: ReturnType<typeof check>, status: number, errors: string[], events: string[]): void => {
    assert.equal(run.status, status, `${what}: ${run.output}`);
    assert.deepEqual(run.errors, errors, `${what}: ${run.output}`);
    assert.deepEqual(run.events, events, `${what}: ${run.output}`);
  };
  const succeeded: ReleaseRun = { run_number: 4, status: 'completed', conclusion: 'success' };
  const running = (status: string): ReleaseRun => ({ run_number: 4, status, conclusion: null });

  outcome('a run that succeeded', check([[succeeded]]), 0, [], [read]);
  outcome('a run that succeeded, read with the default bounds', check([[succeeded]], {}), 0, [], [read]);
  outcome('a run in progress, then succeeded', check([[running('in_progress')], [running('in_progress')], [succeeded]]), 0, [], [read, pause, read, pause, read]);
  outcome('a run queued, then waiting, then succeeded', check([[running('queued')], [running('waiting')], [succeeded]]), 0, [], [read, pause, read, pause, read]);
  // A push's run can be missing for a moment after the push, and a run for another commit or of another
  // event does not stand in for it.
  outcome('no run yet, then a run that succeeded', check([[], [succeeded]]), 0, [], [read, pause, read]);
  outcome(
    'only runs for another commit or of another event, then a run that succeeded',
    runQueueCheck(repo.base, repo.entry.fresh, queueRef(repo.fresh.number, repo.base), [
      releaseRuns(repo.old, succeeded),
      releaseRuns(repo.base, { ...succeeded, event: 'workflow_dispatch' }),
      releaseRuns(repo.base, succeeded),
    ], wait),
    0,
    [],
    [read, pause, read, pause, read],
  );
  // 60 seconds of waiting are three pauses of 20, and the read after the last one is the last.
  const still = [running('in_progress'), running('in_progress'), running('in_progress'), running('in_progress')].map((run) => [run]);
  outcome('a run in progress until the deadline', check(still), 1, [unfinished], [read, pause, read, pause, read, pause, read]);
  outcome('no run until the deadline', check([[], [], [], []]), 1, [unfinished], [read, pause, read, pause, read, pause, read]);
  outcome('a run in progress with no time to wait', check([[running('in_progress')]], { DEADLINE_SECONDS: '0' }), 1, [unfinished], [read]);
  // A completed run that did not succeed fails at once.
  for (const conclusion of ['failure', 'cancelled']) {
    outcome(`a run that ended ${conclusion}`, check([[{ ...succeeded, conclusion }]]), 1, [ended(conclusion)], [read]);
  }
  outcome('a run in progress, then failed', check([[running('in_progress')], [{ ...succeeded, conclusion: 'failure' }]]), 1, [ended('failure')], [read, pause, read]);
  // An older run that failed, listed after the newer run that succeeded, is not the one that counts, and
  // an older run that succeeded does not stand in for a newer one still running.
  outcome('a newer run that succeeded', check([[{ ...succeeded, run_number: 5 }, { ...succeeded, run_number: 3, conclusion: 'failure' }]]), 0, [], [read]);
  outcome(
    'a newer run still in progress',
    check([[{ ...succeeded, run_number: 3 }, { ...running('in_progress'), run_number: 5 }]], { DEADLINE_SECONDS: '0' }),
    1,
    [unfinished],
    [read],
  );
});

test("the queue check refuses a release PR whose base's release run it cannot read", () => {
  // Each of these fails closed at once with one ::error::, after one gh call, without waiting.
  const repo = queueFixture();
  const cannotRead = `::error::Could not read main's release run for ${repo.base}, so this check cannot tell whether release-please has rebuilt the release PR since that commit.`;
  const succeeded = { run_number: 4, status: 'completed', conclusion: 'success' };
  const answers: Array<[string, RunsAnswer]> = [
    ['an error from gh', { response: '{"message":"Resource not accessible by integration","status":"403"}', exit: 1 }],
    ['an error from gh after a list of runs', { ...releaseRuns(repo.base, succeeded), exit: 1 }],
    ['no list of runs', { response: '{"total_count":0,"workflow_runs":null}' }],
    ['a list of runs that is no array', { response: '{"total_count":1,"workflow_runs":{}}' }],
    ['text that is not JSON', { response: 'completed success' }],
    ['no output', { response: '' }],
    ['two documents', { response: `${releaseRuns(repo.base, succeeded).response}\n${releaseRuns(repo.base, succeeded).response}` }],
    ['a status that is not one word', releaseRuns(repo.base, { ...succeeded, status: 'completed success' })],
    ['a conclusion that runs onto a second line', releaseRuns(repo.base, { ...succeeded, conclusion: 'success\n::notice::merged' })],
  ];
  for (const [what, runs] of answers) {
    const run = runQueueCheck(repo.base, repo.entry.fresh, queueRef(repo.fresh.number, repo.base), [runs, releaseRuns(repo.base, succeeded)]);
    assert.equal(run.status, 1, `${what} passes: ${run.output}`);
    assert.deepEqual(run.errors, [cannotRead], `${what}: ${run.output}`);
    assert.deepEqual(run.events, [runsQuery(repo.base)], `${what}: ${run.output}`);
  }
});

test('the queue check reads no release run when its poll interval or deadline is not a whole number of seconds', () => {
  // The step takes both from the environment, so the tests can shorten them, and an empty or unset one
  // takes its default. A poll interval of 0 would read without pause, and a leading 0 would make bash
  // read the number as octal.
  const repo = queueFixture();
  const invalid = '::error::POLL_SECONDS has to be a whole number of seconds above 0, and DEADLINE_SECONDS a whole number of seconds.';
  const succeeded = releaseRuns(repo.base, { run_number: 4, status: 'completed', conclusion: 'success' });
  const cases: Array<[string, Record<string, string>]> = [
    ['a poll interval of 0', { POLL_SECONDS: '0' }],
    ['a poll interval with a leading 0', { POLL_SECONDS: '08' }],
    ['a fractional poll interval', { POLL_SECONDS: '1.5' }],
    ['a negative deadline', { DEADLINE_SECONDS: '-1' }],
    ['a deadline with a leading 0', { DEADLINE_SECONDS: '060' }],
    ['a deadline that is a command', { DEADLINE_SECONDS: '60; echo' }],
  ];
  for (const [what, env] of cases) {
    const run = runQueueCheck(repo.base, repo.entry.fresh, queueRef(repo.fresh.number, repo.base), [succeeded], env);
    assert.equal(run.status, 1, `${what} passes: ${run.output}`);
    assert.deepEqual(run.errors, [invalid], `${what}: ${run.output}`);
    assert.deepEqual(run.events, [], `${what} reads the release runs`);
  }
});

test('the queue check refuses a release PR whose base or ref it cannot read', () => {
  // Each of these fails closed with one ::error::, before git reads the value.
  const repo = queueFixture();
  const { number } = repo.fresh;
  const refs: Array<[string, string]> = [
    ['a ref naming another base', queueRef(number, repo.old)],
    ['a ref naming the PR head for its base', queueRef(number, repo.fresh.head)],
    ['a ref without the base', `refs/heads/gh-readonly-queue/main/pr-${number}`],
    ['a ref without the number', `refs/heads/gh-readonly-queue/main/pr--${repo.base}`],
    ['a short base in the ref', queueRef(number, repo.base.slice(0, 12))],
    ['an uppercase base in the ref', queueRef(number, repo.base.toUpperCase())],
    ['a ref with a trailing newline', `${queueRef(number, repo.base)}\n`],
    ['a ref outside the queue', `refs/heads/main/pr-${number}-${repo.base}`],
    ['a branch name without refs/heads/', `gh-readonly-queue/main/pr-${number}-${repo.base}`],
    ['no ref', ''],
  ];
  for (const [what, ref] of refs) {
    const run = runQueueCheck(repo.base, repo.entry.fresh, ref);
    assert.equal(run.status, 1, `${what} passes: ${run.output}`);
    assert.equal(run.errors.length, 1, `${what} fails without exactly one ::error::: ${run.output}`);
    assert.ok(!run.has(repo.fresh.head), `${what} fetched the PR head`);
  }
  for (const [what, base] of [['no base', ''], ['a base with a trailing newline', `${repo.base}\n`], ['a short base', repo.base.slice(0, 12)]] as const) {
    const run = runQueueCheck(base, repo.entry.fresh, queueRef(number, repo.base));
    assert.equal(run.status, 1, `${what} passes: ${run.output}`);
    assert.equal(run.errors.length, 1, `${what} fails without exactly one ::error::: ${run.output}`);
  }
  // A pull request origin serves no head for fails the step too.
  const missing = runQueueCheck(repo.base, repo.entry.fresh, queueRef(99, repo.base));
  assert.notEqual(missing.status, 0, missing.output);
});

test('the queue check keys on the manifest release-please bumps in every release PR', () => {
  // release-please writes the version into .release-please-manifest.json in every release PR it
  // opens, so every release PR changes the file the check reads. Another PR that changed it would be
  // taken for a release PR and refused unless it were one commit on main's tip, which fails closed.
  const manifest = RELEASE_PLEASE_INPUTS['manifest-file'];
  assert.equal(mappingOf(stepInputs(pleaseJobSteps().find(isReleasePlease)!))['manifest-file'], manifest);
  assert.ok(stepScript(queueCheckStep())!.includes(`"$GITHUB_SHA" -- ${manifest} `), `the queue check does not read ${manifest}`);
  // The root package's version sits there, so a release changes it.
  assert.deepEqual(JSON.parse(read(manifest)), { '.': PACKAGE_VERSION });
});

test('release-please rebuilds an open release PR on main on every push', () => {
  // The queue check refuses a release PR that is not built on its queue base, so the PR has to be rebuilt
  // on main's tip after every merge that lands before it. release-please leaves an open release PR
  // alone while its body stays the same, as it does after a ci:, docs: or chore: merge, unless
  // always-update is on. Then it force-pushes the PR as one commit on main's tip, reports it, and the
  // please job turns its auto-merge on again. release-please reads always-update at the config's root
  // only, and ignores it on a package.
  const { packages, ...root } = JSON.parse(read('release-please-config.json')) as Record<string, unknown> & {
    packages: Record<string, Record<string, unknown>>;
  };
  assert.equal(root['always-update'], true, 'release-please-config.json does not set always-update at its root');
  for (const [path, config] of Object.entries(packages)) {
    assert.ok(!Object.hasOwn(config, 'always-update'), `package ${path} sets always-update, which release-please ignores there`);
  }
});
