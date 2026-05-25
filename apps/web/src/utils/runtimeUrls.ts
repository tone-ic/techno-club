function isLoopbackHost(hostname: string) {
  return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '::1' || hostname === '[::1]'
}

export function resolveRuntimeUrl(rawUrl: string, options: { httpsProtocol: string; httpProtocol: string }) {
  try {
    const url = new URL(rawUrl)
    const pageHost = window.location.hostname

    if (isLoopbackHost(url.hostname) && !isLoopbackHost(pageHost)) {
      url.hostname = pageHost
    }

    if (window.location.protocol === 'https:' && !isLoopbackHost(url.hostname)) {
      url.protocol = options.httpsProtocol
    }

    return url.toString().replace(/\/$/, '')
  } catch {
    return rawUrl
  }
}
