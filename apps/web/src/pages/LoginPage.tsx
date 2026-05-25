import { FormEvent, useState } from 'react'
import type { CSSProperties } from 'react'
import { supabase } from '@/utils/supabase'
import { getAuthRedirectUrl } from '@/utils/authRedirect'

export default function LoginPage() {
  const [email, setEmail] = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [sent, setSent] = useState(false)

  async function handleEmail(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const cleanEmail = email.trim().toLowerCase()
    if (!cleanEmail) {
      setError('Укажи email, чтобы получить ссылку для входа.')
      return
    }

    setLoading(true)
    setError('')
    setSent(false)

    const { error } = await supabase.auth.signInWithOtp({
      email: cleanEmail,
      options: {
        emailRedirectTo: getAuthRedirectUrl('/age-gate'),
        shouldCreateUser: true,
      },
    })

    setLoading(false)
    if (error) {
      setError(error.message)
      return
    }

    setSent(true)
  }

  return (
    <div style={styles.container}>
      <main style={styles.panel}>
        <div style={styles.kicker}>DOOR//CLUB</div>
        <h1 style={styles.title}>Вход через email</h1>
        <p style={styles.sub}>
          Регистрация гостя откроется только после подтверждения email. Без письма-ссылки профиль не создаётся.
        </p>

        <form onSubmit={handleEmail} style={styles.form}>
          <label style={styles.label}>
            Email
            <input
              type="email"
              value={email}
              onChange={(event) => setEmail(event.target.value)}
              placeholder="you@example.com"
              autoComplete="email"
              disabled={loading}
              style={styles.input}
            />
          </label>

          <button type="submit" style={styles.emailButton} disabled={loading}>
            {loading ? 'ОТПРАВЛЯЕМ ССЫЛКУ...' : 'ПОЛУЧИТЬ ССЫЛКУ ДЛЯ ВХОДА'}
          </button>
        </form>

        {error && <div style={styles.error}>{error}</div>}
        {sent && (
          <div style={styles.success}>
            Проверь почту и открой ссылку. После входа появится регистрация гостя.
          </div>
        )}

        <p style={styles.legal}>
          Только 18+. После входа нужно подтвердить возраст и выбрать уникальный никнейм.
        </p>
      </main>
    </div>
  )
}

const styles: Record<string, CSSProperties> = {
  container: {
    minHeight: '100dvh',
    display: 'grid',
    placeItems: 'center',
    padding: 24,
    background: '#070809',
    color: '#e8e0d2',
    fontFamily: 'monospace',
  },
  panel: {
    width: 'min(420px, 100%)',
    display: 'flex',
    flexDirection: 'column',
    gap: 14,
  },
  kicker: {
    color: '#d8b06f',
    fontSize: 11,
    letterSpacing: 3,
  },
  title: {
    margin: 0,
    color: '#f1eadf',
    fontSize: 28,
    letterSpacing: 0,
    lineHeight: 1.12,
  },
  sub: {
    margin: '0 0 10px',
    color: '#9d9588',
    fontSize: 13,
    lineHeight: 1.6,
  },
  form: {
    display: 'grid',
    gap: 12,
  },
  label: {
    display: 'grid',
    gap: 7,
    color: '#7f776e',
    fontSize: 10,
    letterSpacing: 1.6,
    textTransform: 'uppercase',
  },
  input: {
    minHeight: 44,
    border: '1px solid #2d2a25',
    borderRadius: 4,
    background: '#10100d',
    color: '#f1eadf',
    fontFamily: 'monospace',
    fontSize: 14,
    padding: '0 12px',
    outline: 'none',
  },
  emailButton: {
    minHeight: 48,
    border: '1px solid rgba(216,176,111,0.44)',
    borderRadius: 4,
    background: '#d8b06f',
    color: '#080806',
    fontFamily: 'monospace',
    fontSize: 13,
    fontWeight: 800,
    letterSpacing: 1,
    cursor: 'pointer',
  },
  error: {
    color: '#ff7a7a',
    border: '1px solid rgba(255,122,122,0.28)',
    borderRadius: 4,
    padding: '10px 12px',
    fontSize: 12,
    lineHeight: 1.45,
  },
  success: {
    color: '#bfe6a1',
    border: '1px solid rgba(191,230,161,0.28)',
    borderRadius: 4,
    padding: '10px 12px',
    fontSize: 12,
    lineHeight: 1.45,
  },
  legal: {
    margin: '12px 0 0',
    color: '#6c655d',
    fontSize: 11,
    lineHeight: 1.55,
  },
}
