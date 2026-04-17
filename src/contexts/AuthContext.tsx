import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react'
import type { Session, User } from '@supabase/supabase-js'
import { AuthContext } from './auth'
import {
  isSupabaseConfigured,
  supabase,
} from '../services/auth/supabaseClient'
import { initializeUserProfile } from '../services/points/pointsService'

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null)
  const [isAuthLoading, setIsAuthLoading] = useState(() => Boolean(supabase))

  useEffect(() => {
    if (!supabase) {
      return
    }

    let isMounted = true

    supabase.auth
      .getSession()
      .then(({ data }) => {
        if (isMounted) {
          setUser(data.session?.user ?? null)
        }
      })
      .finally(() => {
        if (isMounted) {
          setIsAuthLoading(false)
        }
      })

    const { data } = supabase.auth.onAuthStateChange(
      (_event, session: Session | null) => {
        setUser(session?.user ?? null)
        setIsAuthLoading(false)
      },
    )

    return () => {
      isMounted = false
      data.subscription.unsubscribe()
    }
  }, [])

  useEffect(() => {
    if (!user) {
      return
    }

    void initializeUserProfile().catch(() => {
      // Points schema may not be installed yet during local setup.
    })
  }, [user])

  const signInWithGoogle = useCallback(async () => {
    if (!supabase) {
      throw new Error('尚未設定 Supabase，請先補上登入設定。')
    }

    const { error } = await supabase.auth.signInWithOAuth({
      provider: 'google',
      options: {
        redirectTo: window.location.origin,
      },
    })

    if (error) {
      throw error
    }
  }, [])

  const signOut = useCallback(async () => {
    if (!supabase) {
      return
    }

    const { error } = await supabase.auth.signOut()

    if (error) {
      throw error
    }
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
