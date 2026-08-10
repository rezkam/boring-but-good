import { startChromeWithoutTerminalOutput } from '../../extensions/gemini-search/runtime.mjs';

const result = await startChromeWithoutTerminalOutput({ port: 43125 }, {
  moduleUrl: new URL('./noisy-browser-start.mjs', import.meta.url).href,
});
process.stdout.write(JSON.stringify(result));
