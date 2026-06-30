// Copyright (c) Jupyter Development Team.
// Distributed under the terms of the Modified BSD License.

import { Token } from '@lumino/coreutils';
import type { IDisposable } from '@lumino/disposable';

import type { JavaScriptKernel } from './kernel';

/**
 * Registry for JavaScript kernel startup extensions.
 */
export interface IJavaScriptKernelStartup {
  readonly startupExtensions: readonly JavaScriptKernel.IStartupExtension[];
  registerStartupExtension(
    extension: JavaScriptKernel.IStartupExtension
  ): IDisposable;
  trackKernel(kernel: JavaScriptKernel): void;
}

/**
 * Token for registering JavaScript kernel startup extensions.
 */
export const IJavaScriptKernelStartup = new Token<IJavaScriptKernelStartup>(
  '@jupyterlite/javascript-kernel:IJavaScriptKernelStartup'
);
