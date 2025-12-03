// Copyright (c) Jupyter Development Team.
// Distributed under the terms of the Modified BSD License.

import type { KernelMessage } from '@jupyterlab/services';

import { BaseKernel, type IKernel } from '@jupyterlite/services';

import { PromiseDelegate } from '@lumino/coreutils';

import { JavaScriptExecutor } from './executor';

/**
 * A kernel that executes JavaScript code in an IFrame.
 */
export class JavaScriptKernel extends BaseKernel implements IKernel {
  /**
   * Instantiate a new JavaScriptKernel
   *
   * @param options The instantiation options for a new JavaScriptKernel
   */
  constructor(options: JavaScriptKernel.IOptions) {
    super(options);
    this._initIFrame();
  }

  /**
   * Dispose the kernel.
   */
  dispose(): void {
    if (this.isDisposed) {
      return;
    }
    this._cleanupIFrame();
    super.dispose();
  }

  /**
   * A promise that is fulfilled when the kernel is ready.
   */
  get ready(): Promise<void> {
    return this._ready.promise;
  }

  /**
   * Get the executor instance.
   * Subclasses can use this to access executor functionality.
   */
  protected get executor(): JavaScriptExecutor | undefined {
    return this._executor;
  }

  /**
   * Get the iframe element.
   * Subclasses can use this for custom iframe operations.
   */
  protected get iframe(): HTMLIFrameElement {
    return this._iframe;
  }

