import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { setGenerator } from '../scripts/set-generator.ts';
import { GENERATOR, GENERATOR_SHA256 } from '../src/indexer/build-index.ts';
import { attestationFlags, generatorWheelUrl } from '../src/indexer/generator-release.ts';
import { tempDirs } from './harness.ts';
import {
  APP, APP_TOKEN_ACTION, appTokenStep, assertDefaultShell, bash, entryOf, isAppToken, isCheckout, isPnpmSetup, jobSteps,
  mappingOf, read, recorded, root, scalar, stepBody, stepIf, stepInputs, stepName, stepScript, under, workflowCode,
  workflowJobs,
} from './workflow.ts';

/**
 * generator.yml cannot run inside the suite. Its prepare job runs dependency code and holds no
 * App token, and its propose job holds the token and must trust nothing prepare hands on. Each
 * property that keeps them apart is pinned here, the propose job's checks word for word, and the
 * checks run against stand-in gh, curl and timeout.
 */

const FILE = 'generator.yml';
const code = (): string => workflowCode(FILE);
const prepareJob = (): string => under(under(code(), 'jobs'), 'prepare');
const proposeJob = (): string => under(under(code(), 'jobs'), 'propose');

/** The one step of `job` that `stepName` calls `name`. */
const stepNamed = (job: string, name: string): string => {
  const found = jobSteps(job).filter((step) => stepName(step) === name);
  assert.equal(found.length, 1, `expected exactly one step named ${name}`);
  return found[0]!;
};

const envOf = (step: string): Record<string, string> => mappingOf(under(stepBody(step), 'env'));

/** Where both jobs take the requested version from: the dispatch's payload, or the manual run's input. */
const VERSION_ENV =
  "${{ github.event_name == 'repository_dispatch' && github.event.client_payload.version || inputs.version }}";

/** The conditions the steps of prepare and propose run on. */
const IF_PREPARED = "${{ steps.decide.outputs.decision == 'propose' }}";
const IF_PROPOSE = "${{ steps.decide.outputs.action == 'propose' }}";
const IF_REARM = "${{ steps.decide.outputs.action == 'rearm' }}";
const IF_WRITE = "${{ steps.decide.outputs.action == 'propose' || steps.decide.outputs.action == 'rearm' }}";
const IF_SUPERSEDE =
  "${{ steps.decide.outputs.supersede != '' && (steps.decide.outputs.action == 'propose' || steps.decide.outputs.action == 'rearm') }}";

const CHECKOUT = 'actions/checkout@08c6903cd8c0fde910a37f88322edcfb5dd907a8';
const SETUP_NODE = 'actions/setup-node@a0853c24544627f65ddf259abe73b1d18a591444';
const PNPM_SETUP = 'pnpm/setup@703c52620218391530e48b9e8870d5c0082e1b9b';
const SETUP_UV = 'astral-sh/setup-uv@bec219d24cd3e171d82865faccec33120bb574f4';
const UPLOAD = 'actions/upload-artifact@043fb46d1a93c77aae656e7c1c64a875d1fc6a0a';
const DOWNLOAD = 'actions/download-artifact@3e5f45b2cfb9172054b4087a40e8e0b5a5461e7c';

/**
 * The scripts that check a request and write, word for word. Each holds or guards the App token, or
 * decides what prepare's work may reach it, so a change here has to change this test on purpose.
 */
const CHECK_VERSION_SCRIPT = String.raw`if [[ ! $VERSION =~ ^[0-9]+\.[0-9]+\.[0-9]+\+tibiash\.[0-9]+$ ]]; then
  echo "::error::The requested generator version is not x.y.z+tibiash.N."
  exit 1
fi`;

const ATTEST_SCRIPT = String.raw`url="$(node --input-type=module -e '
  import { generatorWheelUrl } from "./src/indexer/generator-release.ts";
  process.stdout.write(generatorWheelUrl(process.argv[1]));
' "$VERSION")"
flag_lines="$(node --input-type=module -e '
  import { attestationFlags } from "./src/indexer/generator-release.ts";
  process.stdout.write(attestationFlags(process.argv[1]).join("\n"));
' "$VERSION")"
mapfile -t flags <<< "$flag_lines"
wheel="$RUNNER_TEMP/generator.whl"
curl -fsSL --max-time 300 -o "$wheel" "$url"
timeout --kill-after=10 300 gh attestation verify "$wheel" "${'${'}flags[@]}"
sha256="$(sha256sum "$wheel")"
echo "sha256=${'${'}sha256%% *}" >> "$GITHUB_OUTPUT"`;

const DECIDE_SCRIPT = String.raw`decision="$(node scripts/set-generator.ts decide "$VERSION")"
action="$(jq -r .action <<< "$decision")"
echo "decision=$action" >> "$GITHUB_OUTPUT"
case $action in
  propose) echo "Pinning $VERSION: $decision" ;;
  rearm) echo "The pull request for $VERSION is open with auto-merge off, so the propose job turns it on: $decision" ;;
  noop) echo "Nothing to do for $VERSION: main pins it, its pull request is open with auto-merge on, or a newer version's is open." ;;
  refuse)
    echo "::error::main pins a newer generator than $VERSION, so it was not pinned."
    exit 1
    ;;
  *)
    echo "::error::set-generator.ts decide printed an unknown decision."
    exit 1
    ;;
esac`;

const VALIDATE_SCRIPT = String.raw`if [[ ! $VERSION =~ ^[0-9]+\.[0-9]+\.[0-9]+\+tibiash\.[0-9]+$ ]]; then
  echo "::error::The requested generator version is not x.y.z+tibiash.N."
  exit 1
fi
if [[ ! $PREPARED =~ ^(propose|rearm)$ ]]; then
  echo "::error::prepare decided neither propose nor rearm."
  exit 1
fi
if [[ $PREPARED == propose && ( ! $BUILD_INDEX_SHA256 =~ ^[0-9a-f]{64}$ || ! $REQUIREMENTS_SHA256 =~ ^[0-9a-f]{64}$ ) ]]; then
  echo "::error::prepare handed on a hash of the prepared files that is not a SHA-256 hex digest."
  exit 1
fi`;

const DECIDE_AGAIN_SCRIPT = String.raw`decision="$(node scripts/set-generator.ts decide "$VERSION")"
action="$(jq -r .action <<< "$decision")"
supersede="$(jq -r '.supersede | map(tostring) | join(" ")' <<< "$decision")"
pr="$(jq -r '.pr // ""' <<< "$decision")"
if [[ ! $action =~ ^(noop|refuse|rearm|propose)$ || ! $supersede =~ ^([0-9]+( [0-9]+)*)?$ || ! $pr =~ ^[0-9]*$ ]]; then
  echo "::error::set-generator.ts decide printed a decision this step cannot read."
  exit 1
fi
if [[ $action == propose && $PREPARED != propose ]]; then
  echo "::error::$VERSION needs a new pull request now, but prepare decided $PREPARED and prepared nothing. Dispatch generator.yml again with the version."
  exit 1
fi
if [[ $action == noop || $action == refuse ]]; then
  echo "main moved since prepare decided, and now nothing is to be done for $VERSION: $decision"
fi
{
  echo "action=$action"
  echo "supersede=$supersede"
  echo "pr=$pr"
} >> "$GITHUB_OUTPUT"`;

