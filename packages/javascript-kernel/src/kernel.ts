// Copyright (c) Jupyter Development Team.
// Distributed under the terms of the Modified BSD License.

import type { KernelMessage } from '@jupyterlab/services';

import { BaseKernel, type IKernel } from '@jupyterlite/services';

import type { JavaScriptExecutor } from './executor';
import { normalizeError as normalizeUnknownError } from './errors';
import {
  IFrameRuntimeBackend,
  IRuntimeBackend,
  WorkerRuntimeBackend
} from './runtime_backends';
import type { RuntimeMode, RuntimeOutputMessage } from './runtime_protocol';

/**
 * A kernel that executes JavaScript code in browser runtimes.
 */
export class JavaScriptKernel extends BaseKernel implements IKernel {
  /**
   * Instantiate a new JavaScriptKernel.
   *
   * @param options - The instantiation options for a new JavaScriptKernel.
   */
  constructor(options: JavaScriptKernel.IOptions) {
    super(options);
    this._runtimeMode = options.runtime ?? 'iframe';
    this._executorFactory = options.executorFactory;
    this._startupExtensions = [...(options.startupExtensions ?? [])];
    this._backend = this.createBackend(this._runtimeMode);
  }

  /**
   * Dispose the kernel.
   */
  dispose(): void {
    if (this.isDisposed) {
      return;
    }

    this._comms.clear();
    this._backend.dispose();
    this._runtimeReadyContext = null;
    this._appliedStartupExtensions.clear();
    super.dispose();
  }

  /**
   * A promise that is fulfilled when the kernel runtime is ready.
   */
  get ready(): Promise<void> {
    return this._backend.ready;
  }

  /**
   * The active runtime backend.
   */
  protected get runtimeBackend(): IRuntimeBackend {
    return this._backend;
  }

  /**
   * Handle a kernel_info_request message.
   */
  async kernelInfoRequest(): Promise<KernelMessage.IInfoReplyMsg['content']> {
    const runtimeName =
      this._runtimeMode === 'worker' ? 'Web Worker' : 'IFrame';

    const content: KernelMessage.IInfoReply = {
      implementation: 'JavaScript',
      implementation_version: '0.1.0',
      language_info: {
        codemirror_mode: {
          name: 'javascript'
        },
        file_extension: '.js',
        mimetype: 'text/javascript',
        name: 'javascript',
        nbconvert_exporter: 'javascript',
        pygments_lexer: 'javascript',
        version: 'es2017'
      },
      protocol_version: '5.3',
      status: 'ok',
      banner: `A JavaScript kernel running in the browser (${runtimeName})`,
      help_links: [
        {
          text: 'JavaScript Kernel',
          url: 'https://github.com/jupyterlite/javascript-kernel'
        }
      ]
    };

    return content;
  }

  /**
   * Handle an `execute_request` message.
   */
  async executeRequest(
    content: KernelMessage.IExecuteRequestMsg['content']
  ): Promise<KernelMessage.IExecuteReplyMsg['content']> {
    try {
      await this.ready;
      return await this._backend.execute(
        content.code,
        this.executionCount,
        this.parentHeader?.msg_id
      );
    } catch (error) {
      const normalized = this.normalizeError(error);
      const traceback = [
        normalized.stack || normalized.message || String(error)
      ];

      this.publishExecuteError({
        ename: normalized.name || 'RuntimeError',
        evalue: normalized.message || '',
        traceback
      });

      return {
        status: 'error',
        execution_count: this.executionCount,
        ename: normalized.name || 'RuntimeError',
        evalue: normalized.message || '',
        traceback
      };
    }
  }

  /**
   * Handle a `complete_request` message.
   */
  async completeRequest(
    content: KernelMessage.ICompleteRequestMsg['content']
  ): Promise<KernelMessage.ICompleteReplyMsg['content']> {
    try {
      await this.ready;
      return await this._backend.complete(content.code, content.cursor_pos);
    } catch {
      return {
        matches: [],
        cursor_start: content.cursor_pos,
        cursor_end: content.cursor_pos,
        metadata: {},
        status: 'ok'
      };
    }
  }

