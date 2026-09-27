/**
 * Where a generator release lives. This file imports nothing, so a job that holds a token
 * can run it from its own checkout without installing a dependency.
 */

/** The repository whose release workflow builds and attests the generator wheel. */
export const GENERATOR_REPO = 'tibia-sh/tibiawiki-sql';

/**
 * The wheel of a generator release, as its GitHub release asset. The `+` in the tag is
 * percent-encoded in the path, and not in the file name.
 */
export function generatorWheelUrl(version: string): string {
  return `https://github.com/${GENERATOR_REPO}/releases/download/v${encodeURIComponent(version)}` +
    `/tibiawikisql-${version}-py3-none-any.whl`;
}
