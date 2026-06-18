import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { shellQuote } from '@shared/utils/shell'
import { describe, expect, test } from 'vitest'
import { buildBashExecutionCommand, buildNodeExecutionCommand } from './local-provider'

function encodeCode(code: string): string {
  return Buffer.from(code, 'utf8').toString('base64')
}

describe('buildNodeExecutionCommand', () => {
  test('filters Electron codesign noise while preserving user stderr', () => {
    const command = buildNodeExecutionCommand(
      encodeCode(`
console.error('[0525/114014.700946:ERROR:codesign_util.cc(109)] SecCodeCheckValidity: Error Domain=NSOSStatusErrorDomain Code=-2147409622 "(null)" (-2147409622)')
console.error('real user stderr')
console.log('ok')
`),
      shellQuote(process.execPath)
    )

    const result = spawnSync('sh', ['-c', command], { encoding: 'utf8' })

    expect(result.status).toBe(0)
    expect(result.stdout).toBe('ok\n')
    expect(result.stderr).toBe('real user stderr\n')
  })

  test('preserves node exit code', () => {
    const command = buildNodeExecutionCommand(encodeCode('process.exit(7)'), shellQuote(process.execPath))

    const result = spawnSync('sh', ['-c', command], { encoding: 'utf8' })

    expect(result.status).toBe(7)
  })

  test('does not require TMPDIR to exist', () => {
    const cwd = mkdtempSync(join(tmpdir(), 'chatbox-node-wrapper-'))
    try {
      const command = buildNodeExecutionCommand(encodeCode("console.log('ok')"), shellQuote(process.execPath))

      const result = spawnSync('sh', ['-c', command], {
        cwd,
        encoding: 'utf8',
        env: { ...process.env, TMPDIR: join(cwd, 'missing') },
      })

      expect(result.status).toBe(0)
      expect(result.stdout).toBe('ok\n')
      expect(result.stderr).toBe('')
    } finally {
      rmSync(cwd, { recursive: true, force: true })
    }
  })

  test('makes node available to bash scripts without PATH', () => {
    const command = buildBashExecutionCommand(encodeCode('node -e "console.log(\'ok\')"'), shellQuote(process.execPath))

    const result = spawnSync('sh', ['-c', command], {
      encoding: 'utf8',
      env: { PATH: '/usr/bin:/bin', HOME: tmpdir() },
    })

    expect(result.status).toBe(0)
    expect(result.stdout).toBe('ok\n')
    expect(result.stderr).toBe('')
  })
})
