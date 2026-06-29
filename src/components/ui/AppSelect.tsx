import {
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
} from 'react'
import { Check, ChevronDown } from 'lucide-react'

export type AppSelectOption<T extends string | number> = {
  value: T | ''
  label: string
}

type AppSelectProps<T extends string | number> = {
  id?: string
  ariaLabel?: string
  value: T | ''
  options: Array<AppSelectOption<T>>
  onChange: (value: T | '') => void
  placeholder?: string
  className?: string
  disabled?: boolean
  autoPlacement?: boolean
}

export function AppSelect<T extends string | number>({
  id,
  ariaLabel,
  value,
  options,
  onChange,
  placeholder,
  className,
  disabled = false,
  autoPlacement = false,
}: AppSelectProps<T>) {
  const generatedId = useId()
  const triggerId = id ?? `app-select-${generatedId}`
  const listboxId = `${triggerId}-${generatedId}-listbox`
  const wrapperRef = useRef<HTMLDivElement | null>(null)
  const triggerRef = useRef<HTMLButtonElement | null>(null)
  const [isOpen, setIsOpen] = useState(false)
  const [opensUpward, setOpensUpward] = useState(false)
  const [availablePanelHeight, setAvailablePanelHeight] = useState<number>()
  const selectedIndex = useMemo(
    () => options.findIndex((option) => option.value === value),
    [options, value],
  )
  const fallbackIndex = selectedIndex >= 0 ? selectedIndex : 0
  const [highlightedIndex, setHighlightedIndex] = useState(fallbackIndex)
  const selectedOption = selectedIndex >= 0 ? options[selectedIndex] : undefined
  const displayLabel = selectedOption?.label ?? placeholder ?? options[0]?.label ?? ''

  const updatePanelPlacement = useCallback(() => {
    if (!autoPlacement || !triggerRef.current) return

    const triggerRect = triggerRef.current.getBoundingClientRect()
    const viewportPadding = 12
    const panelGap = 8
    const desiredPanelHeight = Math.min(options.length * 46 + 12, 280)
    const bottomSpace = Math.max(
      0,
      window.innerHeight - triggerRect.bottom - panelGap - viewportPadding,
    )
    const topSpace = Math.max(0, triggerRect.top - panelGap - viewportPadding)
    const shouldOpenUpward = bottomSpace < desiredPanelHeight && topSpace > bottomSpace

    setOpensUpward(shouldOpenUpward)
    setAvailablePanelHeight(Math.floor(shouldOpenUpward ? topSpace : bottomSpace))
  }, [autoPlacement, options.length])

  function openSelect() {
    updatePanelPlacement()
    setIsOpen(true)
  }

  useEffect(() => {
    setHighlightedIndex(fallbackIndex)
  }, [fallbackIndex])

  useEffect(() => {
    if (!disabled) return
    setIsOpen(false)
  }, [disabled])

  useEffect(() => {
    if (!isOpen) return

    function handleDocumentPointerDown(event: PointerEvent) {
      if (!wrapperRef.current?.contains(event.target as Node)) {
        setIsOpen(false)
      }
    }

    document.addEventListener('pointerdown', handleDocumentPointerDown)
    return () => document.removeEventListener('pointerdown', handleDocumentPointerDown)
  }, [isOpen])

  useEffect(() => {
    if (!isOpen || !autoPlacement) return

    updatePanelPlacement()
    window.addEventListener('resize', updatePanelPlacement)
    window.addEventListener('scroll', updatePanelPlacement, true)
    return () => {
      window.removeEventListener('resize', updatePanelPlacement)
      window.removeEventListener('scroll', updatePanelPlacement, true)
    }
  }, [autoPlacement, isOpen, updatePanelPlacement])

  function selectOption(option: AppSelectOption<T> | undefined) {
    if (!option) return
    onChange(option.value)
    setIsOpen(false)
  }

  function moveHighlight(direction: 1 | -1) {
    if (disabled || options.length === 0) return
    openSelect()
    setHighlightedIndex((currentIndex) => {
      const nextIndex = currentIndex + direction
      if (nextIndex < 0) return options.length - 1
      if (nextIndex >= options.length) return 0
      return nextIndex
    })
  }

  function handleKeyDown(event: KeyboardEvent<HTMLButtonElement>) {
    if (event.key === 'ArrowDown') {
      event.preventDefault()
      moveHighlight(1)
      return
    }

    if (event.key === 'ArrowUp') {
      event.preventDefault()
      moveHighlight(-1)
      return
    }

    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault()
      if (isOpen) {
        selectOption(options[highlightedIndex])
      } else if (!disabled && options.length > 0) {
        openSelect()
      }
      return
    }

    if (event.key === 'Escape') {
      setIsOpen(false)
    }
  }

  return (
    <div
      className={`app-select ${isOpen ? 'is-open' : ''} ${
        opensUpward ? 'opens-upward' : ''
      } ${className ?? ''}`}
      ref={wrapperRef}
    >
      <button
        ref={triggerRef}
        id={triggerId}
        type="button"
        className="app-select-trigger"
        aria-label={ariaLabel}
        aria-haspopup="listbox"
        aria-expanded={isOpen}
        aria-controls={listboxId}
        disabled={disabled}
        onClick={() => {
          if (!disabled && options.length > 0) {
            if (isOpen) {
              setIsOpen(false)
            } else {
              openSelect()
            }
          }
        }}
        onKeyDown={handleKeyDown}
      >
        <span className={!selectedOption && placeholder ? 'app-select-placeholder' : undefined}>
          {displayLabel}
        </span>
        <ChevronDown className="app-select-chevron" size={20} strokeWidth={2} aria-hidden="true" />
      </button>

      {isOpen && (
        <div
          className="app-select-panel"
          role="listbox"
          id={listboxId}
          aria-labelledby={triggerId}
          style={
            autoPlacement && availablePanelHeight !== undefined
              ? { maxHeight: availablePanelHeight }
              : undefined
          }
        >
          {options.map((option, index) => {
            const isSelected = option.value === value
            const isHighlighted = index === highlightedIndex

            return (
              <button
                key={`${option.value}`}
                type="button"
                className={`app-select-option ${isSelected ? 'is-selected' : ''} ${
                  isHighlighted ? 'is-highlighted' : ''
                }`}
                role="option"
                aria-selected={isSelected}
                onMouseEnter={() => setHighlightedIndex(index)}
                onClick={() => selectOption(option)}
              >
                <span className="app-select-check" aria-hidden="true">
                  {isSelected ? <Check size={16} strokeWidth={2.4} /> : null}
                </span>
                <span>{option.label}</span>
              </button>
            )
          })}
        </div>
      )}
    </div>
  )
}
