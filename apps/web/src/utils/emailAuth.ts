import type { User } from '@supabase/supabase-js'

export function isEmailAuthorizedUser(user: User | null | undefined) {
  if (!user?.email) return false

  const provider = user.app_metadata?.provider
  const providers = user.app_metadata?.providers
  const identityProviders = user.identities?.map((identity) => identity.provider) ?? []

  return provider === 'email'
    || (Array.isArray(providers) && providers.includes('email'))
    || identityProviders.includes('email')
}
