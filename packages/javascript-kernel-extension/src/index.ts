// Copyright (c) Jupyter Development Team.
// Distributed under the terms of the Modified BSD License.

import {
  JupyterLiteServer,
  JupyterLiteServerPlugin
} from '@jupyterlite/server';

import { IKernel, IKernelSpecs } from '@jupyterlite/kernel';

import { JavaScriptKernel } from '@jupyterlite/javascript-kernel';

import jsLogo32 from '../style/icons/logo-32x32.png';

import jsLogo64 from '../style/icons/logo-64x64.png';

/**
 * A plugin to register the JavaScript kernel.
 */
const kernel: JupyterLiteServerPlugin<void> = {
  id: '@jupyterlite/javascript-kernel-extension:kernel',
  autoStart: true,
  requires: [IKernelSpecs],
  activate: (app: JupyterLiteServer, kernelspecs: IKernelSpecs) => {
    kernelspecs.register({
      spec: {
        name: 'javascript',
        display_name: 'JavaScript (Web Worker)',
        language: 'javascript',
        argv: [],
        resources: {
          'logo-32x32': jsLogo32,
          'logo-64x64': jsLogo64
        }
      },
      create: async (options: IKernel.IOptions): Promise<IKernel> => {
        return new JavaScriptKernel(options);
      }
    });
  }
};

const plugins: JupyterLiteServerPlugin<any>[] = [kernel];

export default plugins;
