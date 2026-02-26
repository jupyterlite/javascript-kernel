// Copyright (c) Jupyter Development Team.
// Distributed under the terms of the Modified BSD License.

import type { KernelMessage } from '@jupyterlab/services';
import { PageConfig } from '@jupyterlab/coreutils';

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
  baseUrl?: string;
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
 * Base class providing shared Comlink proxy logic for runtime backends.
 *
 * Subclasses must set `_remote` during initialization and call
 * `_ready.resolve()` / `_ready.reject()` to signal readiness.
 */
abstract class AbstractRuntimeBackend implements IRuntimeBackend {
  /**
   * A promise that resolves when the runtime is initialized.
   */
  get ready(): Promise<void> {
    return this._ready.promise;
  }

  abstract dispose(): void;

  /**
   * Execute code via the remote runtime API.
   */
  async execute(
    code: string,
    executionCount: number
  ): Promise<KernelMessage.IExecuteReplyMsg['content']> {
    await this.ready;
    return this._getRemote().execute(code, executionCount);
  }

  /**
   * Complete code via the remote runtime API.
   */
  async complete(
    code: string,
    cursorPos: number
  ): Promise<KernelMessage.ICompleteReplyMsg['content']> {
    await this.ready;
    return this._getRemote().complete(code, cursorPos);
  }

  /**
   * Inspect code via the remote runtime API.
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
   * Check code completeness via the remote runtime API.
   */
  async isComplete(
    code: string
  ): Promise<KernelMessage.IIsCompleteReplyMsg['content']> {
    await this.ready;
    return this._getRemote().isComplete(code);
  }

  /**
   * Return remote runtime API or throw when not initialized.
   */
  private _getRemote(): Comlink.Remote<IRemoteRuntimeApi> {
    if (!this._remote) {
      throw new Error(`${this._runtimeLabel} runtime is not initialized`);
    }
    return this._remote;
  }

  /** Human-readable label used in error messages. */
  protected abstract readonly _runtimeLabel: string;
  protected _ready = new PromiseDelegate<void>();
  protected _remote: Comlink.Remote<IRemoteRuntimeApi> | null = null;
}

/**
 * Runtime backend that executes code in a hidden iframe through Comlink.
 */
export class IFrameRuntimeBackend extends AbstractRuntimeBackend {
  /**
   * Instantiate a new iframe runtime backend.
   */
  constructor(options: IFrameRuntimeBackend.IOptions) {
    super();
    this._options = options;
    void this._init();
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

      const iframe = this._iframe;
      const iframeLoad = new Promise<void>((resolve, reject) => {
        let settled = false;

        const cleanup = (): void => {
          iframe.onload = null;
          iframe.onerror = null;
        };

        iframe.onload = () => {
          if (settled) {
            return;
          }
          settled = true;
          cleanup();
          resolve();
        };
        iframe.onerror = () => {
          if (settled) {
            return;
          }
          settled = true;
          cleanup();
          reject(new Error('IFrame runtime failed to load'));
        };
      });

      this._container.appendChild(iframe);

      await withTimeout(
        iframeLoad,
        IFrameRuntimeBackend.STARTUP_TIMEOUT_MS,
        'IFrame runtime failed to load'
      );

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
        remote.initialize(
          {
            baseUrl: resolveBaseUrl(this._options.baseUrl)
          },
          activeOutputProxy
        ),
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

  protected readonly _runtimeLabel = 'IFrame';

  private _options: IFrameRuntimeBackend.IOptions;
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
export class WorkerRuntimeBackend extends AbstractRuntimeBackend {
  /**
   * Instantiate a new worker runtime backend.
   */
  constructor(options: WorkerRuntimeBackend.IOptions) {
    super();
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
        remote.initialize(
          {
            baseUrl: resolveBaseUrl(this._options.baseUrl)
          },
          outputProxy
        ),
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

  protected readonly _runtimeLabel = 'Worker';

  private _options: WorkerRuntimeBackend.IOptions;
  private _worker: Worker | null = null;
  private _outputProxy: RuntimeOutputCallback | null = null;

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

/**
 * Resolve the runtime base URL with JupyterLab PageConfig fallback.
 */
function resolveBaseUrl(baseUrl?: string): string {
  if (typeof baseUrl === 'string' && baseUrl.length > 0) {
    return baseUrl;
  }

  try {
    return PageConfig.getBaseUrl();
  } catch {
    return '/';
  }
}
