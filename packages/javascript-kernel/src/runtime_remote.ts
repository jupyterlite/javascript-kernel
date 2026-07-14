// Copyright (c) Jupyter Development Team.
// Distributed under the terms of the Modified BSD License.

import { JavaScriptRuntimeEvaluator } from './runtime_evaluator';
import type { JavaScriptExecutor } from './executor';
import type {
  IRemoteRuntimeApi,
  RuntimeOutputMessage
} from './runtime_protocol';

/**
 * Create a Comlink runtime API bound to the provided global scope.
 */
export function createRemoteRuntimeApi(
  globalScope: Record<string, any>,
  executor?: JavaScriptExecutor
): IRemoteRuntimeApi {
  let evaluator: JavaScriptRuntimeEvaluator | null = null;

  const ensureEvaluator = (): JavaScriptRuntimeEvaluator => {
    if (!evaluator) {
      throw new Error('Runtime is not initialized');
    }
    return evaluator;
  };

  const emitOutput = (
    callback: Parameters<IRemoteRuntimeApi['initialize']>[1],
    message: RuntimeOutputMessage
  ): void => {
    void Promise.resolve(callback(makeCloneSafe(message))).catch(() => {
      // Ignore output callback failures so execution replies can still resolve.
    });
  };

  return {
    async initialize(
      options: Parameters<IRemoteRuntimeApi['initialize']>[0],
      onOutput: Parameters<IRemoteRuntimeApi['initialize']>[1]
    ): Promise<void> {
      if (typeof options.baseUrl !== 'string') {
        throw new Error('Runtime baseUrl is required');
      }
      evaluator?.dispose();
      evaluator = new JavaScriptRuntimeEvaluator({
        globalScope,
        executor,
        onOutput: message => {
          emitOutput(onOutput, message);
        }
      });
    },

    async execute(
      code: string,
      executionCount: number,
      parentMessageId?: string
    ) {
      return ensureEvaluator().execute(code, executionCount, parentMessageId);
    },

    async preloadModule(moduleName: string): Promise<void> {
      await ensureEvaluator().preloadModule(moduleName);
    },

    async registerCommTarget(
      targetName: string,
      moduleName: string,
      exportName?: string
    ): Promise<void> {
      await ensureEvaluator().registerCommTarget(
        targetName,
        moduleName,
        exportName
      );
    },

    async unregisterCommTarget(targetName: string): Promise<void> {
      ensureEvaluator().unregisterCommTarget(targetName);
    },

    async complete(code: string, cursorPos: number) {
      return ensureEvaluator().complete(code, cursorPos);
    },

    async inspect(
      code: string,
      cursorPos: number,
      detailLevel: Parameters<IRemoteRuntimeApi['inspect']>[2]
    ) {
      return ensureEvaluator().inspect(code, cursorPos, detailLevel);
    },

    async isComplete(code: string) {
      return ensureEvaluator().isComplete(code);
    },

    async handleCommOpen(
      commId: string,
      targetName: string,
      data: Record<string, unknown>,
      buffers?: ArrayBuffer[],
      parentMessageId?: string
    ): Promise<void> {
      ensureEvaluator().handleCommOpen(
        commId,
        targetName,
        data,
        buffers,
        parentMessageId
      );
    },

    async handleCommMsg(
      commId: string,
      data: Record<string, unknown>,
      buffers?: ArrayBuffer[],
      parentMessageId?: string
    ): Promise<void> {
      ensureEvaluator().handleCommMsg(commId, data, buffers, parentMessageId);
    },

    async handleCommClose(
      commId: string,
      data: Record<string, unknown>,
      buffers?: ArrayBuffer[],
      parentMessageId?: string
    ): Promise<void> {
      ensureEvaluator().handleCommClose(commId, data, buffers, parentMessageId);
    },

    async dispose(): Promise<void> {
      evaluator?.dispose();
      evaluator = null;
    }
  };
}

/**
 * Make outbound payload clone-safe for Comlink transport.
 */
function makeCloneSafe<T>(value: T): T {
  if (typeof structuredClone === 'function') {
    try {
      return structuredClone(value);
    } catch {
      // fall through to sanitization
    }
  }

  return sanitize(value, new WeakSet<object>(), 0) as T;
}

/**
 * Convert unsupported values (functions, cyclic objects) to plain data.
 */
function sanitize(value: any, seen: WeakSet<object>, depth: number): any {
  if (value === null || value === undefined) {
    return value;
  }

  if (depth > 8) {
    return '[Truncated]';
  }

  const valueType = typeof value;
  if (
    valueType === 'string' ||
    valueType === 'number' ||
    valueType === 'boolean'
  ) {
    return value;
  }
  if (valueType === 'bigint') {
    return value.toString();
  }
  if (valueType === 'symbol' || valueType === 'function') {
    return String(value);
  }

  if (value instanceof ArrayBuffer) {
    return value;
  }

  if (value instanceof Error) {
    return {
      name: value.name,
      message: value.message,
      stack: value.stack
    };
  }

  if (Array.isArray(value)) {
    return value.map(item => sanitize(item, seen, depth + 1));
  }

  if (valueType === 'object') {
    if (seen.has(value)) {
      return '[Circular]';
    }
    seen.add(value);

    const output: Record<string, any> = {};
    for (const [key, item] of Object.entries(value)) {
      output[key] = sanitize(item, seen, depth + 1);
    }

    seen.delete(value);
    return output;
  }

  return String(value);
}
