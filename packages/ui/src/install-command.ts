/**
 * How an agent machine gets the conus CLI: the package attached to the latest GitHub release.
 * `--allow-remote=all` lets npm 12+ install from a URL; older npm ignores it.
 */
export const CLI_INSTALL = 'npm install -g --allow-remote=all https://github.com/Pandusss/conus/releases/latest/download/conus-cli.tgz';
