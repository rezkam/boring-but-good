export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export function hostnameFromUrl(url) {
  if (!url || typeof url !== 'string') return null;
  try {
    return new URL(url).hostname.toLowerCase().replace(/\.$/, '');
  } catch {
    return null;
  }
}

export function urlHasAllowedHostname(url, allowedHostnames = []) {
  const hostname = hostnameFromUrl(url);
  if (!hostname) return false;
  return allowedHostnames.some(allowed => hostname === String(allowed || '').toLowerCase().replace(/\.$/, ''));
}
