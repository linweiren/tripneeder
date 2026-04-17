import { useCallback, useMemo, useRef, useState, type ReactNode } from 'react'
import {
  DialogContext,
  type DialogOptions,
} from './dialog'

type DialogState = DialogOptions & {
  type: 'alert' | 'confirm'
}

export function DialogProvider({ children }: { children: ReactNode }) {
  const [dialog, setDialog] = useState<DialogState | null>(null)
  const resolverRef = useRef<((value: boolean) => void) | null>(null)

  const closeDialog = useCallback((value: boolean) => {
    resolverRef.current?.(value)
    resolverRef.current = null
    setDialog(null)
  }, [])

  const openDialog = useCallback(
    (type: DialogState['type'], options: DialogOptions) =>
      new Promise<boolean>((resolve) => {
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

  return (
    <DialogContext.Provider value={value}>
      {children}
      {dialog ? (
        <div className="dialog-backdrop" role="presentation">
          <section
            className="dialog-panel"
            role="dialog"
            aria-modal="true"
            aria-labelledby="app-dialog-title"
            aria-describedby="app-dialog-message"
          >
            <div>
              <h2 id="app-dialog-title">{dialog.title}</h2>
              <p id="app-dialog-message">{dialog.message}</p>
            </div>
            <div className="dialog-actions">
              {dialog.type === 'confirm' ? (
                <button
                  className="secondary-button"
                  type="button"
                  onClick={() => closeDialog(false)}
                >
                  {dialog.cancelLabel ?? '取消'}
                </button>
              ) : null}
              <button
                className="submit-button"
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
