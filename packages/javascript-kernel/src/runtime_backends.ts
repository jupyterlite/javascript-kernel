// Copyright (c) Jupyter Development Team.
// Distributed under the terms of the Modified BSD License.

import type { KernelMessage } from '@jupyterlab/services';

import { PromiseDelegate } from '@lumino/coreutils';

import type { JavaScriptExecutor } from './executor';
import { normalizeError } from './errors';
import { JavaScriptRuntimeEvaluator } from './runtime_evaluator';
import type {
  RuntimeOutputHandler,
  RuntimeRequest,
  RuntimeResponse,
  WorkerRuntimeInboundMessage,
  WorkerRuntimeOutboundMessage
} from './runtime_protocol';

/**
 * Shared options for runtime backend implementations.
 */
export interface IRuntimeBackendOptions {
  onOutput: RuntimeOutputHandler;
}

/**
 * Interface implemented by all execution runtime backends.
 */
export interface IRuntimeBackend {
  readonly ready: Promise<void>;
  dispose(): void;
  execute(
    code: string,
    executionCount: number
  ): Promise<KernelMessage.IExecuteReplyMsg['content']>;
  complete(
    code: string,
    cursorPos: number
  ): Promise<KernelMessage.ICompleteReplyMsg['content']>;
  inspect(
    code: string,
    cursorPos: number,
    detailLevel: KernelMessage.IInspectRequestMsg['content']['detail_level']
  ): Promise<KernelMessage.IInspectReplyMsg['content']>;
  isComplete(
    code: string
  ): Promise<KernelMessage.IIsCompleteReplyMsg['content']>;
}

/**
 * Runtime backend that executes code in a hidden iframe.
 */
export class IFrameRuntimeBackend implements IRuntimeBackend {
  /**
   * Instantiate a new iframe runtime backend.
   */
  constructor(options: IFrameRuntimeBackend.IOptions) {
    this._options = options;
    void this._init();
  }

  /**
   * A promise that resolves when the runtime is initialized.
   */
  get ready(): Promise<void> {
    return this._ready.promise;
  }

  /**
   * The iframe used by the runtime backend.
   */
  get iframe(): HTMLIFrameElement | null {
    return this._iframe;
  }

  /**
   * The runtime global scope.
   */
  get globalScope(): Record<string, any> | null {
    return this._iframe?.contentWindow
      ? (this._iframe.contentWindow as Record<string, any>)
      : null;
  }

  /**
   * The runtime evaluator.
   */
  get evaluator(): JavaScriptRuntimeEvaluator | null {
    return this._evaluator;
  }

  /**
   * Dispose iframe resources.
   */
  dispose(): void {
    this._ready.reject(new Error('IFrame runtime disposed'));
    this._evaluator?.dispose();
    this._evaluator = null;

    this._iframe?.remove();
    this._iframe = null;

    if (this._container) {
      this._container.remove();
      this._container = null;
    }
  }

  /**
   * Execute code inside the iframe runtime.
   */
  async execute(
    code: string,
    executionCount: number
  ): Promise<KernelMessage.IExecuteReplyMsg['content']> {
    await this.ready;
    return this._getEvaluator().execute(code, executionCount);
  }

  /**
   * Complete code inside the iframe runtime.
   */
  async complete(
    code: string,
    cursorPos: number
  ): Promise<KernelMessage.ICompleteReplyMsg['content']> {
    await this.ready;
    return this._getEvaluator().complete(code, cursorPos);
  }

  /**
   * Inspect code inside the iframe runtime.
   */
  async inspect(
    code: string,
    cursorPos: number,
    detailLevel: KernelMessage.IInspectRequestMsg['content']['detail_level']
  ): Promise<KernelMessage.IInspectReplyMsg['content']> {
    await this.ready;
    return this._getEvaluator().inspect(code, cursorPos, detailLevel);
  }

  /**
   * Check code completeness inside the iframe runtime.
   */
  async isComplete(
    code: string
  ): Promise<KernelMessage.IIsCompleteReplyMsg['content']> {
    await this.ready;
    return this._getEvaluator().isComplete(code);
  }

  /**
   * Evaluate raw code in the iframe global scope.
   */
  evaluate(code: string): any {
    const globalScope = this._getGlobalScope();
    const scopeFunction = globalScope.Function;
    const functionConstructor =
      typeof scopeFunction === 'function'
        ? (scopeFunction as FunctionConstructor)
        : Function;
    const evaluateCode = functionConstructor(code);
    return evaluateCode.call(globalScope);
  }

