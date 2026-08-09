import type { ExtensionAPI, ExtensionFactory } from '@earendil-works/pi-coding-agent';
import { Text } from '@earendil-works/pi-tui';
import { Type, type Static } from 'typebox';

import {
  DEFAULT_GEMINI_SEARCH_TIMEOUT_SECONDS,
  runGeminiSearchBatch,
  stopOwnedAiChatBrowser,
} from './runtime.mjs';

const geminiSearchSchema = Type.Object({
  query: Type.Optional(Type.String({ description: 'One web research query.' })),
  queries: Type.Optional(Type.Array(Type.String(), {
    minItems: 1,
    maxItems: 5,
    description: 'Up to five distinct web research queries. Use varied angles rather than near-duplicates.',
  })),
  timeoutSeconds: Type.Optional(Type.Integer({
    minimum: 30,
    maximum: 900,
    description: `Timeout per query in seconds. Default: ${DEFAULT_GEMINI_SEARCH_TIMEOUT_SECONDS}.`,
  })),
});

export type GeminiSearchInput = Static<typeof geminiSearchSchema>;

type GeminiSearchProgress = {
  phase: 'searching' | 'complete' | 'failed' | 'cancelled';
  index: number;
  total: number;
  query: string;
  path?: string;
  error?: string;
};

type GeminiSearchBatch = {
  queryCount: number;
  successfulQueries: number;
  failedQueries: number;
  cancelled?: boolean;
  files: Array<{ query: string; path: string }>;
  failures: Array<{ query: string; error: string }>;
};

type GeminiSearchDetails = GeminiSearchProgress | GeminiSearchBatch;
type RunBatch = (
  params: GeminiSearchInput & { signal?: AbortSignal },
  deps: { onProgress: (progress: GeminiSearchProgress) => void },
) => Promise<GeminiSearchBatch>;

function displayQueries(args: GeminiSearchInput): string[] {
  const values = Array.isArray(args.queries) && args.queries.length > 0
    ? args.queries
    : [args.query];
  return values
    .filter((value): value is string => typeof value === 'string' && value.trim().length > 0)
    .map(value => value.trim());
}

function resultText(batch: GeminiSearchBatch): string {
  const lines = [
    `Completed ${batch.successfulQueries}/${batch.queryCount} Gemini searches in temporary chats.`,
    'Read the full results from:',
    ...batch.files.map((file, index) => `${index + 1}. ${file.path}`),
  ];
  if (batch.cancelled) lines.push('Cancellation was applied before the next query started.');
  if (batch.failedQueries > 0) lines.push(`${batch.failedQueries} queries failed. Expand the tool result for details.`);
  return lines.join('\n');
}

function abortError(message: string): Error {
  const error = new Error(message);
  error.name = 'AbortError';
  return error;
}

