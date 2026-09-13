import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/**
 * The release workflow cannot run inside the suite, and every property pinned here
 * breaks publishing silently: the mistake surfaces when a release PR merges, usually
 * after the tag already exists. Each one is checkable from the files alone.
 */

const root = fileURLToPath(new URL('..', import.meta.url));
const read = (rel: string): string => readFileSync(`${root}${rel}`, 'utf8');

const workflow = (): string => read('.github/workflows/release.yml');

/**
 * The workflow without comments or blank lines. Its own prose says "this job holds
 * id-token: write", so a presence check against the raw text passes with the permission
 * deleted. A YAML comment starts at a `#` preceded by whitespace, and none of this
 * workflow's values contain one.
 */
const workflowCode = (): string =>
  workflow()
    .split('\n')
    .map((line) => line.replace(/(^|\s)#.*$/, '').trimEnd())
    .filter((line) => line !== '')
    .join('\n');

/**
 * The lines nested under `key:` where it is a direct child of `yaml`, a key at the block's
 * shallowest indentation, or '' when there is none. A deeper key of the same name, such as
 * a job's own `concurrency:`, does not count.
 */
const under = (yaml: string, key: string): string => {
  const indents = yaml.split('\n').filter((line) => line.trim() !== '').map((line) => line.search(/\S/));
  if (indents.length === 0) return '';
  const depth = Math.min(...indents);
  return new RegExp(`^ {${depth}}${key}:\\n((?: {${depth + 1},}.*(?:\\n|$))*)`, 'm').exec(yaml)?.[1] ?? '';
};

const releaseJob = (): string => under(under(workflowCode(), 'jobs'), 'release');

/**
 * The release job's own permissions block. It replaces the workflow-level block instead
 * of adding to it, so every grant the job needs has to sit here.
 */
const releaseJobPermissions = (): string => under(releaseJob(), 'permissions');

/** The release job's steps, one string per list item. */
const releaseJobSteps = (): string[] => {
  const steps = under(releaseJob(), 'steps');
  const marker = /^ *- /.exec(steps)?.[0];
  return marker ? steps.split(new RegExp(`^(?=${marker})`, 'm')) : [];
};

/** The steps that follow the release-please step in the release job. */
const stepsAfterReleasePlease = (): string[] => {
  const steps = releaseJobSteps();
  const releasePlease = steps.findIndex((step) =>
    /^ *(?:- +)?uses: *googleapis\/release-please-action@/m.test(step),
  );
  assert.notEqual(releasePlease, -1, 'the release job has no release-please step');
  return steps.slice(releasePlease + 1);
};

const stepIf = (step: string): string | undefined => /^ *if: *(.*)$/m.exec(step)?.[1];

const stepName = (step: string): string =>
  /^ *(?:- +)?(?:name|id|uses|run): *(.*)$/m.exec(step)?.[1] ?? step.trim();

/** The condition every building and publishing step carries. */
const PUBLISH_GATE = '${{ steps.release.outputs.release_created && steps.release.outputs.sha == github.sha }}';

/** Its opposite: a release was created, but this run was triggered at another commit. */
const DIVERGED = '${{ steps.release.outputs.release_created && steps.release.outputs.sha != github.sha }}';

/** The step that fails a diverged run: on the diverged condition, with no publish and no action. */
const isAlarm = (step: string): boolean =>
  stepIf(step) === DIVERGED && !/\bnpm publish\b/.test(step) && !/^ *(?:- +)?uses:/m.test(step);

/**
 * Every `run:` script in the raw workflow text, block scalars included. Comments stay in,
 * because GitHub substitutes `${{ }}` inside a block scalar's comment lines too.
 */
const runScripts = (yaml: string): string[] => {
  const lines = yaml.split('\n');
  return lines.flatMap((line, index) => {
    const match = /^( *(?:- +)?)run:(.*)$/.exec(line);
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

test('the npm that publishes is installed at an exact version', () => {
  // The job holds id-token: write, so a floating install is the one unpinned thing in it.
  // Each global install of npm is checked, not just the first, because the last one wins.
  const specs = [...workflowCode().matchAll(/\bnpm +(?:install|i|add)\b([^\n;&|]*)/g)]
    .map((match) => match[1]!.trim().split(/ +/))
    .filter((args) => args.includes('-g') || args.includes('--global'))
    .flatMap((args) => args.filter((arg) => /^npm(@|$)/.test(arg)));
  assert.ok(specs.length > 0, 'no step installs the npm that trusted publishing needs');
  for (const spec of specs) {
    assert.match(spec, /^npm@\d+\.\d+\.\d+$/, `${spec} is not an exact version`);
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
  const setup = code.search(/uses: *pnpm\/action-setup@/);
  const publish = code.search(/\bnpm publish\b/);
  assert.notEqual(setup, -1, 'the workflow never sets up pnpm');
  assert.notEqual(publish, -1, 'the workflow never runs npm publish');
  assert.ok(setup < publish, 'pnpm/action-setup runs after npm publish');
});

test('the release job checks out the commit release-please tagged', () => {
  // Without a ref, checkout takes the commit that triggered the run, and that run can be a
  // later push creating the release for an earlier merge. The tests and the publish would
  // then use code the tag does not point at, under a version npm never lets be reused.
  const checkouts = releaseJobSteps().filter((step) => /^ *(?:- +)?uses: *actions\/checkout@/m.test(step));
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
  // conditions. The alarm below is the only step exempt.
  const after = stepsAfterReleasePlease();
  assert.ok(after.some((step) => /\bnpm publish\b/.test(step)), 'no step after release-please runs npm publish');
  for (const step of after.filter((step) => !isAlarm(step))) {
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

test('the released output is true only once npm accepted the publish', () => {
  // A job output is a string, so an expression that evaluates to false arrives as 'false',
  // which a bare if: treats as true. The publish step writes released=true after npm publish,
  // and the default bash -e stops the script at a failed publish, so the output is 'true'
  // or empty.
  const publishing = releaseJobSteps().filter((step) => /\bnpm publish\b/.test(step));
  assert.equal(publishing.length, 1, 'expected exactly one step that runs npm publish');
  const step = publishing[0]!;
  const id = /^ *(?:- +)?id: *(\S+)$/m.exec(step)?.[1];
  assert.ok(id, 'the npm publish step has no id');
  const released = /^ *released: *(.*)$/m.exec(under(releaseJob(), 'outputs'))?.[1];
  assert.equal(released, `\${{ steps.${id}.outputs.released }}`, 'released does not read the publish step');
  const write = step.search(/released=true.*>> *"?\$GITHUB_OUTPUT"?/);
  assert.notEqual(write, -1, 'the publish step never writes released=true to $GITHUB_OUTPUT');
  assert.ok(step.search(/\bnpm publish\b/) < write, 'released=true is written before npm publish runs');
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