  /**
   * Handle a kernel_info_request message
   */
  async kernelInfoRequest(): Promise<KernelMessage.IInfoReplyMsg['content']> {
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
      banner: 'A JavaScript kernel running in the browser',
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
   * Handle an `execute_request` message
   *
   * @param content The content of the request.
   */
  async executeRequest(
    content: KernelMessage.IExecuteRequestMsg['content']
  ): Promise<KernelMessage.IExecuteReplyMsg['content']> {
    const { code } = content;

    if (!this._executor) {
      return {
        status: 'error',
        execution_count: this.executionCount,
        ename: 'ExecutorError',
        evalue: 'Executor not initialized',
        traceback: []
      };
    }

    try {
      // Use the executor to create an async function from the code
      const { asyncFunction, withReturn } =
        this._executor.makeAsyncFromCode(code);

      // Execute the async function in the iframe context
      const resultPromise = this._evalFunc(
        this._iframe.contentWindow,
        asyncFunction
      );

      if (withReturn) {
        const resultHolder = await resultPromise;
        const result = resultHolder[0];
        // Skip undefined results (e.g., from console.log)
        if (result !== undefined) {
          const data = this._executor.getMimeBundle(result);

          this.publishExecuteResult({
            execution_count: this.executionCount,
            data,
            metadata: {}
          });
        }
      } else {
        await resultPromise;
      }

      return {
        status: 'ok',
        execution_count: this.executionCount,
        user_expressions: {}
      };
    } catch (e) {
      const error = e as Error;
      const { name, message } = error;

      // Use executor to clean stack trace
      const cleanedStack = this._executor.cleanStackTrace(error);

      this.publishExecuteError({
        ename: name || 'Error',
        evalue: message || '',
        traceback: [cleanedStack]
      });

      return {
        status: 'error',
        execution_count: this.executionCount,
        ename: name || 'Error',
        evalue: message || '',
        traceback: [cleanedStack]
      };
    }
  }

  /**
   * Handle a complete_request message
   *
   * @param content The content of the request.
   */
  async completeRequest(
    content: KernelMessage.ICompleteRequestMsg['content']
  ): Promise<KernelMessage.ICompleteReplyMsg['content']> {
    if (!this._executor) {
      return {
        matches: [],
        cursor_start: content.cursor_pos,
        cursor_end: content.cursor_pos,
        metadata: {},
        status: 'ok'
      };
    }

    const { code, cursor_pos } = content;
    const result = this._executor.completeRequest(code, cursor_pos);

    return {
      matches: result.matches,
      cursor_start: result.cursorStart,
      cursor_end: result.cursorEnd || cursor_pos,
      metadata: {},
      status: 'ok'
    };
  }

  /**
   * Handle an `inspect_request` message.
   *
   * @param content - The content of the request.
   *
   * @returns A promise that resolves with the response message.
   */
  async inspectRequest(
    content: KernelMessage.IInspectRequestMsg['content']
  ): Promise<KernelMessage.IInspectReplyMsg['content']> {
    if (!this._executor) {
      return {
        status: 'ok',
        found: false,
        data: {},
        metadata: {}
      };
    }

    const { code, cursor_pos, detail_level } = content;
    const result = this._executor.inspect(code, cursor_pos, detail_level);

    return {
      status: 'ok',
      found: result.found,
      data: result.data,
      metadata: result.metadata
    };
  }

  /**
   * Handle an `is_complete_request` message.
   *
   * @param content - The content of the request.
   *
   * @returns A promise that resolves with the response message.
   */
  async isCompleteRequest(
    content: KernelMessage.IIsCompleteRequestMsg['content']
  ): Promise<KernelMessage.IIsCompleteReplyMsg['content']> {
    if (!this._executor) {
      return {
        status: 'unknown'
      };
    }

    const { code } = content;
    const result = this._executor.isComplete(code);

    return {
      status: result.status,
      indent: result.indent || ''
    };
  }

  /**
   * Handle a `comm_info_request` message.
   *
   * @param content - The content of the request.
   *
   * @returns A promise that resolves with the response message.
   */
  async commInfoRequest(
    content: KernelMessage.ICommInfoRequestMsg['content']
  ): Promise<KernelMessage.ICommInfoReplyMsg['content']> {
    return {
      status: 'ok',
      comms: {}
    };
  }

  /**
   * Send an `input_reply` message.
   *
   * @param content - The content of the reply.
   */
  inputReply(content: KernelMessage.IInputReplyMsg['content']): void {
    throw new Error('Not implemented');
  }

  /**
   * Send an `comm_open` message.
   *
   * @param msg - The comm_open message.
   */
  async commOpen(msg: KernelMessage.ICommOpenMsg): Promise<void> {
    throw new Error('Not implemented');
  }

  /**
   * Send an `comm_msg` message.
   *
   * @param msg - The comm_msg message.
   */
  async commMsg(msg: KernelMessage.ICommMsgMsg): Promise<void> {
    throw new Error('Not implemented');
  }

  /**
   * Send an `comm_close` message.
   *
   * @param close - The comm_close message.
   */
  async commClose(msg: KernelMessage.ICommCloseMsg): Promise<void> {
    throw new Error('Not implemented');
  }

  /**
   * Execute code in the kernel IFrame.
   *
   * @param code The code to execute.
   */
  protected _eval(code: string): any {
    return this._evalCodeFunc(this._iframe.contentWindow, code);
  }

  /**
   * Initialize the IFrame and set up communication.
   */
  protected async _initIFrame(): Promise<void> {
    this._container = document.createElement('div');
    this._container.style.cssText =
      'position:absolute;width:0;height:0;overflow:hidden;';
    document.body.appendChild(this._container);

    // Create the iframe with sandbox permissions
    this._iframe = document.createElement('iframe');
    this._iframe.sandbox.add('allow-scripts', 'allow-same-origin');
    this._iframe.style.cssText = 'border:none;width:100%;height:100%;';

    this._iframe.srcdoc = `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <title>JavaScript Kernel</title>
</head>
<body></body>
</html>`;

    this._container.appendChild(this._iframe);

    // Wait for iframe to load
    await new Promise<void>(resolve => {
      this._iframe.onload = () => resolve();
    });

    // Set up console overrides in the iframe
    this._setupConsoleOverrides();

    // Set up message handling for console output
    this._messageHandler = (event: MessageEvent) => {
      if (event.source === this._iframe.contentWindow) {
        this._processMessage(event.data);
      }
    };
    window.addEventListener('message', this._messageHandler);

    // Initialize the executor with the iframe's window
    if (this._iframe.contentWindow) {
      this._executor = new JavaScriptExecutor(this._iframe.contentWindow);
      this._setupDisplay();
    }

    this._ready.resolve();
  }

  /**
   * Set up the display() function in the iframe.
   */
  protected _setupDisplay(): void {
    if (!this._iframe.contentWindow || !this._executor) {
      return;
    }

    const executor = this._executor;

    // Create display function that uses executor's getMimeBundle
    // and calls kernel's displayData directly
    const display = (obj: any, metadata?: Record<string, any>) => {
      const data = executor.getMimeBundle(obj);
      this.displayData(
        { data, metadata: metadata ?? {}, transient: {} },
        this.parentHeader
      );
    };

    // Expose display in the iframe's global scope
    (this._iframe.contentWindow as any).display = display;
  }

  /**
   * Set up console overrides in the iframe to bubble output to parent.
   */
  protected _setupConsoleOverrides(): void {
    if (!this._iframe.contentWindow) {
      return;
    }

    this._evalCodeFunc(
      this._iframe.contentWindow,
      `
      console._log = console.log;
      console._error = console.error;
      window._bubbleUp = function(msg) {
        window.parent.postMessage(msg, '*');
      };
      console.log = function() {
        const args = Array.prototype.slice.call(arguments);
        window._bubbleUp({
          type: 'stream',
          bundle: { name: 'stdout', text: args.join(' ') + '\\n' }
        });
      };
      console.info = console.log;
      console.error = function() {
        const args = Array.prototype.slice.call(arguments);
        window._bubbleUp({
          type: 'stream',
          bundle: { name: 'stderr', text: args.join(' ') + '\\n' }
        });
      };
      console.warn = console.error;
      window.onerror = function(message, source, lineno, colno, error) {
        console.error(message);
      };
    `
    );
  }

  /**
   * Clean up the iframe resources.
   */
  protected _cleanupIFrame(): void {
    if (this._messageHandler) {
      window.removeEventListener('message', this._messageHandler);
      this._messageHandler = null;
    }
    this._iframe.remove();
    if (this._container) {
      this._container.remove();
      this._container = null;
    }
  }

  /**
   * Process a message coming from the IFrame.
   *
   * @param msg The message to process.
   */
  protected _processMessage(msg: any): void {
    if (!msg || !msg.type) {
      return;
    }

    const parentHeader = this.parentHeader;

    switch (msg.type) {
      case 'stream': {
        const bundle = msg.bundle ?? { name: 'stdout', text: '' };
        this.stream(bundle, parentHeader);
        break;
      }
      case 'input_request': {
        const bundle = msg.content ?? { prompt: '', password: false };
        this.inputRequest(bundle, parentHeader);
        break;
      }
      case 'display_data': {
        const bundle = msg.bundle ?? { data: {}, metadata: {}, transient: {} };
        this.displayData(bundle, parentHeader);
        break;
      }
      case 'update_display_data': {
        const bundle = msg.bundle ?? { data: {}, metadata: {}, transient: {} };
        this.updateDisplayData(bundle, parentHeader);
        break;
      }
      case 'clear_output': {
        const bundle = msg.bundle ?? { wait: false };
        this.clearOutput(bundle, parentHeader);
        break;
      }
      case 'execute_result': {
        const bundle = msg.bundle ?? {
          execution_count: 0,
          data: {},
          metadata: {}
        };
        this.publishExecuteResult(bundle, parentHeader);
        break;
      }
      case 'execute_error': {
        const bundle = msg.bundle ?? { ename: '', evalue: '', traceback: [] };
        this.publishExecuteError(bundle, parentHeader);
        break;
      }
      case 'comm_msg':
      case 'comm_open':
      case 'comm_close': {
        this.handleComm(
          msg.type,
          msg.content,
          msg.metadata,
          msg.buffers,
          msg.parentHeader
        );
        break;
      }
    }
  }

  // Function to execute an async function in the iframe context
  private _evalFunc = (win: Window | null, asyncFunc: () => Promise<any>) => {
    if (!win) {
      throw new Error('IFrame window not available');
    }
    return asyncFunc.call(win);
  };

  // Function to execute raw code string in the iframe context
  private _evalCodeFunc = new Function(
    'window',
    'code',
    'return window.eval(code);'
  ) as (win: Window | null, code: string) => any;

  private _iframe!: HTMLIFrameElement;
  private _container: HTMLDivElement | null = null;
  private _messageHandler: ((event: MessageEvent) => void) | null = null;
  private _executor?: JavaScriptExecutor;
  private _ready = new PromiseDelegate<void>();
}

/**
 * A namespace for JavaScriptKernel statics
 */
export namespace JavaScriptKernel {
  /**
   * The instantiation options for a JavaScript kernel.
   */
  export interface IOptions extends IKernel.IOptions {}
}