  /**
   * Handle an `inspect_request` message.
   */
  async inspectRequest(
    content: KernelMessage.IInspectRequestMsg['content']
  ): Promise<KernelMessage.IInspectReplyMsg['content']> {
    try {
      await this.ready;
      return await this._backend.inspect(
        content.code,
        content.cursor_pos,
        content.detail_level
      );
    } catch {
      return {
        status: 'ok',
        found: false,
        data: {},
        metadata: {}
      };
    }
  }

  /**
   * Handle an `is_complete_request` message.
   */
  async isCompleteRequest(
    content: KernelMessage.IIsCompleteRequestMsg['content']
  ): Promise<KernelMessage.IIsCompleteReplyMsg['content']> {
    try {
      await this.ready;
      return await this._backend.isComplete(content.code);
    } catch {
      return {
        status: 'unknown'
      };
    }
  }

  /**
   * Handle a `comm_info_request` message.
   */
  async commInfoRequest(
    content: KernelMessage.ICommInfoRequestMsg['content']
  ): Promise<KernelMessage.ICommInfoReplyMsg['content']> {
    const comms: Record<string, { target_name: string }> = {};
    for (const [commId, info] of this._comms) {
      if (!content.target_name || info.target_name === content.target_name) {
        comms[commId] = { target_name: info.target_name };
      }
    }
    return {
      status: 'ok',
      comms
    };
  }

  /**
   * Send an `input_reply` message.
   */
  inputReply(content: KernelMessage.IInputReplyMsg['content']): void {
    this._logUnsupportedControlMessage('input_reply');
  }

  /**
   * Send an `comm_open` message.
   */
  async commOpen(msg: KernelMessage.ICommOpenMsg): Promise<void> {
    const { comm_id, target_name, data } = msg.content;
    this._comms.set(comm_id, { target_name });
    const buffers = this._toArrayBuffers(msg.buffers);
    await this._backend.handleCommOpen(
      comm_id,
      target_name,
      data as Record<string, unknown>,
      buffers,
      msg.header.msg_id
    );
  }

  /**
   * Send an `comm_msg` message.
   */
  async commMsg(msg: KernelMessage.ICommMsgMsg): Promise<void> {
    const { comm_id, data } = msg.content;
    const buffers = this._toArrayBuffers(msg.buffers);
    await this._backend.handleCommMsg(
      comm_id,
      data as Record<string, unknown>,
      buffers,
      msg.header.msg_id
    );
  }

  /**
   * Send an `comm_close` message.
   */
  async commClose(msg: KernelMessage.ICommCloseMsg): Promise<void> {
    const { comm_id, data } = msg.content;
    this._comms.delete(comm_id);
    const buffers = this._toArrayBuffers(msg.buffers);
    await this._backend.handleCommClose(
      comm_id,
      data as Record<string, unknown>,
      buffers,
      msg.header.msg_id
    );
  }

  /**
   * Called once a runtime backend is initialized, before `ready` resolves.
   */
  protected async onRuntimeReady(
    context: JavaScriptKernel.IRuntimeReadyContext
  ): Promise<void> {
    this._runtimeReadyContext = context;
    for (const extension of this._startupExtensions) {
      await this._applyStartupExtension(extension, context);
    }
  }

  /**
   * Apply a startup extension to an initialized runtime.
   */
  async applyStartupExtension(
    extension: JavaScriptKernel.IStartupExtension
  ): Promise<void> {
    await this.ready;
    const context = this._runtimeReadyContext;
    if (!context) {
      throw new Error('JavaScript runtime is not initialized');
    }
    await this._applyStartupExtension(extension, context);
  }

  /**
   * Remove runtime registrations made by a startup extension.
   */
  async removeStartupExtension(
    extension: JavaScriptKernel.IStartupExtension
  ): Promise<void> {
    await this.ready;
    const context = this._runtimeReadyContext;
    if (!context || !this._appliedStartupExtensions.has(extension.id)) {
      return;
    }
    try {
      await extension.deactivate?.(context);
    } finally {
      this._appliedStartupExtensions.delete(extension.id);
    }
  }

