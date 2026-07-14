// Copyright (c) Jupyter Development Team.
// Distributed under the terms of the Modified BSD License.

import { Token } from '@lumino/coreutils';
import type { IDisposable } from '@lumino/disposable';

import type { JavaScriptKernel } from './kernel';

/**
 * Registry for JavaScript kernel startup extensions.
 */
export interface IJavaScriptKernelStartupRegistry {
  readonly startupExtensions: readonly JavaScriptKernel.IStartupExtension[];
  registerStartupExtension(
    extension: JavaScriptKernel.IStartupExtension
  ): IDisposable;
}

/**
 * Token for registering JavaScript kernel startup extensions.
 */
export const IJavaScriptKernelStartupRegistry =
  new Token<IJavaScriptKernelStartupRegistry>(
    '@jupyterlite/javascript-kernel:IJavaScriptKernelStartupRegistry'
  );
