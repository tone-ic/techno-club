import { useEffect, useState } from 'react'
import type { CSSProperties } from 'react'
import { useNavigate } from 'react-router-dom'
import AvatarPreview3D from '@/components/AvatarPreview3D'
import { useAudioStore } from '@/store/audioStore'
import { usePlayerStore } from '@/store/playerStore'
import { supabase } from '@/utils/supabase'

export type AppLanguage = 'ru' | 'en'

const LANGUAGE_STORAGE_KEY = 'doorclub-language'

export function readAppLanguage(): AppLanguage {
  try {
    return localStorage.getItem(LANGUAGE_STORAGE_KEY) === 'en' ? 'en' : 'ru'
  } catch {
    return 'ru'
  }
}

export function setAppLanguage(language: AppLanguage) {
  try {
    localStorage.setItem(LANGUAGE_STORAGE_KEY, language)
  } catch {}
  document.documentElement.lang = language
  window.dispatchEvent(new CustomEvent('doorclub-language-change', { detail: { language } }))
}

export function useAppLanguage() {
  const [language, setLanguageState] = useState<AppLanguage>(readAppLanguage)

  useEffect(() => {
    setAppLanguage(language)
    const onLanguageChange = (event: Event) => {
      const next = (event as CustomEvent<{ language?: AppLanguage }>).detail?.language
      if (next === 'ru' || next === 'en') setLanguageState(next)
    }
    window.addEventListener('doorclub-language-change', onLanguageChange)
    return () => window.removeEventListener('doorclub-language-change', onLanguageChange)
  }, [language])

  const toggleLanguage = () => {
    const next = language === 'ru' ? 'en' : 'ru'
    setLanguageState(next)
    setAppLanguage(next)
  }

  return { language, toggleLanguage }
}

export function appText(language: AppLanguage, ru: string, en: string) {
  return language === 'ru' ? ru : en
}

export function LanguageToggleButton({ compact = false }: { compact?: boolean }) {
  const { language, toggleLanguage } = useAppLanguage()
  const label = appText(language, 'Сменить язык', 'Change language')
  return (
    <button
      type="button"
      onClick={toggleLanguage}
      style={compact ? compactLanguageButtonStyle : settingsActionButtonStyle}
      aria-label={label}
      title={label}
    >
      {language === 'ru' ? 'RU' : 'EN'}
    </button>
  )
}

export function SettingsButton({ onClick, active = false }: { onClick: () => void; active?: boolean }) {
  const { language } = useAppLanguage()
  const label = appText(language, 'Настройки', 'Settings')
  return (
    <button
      type="button"
      onClick={onClick}
      style={{
        ...settingsFabStyle,
        background: active ? '#d8b06f' : 'rgba(13,13,22,0.82)',
        color: active ? '#090807' : '#d8d0c2',
      }}
      aria-label={label}
      title={label}
    >
      ⚙
    </button>
  )
}