const TAKE_SCRIPT = String.raw`prepared="$RUNNER_TEMP/prepared"
build_index="$(sha256sum "$prepared/src/indexer/build-index.ts")"
requirements="$(sha256sum "$prepared/data/tibiawikisql-requirements.txt")"
if [[ ${'${'}build_index%% *} != "$BUILD_INDEX_SHA256" || ${'${'}requirements%% *} != "$REQUIREMENTS_SHA256" ]]; then
  echo "::error::The prepared files are not the ones prepare hashed."
  exit 1
fi
cp "$prepared/src/indexer/build-index.ts" src/indexer/build-index.ts
cp "$prepared/data/tibiawikisql-requirements.txt" data/tibiawikisql-requirements.txt
if [[ "$(git diff --name-only)" != $'data/tibiawikisql-requirements.txt\nsrc/indexer/build-index.ts' ]]; then
  echo "::error::The prepared files change other files than build-index.ts and the lock, or leave one of them as it was."
  exit 1
fi
numstat="$(git diff --numstat -- src/indexer/build-index.ts)"
constants="$(git diff --unified=0 --no-color -- src/indexer/build-index.ts | grep -cE "^[-+]export const GENERATOR_(VERSION|SHA256) = '[^']*';$" || true)"
if [[ $numstat != $'2\t2\tsrc/indexer/build-index.ts' || $constants != 4 ]]; then
  echo "::error::The prepared build-index.ts changes more than GENERATOR_VERSION and GENERATOR_SHA256."
  exit 1
fi`;

