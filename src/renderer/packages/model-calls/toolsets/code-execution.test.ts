// @ts-nocheck — test file with heavily mocked types
import { beforeEach, describe, expect, test, vi } from 'vitest'

vi.mock('@/lib/utils', () => ({
  getLogger: () => ({ info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}))

import { buildCodeExecutionTools } from './code-execution'

const createMockProvider = () => ({
  type: 'local' as const,
  init: vi.fn().mockResolvedValue({ success: true }),
  reset: vi.fn(),
  getStatus: vi.fn().mockResolvedValue({ initialized: true }),
  copyFileIn: vi.fn().mockResolvedValue({ success: true }),
  copyBlobIn: vi.fn().mockResolvedValue({ success: true }),
  readFileOut: vi.fn().mockResolvedValue({ success: true, content: 'test content' }),
  exportFile: vi.fn().mockResolvedValue({ success: true }),
  persistArtifact: vi.fn().mockResolvedValue({ success: true, artifactPath: '/durable/artifact' }),
  exec: vi.fn().mockResolvedValue({ stdout: '', stderr: '', exitCode: 0 }),
  checkAvailability: vi.fn().mockResolvedValue({ available: true }),
})

describe('buildCodeExecutionTools', () => {
  let mockProvider: ReturnType<typeof createMockProvider>

  beforeEach(() => {
    mockProvider = createMockProvider()
    vi.clearAllMocks()
  })

  test('returns tools and description', () => {
    const result = buildCodeExecutionTools({ sessionId: 'test-session', files: [], provider: mockProvider })
    expect(result.tools).toBeDefined()
    expect(result.description).toBeDefined()
    expect(typeof result.description).toBe('string')
    expect(result.description.length).toBeGreaterThan(0)
  })

  test('description explains Node/Bash runtime and discourages installs', () => {
    const result = buildCodeExecutionTools({ sessionId: 'test-session', files: [], provider: mockProvider })

    expect(result.description).toContain('Available Runtime')
    expect(result.description).toContain('Node.js')
    expect(result.description).toContain('Bash')
    expect(result.description).toContain('Node.js built-ins')
    expect(result.description).toContain('standalone HTML with inline SVG or Canvas')
    expect(result.description).toContain('Python is not available')
    expect(result.description).toContain('Package Installation')
    expect(result.description).toContain('Avoid installing packages')
    expect(result.description).toContain('Do not use sudo, apt, brew')
  })

  test('description keeps file tag guidance aligned with injected context', () => {
    const result = buildCodeExecutionTools({ sessionId: 'test-session', files: [], provider: mockProvider })

    expect(result.description).toContain('<ATTACHMENT_FILE>')
    expect(result.description).toContain('<SANDBOX_PATH>')
    expect(result.description).toContain('<PARSED_SANDBOX_PATH>')
  })

  test('returns code_execution tool', () => {
    const { tools } = buildCodeExecutionTools({ sessionId: 'test-session', files: [], provider: mockProvider })
    expect(tools.code_execution).toBeDefined()
  })

  test('returns read_file tool', () => {
    const { tools } = buildCodeExecutionTools({ sessionId: 'test-session', files: [], provider: mockProvider })
    expect(tools.read_file).toBeDefined()
  })

  test('does not return parse_file tool (removed — files are pre-parsed)', () => {
    const { tools } = buildCodeExecutionTools({ sessionId: 'test-session', files: [], provider: mockProvider })
    expect(tools.parse_file).toBeUndefined()
  })

  test('returns create_download tool', () => {
    const { tools } = buildCodeExecutionTools({ sessionId: 'test-session', files: [], provider: mockProvider })
    expect(tools.create_download).toBeDefined()
  })

  test('code_execution tool calls provider.init on first execute (lazy init)', async () => {
    const { tools } = buildCodeExecutionTools({ sessionId: 'test-session', files: [], provider: mockProvider })

    expect(mockProvider.init).not.toHaveBeenCalled()

    const tool = tools.code_execution as {
      execute: (input: Record<string, unknown>, opts: Record<string, unknown>) => Promise<unknown>
    }
    await tool.execute({ code: 'console.log("hello")', language: 'node' }, {})

    expect(mockProvider.init).toHaveBeenCalledWith('test-session')
  })

  test('code_execution tool calls provider.exec with the code and language', async () => {
    const { tools } = buildCodeExecutionTools({ sessionId: 'test-session', files: [], provider: mockProvider })
    const tool = tools.code_execution as {
      execute: (input: Record<string, unknown>, opts: Record<string, unknown>) => Promise<unknown>
    }

    await tool.execute({ code: 'console.log("hello world")', language: 'node' }, {})

    expect(mockProvider.exec).toHaveBeenCalledWith({
      code: 'console.log("hello world")',
      language: 'node',
      timeout: expect.any(Number),
    })
  })

  test('code_execution tool returns stdout, stderr, and exitCode', async () => {
    mockProvider.exec.mockResolvedValue({ stdout: 'hello world\n', stderr: '', exitCode: 0 })
    const { tools } = buildCodeExecutionTools({ sessionId: 'test-session', files: [], provider: mockProvider })
    const tool = tools.code_execution as {
      execute: (
        input: Record<string, unknown>,
        opts: Record<string, unknown>
      ) => Promise<{ stdout: string; stderr: string; exitCode: number }>
    }

    const result = await tool.execute({ code: 'console.log("hello world")', language: 'node' }, {})

    expect(result.stdout).toBe('hello world\n')
    expect(result.stderr).toBe('')
    expect(result.exitCode).toBe(0)
  })

  test('code_execution tool handles non-zero exit code', async () => {
    mockProvider.exec.mockResolvedValue({ stdout: '', stderr: 'ReferenceError: x is not defined', exitCode: 1 })
    const { tools } = buildCodeExecutionTools({ sessionId: 'test-session', files: [], provider: mockProvider })
    const tool = tools.code_execution as {
      execute: (
        input: Record<string, unknown>,
        opts: Record<string, unknown>
      ) => Promise<{ stdout: string; stderr: string; exitCode: number }>
    }

    const result = await tool.execute({ code: 'console.log(x)', language: 'node' }, {})

    expect(result.exitCode).toBe(1)
    expect(result.stderr).toContain('ReferenceError')
  })

  test('provider.init is called only once across multiple executions', async () => {
    const { tools } = buildCodeExecutionTools({ sessionId: 'test-session', files: [], provider: mockProvider })
    const tool = tools.code_execution as {
      execute: (input: Record<string, unknown>, opts: Record<string, unknown>) => Promise<unknown>
    }

    await tool.execute({ code: 'console.log(1)', language: 'node' }, {})
    await tool.execute({ code: 'console.log(2)', language: 'node' }, {})

    expect(mockProvider.init).toHaveBeenCalledTimes(1)
  })

  test('code_execution tool returns error when sandbox init fails', async () => {
    mockProvider.init.mockResolvedValue({ success: false, error: 'Docker not available' })
    const { tools } = buildCodeExecutionTools({ sessionId: 'test-session', files: [], provider: mockProvider })
    const tool = tools.code_execution as {
      execute: (
        input: Record<string, unknown>,
        opts: Record<string, unknown>
      ) => Promise<{ stdout: string; stderr: string; exitCode: number }>
    }

    const result = await tool.execute({ code: 'console.log(1)', language: 'node' }, {})

    expect(result.exitCode).toBe(1)
    expect(result.stderr).toContain('Sandbox')
  })

  describe('create_download', () => {
    const getTool = (provider: ReturnType<typeof createMockProvider>) => {
      const { tools } = buildCodeExecutionTools({ sessionId: 'test-session', files: [], provider })
      return tools.create_download as {
        execute: (input: Record<string, unknown>, opts: Record<string, unknown>) => Promise<Record<string, unknown>>
      }
    }

    test('persists the file and returns a download (local provider)', async () => {
      mockProvider.exec.mockResolvedValue({ stdout: '/tmp/report.pdf\n', stderr: '', exitCode: 0 })
      mockProvider.persistArtifact.mockResolvedValue({ success: true, artifactPath: '/durable/report.pdf' })

      const result = await getTool(mockProvider).execute({ file_path: '/tmp/report.pdf', display_name: 'Report' }, {})

      expect(mockProvider.persistArtifact).toHaveBeenCalledWith('/tmp/report.pdf', 'Report')
      expect(result).toMatchObject({ downloadable: true, file_path: '/durable/report.pdf', display_name: 'Report' })
    })

    test('reports an error to the model when persisting fails (local provider)', async () => {
      mockProvider.exec.mockResolvedValue({ stdout: '/tmp/report.pdf\n', stderr: '', exitCode: 0 })
      mockProvider.persistArtifact.mockResolvedValue({
        success: false,
        error: 'Access denied: path is outside the sandbox',
      })

      const result = await getTool(mockProvider).execute({ file_path: '/tmp/report.pdf', display_name: 'Report' }, {})

      expect(result.downloadable).toBeUndefined()
      expect(result.error).toMatch(/outside the sandbox/i)
    })

    test('falls back to the sandbox path when persistence is unsupported (cloud provider)', async () => {
      const cloud = createMockProvider()
      cloud.type = 'cloud' as const
      cloud.exec.mockResolvedValue({ stdout: '/work/report.pdf\n', stderr: '', exitCode: 0 })
      cloud.persistArtifact.mockResolvedValue({ success: false, error: 'Cloud sandbox not yet implemented' })

      const result = await getTool(cloud).execute({ file_path: 'report.pdf', display_name: 'Report' }, {})

      expect(result).toMatchObject({ downloadable: true, file_path: '/work/report.pdf', provider_type: 'cloud' })
    })

    test('returns file-not-found without persisting when the file is missing', async () => {
      mockProvider.exec.mockResolvedValue({ stdout: 'not_found\n', stderr: '', exitCode: 0 })

      const result = await getTool(mockProvider).execute({ file_path: '/tmp/missing.pdf', display_name: 'X' }, {})

      expect(result.error).toMatch(/file not found/i)
      expect(mockProvider.persistArtifact).not.toHaveBeenCalled()
    })
  })
})
