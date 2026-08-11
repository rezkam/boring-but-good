let cancelled = false;
let cleanupDeadlineMs = 30000;
let cleanupTimer;

function cancelStartup() {
  cancelled = true;
  cleanupTimer ??= setTimeout(() => process.exit(1), cleanupDeadlineMs);
}

process.on('SIGINT', cancelStartup);
process.on('SIGHUP', cancelStartup);
process.on('SIGTERM', cancelStartup);
process.on('disconnect', cancelStartup);

process.once('message', async message => {
  cleanupDeadlineMs = message.cleanupDeadlineMs ?? cleanupDeadlineMs;
  let response;
  try {
    const browserTools = await import(message.moduleUrl);
    const result = await browserTools.startChrome(message.options);
    if (cancelled) {
      if (result?.port && result?.ownerToken) {
        browserTools.stopChrome({ port: result.port, ownerToken: result.ownerToken, clean: false });
      }
      const error = new Error('Browser Tools startup was cancelled.');
      error.name = 'AbortError';
      throw error;
    }
    response = { ok: true, result };
  } catch (error) {
    response = {
      ok: false,
      error: {
        name: error?.name ? String(error.name) : 'Error',
        message: error?.message ? String(error.message) : String(error),
        code: error?.code ? String(error.code) : undefined,
      },
    };
  } finally {
    clearTimeout(cleanupTimer);
  }

  if (!process.connected || !process.send) process.exit(response.ok ? 0 : 1);
  process.send(response, () => process.exit(response.ok ? 0 : 1));
});
