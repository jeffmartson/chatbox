import { afterEach, describe, expect, it } from 'vitest'
import { settingsStore } from '@/stores/settingsStore'
import {
  FileMutationApprovalPausedError,
  requestFileMutationApproval,
  requestUserExecApproval,
  resetUserExecApprovalsForTests,
  UserExecApprovalPausedError,
} from './user-exec-approval'

const originalShowCommandExplanation = settingsStore.getState().showCommandExplanation

afterEach(() => {
  resetUserExecApprovalsForTests()
  settingsStore.setState({ showCommandExplanation: originalShowCommandExplanation })
})

describe('persistent user approval pauses', () => {
  it('auto-approves read-only commands without pausing', async () => {
    await expect(requestUserExecApproval('tool-a', 'pwd')).resolves.toBe(true)
  })

  it('throws a persistent pause error for privileged commands', async () => {
    await expect(requestUserExecApproval('tool-b', 'touch /tmp/b')).rejects.toBeInstanceOf(UserExecApprovalPausedError)
    try {
      await requestUserExecApproval('tool-b', 'touch /tmp/b')
      throw new Error('expected approval pause')
    } catch (error) {
      expect(error).toBeInstanceOf(UserExecApprovalPausedError)
      expect((error as UserExecApprovalPausedError).toolCallId).toBe('tool-b')
      expect((error as UserExecApprovalPausedError).command).toBe('touch /tmp/b')
    }
  })

  it('persists the generated command explanation on the pause error', async () => {
    settingsStore.setState({ showCommandExplanation: true })

    try {
      await requestUserExecApproval('tool-d', 'rm -rf ./dist', {
        userContext: 'user asked to clean build output',
        generateExplanation: (_command, _userContext, onStream) => {
          onStream('partial explanation')
          return Promise.resolve('final explanation')
        },
      })
      throw new Error('expected approval pause')
    } catch (error) {
      expect(error).toBeInstanceOf(UserExecApprovalPausedError)
      expect((error as UserExecApprovalPausedError).explanation).toBe('final explanation')
      expect((error as UserExecApprovalPausedError).explanationError).toBeUndefined()
    }
  })

  it('throws a persistent pause error for real file mutations', () => {
    expect(() => requestFileMutationApproval('tool-c', 'Write file: /tmp/a.txt', 'hello')).toThrow(
      FileMutationApprovalPausedError
    )

    try {
      void requestFileMutationApproval('tool-c', 'Write file: /tmp/a.txt', 'hello')
      throw new Error('expected approval pause')
    } catch (error) {
      expect(error).toBeInstanceOf(FileMutationApprovalPausedError)
      expect((error as FileMutationApprovalPausedError).toolCallId).toBe('tool-c')
      expect((error as FileMutationApprovalPausedError).title).toBe('Write file: /tmp/a.txt')
      expect((error as FileMutationApprovalPausedError).preview).toBe('hello')
    }
  })
})
