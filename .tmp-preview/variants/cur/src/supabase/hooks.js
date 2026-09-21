import { useState, useEffect } from 'react'
import { supabase } from './client'

/**
 * Custom hook to access Supabase client and user session
 * @returns {{ supabase, user, session, loading }}
 */
export function useSupabase() {
  const [session, setSession] = useState(null)
  const [user, setUser] = useState(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    // Get initial session
    supabase.auth.getSession().then(({ data: { session } }) => {
      setSession(session)
      setUser(session?.user ?? null)
      setLoading(false)
    })

    // Listen for auth changes
    const {
      data: { subscription },
    } = supabase.auth.onAuthStateChange((_event, session) => {
      setSession(session)
      setUser(session?.user ?? null)
      setLoading(false)
    })

    // Cleanup subscription
    return () => subscription.unsubscribe()
  }, [])

  return {
    supabase,
    user,
    session,
    loading,
  }
}