export default function AppSettings({
  open,
  onClose,
  onChangeOutfit,
  changeOutfitDisabled = false,
  changeOutfitLabel = 'Сменить образ',
  onExitOutside,
}: {
  open: boolean
  onClose: () => void
  onChangeOutfit?: () => void
  changeOutfitDisabled?: boolean
  changeOutfitLabel?: string
  onExitOutside?: () => void
}) {
  const navigate = useNavigate()
  const role = usePlayerStore((state) => state.role)
  const accountEmail = usePlayerStore((state) => state.accountEmail)
  const avatarConfig = usePlayerStore((state) => state.avatarConfig)
  const musicVolume = useAudioStore((state) => state.masterVolume)
  const voiceVolume = useAudioStore((state) => state.voiceVolume)
  const setMusicVolume = useAudioStore((state) => state.setMasterVolume)
  const setVoiceVolume = useAudioStore((state) => state.setVoiceVolume)
  const { language, toggleLanguage } = useAppLanguage()
  const [busy, setBusy] = useState(false)
  const text = {
    title: appText(language, 'Настройки', 'Settings'),
    model: appText(language, 'Модель', 'Model'),
    noModel: appText(language, 'нет модели', 'no model'),
    serverRole: appText(language, 'Серверная роль', 'Server role'),
    controls: appText(language, 'Управление', 'Controls'),
    language: appText(language, 'Язык', 'Language'),
    russian: appText(language, 'Русский', 'Russian'),
    english: 'English',
    exitOutside: appText(language, 'Выйти наружу', 'Go outside'),
    musicVolume: appText(language, 'Громкость музыки', 'Music volume'),
    voiceVolume: appText(language, 'Громкость входящего голосового чата', 'Incoming voice chat volume'),
    signingOut: appText(language, 'Выходим...', 'Signing out...'),
    switchAccount: appText(language, 'Сменить аккаунт', 'Switch account'),
  }

  if (!open) return null

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
    <div style={settingsBackdropStyle} onPointerDown={onClose}>
      <section style={settingsPanelStyle} onPointerDown={(event) => event.stopPropagation()}>
        <div style={settingsHeaderStyle}>
          <div>
            <div style={settingsKickerStyle}>DOOR//CLUB</div>
            <div style={settingsTitleStyle}>{text.title}</div>
          </div>
          <button type="button" onClick={onClose} style={settingsCloseButtonStyle}>X</button>
        </div>

        <div style={settingsGridStyle}>
          <div style={settingsPreviewColumnStyle}>
            <div style={settingsSectionTitleStyle}>{text.model}</div>
            {avatarConfig ? (
              <AvatarPreview3D
                config={avatarConfig}
                width={128}
                height={178}
                style={settingsAvatarPreviewStyle}
              />
            ) : (
              <div style={settingsEmptyPreviewStyle}>{text.noModel}</div>
            )}
            <div style={settingsRoleBoxStyle}>
              <span>{text.serverRole}</span>
              <strong>{roleLabel(role)}</strong>
            </div>
            {accountEmail && <div style={settingsEmailStyle}>{accountEmail}</div>}
          </div>

          <div style={settingsControlsColumnStyle}>
            <div style={settingsSectionTitleStyle}>{text.controls}</div>
            <button type="button" onClick={toggleLanguage} style={settingsActionButtonStyle}>
              {text.language}: {language === 'ru' ? text.russian : text.english}
            </button>
            <button
              type="button"
              disabled={!onChangeOutfit || changeOutfitDisabled}
              onClick={() => {
                onClose()
                onChangeOutfit?.()
              }}
              style={{
                ...settingsActionButtonStyle,
                opacity: !onChangeOutfit || changeOutfitDisabled ? 0.48 : 1,
                cursor: !onChangeOutfit || changeOutfitDisabled ? 'not-allowed' : 'pointer',
              }}
            >
              {changeOutfitLabel}
            </button>
            {onExitOutside && (
              <button
                type="button"
                onClick={() => {
                  onClose()
                  onExitOutside()
                }}
                style={settingsActionButtonStyle}
              >
                {text.exitOutside}
              </button>
            )}

            <SettingsSlider
              label={text.musicVolume}
              value={musicVolume}
              onChange={setMusicVolume}
            />
            <SettingsSlider
              label={text.voiceVolume}
              value={voiceVolume}
              onChange={setVoiceVolume}
            />

            <button
              type="button"
              onClick={() => void switchAccount()}
              disabled={busy}
              style={{
                ...settingsDangerButtonStyle,
                opacity: busy ? 0.62 : 1,
                cursor: busy ? 'default' : 'pointer',
              }}
            >
              {busy ? text.signingOut : text.switchAccount}
            </button>
          </div>
        </div>
      </section>
    </div>
  )
}

function SettingsSlider({
  label,
  value,
  onChange,
}: {
  label: string
  value: number
  onChange: (value: number) => void
}) {
  return (
    <label style={settingsSliderLabelStyle}>
      <span>{label}</span>
      <input
        type="range"
        min={0}
        max={1}
        step={0.01}
        value={value}
        onChange={(event) => onChange(Number(event.target.value))}
        style={settingsRangeStyle}
      />
      <strong>{Math.round(value * 100)}%</strong>
    </label>
  )
}

function roleLabel(role: string) {
  if (role === 'bouncer') return 'FACECONTROL'
  if (role === 'guard') return 'SECURITY'
  if (role === 'bartender') return 'BARTENDER'
  if (role === 'guest') return 'GUEST'
  return role.toUpperCase()
}

const settingsFabStyle: CSSProperties = {
  minWidth: 38,
  height: 34,
  padding: '0 11px',
  borderRadius: 4,
  border: '1px solid rgba(255,255,255,0.18)',
  fontFamily: 'monospace',
  fontSize: 17,
  fontWeight: 900,
  cursor: 'pointer',
  pointerEvents: 'auto',
}

const settingsBackdropStyle: CSSProperties = {
  position: 'fixed',
  inset: 0,
  zIndex: 10040,
  background: 'rgba(0,0,0,0.42)',
  display: 'grid',
  placeItems: 'start end',
  padding: 'calc(56px + env(safe-area-inset-top, 0px)) 12px calc(18px + env(safe-area-inset-bottom, 0px))',
  pointerEvents: 'auto',
}

