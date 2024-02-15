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
