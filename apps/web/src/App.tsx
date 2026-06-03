import { BrowserRouter, Routes, Route, Navigate, useLocation, useNavigate } from 'react-router-dom'
import { useEffect, useState } from 'react'
import type { ReactNode } from 'react'
import { supabase } from '@/utils/supabase'
import { isEmailAuthorizedUser } from '@/utils/emailAuth'
import { usePlayerStore } from '@/store/playerStore'
import { DEFAULT_AVATAR_CONFIG } from '@shared/types'
import type { AvatarConfig } from '@shared/types'
import { lazy, Suspense } from 'react'
import MusicPlayer from '@/components/MusicPlayer'
import ScreenWakeLock from '@/components/ScreenWakeLock'

const LoginPage   = lazy(() => import('@/pages/LoginPage'))
const AgeGatePage = lazy(() => import('@/pages/AgeGatePage'))
const CameraPage  = lazy(() => import('@/pages/CameraPage'))
const AvatarPage  = lazy(() => import('@/pages/AvatarPage'))
const OutsidePage = lazy(() => import('@/pages/OutsidePage'))
const ClubPage    = lazy(() => import('@/pages/ClubPage'))
const BouncerPage = lazy(() => import('@/pages/BouncerPage'))
const DJPage      = lazy(() => import('@/pages/DJPage'))
const AdminPage   = lazy(() => import('@/pages/AdminPage'))

function LoadingScreen() {
  return (
    <div style={{
      display: 'flex', alignItems: 'center', justifyContent: 'center',
      height: '100vh', color: '#e040fb', fontFamily: 'monospace', fontSize: 14,
      background: '#0d0d1a',
    }}>
      DOOR//CLUB
    </div>
  )
}

type OnboardingState = {
  ready: boolean
  completed: boolean
  underageBlocked: boolean
}

function RequireAuth({ children }: { children: ReactNode }) {
  const { userId } = usePlayerStore()
  if (!userId) return <Navigate to="/login" replace />
  return <>{children}</>
}

function RequireOnboarding({ state, children }: { state: OnboardingState; children: ReactNode }) {
  if (!state.ready) return <LoadingScreen />
  if (!state.completed || state.underageBlocked) return <Navigate to="/age-gate" replace />
  return <>{children}</>
}

function RequireAvatar({ children }: { children: ReactNode }) {
  const { userId, avatarConfig, setAvatarConfig } = usePlayerStore()
  const [checkedUserId, setCheckedUserId] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)

  const restoreAvatarConfig = (record: any): AvatarConfig | null => {
    const config = record?.config_json && typeof record.config_json === 'object'
      ? record.config_json as Partial<AvatarConfig>
      : null
    const modelUrl = firstString(config?.modelUrl, config?.rpmGlbUrl, record?.glb_url, record?.model_url)
    const faceTextureUrl = firstString(config?.faceTextureUrl, record?.face_tex_url, record?.face_texture_url)
    const bodyTextureUrl = firstString(config?.bodyTextureUrl, record?.body_tex_url, record?.body_texture_url)

    if (!config && !modelUrl && !faceTextureUrl && !bodyTextureUrl) return null
    return {
      ...DEFAULT_AVATAR_CONFIG,
      ...config,
      modelUrl: modelUrl ?? config?.modelUrl ?? null,
      rpmGlbUrl: config?.rpmGlbUrl ?? null,
      faceTextureUrl: faceTextureUrl ?? config?.faceTextureUrl ?? null,
      bodyTextureUrl: bodyTextureUrl ?? config?.bodyTextureUrl ?? null,
      autorig: config?.autorig ?? null,
    }
  }

  useEffect(() => {
    if (avatarConfig || !userId) {
      setLoading(false)
      setCheckedUserId(userId)
      return
    }

    let cancelled = false
    setLoading(true)
    setCheckedUserId(null)

    void (async () => {
      try {
        const { data } = await supabase
          .from('avatars')
          .select('config_json, glb_url, face_tex_url')
          .eq('user_id', userId)
          .order('created_at', { ascending: false })
          .limit(1)
          .maybeSingle()

        if (cancelled) return
        const restored = restoreAvatarConfig(data)
        if (restored) setAvatarConfig(restored)
        setCheckedUserId(userId)
        setLoading(false)
      } catch {
        if (cancelled) return
        setCheckedUserId(userId)
        setLoading(false)
      }
    })()

    return () => {
      cancelled = true
    }
  }, [userId, avatarConfig, setAvatarConfig])

  if (avatarConfig) return <>{children}</>
  if (!userId || loading || checkedUserId !== userId) return <LoadingScreen />
  return <Navigate to="/camera" replace />
}

function firstString(...values: unknown[]) {
  for (const value of values) {
    if (typeof value === 'string' && value.trim()) return value
  }
  return null
}

function RequireRole({ allowed, children }: { allowed: string[]; children: ReactNode }) {
  const role = usePlayerStore((state) => state.role)
  if (!allowed.includes(role)) return <Navigate to="/outside" replace />
  return <>{children}</>
}

