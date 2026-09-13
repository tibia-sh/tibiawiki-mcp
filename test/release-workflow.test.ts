import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
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

/** The indentation of a block's shallowest lines, where its own keys sit. */
const depthOf = (yaml: string): number | undefined => {
  const indents = yaml.split('\n').filter((line) => line.trim() !== '').map((line) => line.search(/\S/));
  return indents.length === 0 ? undefined : Math.min(...indents);
};

/**
 * The lines nested under `key:` where it is a direct child of `yaml`, a key at the block's
 * shallowest indentation, or '' when there is none. A deeper key of the same name, such as
 * a job's own `concurrency:`, does not count.
 */
const under = (yaml: string, key: string): string => {
  const depth = depthOf(yaml);
  if (depth === undefined) return '';
  return new RegExp(`^ {${depth}}${key}:\\n((?: {${depth + 1},}.*(?:\\n|$))*)`, 'm').exec(yaml)?.[1] ?? '';
};

/**
 * What follows `key:` where it is a direct child of `yaml`, as `under` finds it: the value
 * without the quotes YAML allows around it, '' when a nested block follows instead, or
 * undefined when there is no such key.
 */
const scalar = (yaml: string, key: string): string | undefined => {
  const depth = depthOf(yaml);
  if (depth === undefined) return undefined;
  return new RegExp(`^ {${depth}}${key}: *(.*)$`, 'm').exec(yaml)?.[1]?.replace(/^(['"])(.*)\1$/, '$2');
};

const releaseJob = (): string => under(under(workflowCode(), 'jobs'), 'release');

const registryJob = (): string => under(under(workflowCode(), 'jobs'), 'registry');

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

/** A step with its list marker turned into spaces, so its first key sits at the depth of the others. */
const stepBody = (step: string): string =>
  step.replace(/^( *)(- +)/, (_, indent: string, marker: string) => indent + ' '.repeat(marker.length));

/**
 * The script a step's `run:` hands to bash: the value itself, or the lines of a `run: |`
 * block without the block's indentation. Undefined for a step that runs no script. It reads
 * the step as `workflowCode` leaves it, so comment lines inside a block are already gone.
 */
const stepScript = (step: string): string | undefined => {
  const body = stepBody(step);
  const depth = depthOf(body);
  if (depth === undefined) return undefined;
  const run = new RegExp(`^ {${depth}}run: *(.*)\\n?((?: {${depth + 1},}.*(?:\\n|$))*)`, 'm').exec(body);
  if (!run) return undefined;
  if (!/^\|[-+]?$/.test(run[1]!)) return run[1]!;
  const lines = run[2]!.split('\n').filter((line) => line.trim() !== '');
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

/**
 * A stand-in for curl, reading and writing a run's files in $NPM_WAIT_RUN. Call N answers with
 * line N of `responses`, and the last line repeats once they run out. `STATUS FILE` is an HTTP
 * response with that body, and `exit CODE` is a transfer that failed with no response, such as a
 * timeout. It follows real curl where the wait relies on it: with -f an HTTP error fails the call
 * and writes no body, and --write-out still prints the status, or 000 when no response came. Each
 * call's arguments go to `calls`, one call per line. An option it does not know fails the call,
 * so a changed command cannot pass on a guess.
 */
const FAKE_CURL = `#!/usr/bin/env bash
here="$NPM_WAIT_RUN"
printf '%s\\n' "$*" >> "$here/calls"
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
`;

/** A stand-in for sleep that returns at once, and records what it was asked for in the run's `sleeps`. */
const FAKE_SLEEP = `#!/usr/bin/env bash
printf '%s\\n' "$*" >> "$NPM_WAIT_RUN/sleeps"
`;

/**
 * The directory holding the fake curl and sleep, written once for the file. macOS scans a new
 * executable the first time it runs, which costs a fresh pair about 400 ms on every run.
 */
let fakes: string | undefined;
const fakeBin = (): string => {
  if (fakes === undefined) {
    fakes = scratch();
    writeFileSync(join(fakes, 'curl'), FAKE_CURL, { mode: 0o755 });
    writeFileSync(join(fakes, 'sleep'), FAKE_SLEEP, { mode: 0o755 });
  }
  return fakes;
};

/** One try's outcome: an HTTP status with a JSON body, or the curl exit code of a failed transfer. */
type NpmResponse = { status: number; body: unknown } | { curlExit: number };

/**
 * Runs the registry job's npm wait for v1.2.3, as the checks above run their scripts, with the
 * fake curl and sleep first on PATH. jq and everything else is real.
 */
const runNpmWait = (responses: NpmResponse[]) => {
  const waits = npmWaitSteps();
  assert.equal(waits.length, 1, 'expected exactly one registry job step that polls npm');
  const dir = scratch();
  const lines = responses.map((response, index) => {
    if ('curlExit' in response) return `exit ${response.curlExit}`;
    writeFileSync(join(dir, `body-${index}`), JSON.stringify(response.body));
    return `${response.status} body-${index}`;
  });
  writeFileSync(join(dir, 'responses'), `${lines.join('\n')}\n`);
  const env = { TAG: 'v1.2.3', PATH: `${fakeBin()}:${process.env['PATH'] ?? ''}`, NPM_WAIT_RUN: dir };
  const run = bash(stepScript(waits[0]!)!, env, dir);
  const recorded = (file: string): string[] =>
    existsSync(join(dir, file)) ? readFileSync(join(dir, file), 'utf8').split('\n').filter((line) => line !== '') : [];
  return {
    status: run.status,
    stdout: run.stdout,
    output: `${run.stdout}${run.stderr}`,
    calls: recorded('calls'),
    sleeps: recorded('sleeps'),
  };
};

/** npm's manifest for v1.2.3 of the package server.json registers, as the registry reads it. */
const publishedManifest = () => {
  const server = JSON.parse(read('server.json')) as { name: string; packages: { identifier: string }[] };
  return { name: server.packages[0]!.identifier, version: '1.2.3', mcpName: server.name };
};

/** npm's answer for a version it does not serve. */
const NOT_FOUND: NpmResponse = { status: 404, body: 'version not found: 1.2.3' };

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
  const login = steps.findIndex((step) => /^\.\/mcp-publisher login\b/m.test(stepScript(step) ?? ''));
  assert.ok(login !== -1 && wait < login, 'npm is polled after the login, where the wait can outlast its token');
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
  const rejected: Array<[string, NpmResponse]> = [
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
  // Written into a run script, the key would be pasted into the shell as code. In a step's env
  // it is a variable only that step's process sees.
  const references = workflowCode().split('\n').filter((line) => /\bsecrets\b/.test(line));
  assert.equal(references.length, 1, `expected one reference to a secret: ${references.join(' |')}`);
  const steps = registryJobSteps().filter((step) => /\bsecrets\b/.test(step));
  assert.equal(steps.length, 1, 'no registry job step references the secret');
  const step = steps[0]!;
  assert.match(
    under(stepBody(step), 'env'),
    /^ *MCP_PRIVATE_KEY: *\$\{\{ secrets\.MCP_PRIVATE_KEY \}\}$/m,
    'the secret does not reach the step through its env',
  );
  assert.equal(
    stepScript(step),
    './mcp-publisher login dns --domain tibia.sh --private-key "$MCP_PRIVATE_KEY"',
    'the step that holds the key runs something besides the login',
  );
});

test('the registry job publishes after it logs in', () => {
  // Without the publish step the job goes green and registers nothing.
  const scripts = registryJobSteps().map((step) => stepScript(step) ?? '');
  const login = scripts.findIndex((script) => /^\.\/mcp-publisher login\b/m.test(script));
  const publish = scripts.filter((script) => /^\.\/mcp-publisher publish$/m.test(script));
  assert.equal(publish.length, 1, 'expected exactly one step that runs ./mcp-publisher publish');
  assert.ok(login !== -1 && login < scripts.indexOf(publish[0]!), 'the publish runs before the login');
});

test('every registry job step runs, and any failure stops the job', () => {
  // A check skipped by its own `if:`, or a failure let through by `continue-on-error`, a shell
  // without -e or `set +e`, lets the job publish past a check that did not hold. The checks above
  // run each script under `bash -e` for the same reason.
  const registry = registryJob();
  assert.equal(scalar(registry, 'continue-on-error'), undefined, 'the registry job lets its own failure through');
  assert.equal(scalar(registry, 'defaults'), undefined, 'the registry job sets defaults for its steps');
  assert.equal(scalar(workflowCode(), 'defaults'), undefined, 'the workflow sets defaults for its steps');
  for (const step of registryJobSteps()) {
    for (const key of ['if', 'continue-on-error', 'shell']) {
      assert.equal(scalar(stepBody(step), key), undefined, `${stepName(step)} sets ${key}`);
    }
    assert.doesNotMatch(stepScript(step) ?? '', /\bset +\+[a-z]*e|\bset +\+o +errexit\b/, `${stepName(step)} turns off -e`);
  }
});

test('no step traces the commands it runs', () => {
  // A trace prints each command with its variables expanded, and the login command carries the key.
  assert.doesNotMatch(workflowCode(), /\bset +-[a-z]*x|\bxtrace\b|\bbash +-[a-z]*x/);
});
