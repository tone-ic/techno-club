import { FormEvent, useEffect, useState } from 'react'
import type { CSSProperties } from 'react'
import { useNavigate } from 'react-router-dom'
import { supabase } from '@/utils/supabase'
import { usePlayerStore } from '@/store/playerStore'

type OnboardingResult =
  | 'ok'
  | 'underage'
  | 'duplicate'
  | 'invalid_name'
  | 'invalid_age'
  | 'cooldown'
  | 'unauthorized'
  | 'email_required'

const NAME_RE = /^[\p{L}\p{N}_ .-]+$/u

export default function AgeGatePage() {
  const navigate = useNavigate()
  const userId = usePlayerStore((state) => state.userId)
  const setDisplayName = usePlayerStore((state) => state.setDisplayName)
  const [nickname, setNickname] = useState('')
  const [age, setAge] = useState('')
  const [loading, setLoading] = useState(false)
  const [message, setMessage] = useState('')
  const [blocked, setBlocked] = useState(false)

  useEffect(() => {
    if (!userId) {
      navigate('/login', { replace: true })
      return
    }

    let cancelled = false
    supabase
      .from('profiles')
      .select('display_name, age, onboarding_completed, underage_blocked_at')
      .eq('user_id', userId)
      .maybeSingle()
      .then(({ data }) => {
        if (cancelled || !data) return
        const profile = data as any
        if (profile.underage_blocked_at) {
          setBlocked(true)
          setMessage('Регистрация и посещение DOOR//CLUB запрещены: указанный возраст меньше 18 лет.')
          window.setTimeout(() => {
            void supabase.auth.signOut().finally(() => {
              usePlayerStore.getState().reset()
              navigate('/login', { replace: true })
            })
          }, 2600)
          return
        }
        if (profile.onboarding_completed) {
          navigate('/camera', { replace: true })
          return
        }
        if (profile.display_name && profile.display_name !== 'Аноним') setNickname(profile.display_name)
        if (profile.age) setAge(String(profile.age))
      })

    return () => {
      cancelled = true
    }
  }, [navigate, userId])

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (blocked || loading) return

    const cleanName = nickname.trim().replace(/\s+/g, ' ')
    const parsedAge = Number(age)
    const validation = validate(cleanName, parsedAge)
    if (validation) {
      setMessage(validation)
      return
    }

    setLoading(true)
    setMessage('')
    const { data, error } = await supabase.rpc('complete_profile_onboarding', {
      p_display_name: cleanName,
      p_age: parsedAge,
    })
    setLoading(false)

    if (error) {
      setMessage(error.message.includes('complete_profile_onboarding')
        ? 'Нужно применить миграцию профиля в Supabase, затем повторить регистрацию.'
        : error.message)
      return
    }

    const result = (data as { status?: OnboardingResult; next_change_at?: string; display_name?: string } | null)?.status
    if (result === 'ok') {
      setDisplayName(cleanName)
      window.dispatchEvent(new CustomEvent('profile-onboarding-completed', { detail: { displayName: cleanName } }))
      navigate('/camera', { replace: true })
      return
    }

    if (result === 'underage') {
      setBlocked(true)
      setMessage('Регистрация и посещение сайта/клуба запрещены: доступ только для гостей 18+.')
      window.setTimeout(() => {
        void supabase.auth.signOut().finally(() => {
          usePlayerStore.getState().reset()
          navigate('/login', { replace: true })
        })
      }, 3200)
      return
    }

    if (result === 'duplicate') {
      setMessage('Такой пользователь уже существует. Выбери другой никнейм.')
      return
    }

    if (result === 'cooldown') {
      setMessage('Имя можно изменить не чаще одного раза в неделю.')
      return
    }

    if (result === 'email_required' || result === 'unauthorized') {
      setMessage('Регистрация гостя доступна только после входа через email.')
      void supabase.auth.signOut().finally(() => {
        usePlayerStore.getState().reset()
        navigate('/login', { replace: true })
      })
      return
    }

    setMessage('Проверь никнейм и возраст, затем попробуй снова.')
  }

  return (
    <div style={pageStyle}>
      <main style={formWrapStyle}>
        <div style={brandStyle}>DOOR//CLUB</div>
        <h1 style={titleStyle}>Регистрация гостя</h1>
        <p style={noticeStyle}>
          Имя можно изменить не чаще одного раза в неделю. От установленного имени может зависеть проход в заведение.
          Не пытайтесь никого оскорбить: за оскорбительное имя можно получить бан навсегда.
        </p>

        <form onSubmit={submit} style={formStyle}>
          <label style={fieldStyle}>
            Никнейм
            <input
              value={nickname}
              onChange={(event) => setNickname(event.target.value.slice(0, 24))}
              placeholder="например: Mila Signal"
              maxLength={24}
              disabled={blocked}
              style={inputStyle}
            />
          </label>

          <label style={fieldStyle}>
            Возраст
            <input
              value={age}
              onChange={(event) => setAge(event.target.value.replace(/[^\d]/g, '').slice(0, 3))}
              placeholder="18"
              inputMode="numeric"
              disabled={blocked}
              style={inputStyle}
            />
          </label>

          <button type="submit" disabled={blocked || loading} style={buttonStyle(blocked || loading)}>
            {loading ? 'ПРОВЕРЯЕМ...' : 'ПОДТВЕРДИТЬ'}
          </button>
        </form>

        {message && (
          <div style={{ ...messageStyle, color: blocked ? '#ff7a7a' : '#d8d0c2', borderColor: blocked ? 'rgba(255,122,122,0.34)' : 'rgba(216,176,111,0.28)' }}>
            {message}
          </div>
        )}
      </main>
    </div>
  )
}

