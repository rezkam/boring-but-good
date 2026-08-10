import type { ExtensionAPI, ExtensionFactory } from '@earendil-works/pi-coding-agent';
import { Text } from '@earendil-works/pi-tui';
import { Type, type Static } from 'typebox';

import {
  DEFAULT_GEMINI_SEARCH_TIMEOUT_SECONDS,
  hasGeminiSearchProviderRunInFlight,
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

type GeminiSearchProgressState = GeminiSearchProgress & {
  successfulQueries: number;
  failedQueries: number;
};

type GeminiSearchBatch = {
  queryCount: number;
  successfulQueries: number;
  failedQueries: number;
  cancelled?: boolean;
  files: Array<{ query: string; path: string }>;
  failures: Array<{ query: string; error: string }>;
};

type GeminiSearchDetails = GeminiSearchProgressState | GeminiSearchBatch;
type RunBatch = (
  params: GeminiSearchInput & { signal?: AbortSignal },
  deps: { onProgress: (progress: GeminiSearchProgress) => void },
) => Promise<GeminiSearchBatch>;

function displayQueries(args: GeminiSearchInput): string[] {
  const values = Array.isArray(args.queries) && args.queries.length > 0
    ? args.queries
    : [args.query];
  return [...new Set(values
    .filter((value): value is string => typeof value === 'string' && value.trim().length > 0)
    .map(value => value.trim()))];
}

function resultText(batch: GeminiSearchBatch): string {
  const lines = [
    `Completed ${batch.successfulQueries}/${batch.queryCount} Gemini searches in temporary chats.`,
    'Read the full results from:',
    ...batch.files.map((file, index) => `${index + 1}. ${file.path}`),
  ];
  if (batch.cancelled) lines.push('Cancellation stopped the active search batch.');
  if (batch.failedQueries > 0) {
    const label = batch.failedQueries === 1 ? 'query' : 'queries';
    lines.push(`${batch.failedQueries} ${label} failed. Expand the tool result for details.`);
  }
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
    hasProviderRunInFlight = hasGeminiSearchProviderRunInFlight,
  }: {
    runBatch?: RunBatch;
    stopOwnedBrowser?: () => Promise<unknown>;
    hasProviderRunInFlight?: () => boolean;
  } = {},
): ExtensionFactory {
  return function geminiSearchExtension(pi: ExtensionAPI) {
    let queue: Promise<unknown> = Promise.resolve();
    let searchesInFlight = 0;

    pi.on('session_shutdown', async () => {
      if (searchesInFlight === 0 && !hasProviderRunInFlight()) return;
      await stopOwnedBrowser();
    });
    const runExclusive = <T>(operation: () => Promise<T>, signal?: AbortSignal, cancelResult?: () => T): Promise<T> => {
      if (signal?.aborted) return cancelResult ? Promise.resolve(cancelResult()) : Promise.reject(abortError('Gemini search was cancelled.'));
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
      const aborted = new Promise<T>((resolve, reject) => {
        onAbort = () => {
          if (!cancelResult) return reject(abortError('Gemini search was cancelled.'));
          try { resolve(cancelResult()); } catch (error) { reject(error); }
        };
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
        const completed: Array<{ query: string; path: string }> = [];
        const failures: Array<{ query: string; error: string }> = [];
        let failedQueries = 0;
        let executionSettled = false;
        const queryCount = Math.max(1, displayQueries(params).length);
        try {
          return await runExclusive(async () => {
            searchesInFlight += 1;
            try {
              return await runSearch();
            } finally {
              searchesInFlight -= 1;
            }
          }, signal, () => {
            if (completed.length === 0) throw abortError('Gemini search was cancelled.');
            const batch: GeminiSearchBatch = {
              queryCount,
              successfulQueries: completed.length,
              failedQueries,
              cancelled: true,
              files: [...completed],
              failures: [...failures],
            };
            return { content: [{ type: 'text' as const, text: resultText(batch) }], details: batch };
          });
        } finally {
          executionSettled = true;
        }

        async function runSearch() {
          const batch = await runBatch({
            query: params.query,
            queries: params.queries,
            timeoutSeconds: params.timeoutSeconds,
            signal,
          }, {
            onProgress(progress) {
              if (progress.phase === 'complete' && progress.path) completed.push({ query: progress.query, path: progress.path });
              if (progress.phase === 'failed') {
                failedQueries += 1;
                failures.push({ query: progress.query, error: progress.error || 'Gemini search failed.' });
              }
              if (!executionSettled) {
                onUpdate?.({
                  content: [{ type: 'text', text: `${progress.phase}: ${progress.query}` }],
                  details: {
                    ...progress,
                    successfulQueries: completed.length,
                    failedQueries,
                  },
                });
              }
            },
          });
          return {
            content: [{ type: 'text' as const, text: resultText(batch) }],
            details: batch,
          };
        }
      },

      renderCall(args, theme, context) {
        const text = context.lastComponent instanceof Text
          ? context.lastComponent
          : new Text('', 0, 0);
        const queries = displayQueries(args);
        if (queries.length === 0) {
          text.setText(theme.fg('toolTitle', theme.bold('gemini search ')) + theme.fg('error', '(no query)'));
          return text;
        }
        if (queries.length === 1) {
          const query = context.expanded || queries[0].length <= 64
            ? queries[0]
            : `${queries[0].slice(0, 61)}...`;
          text.setText(theme.fg('toolTitle', theme.bold('gemini search ')) + theme.fg('accent', `"${query}"`));
          return text;
        }

        const lines = [theme.fg('toolTitle', theme.bold('gemini search ')) + theme.fg('accent', `${queries.length} queries`)];
        for (const [index, query] of queries.entries()) {
          const display = context.expanded || query.length <= 56
            ? query
            : `${query.slice(0, 53)}...`;
          lines.push(theme.fg('muted', `  ${index + 1}. ${display}`));
        }
        text.setText(lines.join('\n'));
        return text;
      },

      renderResult(result, { expanded, isPartial }, theme, context) {
        const text = context?.lastComponent instanceof Text
          ? context.lastComponent
          : new Text('', 0, 0);
        const details = result.details;
        if (!details) {
          const message = result.content.find(item => item.type === 'text')?.text || 'Gemini search stopped.';
          text.setText(theme.fg(context?.isError ? 'error' : 'warning', `${context?.isError ? '✗ ' : ''}${message}`));
          return text;
        }

        if (isPartial && 'phase' in details) {
          const total = Math.max(1, details.total);
          const finished = Math.max(0, Math.min(total, details.successfulQueries + details.failedQueries));
          const filled = Math.floor((finished / total) * 10);
          const bar = `${'█'.repeat(filled)}${'░'.repeat(10 - filled)}`;
          const display = details.query.length > 28 ? `${details.query.slice(0, 25)}...` : details.query;
          const color = details.phase === 'failed' || details.phase === 'cancelled' ? 'warning' : 'accent';
          text.setText(theme.fg(color, `[${bar}] ${finished}/${total} · ${details.phase} · ${display}`));
          return text;
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
          text.setText(lines.join('\n'));
          return text;
        }

        text.setText(theme.fg('accent', 'Starting Gemini search.'));
        return text;
      },
    });
  };
}

export default createGeminiSearchExtension();