  /**
   * Initialize iframe and evaluator.
   */
  private async _init(): Promise<void> {
    try {
      this._container = document.createElement('div');
      this._container.style.display = 'none';
      document.body.appendChild(this._container);

      this._iframe = document.createElement('iframe');
      this._iframe.style.border = 'none';
      this._iframe.srcdoc = `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <title>JavaScript Kernel</title>
</head>
<body></body>
</html>`;

      this._container.appendChild(this._iframe);

      await new Promise<void>(resolve => {
        if (!this._iframe) {
          resolve();
          return;
        }
        this._iframe.onload = () => resolve();
      });

      if (!this._iframe?.contentWindow) {
        throw new Error('IFrame window not available');
      }

      const globalScope = this._iframe.contentWindow as Record<string, any>;
      const executor = this._options.executorFactory?.(globalScope);
      this._evaluator = new JavaScriptRuntimeEvaluator({
        globalScope,
        onOutput: this._options.onOutput,
        executor
      });

      await this._options.onReady?.({
        iframe: this._iframe,
        container: this._container,
        globalScope,
        evaluator: this._evaluator,
        evaluate: code => this.evaluate(code)
      });
      this._ready.resolve();
    } catch (error) {
      this._evaluator?.dispose();
      this._evaluator = null;
      this._iframe?.remove();
      this._iframe = null;
      if (this._container) {
        this._container.remove();
        this._container = null;
      }
      this._ready.reject(error);
    }
  }

  /**
   * Return evaluator or throw when not initialized.
   */
  private _getEvaluator(): JavaScriptRuntimeEvaluator {
    if (!this._evaluator) {
      throw new Error('IFrame runtime is not initialized');
    }
    return this._evaluator;
  }

  /**
   * Return global scope or throw when not initialized.
   */
  private _getGlobalScope(): Record<string, any> {
    const globalScope = this.globalScope;
    if (!globalScope) {
      throw new Error('IFrame runtime is not initialized');
    }
    return globalScope;
  }

  private _options: IFrameRuntimeBackend.IOptions;
  private _ready = new PromiseDelegate<void>();
  private _evaluator: JavaScriptRuntimeEvaluator | null = null;
  private _iframe: HTMLIFrameElement | null = null;
  private _container: HTMLDivElement | null = null;
}

/**
 * A namespace for IFrameRuntimeBackend statics.
 */
export namespace IFrameRuntimeBackend {
  /**
   * Runtime objects available after iframe initialization.
   */
  export interface IReadyContext {
    iframe: HTMLIFrameElement;
    container: HTMLDivElement;
    globalScope: Record<string, any>;
    evaluator: JavaScriptRuntimeEvaluator;
    evaluate: (code: string) => any;
  }

  /**
   * The instantiation options for an iframe runtime backend.
   */
  export interface IOptions extends IRuntimeBackendOptions {
    executorFactory?: (globalScope: Record<string, any>) => JavaScriptExecutor;
    onReady?: (context: IReadyContext) => void | Promise<void>;
  }
}

/**
 * Runtime backend that executes code in a dedicated web worker.
 */
export class WorkerRuntimeBackend implements IRuntimeBackend {
  /**
   * Instantiate a new worker runtime backend.
   */
  constructor(options: WorkerRuntimeBackend.IOptions) {
    this._options = options;

    if (typeof Worker === 'undefined') {
      this._ready.reject(new Error('Web Workers are not available'));
      return;
    }

    this._worker = new Worker(new URL('./worker-runtime.js', import.meta.url), {
      type: 'module'
    });
    this._worker.onmessage = event => {
      this._onWorkerMessage(event.data as WorkerRuntimeOutboundMessage);
    };
    this._worker.onerror = event => {
      const details = [event.message || 'Worker runtime failed to initialize'];
      if (event.filename) {
        details.push(`at ${event.filename}:${event.lineno}:${event.colno}`);
      }
      this._handleWorkerFatal(new Error(details.join(' ')));
    };
    this._worker.onmessageerror = () => {
      this._handleWorkerFatal(
        new Error(
          'Worker runtime sent a message that could not be deserialized'
        )
      );
    };
  }

  /**
   * A promise that resolves when the runtime is initialized.
   */
  get ready(): Promise<void> {
    return this._ready.promise;
  }

  /**
   * Dispose worker resources.
   */
  dispose(): void {
    this._ready.reject(new Error('Worker runtime disposed'));
    this._worker?.terminate();
    this._worker = null;

    this._rejectPending(new Error('Worker runtime disposed'));
  }

  /**
   * Execute code inside the worker runtime.
   */
  async execute(
    code: string,
    executionCount: number
  ): Promise<KernelMessage.IExecuteReplyMsg['content']> {
    return this._request<KernelMessage.IExecuteReplyMsg['content']>({
      type: 'execute_request',
      content: {
        code
      },
      execution_count: executionCount
    });
  }