  /**
   * Create a runtime backend for the selected mode.
   */
  protected createBackend(runtimeMode: RuntimeMode): IRuntimeBackend {
    const options = {
      onOutput: (message: RuntimeOutputMessage) => {
        this.processRuntimeMessage(message);
      }
    };

    if (runtimeMode === 'worker') {
      return new WorkerRuntimeBackend({
        ...options,
        onReady: async context => {
          await this.onRuntimeReady({
            runtime: 'worker',
            execute: async code => {
              const reply = await context.execute(code);
              if (reply.status === 'error') {
                throw this._createRuntimeInitializationError(reply);
              }
              return reply;
            },
            preloadModule: context.preloadModule,
            registerCommTarget: async target => {
              await context.registerCommTarget(
                target.targetName,
                target.module,
                target.exportName
              );
            },
            unregisterCommTarget: context.unregisterCommTarget
          });
        }
      });
    }

    return new IFrameRuntimeBackend({
      ...options,
      executorFactory: this._executorFactory,
      onReady: async context => {
        await this.onRuntimeReady({
          runtime: 'iframe',
          globalScope: context.globalScope,
          executor: context.executor,
          execute: async code => {
            const reply = await context.execute(code);
            if (reply.status === 'error') {
              throw this._createRuntimeInitializationError(reply);
            }
            return reply;
          },
          preloadModule: context.preloadModule,
          registerCommTarget: async target => {
            await context.registerCommTarget(
              target.targetName,
              target.module,
              target.exportName
            );
          },
          unregisterCommTarget: context.unregisterCommTarget
        });
      }
    });
  }

  /**
   * Route runtime output messages to Jupyter kernel channels.
   */
  protected processRuntimeMessage(message: RuntimeOutputMessage): void {
    const parentHeader = this.parentHeader;

    switch (message.type) {
      case 'stream':
        this.stream(message.bundle, parentHeader);
        break;
      case 'input_request':
        this.inputRequest(message.content, parentHeader);
        break;
      case 'display_data':
        this.displayData(message.bundle, parentHeader);
        break;
      case 'update_display_data':
        this.updateDisplayData(message.bundle, parentHeader);
        break;
      case 'clear_output':
        this.clearOutput(message.bundle, parentHeader);
        break;
      case 'execute_result':
        this.publishExecuteResult(message.bundle, parentHeader);
        break;
      case 'execute_error':
        this.publishExecuteError(message.bundle, parentHeader);
        break;
      case 'comm_open':
        this._comms.set(message.content.comm_id, {
          target_name: message.content.target_name
        });
        this.handleComm(
          'comm_open',
          message.content as any,
          (message.metadata ?? {}) as any,
          message.buffers as any,
          parentHeader
        );
        break;
      case 'comm_msg':
        this.handleComm(
          'comm_msg',
          message.content as any,
          (message.metadata ?? {}) as any,
          message.buffers as any,
          parentHeader
        );
        break;
      case 'comm_close':
        this._comms.delete(message.content.comm_id);
        this.handleComm(
          'comm_close',
          message.content as any,
          (message.metadata ?? {}) as any,
          message.buffers as any,
          parentHeader
        );
        break;
      default:
        break;
    }
  }

  /**
   * Normalize unknown thrown values into Error instances.
   */
  protected normalizeError(error: unknown): Error {
    return normalizeUnknownError(error, 'RuntimeError');
  }

  /**
   * Normalize an execute reply error into an Error instance.
   */
  private _createRuntimeInitializationError(
    reply: KernelMessage.IExecuteReplyMsg['content']
  ): Error {
    const ename =
      'ename' in reply && typeof reply.ename === 'string'
        ? reply.ename
        : 'RuntimeError';
    const evalue =
      'evalue' in reply && typeof reply.evalue === 'string'
        ? reply.evalue
        : 'Runtime initialization failed';
    const error = new Error(evalue);
    error.name = ename;

    const traceback =
      'traceback' in reply && Array.isArray(reply.traceback)
        ? reply.traceback
        : [];
    if (traceback.length > 0) {
      error.stack = traceback.join('\n');
    }

    return error;
  }

