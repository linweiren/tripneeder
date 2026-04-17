import { createContext, useContext } from 'react'

export type DialogOptions = {
  title: string
  message: string
  confirmLabel?: string
  cancelLabel?: string
}

export type DialogContextValue = {
  alert: (options: DialogOptions) => Promise<void>
  confirm: (options: DialogOptions) => Promise<boolean>
}

export const DialogContext = createContext<DialogContextValue | null>(null)

export function useDialog() {
  const context = useContext(DialogContext)

  if (!context) {
    throw new Error('useDialog must be used inside DialogProvider')
  }

  return context
}
