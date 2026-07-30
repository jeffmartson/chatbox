import { ColorInput } from '@mantine/core'
import { useEffect, useRef, useState } from 'react'

export function InterfaceColorInput({
  label,
  value,
  onCommit,
}: {
  label: string
  value: string
  onCommit: (value: string) => void
}) {
  const [draftValue, setDraftValue] = useState(value)
  const committedValueRef = useRef(value.toLowerCase())

  useEffect(() => {
    setDraftValue(value)
    committedValueRef.current = value.toLowerCase()
  }, [value])

  const commitValue = (nextValue: string) => {
    if (!/^#[0-9a-f]{6}$/i.test(nextValue)) {
      setDraftValue(value)
      return
    }

    const normalizedValue = nextValue.toLowerCase()
    setDraftValue(normalizedValue)
    if (committedValueRef.current === normalizedValue) return

    committedValueRef.current = normalizedValue
    onCommit(normalizedValue)
  }

  return (
    <ColorInput
      label={label}
      value={draftValue}
      onChange={setDraftValue}
      onChangeEnd={commitValue}
      onBlur={() => commitValue(draftValue)}
    />
  )
}
