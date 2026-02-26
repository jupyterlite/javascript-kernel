// Copyright (c) Jupyter Development Team.
// Distributed under the terms of the Modified BSD License.

import type { KernelMessage } from '@jupyterlab/services';
import type { IWorkerKernel } from '@jupyterlite/services';

/**
 * Supported runtime backends for the JavaScript kernel.
 */
export type RuntimeMode = 'iframe' | 'worker';

/**
 * Output messages emitted by runtime backends.
 */
export type RuntimeOutputMessage =
  | {
      type: 'stream';
      bundle: KernelMessage.IStreamMsg['content'];
    }
  | {
      type: 'input_request';
      content: KernelMessage.IInputRequestMsg['content'];
    }
  | {
      type: 'display_data';
      bundle: KernelMessage.IDisplayDataMsg['content'];
    }
  | {
      type: 'update_display_data';
      bundle: KernelMessage.IUpdateDisplayDataMsg['content'];
    }
  | {
      type: 'clear_output';
      bundle: KernelMessage.IClearOutputMsg['content'];
    }
  | {
      type: 'execute_result';
      bundle: KernelMessage.IExecuteResultMsg['content'];
    }
  | {
      type: 'execute_error';
      bundle: KernelMessage.IReplyErrorContent;
    };

/**
 * Callback invoked when a runtime emits output.
 */
export type RuntimeOutputHandler = (message: RuntimeOutputMessage) => void;

/**
 * Output callback passed across Comlink endpoints.
 */
export type RuntimeOutputCallback = (
  message: RuntimeOutputMessage
) => void | Promise<void>;

/**
 * Runtime API exposed from iframe and worker contexts over Comlink.
 */
export interface IRemoteRuntimeApi {
  initialize(
    options: IWorkerKernel.IOptions,
    onOutput: RuntimeOutputCallback
  ): Promise<void>;
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
  dispose(): Promise<void>;
}
