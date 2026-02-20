// Copyright (c) Jupyter Development Team.
// Distributed under the terms of the Modified BSD License.

import type { KernelMessage } from '@jupyterlab/services';

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
 * Execute request sent to a runtime backend.
 */
export interface IExecuteRuntimeRequest {
  type: 'execute_request';
  content: KernelMessage.IExecuteRequestMsg['content'];
  execution_count: number;
}

/**
 * Completion request sent to a runtime backend.
 */
export interface ICompleteRuntimeRequest {
  type: 'complete_request';
  content: KernelMessage.ICompleteRequestMsg['content'];
}

/**
 * Inspection request sent to a runtime backend.
 */
export interface IInspectRuntimeRequest {
  type: 'inspect_request';
  content: KernelMessage.IInspectRequestMsg['content'];
}

/**
 * is_complete request sent to a runtime backend.
 */
export interface IIsCompleteRuntimeRequest {
  type: 'is_complete_request';
  content: KernelMessage.IIsCompleteRequestMsg['content'];
}

/**
 * Any request that can be handled by a runtime backend.
 */
export type RuntimeRequest =
  | IExecuteRuntimeRequest
  | ICompleteRuntimeRequest
  | IInspectRuntimeRequest
  | IIsCompleteRuntimeRequest;

/**
 * Response payloads for runtime requests.
 */
export type RuntimeResponse =
  | KernelMessage.IExecuteReplyMsg['content']
  | KernelMessage.ICompleteReplyMsg['content']
  | KernelMessage.IInspectReplyMsg['content']
  | KernelMessage.IIsCompleteReplyMsg['content'];

/**
 * Request envelope sent from main thread to worker runtime.
 */
export interface IWorkerRuntimeRequestEnvelope {
  kind: 'request';
  id: number;
  request: RuntimeRequest;
}

/**
 * Successful response from a worker runtime.
 */
export interface IWorkerRuntimeSuccessEnvelope {
  kind: 'response';
  id: number;
  ok: true;
  payload: RuntimeResponse;
}

/**
 * Error response from a worker runtime.
 */
export interface IWorkerRuntimeErrorEnvelope {
  kind: 'response';
  id: number;
  ok: false;
  error: {
    name: string;
    message: string;
    stack?: string;
  };
}

/**
 * Output envelope emitted by a worker runtime.
 */
export interface IWorkerRuntimeOutputEnvelope {
  kind: 'output';
  message: RuntimeOutputMessage;
}

/**
 * Ready envelope emitted when the worker runtime is initialized.
 */
export interface IWorkerRuntimeReadyEnvelope {
  kind: 'ready';
}

/**
 * Messages posted to a worker runtime.
 */
export type WorkerRuntimeInboundMessage = IWorkerRuntimeRequestEnvelope;

/**
 * Messages posted from a worker runtime.
 */
export type WorkerRuntimeOutboundMessage =
  | IWorkerRuntimeSuccessEnvelope
  | IWorkerRuntimeErrorEnvelope
  | IWorkerRuntimeOutputEnvelope
  | IWorkerRuntimeReadyEnvelope;
