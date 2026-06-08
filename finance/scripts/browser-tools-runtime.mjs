export async function loadBrowserToolsRuntime() {
  const [browserControl, resourceHelper] = await Promise.all([
    import('../../browser-tools/scripts/browser-control.mjs'),
    import('../../browser-tools/scripts/resource-helper.mjs'),
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

export function optionValue(args, name) {
  const index = args.indexOf(name);
  if (index === -1) return null;
  const value = args[index + 1];
  return value && !value.startsWith('--') ? value : null;
}