export function createGeminiSearchExtension(
  {
    runBatch = runGeminiSearchBatch as RunBatch,
    stopOwnedBrowser = stopOwnedAiChatBrowser,
  }: { runBatch?: RunBatch; stopOwnedBrowser?: () => Promise<unknown> } = {},
): ExtensionFactory {
  return function geminiSearchExtension(pi: ExtensionAPI) {
    let queue: Promise<unknown> = Promise.resolve();
    let searchesInFlight = 0;

    pi.on('session_shutdown', async () => {
      if (searchesInFlight === 0) return;
      await stopOwnedBrowser();
    });
    const runExclusive = <T>(operation: () => Promise<T>, signal?: AbortSignal): Promise<T> => {
      const start = () => {
        if (signal?.aborted) throw abortError('Gemini search was cancelled before it acquired the browser.');
        return operation();
      };
      // The queue keeps following the real run even when the caller abandons it, so an
      // abandoned browser session is never overlapped by the next search.
      const running = queue.then(start, start);
      queue = running.catch(() => undefined);
      if (!signal) return running;
      running.catch(() => undefined);

      let onAbort: (() => void) | undefined;
      const aborted = new Promise<T>((_resolve, reject) => {
        onAbort = () => reject(abortError('Gemini search was cancelled.'));
        signal.addEventListener('abort', onAbort, { once: true });
      });
      return Promise.race([running, aborted]).finally(() => {
        if (onAbort) signal.removeEventListener('abort', onAbort);
      });
    };


    pi.registerTool<typeof geminiSearchSchema, GeminiSearchDetails>({
      name: 'gemini_search',
      label: 'Gemini Search',
      description: 'Search the web with Gemini 3.6 Flash Extended Thinking in a verified temporary chat. Accepts one query or up to five queries. Full answers are written to private result files, and only home-relative paths are returned to the agent.',
      promptSnippet: 'Search the current web with Gemini extended thinking and return private result-file paths.',
      promptGuidelines: [
        'Use gemini_search when a task needs current web information or independent web research.',
        'After gemini_search returns, use read on each returned result path before answering the user.',
        'Prefer the queries array with distinct research angles when broader coverage is useful.',
      ],
      parameters: geminiSearchSchema,
      executionMode: 'sequential',

      async execute(_toolCallId, params, signal, onUpdate) {
        return runExclusive(async () => {
          searchesInFlight += 1;
          try {
            return await runSearch();
          } finally {
            searchesInFlight -= 1;
          }
        }, signal);

        async function runSearch() {
          const batch = await runBatch({ ...params, signal }, {
            onProgress(progress) {
              onUpdate?.({
                content: [{ type: 'text', text: `${progress.phase}: ${progress.query}` }],
                details: progress,
              });
            },
          });
          return {
            content: [{ type: 'text' as const, text: resultText(batch) }],
            details: batch,
          };
        }
      },

      renderCall(args, theme) {
        const queries = displayQueries(args);
        if (queries.length === 0) {
          return new Text(theme.fg('toolTitle', theme.bold('gemini search ')) + theme.fg('error', '(no query)'), 0, 0);
        }
        if (queries.length === 1) {
          const query = queries[0].length > 64 ? `${queries[0].slice(0, 61)}...` : queries[0];
          return new Text(theme.fg('toolTitle', theme.bold('gemini search ')) + theme.fg('accent', `"${query}"`), 0, 0);
        }
        const lines = [theme.fg('toolTitle', theme.bold('gemini search ')) + theme.fg('accent', `${queries.length} queries`)];
        for (const query of queries) {
          const display = query.length > 56 ? `${query.slice(0, 53)}...` : query;
          lines.push(theme.fg('muted', `  ${display}`));
        }
        return new Text(lines.join('\n'), 0, 0);
      },

      renderResult(result, { expanded, isPartial }, theme, context) {
        const details = result.details;
        if (!details && context?.isError) return new Text(theme.fg('warning', 'Gemini search stopped.'), 0, 0);
        if (isPartial && 'phase' in details) {
          const total = Math.max(1, details.total);
          const finished = details.phase === 'searching' ? details.index : details.index + 1;
          const progress = Math.max(0, Math.min(1, finished / total));
          const filled = Math.floor(progress * 10);
          const bar = `${'█'.repeat(filled)}${'░'.repeat(10 - filled)}`;
          const display = details.query.length > 48 ? `${details.query.slice(0, 45)}...` : details.query;
          const color = details.phase === 'failed' ? 'warning' : 'accent';
          return new Text(theme.fg(color, `[${bar}] ${details.phase}: ${display}`), 0, 0);
        }

        if ('queryCount' in details) {
          const lines = [theme.fg(details.failedQueries > 0 ? 'warning' : 'success', `${details.successfulQueries}/${details.queryCount} results ready`)];
          if (details.cancelled) lines.push(theme.fg('warning', 'Cancelled before the next query.'));
          if (expanded) {
            for (const [index, file] of details.files.entries()) {
              lines.push(theme.fg('muted', `  ${index + 1}. ${file.path}`));
            }
            for (const failure of details.failures) {
              lines.push(theme.fg('error', `  failed: ${failure.query}: ${failure.error}`));
            }
          } else if (details.files.length > 0) {
            lines.push(theme.fg('dim', 'Expand to show result paths.'));
          }
          return new Text(lines.join('\n'), 0, 0);
        }

        return new Text(theme.fg('accent', 'Starting Gemini search.'), 0, 0);
      },
    });
  };
}

export default createGeminiSearchExtension();
