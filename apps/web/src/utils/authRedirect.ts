export function getAuthRedirectUrl(path = '/outside') {
  return new URL(path, window.location.origin).toString()
}