const LOCKED_SCRIPT = String.raw`node --input-type=module -e '
  import { readFileSync } from "node:fs";
  import { assertGeneratorLocked, generatorWheelUrl } from "./src/indexer/generator-release.ts";
  const [version, sha256] = process.argv.slice(1);
  const lock = readFileSync("data/tibiawikisql-requirements.txt", "utf8");
  assertGeneratorLocked(lock, ${'`'}tibiawikisql @ ${'${'}generatorWheelUrl(version)}${'`'}, sha256);
' "$VERSION" "$SHA256"`;

const RECOMPUTE_SCRIPT = String.raw`git show HEAD:src/indexer/build-index.ts > "$RUNNER_TEMP/checked-out-build-index.ts"
node --input-type=module -e '
  import { readFileSync } from "node:fs";
  import { setGenerator } from "./scripts/set-generator.ts";
  const [version, sha256, checkedOut] = process.argv.slice(1);
  const expected = setGenerator(readFileSync(checkedOut, "utf8"), version, sha256);
  if (readFileSync("src/indexer/build-index.ts", "utf8") !== expected) {
    throw new Error("The prepared build-index.ts is not the checked-out one with " + version + " and sha256:" + sha256 + ".");
  }
' "$VERSION" "$SHA256" "$RUNNER_TEMP/checked-out-build-index.ts"`;

const CLOSE_SCRIPT = String.raw`for number in $SUPERSEDE; do
  if [[ ! $number =~ ^[0-9]+$ ]]; then
    echo "::error::A pull request to close has no plain number."
    exit 1
  fi
  timeout --kill-after=10 120 gh pr close "$number" --comment "Superseded by the pull request for the generator $VERSION."
done`;

const REARM_SCRIPT = String.raw`if [[ ! $PR =~ ^[0-9]+$ ]]; then
  echo "::error::The pull request to re-arm has no plain number."
  exit 1
fi
timeout --kill-after=10 120 gh pr merge "$PR" --auto --rebase`;

const PUSH_SCRIPT = String.raw`branch="generator/$VERSION"
title="fix: move the generator to $VERSION"
git add src/indexer/build-index.ts data/tibiawikisql-requirements.txt
git commit --quiet -m "$title"
timeout --kill-after=10 120 git -c credential.helper= \
  -c 'credential.helper=!f() { echo username=x-access-token; echo "password=$GH_TOKEN"; }; f' \
  push --force origin "HEAD:refs/heads/$branch"
found="$(timeout --kill-after=10 120 gh pr list --head "$branch" --base main --state open --json number,isCrossRepository,autoMergeRequest \
  --jq 'map(select(.isCrossRepository | not)) | .[0] // empty | "\(.number) \(.autoMergeRequest != null)"')"
number=
armed=false
if [[ -n $found ]]; then
  if [[ ! $found =~ ^([0-9]+)\ (true|false)$ ]]; then
    echo "::error::The lookup of the open pull request for $branch printed something else than its number and auto-merge."
    exit 1
  fi
  number="${'${'}BASH_REMATCH[1]}"
  armed="${'${'}BASH_REMATCH[2]}"
fi
if [[ -z $number ]]; then
  body="$(printf 'Moves the generator pin to ${'`'}%s${'`'}, the wheel with sha256 ${'`'}%s${'`'}, whose attestation this run verified for ${'`'}refs/tags/v%s${'`'}, and regenerates ${'`'}data/tibiawikisql-requirements.txt${'`'}.\n\nRun: %s/%s/actions/runs/%s\n' \
    "$VERSION" "$SHA256" "$VERSION" "$GITHUB_SERVER_URL" "$GITHUB_REPOSITORY" "$GITHUB_RUN_ID")"
  url="$(timeout --kill-after=10 120 gh pr create --head "$branch" --base main --title "$title" --body "$body")"
  number="${'${'}url##*/}"
fi
if [[ ! $number =~ ^[0-9]+$ ]]; then
  echo "::error::The pull request for $branch has no plain number."
  exit 1
fi
if [[ $armed == true ]]; then
  echo "Auto-merge is already on for pull request $number."
else
  timeout --kill-after=10 120 gh pr merge "$number" --auto --rebase
fi`;

const BUILD_SCRIPT = String.raw`git show refs/remotes/origin/main:src/indexer/build-index.ts > "$RUNNER_TEMP/main-build-index.ts"
node --input-type=module -e '
  import { readFileSync, writeFileSync } from "node:fs";
  import { setGenerator } from "./scripts/set-generator.ts";
  const [version, sha256, main, out] = process.argv.slice(1);
  writeFileSync(out, setGenerator(readFileSync(main, "utf8"), version, sha256));
' "$VERSION" "$SHA256" "$RUNNER_TEMP/main-build-index.ts" "$RUNNER_TEMP/build-index.ts"
cp data/tibiawikisql-requirements.txt "$RUNNER_TEMP/tibiawikisql-requirements.txt"
git checkout --quiet --force --detach refs/remotes/origin/main
cp "$RUNNER_TEMP/build-index.ts" src/indexer/build-index.ts
cp "$RUNNER_TEMP/tibiawikisql-requirements.txt" data/tibiawikisql-requirements.txt
if [[ "$(git diff --name-only)" != $'data/tibiawikisql-requirements.txt\nsrc/indexer/build-index.ts' ]]; then
  echo "::error::Against main, the commit changes other files than build-index.ts and the lock, or leaves one of them as it was."
  exit 1
fi
numstat="$(git diff --numstat -- src/indexer/build-index.ts)"
constants="$(git diff --unified=0 --no-color -- src/indexer/build-index.ts | grep -cE "^[-+]export const GENERATOR_(VERSION|SHA256) = '[^']*';$" || true)"
if [[ $numstat != $'2\t2\tsrc/indexer/build-index.ts' || $constants != 4 ]]; then
  echo "::error::Against main, build-index.ts changes more than GENERATOR_VERSION and GENERATOR_SHA256."
  exit 1
fi`;

test('generator.yml is named generator, starts on generator-release or a manual run with a version, and runs one at a time', () => {
  // alert.yml matches it by this name. Runs wait for each other and a pending one is never
  // replaced, so a second release's request waits for the first one's pull request.
  const workflow = code();
  assert.equal(scalar(workflow, 'name'), 'generator');
  const on = under(workflow, 'on');
  assert.deepEqual(Object.keys(mappingOf(on)), ['repository_dispatch', 'workflow_dispatch']);
  assert.deepEqual(mappingOf(under(on, 'repository_dispatch')), { types: '[generator-release]' });
  assert.deepEqual(mappingOf(under(under(under(on, 'workflow_dispatch'), 'inputs'), 'version')), {
    description: 'Generator version to pin, such as 9.0.0+tibiash.3',
    required: 'true',
  });
  assert.equal(scalar(workflow, 'permissions'), '{}');
  assert.deepEqual(mappingOf(under(workflow, 'concurrency')), { group: 'generator', 'cancel-in-progress': 'false', queue: 'max' });
  assert.deepEqual(workflowJobs(FILE).map(([name]) => name), ['prepare', 'propose']);
  for (const [name, job] of workflowJobs(FILE)) {
    assert.deepEqual(mappingOf(under(job, 'env')), { VERSION: VERSION_ENV }, `the ${name} job takes the version from elsewhere`);
    assert.deepEqual(mappingOf(under(job, 'permissions')), { contents: 'read', 'pull-requests': 'read' });
    assert.equal(scalar(job, 'runs-on'), 'ubuntu-latest');
    assert.equal(scalar(job, 'continue-on-error'), undefined);
    for (const step of jobSteps(job)) {
      assertDefaultShell(job, step, FILE);
      assert.equal(scalar(stepBody(step), 'continue-on-error'), undefined, `${stepName(step)} lets its own failure through`);
      assert.doesNotMatch(stepScript(step) ?? '', /\bset +\+[a-z]*e|\bset +\+o +errexit\b|\bset +-[a-z]*x/, `${stepName(step)} turns off -e or traces`);
    }
  }
});

test('prepare holds no App token and no environment', () => {
  // It installs the package's dependencies, runs the generator's lock sequence and the suite, so a
  // token or an environment secret here would reach dependency code.
  const prepare = prepareJob();
  assert.equal(scalar(prepare, 'environment'), undefined, 'prepare names an environment');
  assert.equal(scalar(prepare, 'needs'), undefined);
  assert.equal(scalar(prepare, 'timeout-minutes'), '45');
  assert.ok(!jobSteps(prepare).some(isAppToken), 'prepare mints an App token');
  assert.doesNotMatch(prepare, /create-github-app-token|\bsecrets\.|\bvars\./, 'prepare reads a secret or the App');
  assert.deepEqual(mappingOf(under(prepare, 'outputs')), {
    decision: '${{ steps.decide.outputs.decision }}',
    build_index_sha256: '${{ steps.hash.outputs.build_index_sha256 }}',
    requirements_sha256: '${{ steps.hash.outputs.requirements_sha256 }}',
  });
});

test('prepare checks the version, verifies the attestation and decides before anything installs', () => {
  // The attestation is verified on every request, a noop included, with github.token. Only a
  // propose decision installs, pins, locks, tests and uploads the two files.
  const prepare = prepareJob();
  const steps = jobSteps(prepare);
  assert.deepEqual(steps.map((step) => [stepName(step), stepIf(step)]), [
    [CHECKOUT, undefined],
    [SETUP_NODE, undefined],
    ['Check the version', undefined],
    ["Verify the requested wheel's attestation", undefined],
    ['Decide', undefined],
    [PNPM_SETUP, IF_PREPARED],
    [SETUP_UV, IF_PREPARED],
    ['Pin the version and regenerate the lock', IF_PREPARED],
    ['pnpm test', IF_PREPARED],
    ['Hash the prepared files', IF_PREPARED],
    [UPLOAD, IF_PREPARED],
  ]);
  assert.equal(scalar(stepInputs(steps[0]!), 'persist-credentials'), 'false');
  assert.deepEqual(mappingOf(stepInputs(steps[1]!)), { 'node-version': '26', 'package-manager-cache': 'false' });
  assert.equal(stepScript(stepNamed(prepare, 'Check the version')), CHECK_VERSION_SCRIPT);
  const attest = stepNamed(prepare, "Verify the requested wheel's attestation");
  assert.equal(scalar(stepBody(attest), 'id'), 'attest');
  assert.deepEqual(envOf(attest), { GH_TOKEN: '${{ github.token }}' });
  assert.equal(stepScript(attest), ATTEST_SCRIPT);
  const decide = stepNamed(prepare, 'Decide');
  assert.deepEqual(envOf(decide), { GH_TOKEN: '${{ github.token }}', GH_REPO: '${{ github.repository }}' });
  assert.equal(stepScript(decide), DECIDE_SCRIPT);
  assert.deepEqual(mappingOf(stepInputs(steps[5]!)), { install: 'true', 'require-lockfile': 'true' });
  assert.deepEqual(mappingOf(stepInputs(steps[6]!)), { version: '0.12.12', 'enable-cache': 'false' });
  const pin = stepNamed(prepare, 'Pin the version and regenerate the lock');
  assert.deepEqual(envOf(pin), { GH_TOKEN: '${{ github.token }}' });
  assert.equal(stepScript(pin), 'node scripts/set-generator.ts set "$VERSION"\npnpm lock-generator');
  assert.deepEqual(mappingOf(stepInputs(steps[10]!)), {
    name: 'generator',
    path: '|',
    'if-no-files-found': 'error',
    'retention-days': '1',
  });
  assert.deepEqual(
    entryOf(stepInputs(steps[10]!), 'path')!.nested.split('\n').map((line) => line.trim()).filter((line) => line !== ''),
    ['src/indexer/build-index.ts', 'data/tibiawikisql-requirements.txt'],
  );
});

test('propose installs nothing and checks the diff before it gets a token', () => {
  // Every check runs before the token step, and each step that runs on a propose decision alone.
  // The job installs nothing, restores no cache, and runs node only on the two dependency-free files
  // of its own checkout.
  const propose = proposeJob();
  assert.equal(scalar(propose, 'needs'), 'prepare');
  assert.equal(scalar(propose, 'if'), "${{ needs.prepare.outputs.decision == 'propose' || needs.prepare.outputs.decision == 'rearm' }}");
  assert.equal(scalar(propose, 'environment'), 'release-trigger');
  assert.equal(scalar(propose, 'timeout-minutes'), '20');
  const steps = jobSteps(propose);
  assert.deepEqual(steps.map((step) => [stepName(step), stepIf(step)]), [
    [CHECKOUT, undefined],
    [SETUP_NODE, undefined],
    ['Check the version and what prepare handed on', undefined],
    ['Decide again', undefined],
    [DOWNLOAD, IF_PROPOSE],
    ['Take the prepared files, and check what they change', IF_PROPOSE],
    ["Verify the requested wheel's attestation", IF_PROPOSE],
    ['Require the attested wheel in the prepared lock', IF_PROPOSE],
    ['Require the prepared build-index.ts to be the pin recomputed here', IF_PROPOSE],
    ['Build the commit on main', IF_PROPOSE],
    ['token', IF_WRITE],
    ['Close the pull requests the request supersedes', IF_SUPERSEDE],
    ['Turn on auto-merge for the open pull request', IF_REARM],
    ['Push generator/<version>, open its pull request, and turn on auto-merge', IF_PROPOSE],
  ]);
  assert.ok(isCheckout(steps[0]!));
  assert.deepEqual(mappingOf(stepInputs(steps[0]!)), { 'persist-credentials': 'false' });
  assert.deepEqual(mappingOf(stepInputs(steps[1]!)), { 'node-version': '26', 'package-manager-cache': 'false' });
  assert.ok(!steps.some(isPnpmSetup), 'propose sets up pnpm');
  assert.doesNotMatch(propose, /setup-uv@|actions\/cache@/, 'propose sets up uv or restores a cache');
  assert.deepEqual(mappingOf(stepInputs(steps[4]!)), { name: 'generator', path: '${{ runner.temp }}/prepared' });
  for (const step of steps) {
    assert.equal(scalar(stepInputs(step), 'cache'), undefined, `${stepName(step)} restores a cache`);
    const script = stepScript(step) ?? '';
    assert.doesNotMatch(script, /\b(?:pnpm|npm|npx|uv|pip|python3?)\b/, `${stepName(step)} installs or runs a dependency`);
    const nodes = [...script.matchAll(/\bnode (?!--input-type=module -e ')([^)\n]*)/g)].map((match) => match[1]!.trim());
    for (const run of nodes) {
      assert.match(run, /^(?:scripts\/set-generator\.ts decide "\$VERSION")$/, `${stepName(step)} runs node on something else: ${run}`);
    }
    for (const imported of script.matchAll(/import .* from "([^"]+)";/g)) {
      assert.match(imported[1]!, /^(?:node:fs|\.\/src\/indexer\/generator-release\.ts|\.\/scripts\/set-generator\.ts)$/,
        `${stepName(step)} imports ${imported[1]}`);
    }
  }
  // The two files node runs import only node: modules and each other.
  for (const file of ['src/indexer/generator-release.ts', 'scripts/set-generator.ts']) {
    const imports = [...read(file).matchAll(/^import .* from '([^']+)';$/gm)].map((match) => match[1]!);
    for (const imported of imports) {
      assert.match(imported, /^(?:node:[a-z_/]+|\.\.\/src\/indexer\/generator-release\.ts)$/, `${file} imports ${imported}`);
    }
    assert.doesNotMatch(read(file), /\bimport\(|\brequire\(/, `${file} loads a module some other way`);
  }
});

test("propose's checks are pinned word for word, and every value reaches them through env", () => {
  const propose = proposeJob();
  const validate = stepNamed(propose, 'Check the version and what prepare handed on');
  assert.deepEqual(envOf(validate), {
    PREPARED: '${{ needs.prepare.outputs.decision }}',
    BUILD_INDEX_SHA256: '${{ needs.prepare.outputs.build_index_sha256 }}',
    REQUIREMENTS_SHA256: '${{ needs.prepare.outputs.requirements_sha256 }}',
  });
  assert.equal(stepScript(validate), VALIDATE_SCRIPT);
  const decide = stepNamed(propose, 'Decide again');
  assert.equal(scalar(stepBody(decide), 'id'), 'decide');
  assert.deepEqual(envOf(decide), {
    GH_TOKEN: '${{ github.token }}',
    GH_REPO: '${{ github.repository }}',
    PREPARED: '${{ needs.prepare.outputs.decision }}',
  });
  assert.equal(stepScript(decide), DECIDE_AGAIN_SCRIPT);
  const take = stepNamed(propose, 'Take the prepared files, and check what they change');
  assert.deepEqual(envOf(take), {
    BUILD_INDEX_SHA256: '${{ needs.prepare.outputs.build_index_sha256 }}',
    REQUIREMENTS_SHA256: '${{ needs.prepare.outputs.requirements_sha256 }}',
  });
  assert.equal(stepScript(take), TAKE_SCRIPT);
  // The same download and verification as prepare's, with this job's own github.token.
  const attest = stepNamed(propose, "Verify the requested wheel's attestation");
  assert.equal(scalar(stepBody(attest), 'id'), 'attest');
  assert.deepEqual(envOf(attest), { GH_TOKEN: '${{ github.token }}' });
  assert.equal(stepScript(attest), ATTEST_SCRIPT);
  const locked = stepNamed(propose, 'Require the attested wheel in the prepared lock');
  assert.deepEqual(envOf(locked), { SHA256: '${{ steps.attest.outputs.sha256 }}' });
  assert.equal(stepScript(locked), LOCKED_SCRIPT);
  const recompute = stepNamed(propose, 'Require the prepared build-index.ts to be the pin recomputed here');
  assert.deepEqual(envOf(recompute), { SHA256: '${{ steps.attest.outputs.sha256 }}' });
  assert.equal(stepScript(recompute), RECOMPUTE_SCRIPT);
  const build = stepNamed(propose, 'Build the commit on main');
  assert.deepEqual(envOf(build), { SHA256: '${{ steps.attest.outputs.sha256 }}' });
  assert.equal(stepScript(build), BUILD_SCRIPT);
});

test('only the steps that write get the App token, which is limited to this repository', () => {
  const propose = proposeJob();
  const token = appTokenStep(propose, 'propose');
  assert.equal(scalar(stepBody(token), 'uses'), APP_TOKEN_ACTION);
  assert.deepEqual(mappingOf(stepInputs(token)), {
    ...APP,
    repositories: 'tibiawiki-mcp',
    'permission-contents': 'write',
    'permission-pull-requests': 'write',
  });
  assert.equal(under(stepBody(token), 'env'), '', 'the token step has an env');
  const writers = [
    'Close the pull requests the request supersedes',
    'Turn on auto-merge for the open pull request',
    'Push generator/<version>, open its pull request, and turn on auto-merge',
  ];
  const readers = jobSteps(propose).filter((step) => /\bsteps\.token\b/.test(step)).map(stepName);
  assert.deepEqual(readers, writers, 'the token reaches a step that does not write');
  for (const name of writers) {
    const step = stepNamed(propose, name);
    assert.equal(envOf(step)['GH_TOKEN'], '${{ steps.token.outputs.token }}');
    assert.equal(step.split('steps.token').length - 1, 1, `${name} reads the token outside GH_TOKEN`);
  }
  const close = stepNamed(propose, writers[0]!);
  assert.deepEqual(envOf(close), {
    GH_TOKEN: '${{ steps.token.outputs.token }}',
    GH_REPO: '${{ github.repository }}',
    SUPERSEDE: '${{ steps.decide.outputs.supersede }}',
  });
  assert.equal(stepScript(close), CLOSE_SCRIPT);
  const push = stepNamed(propose, writers[2]!);
  assert.deepEqual(envOf(push), {
    GH_TOKEN: '${{ steps.token.outputs.token }}',
    GH_REPO: '${{ github.repository }}',
    SHA256: '${{ steps.attest.outputs.sha256 }}',
    GIT_AUTHOR_NAME: 'github-actions[bot]',
    GIT_AUTHOR_EMAIL: '41898282+github-actions[bot]@users.noreply.github.com',
    GIT_COMMITTER_NAME: 'github-actions[bot]',
    GIT_COMMITTER_EMAIL: '41898282+github-actions[bot]@users.noreply.github.com',
  });
  assert.equal(stepScript(push), PUSH_SCRIPT);
});

/** Whether a propose step with condition `condition` runs when the job decided `action`. */
const runsOn = (condition: string | undefined, action: 'propose' | 'rearm', supersede: boolean): boolean => {
  switch (condition) {
    case undefined: return true;
    case IF_PROPOSE: return action === 'propose';
    case IF_REARM: return action === 'rearm';
    case IF_WRITE: return true;
    case IF_SUPERSEDE: return supersede;
    default: return assert.fail(`a propose step runs on a condition this test cannot read: ${condition}`);
  }
};

test('the rearm path only turns on auto-merge: it pushes nothing and downloads no artifact', () => {
  // A rearm finds the pull request an interrupted run opened, and turns its auto-merge on. It takes
  // nothing from prepare, which prepared nothing for it.
  const propose = proposeJob();
  for (const supersede of [false, true]) {
    const rearm = jobSteps(propose).filter((step) => runsOn(stepIf(step), 'rearm', supersede));
    assert.deepEqual(rearm.map(stepName), [
      CHECKOUT,
      SETUP_NODE,
      'Check the version and what prepare handed on',
      'Decide again',
      'token',
      ...(supersede ? ['Close the pull requests the request supersedes'] : []),
      'Turn on auto-merge for the open pull request',
    ]);
    for (const step of rearm) {
      assert.doesNotMatch(step, /\bgit\b[^\n]*\b(?:push|commit|add)\b|download-artifact|\/prepared|\bcp\b|steps\.attest/,
        `${stepName(step)} runs on rearm and pushes or takes something from prepare`);
    }
  }
  const step = stepNamed(propose, 'Turn on auto-merge for the open pull request');
  assert.deepEqual(envOf(step), {
    GH_TOKEN: '${{ steps.token.outputs.token }}',
    GH_REPO: '${{ github.repository }}',
    PR: '${{ steps.decide.outputs.pr }}',
  });
  assert.equal(stepScript(step), REARM_SCRIPT);
});

/** Stand-ins for curl, gh and timeout. Each records its command line in $FAKE_RUN/events. */
const FAKE_CURL = `#!/usr/bin/env bash
printf 'curl %s\\n' "$*" >> "$FAKE_RUN/events"
if [ "$#" -ne 6 ] || [ "$1" != -fsSL ] || [ "$2" != --max-time ] || [ "$3" != 300 ] || [ "$4" != -o ]; then
  echo "fake curl: unsupported command: $*" >&2
  exit 2
fi
cp "$FAKE_RUN/wheel" "$5"
`;

const FAKE_TIMEOUT = `#!/usr/bin/env bash
if [ "$1" != --kill-after=10 ] || [[ ! $2 =~ ^[0-9]+$ ]]; then
  echo "fake timeout: unsupported command: $*" >&2
  exit 2
fi
bound=$2
shift 2
BOUNDED_BY_TIMEOUT=$bound exec "$@"
`;

/**
 * gh as the steps call it. `attestation verify` exits with $FAKE_RUN/attest-exit, 0 unless the file
 * says otherwise. `pr list` applies its --jq filter with the real jq to $FAKE_RUN/pull-requests.json.
 * `pr create` prints the new pull request's URL. Every call needs GH_TOKEN, every pr call GH_REPO, and
 * every call is bounded by timeout.
 */
const FAKE_GH = `#!/usr/bin/env bash
printf 'gh %s\\n' "$*" >> "$FAKE_RUN/events"
if [ -z "$GH_TOKEN" ] || [ -z "$BOUNDED_BY_TIMEOUT" ]; then
  echo "fake gh: $1 $2 without GH_TOKEN or timeout" >&2
  exit 2
fi
if [ "$1" = pr ] && [ -z "$GH_REPO" ]; then
  echo "fake gh: pr $2 without GH_REPO" >&2
  exit 2
fi
case "$1 $2" in
  'attestation verify')
    if [ -e "$FAKE_RUN/attest-exit" ]; then exit "$(cat "$FAKE_RUN/attest-exit")"; fi
    ;;
  'pr list')
    filter="\${@: -1}"
    jq -r "$filter" "$FAKE_RUN/pull-requests.json"
    ;;
  'pr create') echo 'https://github.com/tibia-sh/tibiawiki-mcp/pull/77' ;;
  'pr merge' | 'pr close') ;;
  *)
    echo "fake gh: unsupported command: $*" >&2
    exit 2
    ;;
esac
`;

const scratch = tempDirs('twmcp-generator-workflow-');

let fakes: string | undefined;
const fakeBin = (): string => {
  if (fakes === undefined) {
    fakes = scratch();
    writeFileSync(join(fakes, 'curl'), FAKE_CURL, { mode: 0o755 });
    writeFileSync(join(fakes, 'timeout'), FAKE_TIMEOUT, { mode: 0o755 });
    writeFileSync(join(fakes, 'gh'), FAKE_GH, { mode: 0o755 });
  }
  return fakes;
};

const BUILD_INDEX = read('src/indexer/build-index.ts');
const LOCK = read('data/tibiawikisql-requirements.txt');
const REQUESTED = '9.0.0+tibiash.3';

/** The committed lock with its generator entry moved to `version`'s wheel, hashed `sha256`. */
const lockFor = (version: string, sha256: string): string => {
  const entry = `${GENERATOR} \\\n    --hash=sha256:${GENERATOR_SHA256}\n`;
  assert.equal(LOCK.split(entry).length, 2, 'the committed lock has no generator entry to move');
  return LOCK.replace(entry, `tibiawikisql @ ${generatorWheelUrl(version)} \\\n    --hash=sha256:${sha256}\n`);
};

const sha256Of = (text: string): string => createHash('sha256').update(text).digest('hex');

const git = (dir: string, args: string[]): string =>
  execFileSync('git', args, { cwd: dir, encoding: 'utf8', env: gitEnv(dir) }).trim();

const gitEnv = (dir: string): Record<string, string> => ({
  PATH: process.env['PATH'] ?? '',
  HOME: dir,
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_AUTHOR_NAME: 'Test',
  GIT_AUTHOR_EMAIL: 'test@example.com',
  GIT_COMMITTER_NAME: 'Test',
  GIT_COMMITTER_EMAIL: 'test@example.com',
});

/**
 * A checkout as the propose job has it: this repository's two dependency-free files, build-index.ts
 * and the lock, committed, with origin a bare repository beside it. `run` is the directory the
 * stand-ins answer and record from.
 */
const checkout = (): { dir: string; origin: string; run: string } => {
  const dir = scratch();
  mkdirSync(join(dir, 'src/indexer'), { recursive: true });
  mkdirSync(join(dir, 'scripts'));
  mkdirSync(join(dir, 'data'));
  writeFileSync(join(dir, 'package.json'), '{ "type": "module" }\n');
  for (const file of ['src/indexer/generator-release.ts', 'src/indexer/build-index.ts', 'scripts/set-generator.ts', 'data/tibiawikisql-requirements.txt']) {
    copyFileSync(join(root, file), join(dir, file));
  }
  git(dir, ['init', '--quiet', '--initial-branch=main']);
  git(dir, ['add', '--all']);
  git(dir, ['commit', '--quiet', '--message', 'checkout']);
  const origin = scratch();
  git(origin, ['init', '--quiet', '--bare', '--initial-branch=main']);
  git(dir, ['remote', 'add', 'origin', origin]);
  git(dir, ['push', '--quiet', 'origin', 'HEAD:refs/heads/main']);
  const run = scratch();
  writeFileSync(join(run, 'events'), '');
  writeFileSync(join(run, 'output'), '');
  return { dir, origin, run };
};

/** The script of the propose step `name`, as the workflow has it. */
const proposeScript = (name: string): string => stepScript(stepNamed(proposeJob(), name))!;

/** Runs a propose step's script in `dir` with the stand-ins first on PATH, as a runner runs it. */
const runStep = (dir: string, run: string, script: string, env: Record<string, string> = {}) => {
  const result = bash(script, {
    ...gitEnv(dir),
    PATH: `${fakeBin()}:${process.env['PATH'] ?? ''}`,
    VERSION: REQUESTED,
    RUNNER_TEMP: run,
    GITHUB_OUTPUT: join(run, 'output'),
    FAKE_RUN: run,
    ...env,
  }, dir);
  return { status: result.status, output: `${result.stdout}${result.stderr}` };
};

/**
 * Runs the propose job's download and attestation, then its two binding checks, on a checkout whose
 * prepared files are `buildIndex` and `lock`, with the stand-in curl serving `wheel`. Returns each
 * step's result, and stops at the first that fails, as a runner does.
 */
const runChecks = (buildIndex: string, lock: string, wheel: string, attestExit = 0) => {
  const { dir, run } = checkout();
  writeFileSync(join(dir, 'src/indexer/build-index.ts'), buildIndex);
  writeFileSync(join(dir, 'data/tibiawikisql-requirements.txt'), lock);
  writeFileSync(join(run, 'wheel'), wheel);
  writeFileSync(join(run, 'attest-exit'), `${attestExit}\n`);
  const results: Array<{ status: number | null; output: string }> = [];
  const attest = runStep(dir, run, proposeScript("Verify the requested wheel's attestation"), { GH_TOKEN: 'fake-github-token' });
  results.push(attest);
  if (attest.status === 0) {
    const [output] = recorded(run, 'output');
    const sha256 = /^sha256=([0-9a-f]{64})$/.exec(output ?? '')?.[1];
    assert.ok(sha256, `the attestation step handed on no sha256: ${output}`);
    for (const name of ['Require the attested wheel in the prepared lock', 'Require the prepared build-index.ts to be the pin recomputed here']) {
      const result = runStep(dir, run, proposeScript(name), { SHA256: sha256 });
      results.push(result);
      if (result.status !== 0) break;
    }
  }
  return { results, events: recorded(run, 'events') };
};

const WHEEL = 'the attested wheel';
const ATTEST_EVENTS = [
  `curl -fsSL --max-time 300 -o RUN/generator.whl ${generatorWheelUrl(REQUESTED)}`,
  `gh attestation verify RUN/generator.whl ${attestationFlags(REQUESTED).join(' ')}`,
];

test("propose accepts prepared files that pin the attested wheel of the requested version", () => {
  const sha = sha256Of(WHEEL);
  const { results, events } = runChecks(setGenerator(BUILD_INDEX, REQUESTED, sha), lockFor(REQUESTED, sha), WHEEL);
  assert.deepEqual(results.map((result) => result.status), [0, 0, 0], results.map((result) => result.output).join('\n'));
  assert.deepEqual(events.map((event) => event.replace(/ \S*\/generator\.whl/g, ' RUN/generator.whl')), ATTEST_EVENTS);
});

test('propose rejects substituted constants that come with a matching lock, when the attestation does not cover the hash', () => {
  // prepare pinned a wheel of its own, and wrote the lock to match, so the two files agree with
  // each other. The wheel this job downloads and verifies is another, so the lock step fails.
  const substituted = sha256Of('a wheel no attestation covers');
  const { results } = runChecks(setGenerator(BUILD_INDEX, REQUESTED, substituted), lockFor(REQUESTED, substituted), WHEEL);
  assert.deepEqual(results.map((result) => result.status === 0), [true, false]);
  assert.match(results[1]!.output, new RegExp(`records the generator wheel sha256:${substituted}, but the attested wheel is sha256:${sha256Of(WHEEL)}`));
});

test("propose rejects a prepared build-index.ts that is not the pin it recomputes, and a wheel gh does not verify", () => {
  // The lock names the requested version's attested wheel, but build-index.ts pins another version.
  const sha = sha256Of(WHEEL);
  const other = runChecks(setGenerator(BUILD_INDEX, '9.0.0+tibiash.4', sha), lockFor(REQUESTED, sha), WHEEL);
  assert.deepEqual(other.results.map((result) => result.status === 0), [true, true, false]);
  assert.match(other.results[2]!.output, /The prepared build-index\.ts is not the checked-out one with 9\.0\.0\+tibiash\.3/);
  // A wheel gh refuses stops the job at its attestation step.
  const refused = runChecks(setGenerator(BUILD_INDEX, REQUESTED, sha), lockFor(REQUESTED, sha), WHEEL, 1);
  assert.deepEqual(refused.results.map((result) => result.status === 0), [false]);
});

test('propose takes only the files prepare hashed, changing nothing but the two constants and the lock', () => {
  const sha = sha256Of(WHEEL);
  const take = (buildIndex: string, lock: string, hashes = { build: sha256Of(buildIndex), lock: sha256Of(lock) }) => {
    const { dir, run } = checkout();
    mkdirSync(join(run, 'prepared/src/indexer'), { recursive: true });
    mkdirSync(join(run, 'prepared/data'), { recursive: true });
    writeFileSync(join(run, 'prepared/src/indexer/build-index.ts'), buildIndex);
    writeFileSync(join(run, 'prepared/data/tibiawikisql-requirements.txt'), lock);
    const result = runStep(dir, run, proposeScript('Take the prepared files, and check what they change'), {
      BUILD_INDEX_SHA256: hashes.build,
      REQUIREMENTS_SHA256: hashes.lock,
    });
    return { ...result, buildIndex: readFileSync(join(dir, 'src/indexer/build-index.ts'), 'utf8') };
  };
  const pinned = setGenerator(BUILD_INDEX, REQUESTED, sha);
  const good = take(pinned, lockFor(REQUESTED, sha));
  assert.equal(good.status, 0, good.output);
  assert.equal(good.buildIndex, pinned);
  const refused: Array<[string, ReturnType<typeof take>, RegExp]> = [
    ['a file prepare did not hash', take(pinned, lockFor(REQUESTED, sha), { build: sha256Of('other'), lock: sha256Of(lockFor(REQUESTED, sha)) }), /not the ones prepare hashed/],
    ['a build-index.ts that changes another line too', take(`${pinned}// planted\n`, lockFor(REQUESTED, sha)), /changes more than GENERATOR_VERSION/],
    ['a lock left as it was', take(pinned, LOCK), /change other files than build-index\.ts and the lock, or leave one/],
  ];
  for (const [what, result, error] of refused) {
    assert.equal(result.status, 1, `${what} is taken: ${result.output}`);
    assert.match(result.output, error, what);
  }
});

test('propose refuses a version or a value from prepare that is not whole, and a propose that prepare did not prepare', () => {
  const { dir, run } = checkout();
  const validate = (env: Record<string, string>) => runStep(dir, run, proposeScript('Check the version and what prepare handed on'), {
    PREPARED: 'propose',
    BUILD_INDEX_SHA256: 'a'.repeat(64),
    REQUIREMENTS_SHA256: 'b'.repeat(64),
    ...env,
  });
  assert.equal(validate({}).status, 0);
  assert.equal(validate({ PREPARED: 'rearm', BUILD_INDEX_SHA256: '', REQUIREMENTS_SHA256: '' }).status, 0);
  const invalid: Array<Record<string, string>> = [
    { VERSION: '9.0.0+tibiash.3\n' },
    { VERSION: '9.0.0+tibiash.3; x' },
    { PREPARED: 'noop' },
    { PREPARED: 'propose\n' },
    { BUILD_INDEX_SHA256: `${'a'.repeat(64)}\n` },
    { REQUIREMENTS_SHA256: 'b'.repeat(63) },
  ];
  for (const env of invalid) {
    assert.equal(validate(env).status, 1, `${JSON.stringify(env)} passes`);
  }
  // decide again, with a stand-in node that prints a decision. Only propose and rearm go on, and a
  // propose needs a propose from prepare, which prepared the files.
  const nodes = scratch();
  writeFileSync(join(nodes, 'node'), '#!/usr/bin/env bash\ncat "$FAKE_RUN/decision"\n', { mode: 0o755 });
  const decide = (decision: string, prepared: string) => {
    writeFileSync(join(run, 'decision'), decision);
    writeFileSync(join(run, 'output'), '');
    const result = runStep(dir, run, proposeScript('Decide again'), {
      PATH: `${nodes}:${fakeBin()}:${process.env['PATH'] ?? ''}`,
      PREPARED: prepared,
      GH_TOKEN: 'fake-github-token',
      GH_REPO: 'tibia-sh/tibiawiki-mcp',
    });
    return { ...result, outputs: recorded(run, 'output') };
  };
  assert.deepEqual(decide('{"action":"propose","supersede":[3,4]}', 'propose').outputs, ['action=propose', 'supersede=3 4', 'pr=']);
  assert.deepEqual(decide('{"action":"rearm","supersede":[],"pr":9}', 'propose').outputs, ['action=rearm', 'supersede=', 'pr=9']);
  const moved = decide('{"action":"refuse","supersede":[]}', 'propose');
  assert.equal(moved.status, 0, 'a newer pin that landed meanwhile does not end the run green');
  assert.deepEqual(moved.outputs, ['action=refuse', 'supersede=', 'pr=']);
  assert.equal(decide('{"action":"propose","supersede":[]}', 'rearm').status, 1);
  for (const decision of ['{"action":"merge","supersede":[]}', '{"action":"propose","supersede":["3;x"]}', '{"action":"rearm","supersede":[],"pr":"9 --admin"}']) {
    const result = decide(decision, 'propose');
    assert.equal(result.status, 1, `${decision} is read`);
    assert.deepEqual(result.outputs, [], `${decision} is handed on`);
  }
});

/**
 * Runs the push step on a checkout whose prepared files pin REQUESTED, where origin already has
 * generator/<version> at another commit, as a run interrupted after its push leaves it, and gh
 * answers the open pull request read with `pullRequests`.
 */
const runPush = (pullRequests: unknown[]) => {
  const { dir, origin, run } = checkout();
  const branch = `generator/${REQUESTED}`;
  git(dir, ['commit', '--quiet', '--allow-empty', '--message', 'left by an interrupted run']);
  git(dir, ['push', '--quiet', 'origin', `HEAD:refs/heads/${branch}`]);
  git(dir, ['reset', '--quiet', '--hard', 'HEAD~1']);
  const sha = sha256Of(WHEEL);
  writeFileSync(join(dir, 'src/indexer/build-index.ts'), setGenerator(BUILD_INDEX, REQUESTED, sha));
  writeFileSync(join(dir, 'data/tibiawikisql-requirements.txt'), lockFor(REQUESTED, sha));
  writeFileSync(join(run, 'pull-requests.json'), JSON.stringify(pullRequests));
  const result = runStep(dir, run, proposeScript('Push generator/<version>, open its pull request, and turn on auto-merge'), {
    GH_TOKEN: 'fake-app-token',
    GH_REPO: 'tibia-sh/tibiawiki-mcp',
    SHA256: sha,
    GITHUB_SERVER_URL: 'https://github.com',
    GITHUB_REPOSITORY: 'tibia-sh/tibiawiki-mcp',
    GITHUB_RUN_ID: '42',
  });
  assert.equal(result.status, 0, result.output);
  const head = git(dir, ['rev-parse', 'HEAD']);
  return {
    head,
    pushed: git(origin, ['rev-parse', `refs/heads/${branch}`]),
    message: git(dir, ['log', '-1', '--format=%s']),
    files: git(dir, ['diff', '--name-only', 'HEAD~1', 'HEAD']).split('\n'),
    events: recorded(run, 'events').filter((line) => /^(?:gh|curl) /.test(line)),
  };
};

const LIST = `gh pr list --head generator/${REQUESTED} --base main --state open --json number,isCrossRepository,autoMergeRequest --jq map(select(.isCrossRepository | not)) | .[0] // empty | "\\(.number) \\(.autoMergeRequest != null)"`;

test('propose force-pushes over a branch an interrupted run left, and opens its pull request when it has none', () => {
  // A fork's pull request from a branch of the same name is not this run's.
  const pushed = runPush([{ number: 5, isCrossRepository: true, autoMergeRequest: null }]);
  assert.equal(pushed.pushed, pushed.head, 'generator/<version> is not the commit this run made');
  assert.equal(pushed.message, `fix: move the generator to ${REQUESTED}`);
  assert.deepEqual(pushed.files, ['data/tibiawikisql-requirements.txt', 'src/indexer/build-index.ts']);
  assert.equal(pushed.events.length, 3, pushed.events.join('\n'));
  assert.equal(pushed.events[0], LIST);
  assert.match(pushed.events[1]!, new RegExp(`^gh pr create --head generator/9\\.0\\.0\\+tibiash\\.3 --base main --title fix: move the generator to 9\\.0\\.0\\+tibiash\\.3 --body Moves the generator pin to \`9\\.0\\.0\\+tibiash\\.3\``));
  assert.equal(pushed.events[2], 'gh pr merge 77 --auto --rebase');
  // This repository's open pull request is reused.
  const reused = runPush([{ number: 5, isCrossRepository: true, autoMergeRequest: null }, { number: 55, isCrossRepository: false, autoMergeRequest: null }]);
  assert.equal(reused.pushed, reused.head);
  assert.deepEqual(reused.events, [LIST, 'gh pr merge 55 --auto --rebase']);
  // A stale pull request rebuilt with its auto-merge still on keeps it, and is not armed a second time.
  const armed = runPush([{ number: 55, isCrossRepository: false, autoMergeRequest: { mergeMethod: 'REBASE' } }]);
  assert.equal(armed.pushed, armed.head);
  assert.deepEqual(armed.events, [LIST]);
});

test('propose builds its commit on main as it fetched it, so a pin that landed since the event does not conflict', () => {
  // Requests for tibiash.3 and tibiash.4 both started from main pinning tibiash.2. tibiash.3 merged
  // while tibiash.4 was prepared, on that older checkout. The commit this run pushes moves main's
  // tibiash.3 to tibiash.4, on main's tip, with the lock prepare wrote and this job checked.
  const version = '9.0.0+tibiash.4';
  const { dir, origin, run } = checkout();
  const checkedOut = git(dir, ['rev-parse', 'HEAD']);
  const landed = sha256Of('the tibiash.3 wheel');
  writeFileSync(join(dir, 'src/indexer/build-index.ts'), setGenerator(BUILD_INDEX, '9.0.0+tibiash.3', landed));
  writeFileSync(join(dir, 'data/tibiawikisql-requirements.txt'), lockFor('9.0.0+tibiash.3', landed));
  git(dir, ['commit', '--quiet', '--all', '--message', 'fix: move the generator to 9.0.0+tibiash.3']);
  git(dir, ['push', '--quiet', 'origin', 'HEAD:refs/heads/main']);
  const main = git(dir, ['rev-parse', 'HEAD']);
  git(dir, ['reset', '--quiet', '--hard', checkedOut]);
  // What Decide again fetched.
  git(dir, ['fetch', '--quiet', '--no-tags', 'origin', '+refs/heads/main:refs/remotes/origin/main']);
  const sha = sha256Of(WHEEL);
  const prepared = { build: setGenerator(BUILD_INDEX, version, sha), lock: lockFor(version, sha) };
  mkdirSync(join(run, 'prepared/src/indexer'), { recursive: true });
  mkdirSync(join(run, 'prepared/data'), { recursive: true });
  writeFileSync(join(run, 'prepared/src/indexer/build-index.ts'), prepared.build);
  writeFileSync(join(run, 'prepared/data/tibiawikisql-requirements.txt'), prepared.lock);
  writeFileSync(join(run, 'wheel'), WHEEL);
  writeFileSync(join(run, 'pull-requests.json'), '[]');
  const steps: Array<[string, Record<string, string>]> = [
    ['Take the prepared files, and check what they change', { BUILD_INDEX_SHA256: sha256Of(prepared.build), REQUIREMENTS_SHA256: sha256Of(prepared.lock) }],
    ["Verify the requested wheel's attestation", { GH_TOKEN: 'fake-github-token' }],
    ['Require the attested wheel in the prepared lock', { SHA256: sha }],
    ['Require the prepared build-index.ts to be the pin recomputed here', { SHA256: sha }],
    ['Build the commit on main', { SHA256: sha }],
    ['Push generator/<version>, open its pull request, and turn on auto-merge', {
      GH_TOKEN: 'fake-app-token',
      GH_REPO: 'tibia-sh/tibiawiki-mcp',
      SHA256: sha,
      GITHUB_SERVER_URL: 'https://github.com',
      GITHUB_REPOSITORY: 'tibia-sh/tibiawiki-mcp',
      GITHUB_RUN_ID: '42',
    }],
  ];
  for (const [name, env] of steps) {
    const result = runStep(dir, run, proposeScript(name), { VERSION: version, ...env });
    assert.equal(result.status, 0, `${name}: ${result.output}`);
  }
  const pushed = git(origin, ['rev-parse', `refs/heads/generator/${version}`]);
  assert.equal(git(origin, ['rev-parse', `${pushed}^`]), main, 'the commit does not sit on main as it was fetched');
  assert.deepEqual(git(origin, ['diff', '--name-only', main, pushed]).split('\n'), ['data/tibiawikisql-requirements.txt', 'src/indexer/build-index.ts']);
  const mainSource = git(origin, ['show', `${main}:src/indexer/build-index.ts`]);
  assert.equal(`${git(origin, ['show', `${pushed}:src/indexer/build-index.ts`])}\n`, `${setGenerator(mainSource, version, sha)}\n`);
  assert.equal(`${git(origin, ['show', `${pushed}:data/tibiawikisql-requirements.txt`])}\n`, prepared.lock);
  assert.deepEqual(
    git(origin, ['diff', '--unified=0', main, pushed, '--', 'src/indexer/build-index.ts']).split('\n').filter((line) => /^[-+]export /.test(line)),
    [
      "-export const GENERATOR_VERSION = '9.0.0+tibiash.3';",
      `+export const GENERATOR_VERSION = '${version}';`,
      `-export const GENERATOR_SHA256 = '${landed}';`,
      `+export const GENERATOR_SHA256 = '${sha}';`,
    ],
  );
  // A rebase of the pushed commit onto main is a no-op, so the queue's rebase cannot conflict.
  assert.equal(git(origin, ['merge-base', main, pushed]), main);
});
