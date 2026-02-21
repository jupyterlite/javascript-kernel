// Copyright (c) Jupyter Development Team.
// Distributed under the terms of the Modified BSD License.

import type { KernelMessage } from '@jupyterlab/services';

import { PromiseDelegate } from '@lumino/coreutils';

import * as Comlink from 'comlink';

import { JavaScriptExecutor } from './executor';
import { normalizeError } from './errors';
import { createRemoteRuntimeApi } from './runtime_remote';
import type {
  IRemoteRuntimeApi,
  RuntimeOutputCallback,
  RuntimeOutputHandler,
  RuntimeOutputMessage
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
 * Runtime backend that executes code in a hidden iframe through Comlink.
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
   * Dispose iframe resources.
   */
  dispose(): void {
    this._ready.reject(new Error('IFrame runtime disposed'));

    if (this._remote) {
      void this._remote.dispose().catch(() => undefined);
      this._remote[Comlink.releaseProxy]();
      this._remote = null;
    }

    this._iframe?.remove();
    this._iframe = null;

    if (this._container) {
      this._container.remove();
      this._container = null;
    }

    this._outputProxy = null;
    this._globalScope = null;
    this._executor = null;
  }

  /**
   * Execute code inside the iframe runtime.
   */
  async execute(
    code: string,
    executionCount: number
  ): Promise<KernelMessage.IExecuteReplyMsg['content']> {
    await this.ready;
    return this._getRemote().execute(code, executionCount);
  }

  /**
   * Complete code inside the iframe runtime.
   */
  async complete(
    code: string,
    cursorPos: number
  ): Promise<KernelMessage.ICompleteReplyMsg['content']> {
    await this.ready;
    return this._getRemote().complete(code, cursorPos);
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
    return this._getRemote().inspect(code, cursorPos, detailLevel);
  }

  /**
   * Check code completeness inside the iframe runtime.
   */
  async isComplete(
    code: string
  ): Promise<KernelMessage.IIsCompleteReplyMsg['content']> {
    await this.ready;
    return this._getRemote().isComplete(code);
  }

  /**
   * Initialize iframe and remote runtime API.
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

      await new Promise<void>((resolve, reject) => {
        if (!this._iframe) {
          reject(new Error('IFrame runtime is not initialized'));
          return;
        }

        this._iframe.onload = () => resolve();
        this._iframe.onerror = () => {
          reject(new Error('IFrame runtime failed to load'));
        };
      });

      if (!this._iframe?.contentWindow) {
        throw new Error('IFrame window not available');
      }

      this._globalScope = this._iframe.contentWindow as Record<string, any>;
      this._executor =
        this._options.executorFactory?.(this._globalScope) ??
        new JavaScriptExecutor(this._globalScope);

      // Bind expose/listen on the iframe window context so RPC still flows
      // through postMessage without requiring an inline iframe bootstrap script.
      const exposedEndpoint = Comlink.windowEndpoint(
        window,
        this._iframe.contentWindow,
        '*'
      );
      Comlink.expose(
        createRemoteRuntimeApi(this._globalScope, this._executor),
        exposedEndpoint
      );

      const endpoint = Comlink.windowEndpoint(
        this._iframe.contentWindow,
        window,
        '*'
      );
      const remote = Comlink.wrap<IRemoteRuntimeApi>(endpoint);
      const outputProxy = Comlink.proxy((message: RuntimeOutputMessage) => {
        this._options.onOutput(message);
      });

      this._remote = remote;
      this._outputProxy = outputProxy;
      const activeOutputProxy = this._outputProxy;
      if (!activeOutputProxy) {
        throw new Error('IFrame runtime output handler is not initialized');
      }

      await withTimeout(
        remote.initialize(activeOutputProxy),
        IFrameRuntimeBackend.STARTUP_TIMEOUT_MS,
        'IFrame runtime failed to initialize'
      );

      await this._options.onReady?.({
        iframe: this._iframe,
        container: this._container,
        globalScope: this._globalScope,
        executor: this._executor,
        execute: (code, executionCount = 0) =>
          remote.execute(code, executionCount)
      });

      this._ready.resolve();
    } catch (error) {
      if (this._remote) {
        void this._remote.dispose().catch(() => undefined);
        this._remote[Comlink.releaseProxy]();
        this._remote = null;
      }

      this._iframe?.remove();
      this._iframe = null;
      if (this._container) {
        this._container.remove();
        this._container = null;
      }

      this._outputProxy = null;
      this._globalScope = null;
      this._executor = null;
      this._ready.reject(error);
    }
  }

  /**
   * Return remote runtime API or throw when not initialized.
   */
  private _getRemote(): Comlink.Remote<IRemoteRuntimeApi> {
    if (!this._remote) {
      throw new Error('IFrame runtime is not initialized');
    }
    return this._remote;
  }

  private _options: IFrameRuntimeBackend.IOptions;
  private _ready = new PromiseDelegate<void>();
  private _remote: Comlink.Remote<IRemoteRuntimeApi> | null = null;
  private _iframe: HTMLIFrameElement | null = null;
  private _container: HTMLDivElement | null = null;
  private _outputProxy: RuntimeOutputCallback | null = null;
  private _globalScope: Record<string, any> | null = null;
  private _executor: JavaScriptExecutor | null = null;

  static readonly STARTUP_TIMEOUT_MS = 10000;
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
    executor: JavaScriptExecutor;
    execute: (
      code: string,
      executionCount?: number
    ) => Promise<KernelMessage.IExecuteReplyMsg['content']>;
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

    const worker = new Worker(new URL('./worker-runtime.js', import.meta.url), {
      type: 'module'
    });

    worker.onerror = event => {
      const details = [event.message || 'Worker runtime failed to initialize'];
      if (event.filename) {
        details.push(`at ${event.filename}:${event.lineno}:${event.colno}`);
      }
      this._handleWorkerFatal(new Error(details.join(' ')));
    };
    worker.onmessageerror = () => {
      this._handleWorkerFatal(
        new Error(
          'Worker runtime sent a message that could not be deserialized'
        )
      );
    };

    this._worker = worker;
    this._remote = Comlink.wrap<IRemoteRuntimeApi>(worker);
    this._outputProxy = Comlink.proxy((message: RuntimeOutputMessage) => {
      this._options.onOutput(message);
    });

    void this._init();
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

    if (this._remote) {
      void this._remote.dispose().catch(() => undefined);
      this._remote[Comlink.releaseProxy]();
      this._remote = null;
    }

    this._worker?.terminate();
    this._worker = null;
    this._outputProxy = null;
  }

  /**
   * Execute code inside the worker runtime.
   */
  async execute(
    code: string,
    executionCount: number
  ): Promise<KernelMessage.IExecuteReplyMsg['content']> {
    await this.ready;
    return this._getRemote().execute(code, executionCount);
  }

  /**
   * Complete code inside the worker runtime.
   */
  async complete(
    code: string,
    cursorPos: number
  ): Promise<KernelMessage.ICompleteReplyMsg['content']> {
    await this.ready;
    return this._getRemote().complete(code, cursorPos);
  }

  /**
   * Inspect code inside the worker runtime.
   */
  async inspect(
    code: string,
    cursorPos: number,
    detailLevel: KernelMessage.IInspectRequestMsg['content']['detail_level']
  ): Promise<KernelMessage.IInspectReplyMsg['content']> {
    await this.ready;
    return this._getRemote().inspect(code, cursorPos, detailLevel);
  }

  /**
   * Check code completeness inside the worker runtime.
   */
  async isComplete(
    code: string
  ): Promise<KernelMessage.IIsCompleteReplyMsg['content']> {
    await this.ready;
    return this._getRemote().isComplete(code);
  }

  /**
   * Initialize remote worker API and execute optional initialization hook.
   */
  private async _init(): Promise<void> {
    const remote = this._remote;
    const outputProxy = this._outputProxy;

    if (!remote || !outputProxy) {
      this._ready.reject(new Error('Worker runtime is not initialized'));
      return;
    }

    try {
      await withTimeout(
        remote.initialize(outputProxy),
        WorkerRuntimeBackend.STARTUP_TIMEOUT_MS,
        'Worker runtime failed to initialize'
      );

      await this._options.onReady?.({
        execute: (code, executionCount = 0) =>
          remote.execute(code, executionCount)
      });

      this._ready.resolve();
    } catch (error) {
      this._handleWorkerFatal(normalizeError(error));
    }
  }

  /**
   * Reject initialization with a fatal worker error.
   */
  private _handleWorkerFatal(error: Error): void {
    if (this._remote) {
      this._remote[Comlink.releaseProxy]();
      this._remote = null;
    }

    this._worker?.terminate();
    this._worker = null;
    this._outputProxy = null;
    this._ready.reject(error);
  }

  /**
   * Return remote runtime API or throw when not initialized.
   */
  private _getRemote(): Comlink.Remote<IRemoteRuntimeApi> {
    if (!this._remote) {
      throw new Error('Worker runtime is not initialized');
    }
    return this._remote;
  }

  private _options: WorkerRuntimeBackend.IOptions;
  private _worker: Worker | null = null;
  private _remote: Comlink.Remote<IRemoteRuntimeApi> | null = null;
  private _outputProxy: RuntimeOutputCallback | null = null;
  private _ready = new PromiseDelegate<void>();

  static readonly STARTUP_TIMEOUT_MS = 10000;
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

/**
 * Add a timeout to runtime startup operations.
 */
async function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  errorMessage: string
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timeout = setTimeout(() => {
      reject(new Error(errorMessage));
    }, timeoutMs);

    void promise.then(
      value => {
        clearTimeout(timeout);
        resolve(value);
      },
      error => {
        clearTimeout(timeout);
        reject(error as Error);
      }
    );
  });
}
