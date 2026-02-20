// Copyright (c) Jupyter Development Team.
// Distributed under the terms of the Modified BSD License.

import { JavaScriptRuntimeEvaluator } from './runtime_evaluator';
import type {
  RuntimeRequest,
  RuntimeResponse,
  WorkerRuntimeInboundMessage,
  WorkerRuntimeOutboundMessage
} from './runtime_protocol';

const workerScope = self as unknown as Worker;
const runtimeGlobal = self as unknown as Record<string, any>;

const evaluator = new JavaScriptRuntimeEvaluator({
  globalScope: runtimeGlobal,
  onOutput: message => {
    postSafe({
      kind: 'output',
      message
    });
  }
});

workerScope.onmessage = async event => {
  const data = event.data as WorkerRuntimeInboundMessage;
  if (!data || data.kind !== 'request') {
    return;
  }

  const { id, request } = data;

  try {
    const payload = await handleRequest(request);
    postSafe({
      kind: 'response',
      id,
      ok: true,
      payload
    });
  } catch (error) {
    const normalized = normalizeError(error);
    postSafe({
      kind: 'response',
      id,
      ok: false,
      error: {
        name: normalized.name,
        message: normalized.message,
        stack: normalized.stack
      }
    });
  }
};

postSafe({
  kind: 'ready'
});

/**
 * Dispatch runtime request to evaluator.
 */
async function handleRequest(
  request: RuntimeRequest
): Promise<RuntimeResponse> {
  switch (request.type) {
    case 'execute_request':
      return evaluator.execute(request.content.code, request.execution_count);
    case 'complete_request':
      return evaluator.complete(
        request.content.code,
        request.content.cursor_pos
      );
    case 'inspect_request':
      return evaluator.inspect(
        request.content.code,
        request.content.cursor_pos,
        request.content.detail_level
      );
    case 'is_complete_request':
      return evaluator.isComplete(request.content.code);
    default:
      throw new Error(`Unknown runtime request type: ${(request as any).type}`);
  }
}

/**
 * Post message after making sure payload is clone-safe.
 */
function postSafe(message: WorkerRuntimeOutboundMessage): void {
  workerScope.postMessage(makeCloneSafe(message));
}

/**
 * Make outbound payload clone-safe for postMessage.
 */
function makeCloneSafe<T>(value: T): T {
  if (typeof structuredClone === 'function') {
    try {
      structuredClone(value);
      return value;
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

/**
 * Normalize unknown thrown value into Error.
 */
function normalizeError(error: unknown): Error {
  if (error instanceof Error) {
    return error;
  }
  return new Error(String(error));
}
