# jupyterlite-javascript-kernel

[![Github Actions Status](https://github.com/jupyterlite/javascript-kernel/workflows/Build/badge.svg)](https://github.com/jupyterlite/javascript-kernel/actions/workflows/build.yml)
[![lite-badge](https://jupyterlite.rtfd.io/en/latest/_static/badge.svg)](https://jupyterlite.github.io/javascript-kernel/lab/index.html)

A JavaScript kernel for JupyterLite.

![a screenshot showing a notebook with the JavaScript kernel in JupyterLite](https://github.com/jupyterlite/javascript-kernel/assets/591645/c9085a6e-452e-4f77-8553-36133ee32389)

## Requirements

- JupyterLite >=0.3.0

This kernel was originally maintained as part of the main JupyterLite repository, and was moved to its own repository for the JupyterLite 0.3.0 release.

## Install

To install the extension, execute:

```bash
pip install jupyterlite-javascript-kernel
```

## Uninstall

To remove the extension, execute:

```bash
pip uninstall jupyterlite-javascript-kernel
```

## Runtime modes

The extension currently registers two JavaScript kernelspecs:

- `JavaScript (IFrame)`:
  Runs code in a hidden runtime `iframe` on the main page thread. Use this when your code needs browser DOM APIs like `document`, `window`, or canvas access through the page context.
- `JavaScript (Web Worker)`:
  Runs code in a dedicated Web Worker. Use this for stronger isolation and to avoid blocking the main UI thread.

Pick either kernel from the notebook kernel selector in JupyterLite.

### Worker mode limitations

Web Workers do not expose DOM APIs. In `JavaScript (Web Worker)`, APIs such as `document`, direct element access, and other main-thread-only browser APIs are unavailable.

### Import side effects in iframe mode

In `JavaScript (IFrame)`, user code and imports execute in the runtime iframe scope.

By default, module-level side effects stay in the runtime iframe. To intentionally affect the main page (`window.parent`), access it directly.

Cell declarations like `var`, `let`, `const`, `function`, and `class` remain in the runtime scope. Host-page mutations happen when your code (or imported code) explicitly reaches `window.parent`.

#### Example: canvas-confetti

```javascript
import confetti from 'canvas-confetti';

const canvas = window.parent.document.createElement('canvas');
Object.assign(canvas.style, {
  position: 'fixed',
  inset: '0',
  width: '100%',
  height: '100%',
  pointerEvents: 'none',
  zIndex: '2147483647'
});
window.parent.document.body.appendChild(canvas);

const fire = confetti.create(canvas, { resize: true, useWorker: true });

fire({ particleCount: 20, spread: 70 });
```

#### Example: p5.js

```javascript
import p5 from 'p5';

const mount = window.parent.document.createElement('div');
Object.assign(mount.style, {
  position: 'fixed',
  right: '16px',
  bottom: '16px',
  zIndex: '1000'
});
window.parent.document.body.appendChild(mount);

const sketch = new p5(p => {
  p.setup = () => {
    p.createCanvas(120, 80);
    p.noLoop();
  };
}, mount);
```

#### Can side effects be auto-detected and cleaned up?

Partially, yes, but not perfectly. This project currently does not provide automatic side-effect cleanup for host-page mutations.

Limits of automatic cleanup:

- It will not reliably undo monkey-patched globals.
- It will not automatically remove all event listeners or timers.
- It cannot safely revert all stateful third-party module internals.

### Enable or disable specific modes

The two runtime modes are registered by separate plugins:

- `@jupyterlite/javascript-kernel-extension:kernel-iframe`
- `@jupyterlite/javascript-kernel-extension:kernel-worker`

You can disable either one using `disabledExtensions` in `jupyter-config-data`.

Disable worker mode:

```json
{
  "jupyter-config-data": {
    "disabledExtensions": [
      "@jupyterlite/javascript-kernel-extension:kernel-worker"
    ]
  }
}
```

Disable iframe mode:

```json
{
  "jupyter-config-data": {
    "disabledExtensions": [
      "@jupyterlite/javascript-kernel-extension:kernel-iframe"
    ]
  }
}
```

## Contributing

### Development install

Note: You will need NodeJS to build the extension package.

The `jlpm` command is JupyterLab's pinned version of
[yarn](https://yarnpkg.com/) that is installed with JupyterLab. You may use
`yarn` or `npm` in lieu of `jlpm` below.

```bash
# Clone the repo to your local environment
# Change directory to the jupyterlite-javascript-kernel directory
# Install package in development mode
pip install -e "."
# Link your development version of the extension with JupyterLab
jupyter labextension develop . --overwrite
# Rebuild extension Typescript source after making changes
jlpm build
```

You can watch the source directory and run JupyterLab at the same time in different terminals to watch for changes in the extension's source and automatically rebuild the extension.

```bash
# Watch the source directory in one terminal, automatically rebuilding when needed
jlpm watch
# Run JupyterLab in another terminal
jupyter lab
```

With the watch command running, every saved change will immediately be built locally and available in your running JupyterLab. Refresh JupyterLab to load the change in your browser (you may need to wait several seconds for the extension to be rebuilt).

By default, the `jlpm build` command generates the source maps for this extension to make it easier to debug using the browser dev tools. To also generate source maps for the JupyterLab core extensions, you can run the following command:

```bash
jupyter lab build --minimize=False
```

### Development uninstall

```bash
pip uninstall jupyterlite-javascript-kernel
```

In development mode, you will also need to remove the symlink created by `jupyter labextension develop`
command. To find its location, you can run `jupyter labextension list` to figure out where the `labextensions`
folder is located. Then you can remove the symlink named `@jupyterlite/javascript-kernel` within that folder.

### Packaging the extension

See [RELEASE](RELEASE.md)
