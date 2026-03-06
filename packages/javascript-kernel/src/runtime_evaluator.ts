// Copyright (c) Jupyter Development Team.
// Distributed under the terms of the Modified BSD License.

import type { KernelMessage } from '@jupyterlab/services';

import { JavaScriptExecutor } from './executor';
import { normalizeError } from './errors';
import type { RuntimeOutputHandler } from './runtime_protocol';

/**
 * Shared execution logic for iframe and worker runtime backends.
 */
export class JavaScriptRuntimeEvaluator {
  /**
   * Instantiate a runtime evaluator.
   */
  constructor(options: JavaScriptRuntimeEvaluator.IOptions) {
    this._globalScope = options.globalScope;
    this._onOutput = options.onOutput;
    this._executor =
      options.executor ?? new JavaScriptExecutor(options.globalScope);

    this._setupDisplay();
    this._setupConsoleOverrides();
  }

  /**
   * Dispose the evaluator and restore patched globals where possible.
   */
  dispose(): void {
    this._restoreConsoleOverrides();
    this._restoreDisplay();
  }

  /**
   * The runtime global scope.
   */
  get globalScope(): Record<string, any> {
    return this._globalScope;
  }

  /**
   * The executor used by the evaluator.
   */
  get executor(): JavaScriptExecutor {
    return this._executor;
  }

  /**
   * Execute user code in the configured runtime global scope.
   */
  async execute(
    code: string,
    executionCount: number
  ): Promise<KernelMessage.IExecuteReplyMsg['content']> {
    // Parse-time errors are syntax errors, so show only `Name: message`.
    let asyncFunction: () => Promise<any>;
    let withReturn: boolean;
    try {
      const parsed = this._executor.makeAsyncFromCode(code);
      asyncFunction = parsed.asyncFunction;
      withReturn = parsed.withReturn;
    } catch (error) {
      const normalized = normalizeError(error);
      return this._emitError(executionCount, normalized, false);
    }

    // Runtime errors may include useful eval frames from user code.
    try {
      const resultPromise = this._evalFunc(asyncFunction);

      if (withReturn) {
        const result = await resultPromise;

        if (result !== undefined) {
          const data = this._executor.getMimeBundle(result);
          this._onOutput({
            type: 'execute_result',
            bundle: {
              execution_count: executionCount,
              data,
              metadata: {}
            }
          });
        }
      } else {
        await resultPromise;
      }

      return {
        status: 'ok',
        execution_count: executionCount,
        user_expressions: {}
      };
    } catch (error) {
      const normalized = normalizeError(error);
      return this._emitError(executionCount, normalized, true);
    }
  }

  /**
   * Complete code at the given cursor position.
   */
  complete(
    code: string,
    cursorPos: number
  ): KernelMessage.ICompleteReplyMsg['content'] {
    const result = this._executor.completeRequest(code, cursorPos);

    return {
      matches: result.matches,
      cursor_start: result.cursorStart,
      cursor_end: result.cursorEnd || cursorPos,
      metadata: {},
      status: 'ok'
    };
  }

  /**
   * Inspect symbol information at the given cursor position.
   */
  inspect(
    code: string,
    cursorPos: number,
    detailLevel: KernelMessage.IInspectRequestMsg['content']['detail_level']
  ): KernelMessage.IInspectReplyMsg['content'] {
    return this._executor.inspect(code, cursorPos, detailLevel);
  }

  /**
   * Check whether the provided code is complete.
   */
  isComplete(code: string): KernelMessage.IIsCompleteReplyMsg['content'] {
    return this._executor.isComplete(code);
  }

  /**
   * Evaluate an async function within the configured global scope.
   */
  private _evalFunc(asyncFunc: () => Promise<any>): Promise<any> {
    return asyncFunc.call(this._globalScope);
  }

  /**
   * Build and emit an execute error reply.
   */
  private _emitError(
    executionCount: number,
    error: Error,
    includeStack: boolean
  ): KernelMessage.IExecuteReplyMsg['content'] {
    const traceback = includeStack
      ? this._executor.cleanStackTrace(error)
      : `${error.name}: ${error.message}`;

    const content: KernelMessage.IReplyErrorContent = {
      status: 'error',
      ename: error.name || 'Error',
      evalue: error.message || '',
      traceback: [traceback]
    };

    this._onOutput({
      type: 'execute_error',
      bundle: content
    });

    return {
      ...content,
      execution_count: executionCount
    };
  }