function validate(name: string, age: number) {
  if (name.length < 3 || name.length > 24) return 'Никнейм должен быть от 3 до 24 символов.'
  if (!NAME_RE.test(name)) return 'В никнейме можно использовать буквы, цифры, пробел, точку, дефис и подчёркивание.'
  if (!Number.isInteger(age) || age < 1 || age > 120) return 'Укажи реальный возраст.'
  return ''
}

const pageStyle: CSSProperties = {
  minHeight: '100dvh',
  display: 'grid',
  placeItems: 'center',
  padding: 24,
  background: '#070809',
  color: '#e8e0d2',
  fontFamily: 'monospace',
}

const formWrapStyle: CSSProperties = {
  width: 'min(520px, 100%)',
}

const brandStyle: CSSProperties = {
  color: '#d8b06f',
  fontSize: 11,
  letterSpacing: 3,
  marginBottom: 12,
}

const titleStyle: CSSProperties = {
  margin: '0 0 12px',
  fontSize: 27,
  lineHeight: 1.12,
  letterSpacing: 0,
}

const noticeStyle: CSSProperties = {
  margin: '0 0 18px',
  color: '#aaa194',
  fontSize: 12,
  lineHeight: 1.65,
}

const formStyle: CSSProperties = {
  display: 'grid',
  gap: 12,
}

const fieldStyle: CSSProperties = {
  display: 'grid',
  gap: 7,
  color: '#7f776e',
  fontSize: 10,
  letterSpacing: 1.6,
  textTransform: 'uppercase',
}

const inputStyle: CSSProperties = {
  minHeight: 42,
  border: '1px solid #2d2a25',
  borderRadius: 4,
  background: '#10100d',
  color: '#f1eadf',
  fontFamily: 'monospace',
  fontSize: 14,
  padding: '0 12px',
  outline: 'none',
}

function buttonStyle(disabled: boolean): CSSProperties {
  return {
    minHeight: 46,
    border: 'none',
    borderRadius: 4,
    background: disabled ? '#28251f' : '#d8b06f',
    color: disabled ? '#736b60' : '#080806',
    fontFamily: 'monospace',
    fontSize: 13,
    fontWeight: 800,
    letterSpacing: 1,
    cursor: disabled ? 'not-allowed' : 'pointer',
  }
}

const messageStyle: CSSProperties = {
  marginTop: 14,
  border: '1px solid',
  borderRadius: 4,
  padding: '10px 12px',
  fontSize: 12,
  lineHeight: 1.5,
}
