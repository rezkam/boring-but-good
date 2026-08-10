export async function loadBrowserToolsRuntime() {
  const [browserControl, resourceHelper] = await Promise.all([
    import('@rezkam/browser-tools'),
    import('@rezkam/browser-tools/resource-helper.mjs'),
  ]);

  return {
    parseOwnerToken: browserControl.parseOwnerToken,
    parsePort: browserControl.parsePort,
    stripBrowserSessionArgs: browserControl.stripBrowserSessionArgs,
    runCachedBrowserResource: resourceHelper.runCachedBrowserResource,
  };
}

export function parseBrowserSessionArgs(rawArgs, browserTools) {
  const positionalPort = rawArgs.find(arg => /^\d{4,5}$/.test(arg)) || '9222';
  return {
    ownerToken: browserTools.parseOwnerToken(rawArgs),
    port: browserTools.parsePort(rawArgs, positionalPort),
    args: browserTools.stripBrowserSessionArgs(rawArgs, { stripPositionalPort: true }),
  };
}

export function optionValue(args, name, fallback = null) {
  const index = args.indexOf(name);
  if (index === -1) return fallback;
  const value = args[index + 1];
  if (value === undefined || value.startsWith('--')) throw new Error(`Missing value after ${name}`);
  return value;
}