const settingsPanelStyle: CSSProperties = {
  width: 'min(420px, calc(100vw - 24px))',
  maxHeight: 'calc(100dvh - 84px)',
  overflowY: 'auto',
  borderRadius: 6,
  border: '1px solid rgba(216,176,111,0.34)',
  background: 'rgba(8,9,12,0.96)',
  boxShadow: '0 20px 60px rgba(0,0,0,0.5)',
  color: '#e8e0d2',
  fontFamily: 'monospace',
}

const settingsHeaderStyle: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'space-between',
  gap: 12,
  padding: 14,
  borderBottom: '1px solid rgba(255,255,255,0.08)',
}

const settingsKickerStyle: CSSProperties = {
  color: '#d8b06f',
  fontSize: 10,
  letterSpacing: 2.2,
}

const settingsTitleStyle: CSSProperties = {
  marginTop: 4,
  color: '#f1eadf',
  fontSize: 17,
  fontWeight: 900,
  letterSpacing: 0,
}

const settingsCloseButtonStyle: CSSProperties = {
  width: 32,
  height: 30,
  borderRadius: 4,
  border: '1px solid rgba(255,255,255,0.14)',
  background: 'rgba(255,255,255,0.04)',
  color: '#8f95aa',
  fontFamily: 'monospace',
  cursor: 'pointer',
}

const settingsGridStyle: CSSProperties = {
  display: 'grid',
  gridTemplateColumns: 'minmax(126px, 0.82fr) minmax(0, 1.18fr)',
  gap: 14,
  padding: 14,
}

const settingsPreviewColumnStyle: CSSProperties = {
  minWidth: 0,
}

const settingsControlsColumnStyle: CSSProperties = {
  minWidth: 0,
  display: 'grid',
  gap: 10,
  alignContent: 'start',
}

const settingsSectionTitleStyle: CSSProperties = {
  color: '#7cffc4',
  fontSize: 10,
  fontWeight: 900,
  letterSpacing: 1.4,
  marginBottom: 8,
  textTransform: 'uppercase',
}

const settingsAvatarPreviewStyle: CSSProperties = {
  width: '100%',
  maxWidth: 128,
  height: 178,
  borderRadius: 6,
  background: '#0d0d16',
}

const settingsEmptyPreviewStyle: CSSProperties = {
  width: '100%',
  minHeight: 178,
  display: 'grid',
  placeItems: 'center',
  borderRadius: 6,
  border: '1px solid #2a2a3a',
  color: '#606779',
  fontSize: 11,
}

const settingsRoleBoxStyle: CSSProperties = {
  marginTop: 10,
  padding: 10,
  borderRadius: 4,
  border: '1px solid rgba(255,255,255,0.1)',
  background: 'rgba(255,255,255,0.035)',
  display: 'grid',
  gap: 5,
  fontSize: 10,
  color: '#8f95aa',
}

const settingsEmailStyle: CSSProperties = {
  marginTop: 8,
  color: '#606779',
  fontSize: 10,
  overflow: 'hidden',
  textOverflow: 'ellipsis',
}

const settingsActionButtonStyle: CSSProperties = {
  minHeight: 36,
  padding: '9px 11px',
  borderRadius: 4,
  border: '1px solid rgba(255,255,255,0.14)',
  background: 'rgba(42,42,58,0.72)',
  color: '#d8d0c2',
  fontFamily: 'monospace',
  fontSize: 11,
  fontWeight: 800,
  letterSpacing: 0,
  cursor: 'pointer',
  textAlign: 'left',
}

const settingsDangerButtonStyle: CSSProperties = {
  ...settingsActionButtonStyle,
  border: '1px solid rgba(255,92,92,0.34)',
  color: '#ff8a8a',
  background: 'rgba(52,14,18,0.72)',
}

const settingsSliderLabelStyle: CSSProperties = {
  display: 'grid',
  gridTemplateColumns: '1fr auto',
  gap: '6px 10px',
  alignItems: 'center',
  color: '#aeb4c4',
  fontSize: 10,
  lineHeight: 1.35,
}

const settingsRangeStyle: CSSProperties = {
  gridColumn: '1 / -1',
  width: '100%',
  accentColor: '#d8b06f',
}

const compactLanguageButtonStyle: CSSProperties = {
  position: 'fixed',
  top: 'max(12px, env(safe-area-inset-top))',
  right: 'max(12px, env(safe-area-inset-right))',
  zIndex: 20,
  minWidth: 46,
  height: 34,
  borderRadius: 4,
  border: '1px solid rgba(216,176,111,0.35)',
  background: 'rgba(8,9,12,0.76)',
  color: '#d8b06f',
  fontFamily: 'monospace',
  fontSize: 12,
  fontWeight: 900,
  cursor: 'pointer',
}
