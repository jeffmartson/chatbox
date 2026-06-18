// Models trained on cloud sandboxes (E2B and similar) frequently emit "phantom home"
// absolute paths such as /home/user/report.txt or ~/report.txt. On the desktop host these
// paths do not exist and would otherwise route to the real filesystem (failing or prompting
// for approval). Rewriting them to a relative path makes the operation resolve inside the
// sandbox working directory instead, matching the model's intent.
//
// The list is intentionally conservative: only paths that are effectively never real user
// paths on a desktop host. The working directory's HOME is also pointed here at exec time,
// so `~`/`$HOME` inside code_execution already resolve correctly; this shim covers the
// structured filesystem tools where the model passes the literal path string.
const PHANTOM_HOME_PREFIXES = ['/home/user', '/home/sandbox']

/**
 * Rewrite a phantom-home absolute path to a path relative to the sandbox working directory.
 * Returns the input unchanged when it is not a recognized phantom-home path.
 */
export function remapPhantomHomePath(filePath: string): string {
  if (!filePath) return filePath

  // ~ and ~/x → relative to the working directory.
  if (filePath === '~') return '.'
  if (filePath.startsWith('~/')) return filePath.slice(2) || '.'

  for (const prefix of PHANTOM_HOME_PREFIXES) {
    if (filePath === prefix) return '.'
    if (filePath.startsWith(`${prefix}/`)) {
      return filePath.slice(prefix.length + 1) || '.'
    }
  }

  return filePath
}
