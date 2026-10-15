import {
  useCallback,
  useMemo,
  useRef,
  useState,
  type PointerEvent,
  type ReactNode,
} from 'react'
import {
  DialogContext,
  type DialogOptions,
} from './dialog'

type DialogState = DialogOptions & {
  type: 'alert' | 'confirm'
}

const DRAG_CLOSE_DISTANCE = 60
const DRAG_CLOSE_RATIO = 0.25

export function DialogProvider({ children }: { children: ReactNode }) {
  const [dialog, setDialog] = useState<DialogState | null>(null)
  const [dragOffsetY, setDragOffsetY] = useState(0)
  const [isDraggingDialog, setIsDraggingDialog] = useState(false)
  const dialogPanelRef = useRef<HTMLElement | null>(null)
  const resolverRef = useRef<((value: boolean) => void) | null>(null)
  const dragStartYRef = useRef(0)
  const dragPointerIdRef = useRef<number | null>(null)

  const closeDialog = useCallback((value: boolean) => {
    setDragOffsetY(0)
    setIsDraggingDialog(false)
    dragPointerIdRef.current = null
    resolverRef.current?.(value)
    resolverRef.current = null
    setDialog(null)
  }, [])

  const openDialog = useCallback(
    (type: DialogState['type'], options: DialogOptions) =>
      new Promise<boolean>((resolve) => {
        setDragOffsetY(0)
        setIsDraggingDialog(false)
        dragPointerIdRef.current = null
        resolverRef.current = resolve
        setDialog({
          ...options,
          type,
        })
      }),
    [],
  )

  const value = useMemo(
    () => ({
      alert: async (options: DialogOptions) => {
        await openDialog('alert', options)
      },
      confirm: (options: DialogOptions) => openDialog('confirm', options),
    }),
    [openDialog],
  )

  function handleDragStart(event: PointerEvent<HTMLDivElement>) {
    if (event.button !== 0) {
      return
    }

    event.preventDefault()
    dragStartYRef.current = event.clientY
    dragPointerIdRef.current = event.pointerId
    event.currentTarget.setPointerCapture(event.pointerId)
    setDragOffsetY(0)
    setIsDraggingDialog(true)
  }

  function handleDragMove(event: PointerEvent<HTMLDivElement>) {
    if (dragPointerIdRef.current !== event.pointerId) {
      return
    }

    event.preventDefault()
    const nextOffsetY = Math.max(0, event.clientY - dragStartYRef.current)
    setDragOffsetY(nextOffsetY)
  }

  function handleDragEnd(event: PointerEvent<HTMLDivElement>) {
    if (dragPointerIdRef.current !== event.pointerId) {
      return
    }

    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId)
    }

    const finalOffsetY = Math.max(0, event.clientY - dragStartYRef.current)
    const sheetHeight = dialogPanelRef.current?.getBoundingClientRect().height ?? 0
    const closeThreshold = sheetHeight > 0
      ? Math.min(DRAG_CLOSE_DISTANCE, sheetHeight * DRAG_CLOSE_RATIO)
      : DRAG_CLOSE_DISTANCE

    dragPointerIdRef.current = null
    setIsDraggingDialog(false)

    if (finalOffsetY > closeThreshold) {
      closeDialog(false)
      return
    }

    setDragOffsetY(0)
  }

  function handleDragCancel(event: PointerEvent<HTMLDivElement>) {
    if (dragPointerIdRef.current !== event.pointerId) {
      return
    }

    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId)
    }

    dragPointerIdRef.current = null
    setIsDraggingDialog(false)
    setDragOffsetY(0)
  }

  return (
    <DialogContext.Provider value={value}>
      {children}
      {dialog ? (
        <div className="dialog-backdrop" role="presentation">
          <section
            ref={dialogPanelRef}
            className={`dialog-panel${isDraggingDialog ? ' dialog-panel-dragging' : ''}`}
            style={{ transform: `translateY(${dragOffsetY}px)` }}
            role="dialog"
            aria-modal="true"
            aria-labelledby="app-dialog-title"
            aria-describedby="app-dialog-message"
          >
            <div
              className={`dialog-drag-zone${isDraggingDialog ? ' dialog-drag-zone-dragging' : ''}`}
              aria-label="下滑關閉視窗"
              onPointerDown={handleDragStart}
              onPointerMove={handleDragMove}
              onPointerUp={handleDragEnd}
              onPointerCancel={handleDragCancel}
            >
              <div className="dialog-handle" aria-hidden="true" />
            </div>
            <div className="dialog-content">
              <h2 id="app-dialog-title">{dialog.title}</h2>
              <p id="app-dialog-message">{dialog.message}</p>
            </div>
            <div className={`dialog-actions dialog-actions-${dialog.type}`}>
              {dialog.type === 'confirm' ? (
                <button
                  className="secondary-button dialog-button dialog-button-secondary"
                  type="button"
                  onClick={() => closeDialog(false)}
                >
                  {dialog.cancelLabel ?? '取消'}
                </button>
              ) : null}
              <button
                className="submit-button dialog-button dialog-button-primary"
                type="button"
                autoFocus
                onClick={() => closeDialog(true)}
              >
                {dialog.confirmLabel ?? '確認'}
              </button>
            </div>
          </section>
        </div>
      ) : null}
    </DialogContext.Provider>
  )
}