  /**
   * Complete code inside the worker runtime.
   */
  async complete(
    code: string,
    cursorPos: number
  ): Promise<KernelMessage.ICompleteReplyMsg['content']> {
    return this._request<KernelMessage.ICompleteReplyMsg['content']>({
      type: 'complete_request',
      content: {
        code,
        cursor_pos: cursorPos
      }
    });
  }

  /**
   * Inspect code inside the worker runtime.
   */
  async inspect(
    code: string,
    cursorPos: number,
    detailLevel: KernelMessage.IInspectRequestMsg['content']['detail_level']
  ): Promise<KernelMessage.IInspectReplyMsg['content']> {
    return this._request<KernelMessage.IInspectReplyMsg['content']>({
      type: 'inspect_request',
      content: {
        code,
        cursor_pos: cursorPos,
        detail_level: detailLevel
      }
    });
  }

  /**
   * Check code completeness inside the worker runtime.
   */
  async isComplete(
    code: string
  ): Promise<KernelMessage.IIsCompleteReplyMsg['content']> {
    return this._request<KernelMessage.IIsCompleteReplyMsg['content']>({
      type: 'is_complete_request',
      content: {
        code
      }
    });
  }

  /**
   * Send a request to the worker and await response.
   */
  private async _request<T>(request: RuntimeRequest): Promise<T> {
    return this._requestWithMode<T>(request, true);
  }

  /**
   * Send a request, optionally waiting for runtime readiness.
   */
  private async _requestWithMode<T>(
    request: RuntimeRequest,
    waitForReady: boolean
  ): Promise<T> {
    if (waitForReady) {
      await this.ready;
    }

    if (!this._worker) {
      throw new Error('Worker runtime is not initialized');
    }

    const id = this._nextRequestId++;
    const envelope: WorkerRuntimeInboundMessage = {
      kind: 'request',
      id,
      request
    };

    return new Promise<T>((resolve, reject) => {
      this._pending.set(id, {
        resolve: value => resolve(value as T),
        reject
      });

      try {
        this._worker?.postMessage(envelope);
      } catch (error) {
        this._pending.delete(id);
        reject(error as Error);
      }
    });
  }

  /**
   * Handle worker output and request responses.
   */
  private _onWorkerMessage(message: WorkerRuntimeOutboundMessage): void {
    switch (message.kind) {
      case 'ready':
        void this._handleWorkerReady();
        break;
      case 'output':
        this._options.onOutput(message.message);
        break;
      case 'response': {
        const pending = this._pending.get(message.id);
        if (!pending) {
          return;
        }
        this._pending.delete(message.id);
        if (message.ok) {
          pending.resolve(message.payload as RuntimeResponse);
        } else {
          const error = new Error(message.error.message);
          error.name = message.error.name;
          error.stack = message.error.stack;
          pending.reject(error);
        }
        break;
      }
      default:
        break;
    }
  }

  /**
   * Resolve readiness after optional initialization hook.
   */
  private async _handleWorkerReady(): Promise<void> {
    if (this._readyHandled) {
      return;
    }
    this._readyHandled = true;

    try {
      await this._options.onReady?.({
        execute: (code, executionCount = 0) =>
          this._requestWithMode<KernelMessage.IExecuteReplyMsg['content']>(
            {
              type: 'execute_request',
              content: {
                code
              },
              execution_count: executionCount
            },
            false
          )
      });
      this._ready.resolve();
    } catch (error) {
      this._handleWorkerFatal(normalizeError(error));
    }
  }

  /**
   * Reject all pending requests and initialization with a fatal worker error.
   */
  private _handleWorkerFatal(error: Error): void {
    this._worker?.terminate();
    this._worker = null;
    this._ready.reject(error);
    this._rejectPending(error);
  }

  /**
   * Reject pending in-flight worker requests.
   */
  private _rejectPending(error: Error): void {
    for (const pending of this._pending.values()) {
      pending.reject(error);
    }
    this._pending.clear();
  }

  private _options: WorkerRuntimeBackend.IOptions;
  private _worker: Worker | null = null;
  private _readyHandled = false;
  private _nextRequestId = 1;
  private _ready = new PromiseDelegate<void>();
  private _pending = new Map<
    number,
    {
      resolve: (value: RuntimeResponse) => void;
      reject: (reason: Error) => void;
    }
  >();
}

/**
 * A namespace for WorkerRuntimeBackend statics.
 */
export namespace WorkerRuntimeBackend {
  /**
   * Runtime capabilities available during worker initialization.
   */
  export interface IReadyContext {
    execute: (
      code: string,
      executionCount?: number
    ) => Promise<KernelMessage.IExecuteReplyMsg['content']>;
  }

  /**
   * The instantiation options for a worker runtime backend.
   */
  export interface IOptions extends IRuntimeBackendOptions {
    onReady?: (context: IReadyContext) => void | Promise<void>;
  }
}
