import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react'
import type { Session, User } from '@supabase/supabase-js'
import { AuthContext } from './auth'
import {
  isSupabaseConfigured,
  supabase,
} from '../services/auth/supabaseClient'
import { prepareTripRecordsForUser } from '../services/tripRecords/tripRecordService'

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null)
  const [isAuthLoading, setIsAuthLoading] = useState(() => Boolean(supabase))

  useEffect(() => {
    if (!supabase) {
      setIsAuthLoading(false)
      return
    }

    let isMounted = true
    const authClient = supabase

    // 核心邏輯：初始化 Session 並設定監聽器
    async function initializeAuth() {
      try {
        const { data } = await authClient.auth.getSession()
        if (isMounted) {
          setUser(data.session?.user ?? null)
        }
      } catch (error) {
        console.error('Auth initialization error:', error)
      } finally {
        if (isMounted) setIsAuthLoading(false)
      }
    }

    initializeAuth()

    const { data: { subscription } } = authClient.auth.onAuthStateChange(
      (_event, session: Session | null) => {
        if (isMounted) {
          setUser(session?.user ?? null)
          setIsAuthLoading(false)
        }
      },
    )

    return () => {
      isMounted = false
      subscription.unsubscribe()
    }
  }, [])

  // 當 User 確定存在時，才執行預載
  useEffect(() => {
    if (!user) return
    void prepareTripRecordsForUser(user.id).catch(() => {})
  }, [user])

  const signInWithGoogle = useCallback(async () => {
    if (!supabase) throw new Error('尚未設定 Supabase')
    const { error } = await supabase.auth.signInWithOAuth({
      provider: 'google',
      options: { redirectTo: window.location.origin },
    })
    if (error) throw error
  }, [])

  const signOut = useCallback(async () => {
    if (!supabase) return
    const { error } = await supabase.auth.signOut()
    if (error) throw error
  }, [])

  const value = useMemo(
    () => ({
      user,
      isAuthLoading,
      isSupabaseReady: isSupabaseConfigured,
      signInWithGoogle,
      signOut,
    }),
    [isAuthLoading, signInWithGoogle, signOut, user],
  )

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>
}
