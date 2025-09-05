'use client'

import { useEffect } from 'react'
import { useRouter } from 'next/navigation'

export default function PostAuth() {
  const router = useRouter()

  useEffect(() => {
    try {
      // If tokens exist in localStorage, set the auth cookie so middleware allows /main
      if (typeof window !== 'undefined') {
        const hasToken = !!(
          localStorage.getItem('DS') ||
          localStorage.getItem('DSR') ||
          localStorage.getItem('sessionToken') ||
          localStorage.getItem('descopeSessionToken') ||
          localStorage.getItem('descope-session') ||
          localStorage.getItem('access_token') ||
          localStorage.getItem('authToken')
        )
        if (hasToken) {
          try { document.cookie = 'auth=1; Max-Age=' + 7 * 24 * 60 * 60 + '; path=/' } catch {}
        }
      }
    } finally {
      // Always proceed to main; middleware will gate if cookie absent
      router.replace('/main')
    }
  }, [router])

  return (
    <div className="min-h-screen bg-black text-neutral-100 flex items-center justify-center p-6">
      <div className="animate-pulse text-neutral-400">Finalizing sign-in…</div>
    </div>
  )
}