  /**
   * Convert incoming message buffers to ArrayBuffer for Comlink transport.
   */
  private _toArrayBuffers(
    buffers?: (ArrayBuffer | ArrayBufferView)[]
  ): ArrayBuffer[] | undefined {
    if (!buffers || buffers.length === 0) {
      return undefined;
    }
    return buffers.map(buf => {
      if (ArrayBuffer.isView(buf)) {
        return buf.buffer.slice(
          buf.byteOffset,
          buf.byteOffset + buf.byteLength
        );
      }
      return buf;
    });
  }

  /**
   * Warn once per unsupported control message type to avoid noisy consoles.
   */
  private _logUnsupportedControlMessage(
    type: 'input_reply',
    detail?: string
  ): void {
    if (this._unsupportedControlMessages.has(type)) {
      return;
    }

    this._unsupportedControlMessages.add(type);
    const suffix = detail ? ` (${detail})` : '';

    console.warn(
      `[javascript-kernel] Ignoring unsupported ${type} message${suffix}.`
    );
  }

  /**
   * Apply a startup extension once to the given runtime context.
   */
  private async _applyStartupExtension(
    extension: JavaScriptKernel.IStartupExtension,
    context: JavaScriptKernel.IRuntimeReadyContext
  ): Promise<void> {
    if (this._appliedStartupExtensions.has(extension.id)) {
      return;
    }
    await extension.activate(context);
    this._appliedStartupExtensions.add(extension.id);
  }

  private _unsupportedControlMessages = new Set<'input_reply'>();
  private _comms = new Map<string, { target_name: string }>();
  private _backend: IRuntimeBackend;
  private _executorFactory?: JavaScriptKernel.IExecutorFactory;
  private _startupExtensions: JavaScriptKernel.IStartupExtension[];
  private _appliedStartupExtensions = new Set<string>();
  private _runtimeReadyContext: JavaScriptKernel.IRuntimeReadyContext | null =
    null;
  private _runtimeMode: RuntimeMode;
}

/**
 * A namespace for JavaScriptKernel statics.
 */
export namespace JavaScriptKernel {
  /**
   * Runtime context shared by all backend initialization hooks.
   */
  export interface IRuntimeReadyContextBase {
    runtime: RuntimeMode;
    execute: (code: string) => Promise<unknown>;
    preloadModule: (moduleName: string) => Promise<void>;
    registerCommTarget: (target: IStartupCommTarget) => Promise<void>;
    unregisterCommTarget: (targetName: string) => Promise<void>;
  }

  /**
   * Runtime context for iframe backend initialization.
   */
  export interface IIFrameRuntimeReadyContext extends IRuntimeReadyContextBase {
    runtime: 'iframe';
    globalScope: Record<string, any>;
    executor: JavaScriptExecutor;
  }

  /**
   * Runtime context for worker backend initialization.
   */
  export interface IWorkerRuntimeReadyContext extends IRuntimeReadyContextBase {
    runtime: 'worker';
  }

  /**
   * Runtime context available from `onRuntimeReady`.
   */
  export type IRuntimeReadyContext =
    | IIFrameRuntimeReadyContext
    | IWorkerRuntimeReadyContext;

  /**
   * A comm target handler exported by a startup module.
   */
  export interface IStartupCommTarget {
    targetName: string;
    module: string;
    exportName?: string;
  }

  /**
   * Startup extension executed before the kernel accepts user code.
   */
  export interface IStartupExtension {
    id: string;
    activate: (context: IRuntimeReadyContext) => Promise<void> | void;
    deactivate?: (context: IRuntimeReadyContext) => Promise<void> | void;
  }

  /**
   * Factory used to customize iframe runtime evaluation behavior.
   */
  export type IExecutorFactory = (
    globalScope: Record<string, any>
  ) => JavaScriptExecutor;

  /**
   * The instantiation options for a JavaScript kernel.
   */
  export interface IOptions extends IKernel.IOptions {
    runtime?: RuntimeMode;
    executorFactory?: IExecutorFactory;
    startupExtensions?: readonly IStartupExtension[];
  }
}
