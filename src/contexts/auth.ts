import { createContext, useContext } from 'react'
import type { User } from '@supabase/supabase-js'

export type AuthContextValue = {
  user: User | null
  isAuthLoading: boolean
  isSupabaseReady: boolean
  signInWithGoogle: () => Promise<void>
  signOut: () => Promise<void>
}

export const AuthContext = createContext<AuthContextValue | null>(null)

export function useAuth() {
  const context = useContext(AuthContext)

  if (!context) {
    throw new Error('useAuth must be used inside AuthProvider')
  }

  return context
}
