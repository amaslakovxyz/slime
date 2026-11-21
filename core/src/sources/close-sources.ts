import type { SlimeConfig } from '../config/slime-config.js';
import { callSource } from './call-source.js';
import { isApiSource } from './types.js';

/** Closes every API source through the redacting wrapper; one failing close doesn't stop the others. */
export async function closeApiSources(config: SlimeConfig): Promise<void> {
  await Promise.allSettled(
    config.apiSourceNames.map((name) => {
      const source = config.sources[name];
      if (!source || !isApiSource(source)) return Promise.resolve();
      return callSource({ sourceName: name, method: 'close', secrets: source.secrets, timeoutMs: config.limits.apiTimeoutMs, run: () => source.close() });
    }),
  );
}
