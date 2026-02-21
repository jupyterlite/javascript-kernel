// Copyright (c) Jupyter Development Team.
// Distributed under the terms of the Modified BSD License.

import * as Comlink from 'comlink';

import { createRemoteRuntimeApi } from './runtime_remote';

const runtimeGlobal = self as unknown as Record<string, any>;

Comlink.expose(createRemoteRuntimeApi(runtimeGlobal));