function AccountSwitchButton() {
  const location = useLocation()
  const navigate = useNavigate()
  const userId = usePlayerStore((state) => state.userId)
  const [busy, setBusy] = useState(false)

  if (!userId || location.pathname === '/login') return null

  const switchAccount = async () => {
    if (busy) return
    setBusy(true)
    try {
      await supabase.auth.signOut()
    } finally {
      usePlayerStore.getState().reset()
      navigate('/login', { replace: true })
    }
  }

  return (
    <button
      type="button"
      onClick={() => void switchAccount()}
      disabled={busy}
      aria-label="Сменить аккаунт"
      title="Сменить аккаунт"
      style={{
        position: 'fixed',
        top: 'max(12px, env(safe-area-inset-top))',
        right: 'max(12px, env(safe-area-inset-right))',
        zIndex: 10050,
        height: 34,
        padding: '0 12px',
        borderRadius: 6,
        border: '1px solid rgba(255,255,255,0.18)',
        background: 'rgba(10, 12, 22, 0.72)',
        color: '#f5f7ff',
        fontFamily: 'Inter, system-ui, sans-serif',
        fontSize: 12,
        fontWeight: 700,
        letterSpacing: 0,
        cursor: busy ? 'default' : 'pointer',
        opacity: busy ? 0.62 : 1,
        backdropFilter: 'blur(12px)',
        boxShadow: '0 8px 22px rgba(0,0,0,0.28)',
      }}
    >
      {busy ? 'Выходим...' : 'Сменить аккаунт'}
    </button>
  )
}

export default function App() {
  const { userId, setUserId, setAccountEmail, setDisplayName, setRole } = usePlayerStore()
  const [authReady, setAuthReady] = useState(false)
  const [onboarding, setOnboarding] = useState<OnboardingState>({
    ready: false,
    completed: false,
    underageBlocked: false,
  })

  useEffect(() => {
    const onOnboardingCompleted = (event: Event) => {
      const displayName = (event as CustomEvent<{ displayName?: string }>).detail?.displayName
      if (displayName) setDisplayName(displayName)
      setOnboarding({ ready: true, completed: true, underageBlocked: false })
    }
    window.addEventListener('profile-onboarding-completed', onOnboardingCompleted)

    const loadProfile = async (nextUserId: string | null) => {
      if (!nextUserId) {
        setOnboarding({ ready: true, completed: false, underageBlocked: false })
        return
      }

      const { data, error } = await supabase
        .from('profiles')
        .select('display_name, role, age_confirmed, onboarding_completed, underage_blocked_at')
        .eq('user_id', nextUserId)
        .maybeSingle()

      if (error) {
        setOnboarding({ ready: true, completed: false, underageBlocked: false })
        return
      }

      const profile = data as any
      if (profile?.display_name && profile.onboarding_completed) setDisplayName(profile.display_name)
      if (profile?.role) setRole(profile.role)
      setOnboarding({
        ready: true,
        completed: Boolean(profile?.onboarding_completed && profile?.age_confirmed),
        underageBlocked: Boolean(profile?.underage_blocked_at),
      })
    }

    supabase.auth.getSession().then(async ({ data: { session } }) => {
      if (session?.user && isEmailAuthorizedUser(session.user)) {
        setUserId(session.user.id)
        setAccountEmail(session.user.email ?? null)
        await loadProfile(session.user.id)
      } else {
        if (session?.user) await supabase.auth.signOut()
        usePlayerStore.getState().reset()
        await loadProfile(null)
      }
      setAuthReady(true)
    })

    const { data: { subscription } } = supabase.auth.onAuthStateChange((_event, session) => {
      if (session?.user && isEmailAuthorizedUser(session.user)) {
        setUserId(session.user.id)
        setAccountEmail(session.user.email ?? null)
        void loadProfile(session.user.id)
        return
      }

      if (session?.user) void supabase.auth.signOut()
      usePlayerStore.getState().reset()
      void loadProfile(null)
    })

    return () => {
      subscription.unsubscribe()
      window.removeEventListener('profile-onboarding-completed', onOnboardingCompleted)
    }
  }, [setUserId, setAccountEmail, setDisplayName, setRole])

  if (!authReady) return <LoadingScreen />

  return (
    <BrowserRouter>
      <Suspense fallback={<LoadingScreen />}>
        <Routes>
          <Route path="/login"    element={userId ? <Navigate to={onboarding.completed ? '/outside' : '/age-gate'} replace /> : <LoginPage />} />
          <Route path="/age-gate" element={<RequireAuth><AgeGatePage /></RequireAuth>} />
          <Route path="/camera"   element={<RequireAuth><RequireOnboarding state={onboarding}><CameraPage /></RequireOnboarding></RequireAuth>} />
          <Route path="/avatar"   element={<RequireAuth><RequireOnboarding state={onboarding}><AvatarPage /></RequireOnboarding></RequireAuth>} />
          <Route path="/outside"  element={<RequireAuth><RequireOnboarding state={onboarding}><RequireAvatar><OutsidePage /></RequireAvatar></RequireOnboarding></RequireAuth>} />
          <Route path="/club"     element={<RequireAuth><RequireOnboarding state={onboarding}><RequireAvatar><ClubPage /></RequireAvatar></RequireOnboarding></RequireAuth>} />
          <Route path="/bouncer" element={<RequireAuth><RequireOnboarding state={onboarding}><RequireRole allowed={['bouncer', 'owner', 'admin']}><BouncerPage /></RequireRole></RequireOnboarding></RequireAuth>} />
          <Route path="/dj"       element={<RequireAuth><RequireOnboarding state={onboarding}><RequireRole allowed={['dj', 'owner', 'admin']}><DJPage /></RequireRole></RequireOnboarding></RequireAuth>} />
          <Route path="/admin"    element={<RequireAuth><RequireOnboarding state={onboarding}><RequireRole allowed={['owner', 'admin']}><AdminPage /></RequireRole></RequireOnboarding></RequireAuth>} />
          <Route path="/"         element={<Navigate to="/outside" replace />} />
          <Route path="*"         element={<Navigate to="/" replace />} />
        </Routes>
        <AccountSwitchButton />
        <MusicPlayer />
        <ScreenWakeLock />
      </Suspense>
    </BrowserRouter>
  )
}
