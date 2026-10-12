interface ErrorSource { on(event: 'error', listener: (err: NodeJS.ErrnoException) => void): unknown }

/**
 * Stream errors arrive asynchronously (a closed pipe gives EPIPE, a closed handle EBADF) and an 'error' event
 * without a listener is thrown as an uncaught exception: a stack trace and a non-zero exit code.
 * A hook must never do that (the agent would see a failed hook), so for `conus hook` every stream error is
 * swallowed and the exit code is forced to 0. Other commands ignore EPIPE (`conus help | head`) and turn any other
 * stream error into a plain exit code 1 instead of a stack trace.
 */
export function installStdoutGuard(
  isHook: boolean,
  streams: ErrorSource[] = [process.stdout, process.stderr],
  proc: { exitCode?: number | string | null } = process,
): void {
  for (const stream of streams) {
    stream.on('error', (err) => {
      if (isHook) { proc.exitCode = 0; return; }
      if (err.code !== 'EPIPE') proc.exitCode = 1;
    });
  }
}
