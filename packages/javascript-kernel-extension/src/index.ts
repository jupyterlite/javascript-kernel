// Copyright (c) Jupyter Development Team.
// Distributed under the terms of the Modified BSD License.

import {
  JupyterFrontEnd,
  JupyterFrontEndPlugin
} from '@jupyterlab/application';

import type { IKernel } from '@jupyterlite/services';

import { IKernelSpecs } from '@jupyterlite/services';

import { JavaScriptKernel } from '@jupyterlite/javascript-kernel';
import type { RuntimeMode } from '@jupyterlite/javascript-kernel';

import jsLogo32 from '../style/icons/logo-32x32.png';

import jsLogo64 from '../style/icons/logo-64x64.png';

/**
 * Register a JavaScript kernelspec for a given runtime.
 */
interface IRegisterKernelOptions {
  name: string;
  displayName: string;
  runtime: RuntimeMode;
}

const registerKernel = (
  kernelspecs: IKernelSpecs,
  options: IRegisterKernelOptions
) => {
  const { name, displayName, runtime } = options;

  kernelspecs.register({
    spec: {
      name,
      display_name: displayName,
      language: 'javascript',
      argv: [],
      spec: {
        argv: [],
        env: {},
        display_name: displayName,
        language: 'javascript',
        interrupt_mode: 'message',
        metadata: {
          runtime
        }
      },
      resources: {
        'logo-32x32': jsLogo32,
        'logo-64x64': jsLogo64
      }
    },
    create: async (options: IKernel.IOptions): Promise<IKernel> => {
      return new JavaScriptKernel({
        ...options,
        runtime
      } as JavaScriptKernel.IOptions);
    }
  });
};

/**
 * Plugin registering the iframe JavaScript kernel.
 */
const kernelIFrame: JupyterFrontEndPlugin<void> = {
  id: '@jupyterlite/javascript-kernel-extension:kernel-iframe',
  autoStart: true,
  requires: [IKernelSpecs],
  activate: (app: JupyterFrontEnd, kernelspecs: IKernelSpecs) => {
    registerKernel(kernelspecs, {
      name: 'javascript',
      displayName: 'JavaScript (IFrame)',
      runtime: 'iframe'
    });
  }
};

/**
 * Plugin registering the worker JavaScript kernel.
 */
const kernelWorker: JupyterFrontEndPlugin<void> = {
  id: '@jupyterlite/javascript-kernel-extension:kernel-worker',
  autoStart: true,
  requires: [IKernelSpecs],
  activate: (app: JupyterFrontEnd, kernelspecs: IKernelSpecs) => {
    registerKernel(kernelspecs, {
      name: 'javascript-worker',
      displayName: 'JavaScript (Web Worker)',
      runtime: 'worker'
    });
  }
};

const plugins: JupyterFrontEndPlugin<void>[] = [kernelIFrame, kernelWorker];

export default plugins;
