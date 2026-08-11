import { writeFileSync } from 'node:fs';

let markerPath;

export async function startChrome(options) {
  markerPath = options.markerPath;
  writeFileSync(options.startedMarkerPath, 'started');
  if (options.pidMarkerPath) writeFileSync(options.pidMarkerPath, String(process.pid));
  await new Promise(resolve => setTimeout(resolve, options.delayMs ?? 200));
  return { status: 'started', port: options.port, ownerToken: 'fixture-owner-token' };
}

export function stopChrome() {
  if (markerPath) writeFileSync(markerPath, 'stopped');
  return { status: 'stopped' };
}
