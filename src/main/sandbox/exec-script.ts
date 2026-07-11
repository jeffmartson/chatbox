import { shellQuote } from '../../shared/utils/shell'

// Pure helpers for building the stdin program and cleaning stderr for sandbox code execution.
// Kept free of any Electron/Node-runtime imports so they can be unit-tested in isolation.

const CODESIGN_NOISE_RE = /ERROR:codesign_util\.cc\(109\).*SecCodeCheckValidity/

/**
 * Strip the macOS Electron code-signing self-check warning the bundled Electron binary can emit
 * on stderr when launched as Node. Only that specific runtime noise is removed; all other stderr
 * (including user output) is preserved verbatim. Idempotent and a no-op when the pattern is absent.
 */
export function stripCodesignNoise(stderr: string): string {
  if (!stderr || !CODESIGN_NOISE_RE.test(stderr)) return stderr
  return stderr
    .split('\n')
    .filter((line) => !CODESIGN_NOISE_RE.test(line))
    .join('\n')
}

/**
 * Build the program text fed to the sandbox process via stdin. The code NEVER travels inside a
 * shell command — it goes on stdin — so there is no shell escaping and no base64 round-trip.
 *
 * `node`: the code is the program itself (the Electron/Node binary runs the piped script).
 * `bash`: parse the complete program as a command group before executing it with stdin redirected
 * from /dev/null. This preserves the old one-shot execution contract: commands such as `cat` and
 * `read` see EOF instead of consuming the remaining script source. On macOS/Linux, prepend a
 * `node()` shell function so user scripts can call the bundled Electron binary (there is no
 * standalone `node` on the sandbox PATH). Windows keeps the shell's own `node` resolution because
 * a host Electron path cannot be executed by the WSL fallback.
 */
export function buildSandboxStdinScript(
  code: string,
  language: 'bash' | 'node',
  nodeExecPath: string,
  injectNodeShim: boolean
): string {
  if (language === 'node') return code
  const nodeShim = injectNodeShim ? `node() { ELECTRON_RUN_AS_NODE=1 ${shellQuote(nodeExecPath)} "$@"; }\n` : ''
  // The leading no-op keeps empty and comment-only programs valid without masking the exit status
  // of the user's final command.
  // Keep a blank line before the closing brace so a trailing backslash retains its normal EOF
  // behavior instead of escaping the brace's newline and corrupting the wrapper syntax.
  return `${nodeShim}{\n:\n${code}\n\n} </dev/null`
}