  /**
   * Patch console methods in runtime scope to emit Jupyter stream messages.
   */
  private _setupConsoleOverrides(): void {
    const scopeConsole = this._globalScope.console as Console | undefined;
    if (!scopeConsole) {
      return;
    }

    this._originalConsole = {
      log: scopeConsole.log,
      info: scopeConsole.info,
      error: scopeConsole.error,
      warn: scopeConsole.warn,
      debug: scopeConsole.debug,
      dir: scopeConsole.dir,
      trace: scopeConsole.trace,
      table: scopeConsole.table
    };

    const toText = (args: any[]) => {
      const text = args
        .map(arg => {
          if (typeof arg === 'string') {
            return arg;
          }

          try {
            if (typeof arg === 'object' && arg !== null) {
              const bundle = this._executor.getMimeBundle(arg);
              const plain = bundle['text/plain'];
              if (typeof plain === 'string') {
                return plain;
              }
            }
            return String(arg);
          } catch {
            return '[Unprintable value]';
          }
        })
        .join(' ');

      return `${text}\n`;
    };

    scopeConsole.log = (...args: any[]) => {
      this._onOutput({
        type: 'stream',
        bundle: { name: 'stdout', text: toText(args) }
      });
    };

    scopeConsole.info = scopeConsole.log;

    scopeConsole.error = (...args: any[]) => {
      this._onOutput({
        type: 'stream',
        bundle: { name: 'stderr', text: toText(args) }
      });
    };

    scopeConsole.warn = scopeConsole.error;

    scopeConsole.debug = scopeConsole.log;
    scopeConsole.dir = scopeConsole.log;
    scopeConsole.trace = scopeConsole.log;
    scopeConsole.table = scopeConsole.log;

    if ('onerror' in this._globalScope) {
      this._originalOnError = this._globalScope.onerror;
      this._globalScope.onerror = (message: any) => {
        scopeConsole.error(message);
        return false;
      };
    }
  }

  /**
   * Restore original console methods if they were patched.
   */
  private _restoreConsoleOverrides(): void {
    if (!this._originalConsole) {
      return;
    }

    const scopeConsole = this._globalScope.console as Console | undefined;
    if (scopeConsole) {
      scopeConsole.log = this._originalConsole.log;
      scopeConsole.info = this._originalConsole.info;
      scopeConsole.error = this._originalConsole.error;
      scopeConsole.warn = this._originalConsole.warn;
      scopeConsole.debug = this._originalConsole.debug;
      scopeConsole.dir = this._originalConsole.dir;
      scopeConsole.trace = this._originalConsole.trace;
      scopeConsole.table = this._originalConsole.table;
    }

    if ('onerror' in this._globalScope) {
      this._globalScope.onerror = this._originalOnError;
    }

    this._originalConsole = null;
    this._originalOnError = undefined;
  }

  /**
   * Install display() helper in runtime scope.
   */
  private _setupDisplay(): void {
    this._previousDisplay = this._globalScope.display;

    this._globalScope.display = (obj: any, metadata?: Record<string, any>) => {
      const data = this._executor.getMimeBundle(obj);

      this._onOutput({
        type: 'display_data',
        bundle: {
          data,
          metadata: metadata ?? {},
          transient: {}
        }
      });
    };
  }

  /**
   * Restore previous display binding.
   */
  private _restoreDisplay(): void {
    if (this._previousDisplay === undefined) {
      delete this._globalScope.display;
      return;
    }

    this._globalScope.display = this._previousDisplay;
  }

  private _globalScope: Record<string, any>;
  private _onOutput: RuntimeOutputHandler;
  private _executor: JavaScriptExecutor;
  private _previousDisplay: any;
  private _originalOnError: any;
  private _originalConsole: {
    log: Console['log'];
    info: Console['info'];
    error: Console['error'];
    warn: Console['warn'];
    debug: Console['debug'];
    dir: Console['dir'];
    trace: Console['trace'];
    table: Console['table'];
  } | null = null;
}

/**
 * A namespace for JavaScriptRuntimeEvaluator statics.
 */
export namespace JavaScriptRuntimeEvaluator {
  /**
   * The instantiation options for a runtime evaluator.
   */
  export interface IOptions {
    globalScope: Record<string, any>;
    onOutput: RuntimeOutputHandler;
    executor?: JavaScriptExecutor;
  }
}
