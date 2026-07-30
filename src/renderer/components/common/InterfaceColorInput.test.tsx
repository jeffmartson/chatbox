// @vitest-environment jsdom

import type { ColorInputProps } from '@mantine/core'
import { describe, expect, it, vi } from 'vitest'
import { InterfaceColorInput } from '@/components/common/InterfaceColorInput'
import { fireEvent, render, screen } from '@/test-utils'

vi.mock('@mantine/core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@mantine/core')>()

  return {
    ...actual,
    ColorInput: ({ label, value, onChange, onChangeEnd, onBlur }: ColorInputProps) => (
      <div>
        <input
          aria-label={typeof label === 'string' ? label : undefined}
          value={typeof value === 'string' ? value : ''}
          onChange={(event) => onChange?.(event.currentTarget.value)}
          onBlur={onBlur}
        />
        <button type="button" onClick={() => onChangeEnd?.(typeof value === 'string' ? value : '')}>
          Finish picking
        </button>
      </div>
    ),
  }
})

describe('InterfaceColorInput', () => {
  it('previews color changes locally and commits only when picking ends', () => {
    const onChange = vi.fn()

    render(<InterfaceColorInput label="Primary Background" value="#ffffff" onCommit={onChange} />)

    fireEvent.change(screen.getByLabelText('Primary Background'), { target: { value: '#123456' } })

    expect((screen.getByLabelText('Primary Background') as HTMLInputElement).value).toBe('#123456')
    expect(onChange).not.toHaveBeenCalled()

    fireEvent.click(screen.getByRole('button', { name: 'Finish picking' }))

    expect(onChange).toHaveBeenCalledOnce()
    expect(onChange).toHaveBeenCalledWith('#123456')
  })

  it('commits a typed color when the input loses focus', () => {
    const onChange = vi.fn()

    render(<InterfaceColorInput label="Primary Background" value="#ffffff" onCommit={onChange} />)

    const input = screen.getByLabelText('Primary Background')
    fireEvent.change(input, { target: { value: '#ABCDEF' } })
    expect(onChange).not.toHaveBeenCalled()

    fireEvent.blur(input)

    expect(onChange).toHaveBeenCalledOnce()
    expect(onChange).toHaveBeenCalledWith('#abcdef')
  })

  it('does not commit the same color again when blur follows picking end', () => {
    const onChange = vi.fn()

    render(<InterfaceColorInput label="Primary Background" value="#ffffff" onCommit={onChange} />)

    const input = screen.getByLabelText('Primary Background')
    fireEvent.change(input, { target: { value: '#123456' } })
    fireEvent.click(screen.getByRole('button', { name: 'Finish picking' }))
    fireEvent.blur(input)

    expect(onChange).toHaveBeenCalledOnce()
  })
})
