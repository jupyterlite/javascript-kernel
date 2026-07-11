// Copyright (c) Jupyter Development Team.
// Distributed under the terms of the Modified BSD License.

import {
  JupyterFrontEnd,
  JupyterFrontEndPlugin
} from '@jupyterlab/application';

import type { IKernel } from '@jupyterlite/services';

import { IKernelSpecs } from '@jupyterlite/services';
import { DisposableDelegate } from '@lumino/disposable';
import type { IDisposable } from '@lumino/disposable';

import {
  IJavaScriptKernelStartup,
  JavaScriptKernel
} from '@jupyterlite/javascript-kernel';
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
  startup: IJavaScriptKernelStartup;
}

const registerKernel = (
  kernelspecs: IKernelSpecs,
  options: IRegisterKernelOptions
) => {
  const { name, displayName, runtime, startup } = options;

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
      const kernel = new JavaScriptKernel({
        ...options,
        runtime,
        startupExtensions: startup.startupExtensions
      } as JavaScriptKernel.IOptions);
      startup.trackKernel(kernel);
      return kernel;
    }
  });
};

/**
 * In-memory registry for JavaScript kernel startup extensions.
 */
class JavaScriptKernelStartup implements IJavaScriptKernelStartup {
  get startupExtensions(): readonly JavaScriptKernel.IStartupExtension[] {
    return [...this._startupExtensions];
  }

  registerStartupExtension(
    extension: JavaScriptKernel.IStartupExtension
  ): IDisposable {
    const existing = this._startupExtensions.findIndex(
      item => item.id === extension.id
    );

    if (existing !== -1) {
      throw new Error(
        `JavaScript kernel startup extension "${extension.id}" is already registered`
      );
    }

    this._startupExtensions.push(extension);
    void Promise.all(
      [...this._kernels].map(kernel => kernel.applyStartupExtension(extension))
    ).catch(error => {
      console.error(
        `[javascript-kernel] Failed to apply startup extension "${extension.id}".`,
        error
      );
    });

    return new DisposableDelegate(() => {
      const index = this._startupExtensions.indexOf(extension);
      if (index !== -1) {
        this._startupExtensions.splice(index, 1);
        void Promise.all(
          [...this._kernels].map(kernel =>
            kernel.removeStartupExtension(extension)
          )
        ).catch(error => {
          console.error(
            `[javascript-kernel] Failed to remove startup extension "${extension.id}".`,
            error
          );
        });
      }
    });
  }

  /**
   * Track an active JavaScript kernel for late startup registrations.
   */
  trackKernel(kernel: JavaScriptKernel): void {
    this._kernels.add(kernel);
    void Promise.all(
      this._startupExtensions.map(extension =>
        kernel.applyStartupExtension(extension)
      )
    ).catch(error => {
      console.error(
        '[javascript-kernel] Failed to apply startup extensions.',
        error
      );
    });
    const untrackKernel = (sender: JavaScriptKernel): void => {
      this._kernels.delete(sender);
      sender.disposed.disconnect(untrackKernel);
    };
    kernel.disposed.connect(untrackKernel);
  }

  private _startupExtensions: JavaScriptKernel.IStartupExtension[] = [];
  private _kernels = new Set<JavaScriptKernel>();
}

/**
 * Plugin providing the JavaScript kernel startup extension registry.
 */
const startupExtensions: JupyterFrontEndPlugin<IJavaScriptKernelStartup> = {
  id: '@jupyterlite/javascript-kernel-extension:startup-extensions',
  autoStart: true,
  provides: IJavaScriptKernelStartup,
  activate: () => new JavaScriptKernelStartup()
};

/**
 * Plugin registering the iframe JavaScript kernel.
 */
const kernelIFrame: JupyterFrontEndPlugin<void> = {
  id: '@jupyterlite/javascript-kernel-extension:kernel-iframe',
  autoStart: true,
  requires: [IKernelSpecs, IJavaScriptKernelStartup],
  activate: (
    app: JupyterFrontEnd,
    kernelspecs: IKernelSpecs,
    startup: IJavaScriptKernelStartup
  ) => {
    registerKernel(kernelspecs, {
      name: 'javascript',
      displayName: 'JavaScript (IFrame)',
      runtime: 'iframe',
      startup
    });
  }
};

/**
 * Plugin registering the worker JavaScript kernel.
 */
const kernelWorker: JupyterFrontEndPlugin<void> = {
  id: '@jupyterlite/javascript-kernel-extension:kernel-worker',
  autoStart: true,
  requires: [IKernelSpecs, IJavaScriptKernelStartup],
  activate: (
    app: JupyterFrontEnd,
    kernelspecs: IKernelSpecs,
    startup: IJavaScriptKernelStartup
  ) => {
    registerKernel(kernelspecs, {
      name: 'javascript-worker',
      displayName: 'JavaScript (Web Worker)',
      runtime: 'worker',
      startup
    });
  }
};

const plugins: Array<
  JupyterFrontEndPlugin<IJavaScriptKernelStartup> | JupyterFrontEndPlugin<void>
> = [startupExtensions, kernelIFrame, kernelWorker];

export default plugins;
