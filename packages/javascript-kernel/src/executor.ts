// Copyright (c) Jupyter Development Team.
// Distributed under the terms of the Modified BSD License.

import type { KernelMessage } from '@jupyterlab/services';

import { parseScript } from 'meriyah';
import { generate } from 'astring';

import type { IMimeBundle } from '@jupyterlab/nbformat';

export { IDisplayData, IDisplayCallbacks, DisplayHelper } from './display';

/** Matches the word "eval" in a stack frame (user eval code). */
const RE_EVAL = /\beval\b/;

/**
 * Configuration for magic imports.
 */
export interface IMagicImportsConfig {
  enabled: boolean;
  baseUrl: string;
  enableAutoNpm: boolean;
}

/**
 * Result of making code async.
 */
export interface IAsyncCodeResult {
  asyncFunction: () => Promise<any>;
  withReturn: boolean;
}

/**
 * Information about an extracted import.
 */
export interface IImportInfo {
  /** The original import source (e.g., 'canvas-confetti') */
  source: string;
  /** The transformed URL (e.g., 'https://cdn.jsdelivr.net/npm/canvas-confetti/+esm') */
  url: string;
  /** The local variable name for default import */
  defaultImport?: string;
  /** The local variable name for namespace import */
  namespaceImport?: string;
  /** Named imports: { importedName: localName } */
  namedImports: Record<string, string>;
}

type JSCallable = (...args: any[]) => any;

/**
 * Result of code completion.
 */
export interface ICompletionResult {
  matches: string[];
  cursorStart: number;
  cursorEnd?: number;
  status?: string;
}

/**
 * Result of code completeness check.
 */
export type IIsCompleteResult =
  | KernelMessage.IIsCompleteReplyIncomplete
  | KernelMessage.IIsCompleteReplyOther;

/**
 * Result of code inspection.
 */
export type IInspectResult = KernelMessage.IInspectReply;

/**
 * Registry for tracking code declarations across cells.
 * Allows deduplication - later definitions override earlier ones.
 */
export interface ICodeRegistry {
  /** Function declarations by name (setup, draw, etc.) */
  functions: Map<string, any>;
  /** Variable declarations by name */
  variables: Map<string, any>;
  /** Class declarations by name */
  classes: Map<string, any>;
  /** Other top-level statements (expressions, etc.) in execution order */
  statements: any[];
}

/**
 * Configuration for the JavaScript executor.
 */
export class ExecutorConfig {
  /**
   * Get the magic imports configuration.
   */
  get magicImports(): IMagicImportsConfig {
    return this._magicImports;
  }

  /**
   * Set the magic imports configuration.
   */
  set magicImports(value: IMagicImportsConfig) {
    this._magicImports = value;
  }

  private _magicImports: IMagicImportsConfig = {
    enabled: true,
    baseUrl: 'https://cdn.jsdelivr.net/',
    enableAutoNpm: true
  };
}

/**
 * JavaScript code executor with advanced features.
 */
export class JavaScriptExecutor {
  /**
   * Instantiate a new JavaScriptExecutor.
   *
   * @param globalScope - The global scope (globalThis) for code execution.
   * @param config - Optional executor configuration.
   */
  constructor(globalScope: Record<string, any>, config?: ExecutorConfig) {
    this._globalScope = globalScope;
    this._config = config || new ExecutorConfig();
  }

  /**
   * Convert user code to an async function.
   *
   * @param code - The user code to convert.
   * @returns The async function and whether it has a return value.
   */
  makeAsyncFromCode(code: string): IAsyncCodeResult {
    if (code.length === 0) {
      return {
        asyncFunction: async () => {},
        withReturn: false
      };
    }

    const ast = parseScript(code, {
      ranges: true,
      module: true
    });

    // Add top-level variables to global scope
    let codeAddToGlobalScope = this._addToGlobalScope(ast);

    // Handle last statement / add return if needed
    const { withReturn, modifiedUserCode, extraReturnCode } =
      this._handleLastStatement(code, ast);
    let finalCode = modifiedUserCode;

    // Handle import statements
    const importResult = this._rewriteImportStatements(finalCode, ast);
    finalCode = importResult.modifiedUserCode;
    codeAddToGlobalScope += importResult.codeAddToGlobalScope;

    const combinedCode = `
      ${finalCode}
      ${codeAddToGlobalScope}
      ${extraReturnCode}
    `;

    const asyncFunctionFactory = this._createScopedFunction(`
      return async function() {
        ${combinedCode}
      };
    `) as () => () => Promise<any>;
    const asyncFunction = asyncFunctionFactory.call(this._globalScope);

    return {
      asyncFunction,
      withReturn
    };
  }

  /**
   * Extract import information from code without executing it.
   * Used to track imports for sketch generation.
   *
   * @param code - The code to analyze for imports.
   * @returns Array of import information objects.
   */
  extractImports(code: string): IImportInfo[] {
    if (code.length === 0) {
      return [];
    }

    try {
      const ast = parseScript(code, {
        ranges: true,
        module: true
      });

      const imports: IImportInfo[] = [];

      for (const node of ast.body) {
        if (node.type === 'ImportDeclaration') {
          const source = String(node.source.value);
          const url = this._transformImportSource(source);

          const importInfo: IImportInfo = {
            source,
            url,
            namedImports: {}
          };

          for (const specifier of node.specifiers) {
            if (specifier.type === 'ImportDefaultSpecifier') {
              importInfo.defaultImport = specifier.local.name;
            } else if (specifier.type === 'ImportNamespaceSpecifier') {
              importInfo.namespaceImport = specifier.local.name;
            } else if (specifier.type === 'ImportSpecifier') {
              if (specifier.imported.name === 'default') {
                importInfo.defaultImport = specifier.local.name;
              } else {
                importInfo.namedImports[specifier.imported.name] =
                  specifier.local.name;
              }
            }
          }

          imports.push(importInfo);
        }
      }

      return imports;
    } catch {
      return [];
    }
  }

  /**
   * Generate async JavaScript code to load imports and assign them to globalThis.
   * This is used when generating the sketch iframe.
   *
   * @param imports - The import information objects.
   * @returns Generated JavaScript code string.
   */
  generateImportCode(imports: IImportInfo[]): string {
    if (imports.length === 0) {
      return '';
    }

    const lines: string[] = [];

    for (const imp of imports) {
      const importCall = `import(${JSON.stringify(imp.url)})`;

      if (imp.defaultImport) {
        lines.push(
          `const { default: ${imp.defaultImport} } = await ${importCall};`
        );
        lines.push(
          `globalThis["${imp.defaultImport}"] = ${imp.defaultImport};`
        );
      }

      if (imp.namespaceImport) {
        lines.push(`const ${imp.namespaceImport} = await ${importCall};`);
        lines.push(
          `globalThis["${imp.namespaceImport}"] = ${imp.namespaceImport};`
        );
      }

      const namedKeys = Object.keys(imp.namedImports);
      if (namedKeys.length > 0) {
        const destructure = namedKeys
          .map(k =>
            k === imp.namedImports[k] ? k : `${k}: ${imp.namedImports[k]}`
          )
          .join(', ');
        lines.push(`const { ${destructure} } = await ${importCall};`);
        for (const importedName of namedKeys) {
          const localName = imp.namedImports[importedName];
          lines.push(`globalThis["${localName}"] = ${localName};`);
        }
      }

      // Side-effect only import (no specifiers)
      if (
        !imp.defaultImport &&
        !imp.namespaceImport &&
        Object.keys(imp.namedImports).length === 0
      ) {
        lines.push(`await ${importCall};`);
      }
    }

    return lines.join('\n');
  }

  /**
   * Create a new empty code registry.
   */
  createCodeRegistry(): ICodeRegistry {
    return {
      functions: new Map(),
      variables: new Map(),
      classes: new Map(),
      statements: []
    };
  }

  /**
   * Register code from executed cells into the registry.
   * Later definitions of the same name will override earlier ones.
   * Import declarations are skipped (handled separately).
   *
   * @param code - The code to register.
   * @param registry - The registry to add declarations to.
   */
  registerCode(code: string, registry: ICodeRegistry): void {
    if (code.trim().length === 0) {
      return;
    }

    try {
      const ast = parseScript(code, {
        ranges: true,
        module: true
      });

      for (const node of ast.body) {
        switch (node.type) {
          case 'FunctionDeclaration':
            // Store function by name - later definitions override
            if (node.id && node.id.name) {
              registry.functions.set(node.id.name, node);
            }
            break;

          case 'ClassDeclaration':
            // Store class by name - later definitions override
            if (node.id && node.id.name) {
              registry.classes.set(node.id.name, node);
            }
            break;

          case 'VariableDeclaration':
            // For variable declarations, extract each declarator
            for (const declarator of node.declarations) {
              if (declarator.id.type === 'Identifier') {
                // Store the whole declaration node with just this declarator
                const singleDecl = {
                  ...node,
                  declarations: [declarator]
                };
                registry.variables.set(declarator.id.name, singleDecl);
              } else if (declarator.id.type === 'ObjectPattern') {
                // Handle destructuring: const { a, b } = obj
                for (const prop of declarator.id.properties) {
                  if (
                    prop.type === 'Property' &&
                    prop.key.type === 'Identifier'
                  ) {
                    const name =
                      prop.value?.type === 'Identifier'
                        ? prop.value.name
                        : prop.key.name;
                    registry.variables.set(name, {
                      ...node,
                      declarations: [declarator],
                      _destructuredName: name
                    });
                  }
                }
              } else if (declarator.id.type === 'ArrayPattern') {
                // Handle array destructuring: const [a, b] = arr
                for (const element of declarator.id.elements) {
                  if (element && element.type === 'Identifier') {
                    registry.variables.set(element.name, {
                      ...node,
                      declarations: [declarator],
                      _destructuredName: element.name
                    });
                  }
                }
              }
            }
            break;

          case 'ImportDeclaration':
            // Skip imports - handled separately via extractImports
            break;

          case 'ExpressionStatement':
            registry.statements.push(node);
            break;

          default:
            // Other statements (if, for, while, etc.) - keep in order
            registry.statements.push(node);
            break;
        }
      }
    } catch {
      // If parsing fails, we can't register the code
    }
  }

  /**
   * Generate code from the registry.
   * Produces clean, deduplicated code for regeneration scenarios.
   * Includes globalThis assignments so declarations are accessible globally.
   *
   * @param registry - The registry to generate code from.
   * @returns Generated JavaScript code string.
   */
  generateCodeFromRegistry(registry: ICodeRegistry): string {
    const programBody: any[] = [];
    const globalAssignments: string[] = [];

    // Add variables first (they might be used by functions)
    const seenDestructuringDecls = new Set<string>();
    for (const [name, node] of registry.variables) {
      // For destructuring, only add once per actual declaration
      if (node._destructuredName) {
        const declKey = generate(node.declarations[0]);
        if (seenDestructuringDecls.has(declKey)) {
          continue;
        }
        seenDestructuringDecls.add(declKey);
        // Remove the marker before generating
        const cleanNode = { ...node };
        delete cleanNode._destructuredName;
        programBody.push(cleanNode);
      } else {
        programBody.push(node);
      }
      globalAssignments.push(`globalThis["${name}"] = ${name};`);
    }

    // Add classes
    for (const [name, node] of registry.classes) {
      programBody.push(node);
      globalAssignments.push(`globalThis["${name}"] = ${name};`);
    }

    // Add functions
    for (const [name, node] of registry.functions) {
      programBody.push(node);
      globalAssignments.push(`globalThis["${name}"] = ${name};`);
    }

    // Add other statements in order
    for (const node of registry.statements) {
      programBody.push(node);
    }

    // Create a program AST and generate code
    const program = {
      type: 'Program',
      body: programBody,
      sourceType: 'script'
    };

    // Generate the code and append globalThis assignments
    const generatedCode = generate(program);

    if (globalAssignments.length > 0) {
      return generatedCode + '\n' + globalAssignments.join('\n');
    }

    return generatedCode;
  }

  /**
   * Get MIME bundle for a value.
   * Supports custom output methods:
   * - _toHtml() for text/html
   * - _toSvg() for image/svg+xml
   * - _toPng() for image/png (base64)
   * - _toJpeg() for image/jpeg (base64)
   * - _toMime() for custom MIME bundle
   * - inspect() for text/plain (Node.js style)
   *
   * @param value - The value to convert to a MIME bundle.
   * @returns The MIME bundle representation of the value.
   */
  getMimeBundle(value: any): IMimeBundle {
    // Handle null and undefined
    if (value === null) {
      return { 'text/plain': 'null' };
    }
    if (value === undefined) {
      return { 'text/plain': 'undefined' };
    }

    // Check for custom MIME output methods
    if (typeof value === 'object' && value !== null) {
      const customMime = this._getCustomMimeBundle(value);
      if (customMime) {
        return customMime;
      }
    }

    // Handle primitives
    if (typeof value === 'string') {
      // Check if it looks like HTML (must start with a valid tag: <div>, <p class="...">,
      // <!DOCTYPE>, <!-- -->, <br/>, etc.). Rejects non-HTML like "<a, b>".
      const trimmed = value.trim();
      if (
        /^<(?:[a-zA-Z][a-zA-Z0-9-]*[\s/>]|!(?:DOCTYPE|--))/.test(trimmed) &&
        trimmed.endsWith('>')
      ) {
        return {
          'text/html': value,
          'text/plain': value
        };
      }
      return { 'text/plain': `'${value}'` };
    }
    if (typeof value === 'number' || typeof value === 'boolean') {
      return { 'text/plain': String(value) };
    }

    // Handle Symbol
    if (typeof value === 'symbol') {
      return { 'text/plain': value.toString() };
    }

    // Handle BigInt
    if (typeof value === 'bigint') {
      return { 'text/plain': `${value.toString()}n` };
    }

    // Handle functions
    if (typeof value === 'function') {
      const funcString = value.toString();
      const name = value.name || 'anonymous';
      return {
        'text/plain': `[Function: ${name}]`,
        'text/html': `<pre style="margin:0"><code>${this._escapeHtml(funcString)}</code></pre>`
      };
    }

    // Handle Error objects
    if (this._isInstanceOfRealm(value, 'Error')) {
      const errorValue = value as Error;
      return {
        'text/plain': errorValue.stack || errorValue.toString(),
        'application/json': {
          name: errorValue.name,
          message: errorValue.message,
          stack: errorValue.stack
        }
      };
    }

    // Handle Date objects
    if (this._isInstanceOfRealm(value, 'Date')) {
      const dateValue = value as Date;
      return {
        'text/plain': dateValue.toISOString(),
        'application/json': dateValue.toISOString()
      };
    }

    // Handle RegExp objects
    if (this._isInstanceOfRealm(value, 'RegExp')) {
      return { 'text/plain': (value as RegExp).toString() };
    }

    // Handle Map
    if (this._isInstanceOfRealm(value, 'Map')) {
      const mapValue = value as Map<any, any>;
      const entries = Array.from(mapValue.entries());
      try {
        return {
          'text/plain': `Map(${mapValue.size}) { ${entries.map(([k, v]) => `${String(k)} => ${String(v)}`).join(', ')} }`,
          'application/json': Object.fromEntries(entries)
        };
      } catch {
        return { 'text/plain': `Map(${mapValue.size})` };
      }
    }

    // Handle Set
    if (this._isInstanceOfRealm(value, 'Set')) {
      const setValue = value as Set<any>;
      const items = Array.from(setValue);
      try {
        return {
          'text/plain': `Set(${setValue.size}) { ${items.map(v => String(v)).join(', ')} }`,
          'application/json': items
        };
      } catch {
        return { 'text/plain': `Set(${setValue.size})` };
      }
    }

    // Handle DOM elements (Canvas, HTMLElement, etc.)
    if (this._isDOMElement(value)) {
      return this._getDOMElementMimeBundle(value);
    }

    // Handle arrays
    if (Array.isArray(value)) {
      try {
        const preview = this._formatArrayPreview(value);
        return {
          'application/json': value,
          'text/plain': preview
        };
      } catch {
        return { 'text/plain': `Array(${value.length})` };
      }
    }

    // Handle typed arrays
    if (ArrayBuffer.isView(value)) {
      const typedArray = value as unknown as { length: number };
      return {
        'text/plain': `${value.constructor.name}(${typedArray.length})`
      };
    }

    // Handle Promise (show as pending)
    if (this._isInstanceOfRealm(value, 'Promise')) {
      return { 'text/plain': 'Promise { <pending> }' };
    }

    // Handle generic objects
    if (typeof value === 'object') {
      // Check if it's already a mime bundle (has data with MIME-type keys)
      if (value.data && typeof value.data === 'object') {
        const dataKeys = Object.keys(value.data);
        const hasMimeKeys = dataKeys.some(key => key.includes('/'));
        if (hasMimeKeys) {
          return value.data;
        }
      }

      try {
        const preview = this._formatObjectPreview(value);
        return {
          'application/json': value,
          'text/plain': preview
        };
      } catch {
        // Object might have circular references or be non-serializable
        return { 'text/plain': this._formatNonSerializableObject(value) };
      }
    }

    // Fallback
    return { 'text/plain': String(value) };
  }

  /**
   * Complete code at cursor position.
   *
   * @param codeLine - The line of code to complete.
   * @param globalScope - The global scope for variable lookup.
   * @returns The completion result with matches and cursor position.
   */
  completeLine(
    codeLine: string,
    globalScope: any = this._globalScope
  ): ICompletionResult {
    // Remove unwanted left part
    const stopChars = ' {}()=+-*/%&|^~<>,:;!?@#';
    let codeBegin = 0;
    for (let i = codeLine.length - 1; i >= 0; i--) {
      if (stopChars.includes(codeLine[i])) {
        codeBegin = i + 1;
        break;
      }
    }

    const pseudoExpression = codeLine.substring(codeBegin);

    // Find part right of dot/bracket
    const expStopChars = '.]';
    let splitPos = pseudoExpression.length;
    let found = false;

    for (let i = splitPos - 1; i >= 0; i--) {
      if (expStopChars.includes(pseudoExpression[i])) {
        splitPos = i;
        found = true;
        break;
      }
    }

    let rootObjectStr = '';
    let toMatch = pseudoExpression;
    let cursorStart = codeBegin;

    if (found) {
      rootObjectStr = pseudoExpression.substring(0, splitPos);
      toMatch = pseudoExpression.substring(splitPos + 1);
      cursorStart += splitPos + 1;
    }

    // Find root object
    let rootObject = globalScope;
    if (rootObjectStr !== '') {
      try {
        const evalFunc = this._createScopedFunction(
          'scope',
          `with(scope) { return ${rootObjectStr}; }`
        ) as (scope: any) => any;
        rootObject = evalFunc(globalScope);
      } catch {
        return {
          matches: [],
          cursorStart,
          status: 'error'
        };
      }
    }

    // Collect all properties including from prototype chain
    const matches = this._getAllProperties(rootObject, toMatch);

    return {
      matches,
      cursorStart
    };
  }

  /**
   * Complete request with multi-line support.
   *
   * @param code - The full code content.
   * @param cursorPos - The cursor position in the code.
   * @returns The completion result with matches and cursor positions.
   */
  completeRequest(code: string, cursorPos: number): ICompletionResult {
    const lines = code.split('\n');

    // Find line the cursor is on
    let lineIndex = 0;
    let cursorPosInLine = 0;
    let lineBegin = 0;

    for (let i = 0; i < lines.length; i++) {
      if (cursorPos >= lineBegin && cursorPos <= lineBegin + lines[i].length) {
        lineIndex = i;
        cursorPosInLine = cursorPos - lineBegin;
        break;
      }
      lineBegin += lines[i].length + 1; // +1 for \n
    }

    const codeLine = lines[lineIndex];

    const codePrefix = codeLine.slice(0, cursorPosInLine);
    const lineRes = this.completeLine(codePrefix);
    const matches = lineRes.matches;
    const inLineCursorStart = lineRes.cursorStart;
    const tail = codeLine.slice(cursorPosInLine);
    const cursorTail = tail.match(/^[\w$]*/)?.[0] ?? '';

    return {
      matches,
      cursorStart: lineBegin + inLineCursorStart,
      cursorEnd: cursorPos + cursorTail.length,
      status: lineRes.status || 'ok'
    };
  }

  /**
   * Clean stack trace to remove internal frames.
   *
   * @param error - The error with stack trace to clean.
   * @returns The cleaned stack trace string.
   */
  cleanStackTrace(error: Error): string {
    const header = `${error.name}: ${error.message}`;
    const stack = error.stack || '';
    const lines = stack.split('\n');
    const userFrames: string[] = [];

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) {
        continue;
      }

      // Some browsers repeat `Name: message` as the first stack line.
      if (trimmed.startsWith(`${error.name}:`)) {
        continue;
      }

      // Stop once we reach internal executor frames.
      if (
        trimmed.includes('makeAsyncFromCode') ||
        trimmed.includes('new Function') ||
        trimmed.includes('asyncFunction')
      ) {
        break;
      }

      // Only keep lines that reference user eval code.
      if (RE_EVAL.test(trimmed) || trimmed.includes('<anonymous>')) {
        userFrames.push(line);
      }
    }

    if (userFrames.length > 0) {
      return `${header}\n${userFrames.join('\n')}`;
    }

    return header;
  }

  /**
   * Check if code is syntactically complete.
   * Used for multi-line input in console-style interfaces.
   *
   * @param code - The code to check.
   * @returns The completeness status and suggested indentation.
   */
  isComplete(code: string): IIsCompleteResult {
    if (code.trim().length === 0) {
      return { status: 'complete' };
    }

    try {
      parseScript(code, {
        ranges: true,
        module: true
      });
      return { status: 'complete' };
    } catch (e: any) {
      const message = e.message || '';

      // Common patterns indicating incomplete code
      const incompletePatterns = [
        /unexpected end of input/i,
        /unterminated string/i,
        /unterminated template/i,
        /unexpected token.*eof/i,
        /expected.*but.*end/i
      ];

      for (const pattern of incompletePatterns) {
        if (pattern.test(message)) {
          // Determine indentation for next line
          const lines = code.split('\n');
          const lastLine = lines[lines.length - 1];
          const currentIndent = lastLine.match(/^(\s*)/)?.[1] || '';

          // Add more indent if we're opening a block
          const opensBlock = /[{([]$/.test(lastLine.trim());
          const indent = opensBlock ? currentIndent + '  ' : currentIndent;

          return { status: 'incomplete', indent };
        }
      }

      // Syntax error that's not about incompleteness
      return { status: 'invalid' };
    }
  }

  /**
   * Inspect an object at the cursor position.
   * Returns documentation/type information for tooltips.
   *
   * @param code - The code containing the expression to inspect.
   * @param cursorPos - The cursor position in the code.
   * @param detailLevel - The level of detail (0 for basic, higher for more).
   * @returns The inspection result with documentation data.
   */
  inspect(
    code: string,
    cursorPos: number,
    detailLevel: KernelMessage.IInspectRequestMsg['content']['detail_level'] = 0
  ): IInspectResult {
    // Extract the word/expression at cursor position
    const expression = this._extractExpressionAtCursor(code, cursorPos);

    if (!expression) {
      return {
        status: 'ok',
        found: false,
        data: {},
        metadata: {}
      };
    }

    try {
      // Try to evaluate the expression in the global scope
      const evalFunc = this._createScopedFunction(
        'scope',
        `with(scope) { return ${expression}; }`
      ) as (scope: any) => any;
      const value = evalFunc(this._globalScope);

      // Build inspection data
      const inspectionData = this._buildInspectionData(
        expression,
        value,
        detailLevel
      );

      // Add predefined documentation if available
      const doc = this.getBuiltinDocumentation(expression);
      if (doc) {
        const mdContent = inspectionData['text/markdown'] || '';
        inspectionData['text/markdown'] = mdContent + `\n\n---\n\n${doc}`;
        const plainContent = inspectionData['text/plain'] || '';
        inspectionData['text/plain'] = plainContent + `\n\nDoc: ${doc}`;
      }

      return {
        status: 'ok',
        found: true,
        data: inspectionData,
        metadata: {}
      };
    } catch {
      // Try to provide info even if we can't evaluate
      return this.inspectBuiltin(expression, detailLevel);
    }
  }

  /**
   * Provide inspection info for built-in objects.
   * First tries runtime lookup, then falls back to predefined docs.
   *
   * @param expression - The expression to look up.
   * @param detailLevel - The level of detail requested.
   * @returns The inspection result.
   */
  protected inspectBuiltin(
    expression: string,
    detailLevel: number
  ): IInspectResult {
    // First, try to find the expression in the global scope at runtime
    const runtimeResult = this._inspectAtRuntime(expression, detailLevel);
    if (runtimeResult.found) {
      return runtimeResult;
    }

    // Fall back to predefined documentation
    const doc = this.getBuiltinDocumentation(expression);
    if (doc) {
      return {
        status: 'ok',
        found: true,
        data: {
          'text/plain': `${expression}: ${doc}`,
          'text/markdown': `**${expression}**\n\n${doc}`
        },
        metadata: {}
      };
    }

    // Try to find similar names in global scope for suggestions
    const suggestions = this._findSimilarNames(expression);
    if (suggestions.length > 0) {
      return {
        status: 'ok',
        found: true,
        data: {
          'text/plain': `'${expression}' not found. Did you mean: ${suggestions.join(', ')}?`,
          'text/markdown': `\`${expression}\` not found.\n\n**Did you mean:**\n${suggestions.map(s => `- \`${s}\``).join('\n')}`
        },
        metadata: {}
      };
    }

    return {
      status: 'ok',
      found: false,
      data: {},
      metadata: {}
    };
  }

  /**
   * Get predefined documentation for built-in JavaScript objects.
   * Subclasses can override this to add domain-specific documentation.
   *
   * @param expression - The expression to get documentation for.
   * @returns The documentation string, or null if not found.
   */
  protected getBuiltinDocumentation(expression: string): string | null {
    // Common JavaScript built-ins documentation
    const builtins: Record<string, string> = {
      console:
        'The console object provides access to the browser debugging console.',
      Math: 'The Math object provides mathematical constants and functions.',
      JSON: 'The JSON object provides methods for parsing and stringifying JSON.',
      Array:
        'The Array object is used to store multiple values in a single variable.',
      Object: "The Object class represents one of JavaScript's data types.",
      String:
        'The String object is used to represent and manipulate a sequence of characters.',
      Number: 'The Number object is a wrapper object for numeric values.',
      Date: 'The Date object represents a single moment in time.',
      Promise:
        'The Promise object represents the eventual completion of an async operation.',
      Map: 'The Map object holds key-value pairs and remembers the original insertion order.',
      Set: 'The Set object lets you store unique values of any type.'
    };

    return builtins[expression] ?? null;
  }

  /**
   * Add code to export top-level variables to global scope.
   */
  private _addToGlobalThisCode(key: string, identifier = key): string {
    // Keep declarations on both globalThis and this for compatibility with
    // different runtime invocation paths.
    return `globalThis["${key}"] = this["${key}"] = ${identifier};`;
  }

  /**
   * Create a function using the runtime realm's Function constructor.
   */
  private _createScopedFunction(...args: string[]): JSCallable {
    const scopeFunction = this._globalScope.Function;
    const functionConstructor =
      typeof scopeFunction === 'function'
        ? (scopeFunction as FunctionConstructor)
        : Function;
    return functionConstructor(...args) as JSCallable;
  }

  /**
   * Replace a section of code with new code.
   */
  private _replaceCode(
    code: string,
    start: number,
    end: number,
    newCode: string
  ): string {
    return code.substring(0, start) + newCode + code.substring(end);
  }

  /**
   * Add top-level variables to global scope.
   */
  private _addToGlobalScope(ast: any): string {
    const extraCode: string[] = [];

    for (const node of ast.body) {
      if (node.type === 'FunctionDeclaration') {
        const name = node.id.name;
        extraCode.push(this._addToGlobalThisCode(name));
      } else if (node.type === 'ClassDeclaration') {
        const name = node.id.name;
        extraCode.push(this._addToGlobalThisCode(name));
      } else if (node.type === 'VariableDeclaration') {
        const declarations = node.declarations;

        for (const declaration of declarations) {
          const identifiers: string[] = [];
          this._collectDeclaredIdentifiers(declaration.id, identifiers);
          for (const name of identifiers) {
            extraCode.push(this._addToGlobalThisCode(name));
          }
        }
      }
    }

    return extraCode.join('\n');
  }

  /**
   * Collect identifiers from a declaration pattern.
   */
  private _collectDeclaredIdentifiers(
    pattern: any,
    identifiers: string[]
  ): void {
    if (!pattern) {
      return;
    }

    switch (pattern.type) {
      case 'Identifier':
        identifiers.push(pattern.name);
        break;
      case 'ObjectPattern':
        for (const prop of pattern.properties) {
          if (prop.type === 'Property') {
            this._collectDeclaredIdentifiers(prop.value, identifiers);
          } else if (prop.type === 'RestElement') {
            this._collectDeclaredIdentifiers(prop.argument, identifiers);
          }
        }
        break;
      case 'ArrayPattern':
        for (const element of pattern.elements) {
          this._collectDeclaredIdentifiers(element, identifiers);
        }
        break;
      case 'AssignmentPattern':
        this._collectDeclaredIdentifiers(pattern.left, identifiers);
        break;
      case 'RestElement':
        this._collectDeclaredIdentifiers(pattern.argument, identifiers);
        break;
      default:
        break;
    }
  }

  /**
   * Handle the last statement to auto-return if it's an expression.
   */
  private _handleLastStatement(
    code: string,
    ast: any
  ): {
    withReturn: boolean;
    modifiedUserCode: string;
    extraReturnCode: string;
  } {
    if (ast.body.length === 0) {
      return {
        withReturn: false,
        modifiedUserCode: code,
        extraReturnCode: ''
      };
    }

    const lastNode = ast.body[ast.body.length - 1];

    // If the last node is an expression statement (and not an assignment)
    if (
      lastNode.type === 'ExpressionStatement' &&
      lastNode.expression.type !== 'AssignmentExpression'
    ) {
      const lastNodeExprStart = lastNode.expression.start;
      const lastNodeExprEnd = lastNode.expression.end;
      const lastNodeRestEnd = lastNode.end;

      // Check for semicolon after the expression
      let semicolonFound = false;
      for (let i = lastNodeExprEnd; i < lastNodeRestEnd; i++) {
        if (code[i] === ';') {
          semicolonFound = true;
          break;
        }
      }

      if (!semicolonFound) {
        // Remove the last node from the code
        const modifiedUserCode =
          code.substring(0, lastNodeExprStart) +
          code.substring(lastNodeExprEnd);
        const codeOfLastNode = code.substring(
          lastNodeExprStart,
          lastNodeExprEnd
        );
        const extraReturnCode = `return ${codeOfLastNode};`;

        return {
          withReturn: true,
          modifiedUserCode,
          extraReturnCode
        };
      }
    }

    return {
      withReturn: false,
      modifiedUserCode: code,
      extraReturnCode: ''
    };
  }

  /**
   * Transform import source with magic imports.
   */
  private _transformImportSource(source: string): string {
    if (!this._config.magicImports.enabled) {
      return source;
    }

    // Keep absolute, relative and import-map style specifiers unchanged.
    if (this._isDirectImportSource(source)) {
      return source;
    }

    const { path: sourcePath, suffix } = this._splitImportSourceSuffix(source);

    const transformedPath =
      ['npm/', 'gh/'].some(start => sourcePath.startsWith(start)) ||
      !this._config.magicImports.enableAutoNpm
        ? sourcePath
        : `npm/${sourcePath}`;

    let transformedSource = `${this._joinBaseAndPath(
      this._config.magicImports.baseUrl,
      transformedPath
    )}${suffix}`;

    if (this._shouldAppendEsmSuffix(sourcePath)) {
      transformedSource = this._appendEsmSuffix(transformedSource);
    }

    return transformedSource;
  }

  /**
   * Whether an import source should bypass magic import transformation.
   */
  private _isDirectImportSource(source: string): boolean {
    return (
      /^(?:[a-zA-Z][a-zA-Z\d+.-]*:|\/\/)/.test(source) ||
      source.startsWith('./') ||
      source.startsWith('../') ||
      source.startsWith('/') ||
      source.startsWith('#')
    );
  }

  /**
   * Whether a transformed import should include the jsDelivr `+esm` suffix.
   */
  private _shouldAppendEsmSuffix(sourcePath: string): boolean {
    const noEsmEnds = ['.js', '.mjs', '.cjs', '.wasm', '+esm'];
    return !noEsmEnds.some(end => sourcePath.endsWith(end));
  }

  /**
   * Append `+esm` before query/hash suffixes.
   */
  private _appendEsmSuffix(source: string): string {
    const { path, suffix } = this._splitImportSourceSuffix(source);
    const esmSuffix = path.endsWith('/') ? '+esm' : '/+esm';
    return `${path}${esmSuffix}${suffix}`;
  }

  /**
   * Split an import source into path and query/hash suffix.
   */
  private _splitImportSourceSuffix(source: string): {
    path: string;
    suffix: string;
  } {
    const queryIndex = source.indexOf('?');
    const hashIndex = source.indexOf('#');
    const splitIndex =
      queryIndex === -1
        ? hashIndex
        : hashIndex === -1
          ? queryIndex
          : Math.min(queryIndex, hashIndex);

    if (splitIndex === -1) {
      return { path: source, suffix: '' };
    }

    return {
      path: source.slice(0, splitIndex),
      suffix: source.slice(splitIndex)
    };
  }

  /**
   * Join a base URL and import path while preserving origin semantics.
   */
  private _joinBaseAndPath(baseUrl: string, path: string): string {
    const normalizedBase = baseUrl.endsWith('/') ? baseUrl : `${baseUrl}/`;
    const normalizedPath = path.replace(/^\/+/, '');

    try {
      return new URL(normalizedPath, normalizedBase).toString();
    } catch {
      return `${normalizedBase}${normalizedPath}`;
    }
  }

  /**
   * Rewrite import statements to dynamic imports.
   */
  private _rewriteImportStatements(
    code: string,
    ast: any
  ): {
    modifiedUserCode: string;
    codeAddToGlobalScope: string;
  } {
    let modifiedUserCode = code;
    let codeAddToGlobalScope = '';

    // Process imports in reverse order to maintain correct positions
    for (let i = ast.body.length - 1; i >= 0; i--) {
      const node = ast.body[i];

      if (node.type === 'ImportDeclaration') {
        const importSource = this._transformImportSource(node.source.value);
        const importSourceCode = JSON.stringify(importSource);

        if (node.specifiers.length === 0) {
          // Side-effect import: import 'module'
          modifiedUserCode = this._replaceCode(
            modifiedUserCode,
            node.start,
            node.end,
            `await import(${importSourceCode});\n`
          );
        } else {
          let hasDefaultImport = false;
          let defaultImportName = '';
          let hasNamespaceImport = false;
          let namespaceImportName = '';
          const importedNames: string[] = [];
          const localNames: string[] = [];

          // Get imported and local names
          for (const specifier of node.specifiers) {
            if (specifier.type === 'ImportSpecifier') {
              if (specifier.imported.name === 'default') {
                hasDefaultImport = true;
                defaultImportName = specifier.local.name;
              } else {
                importedNames.push(specifier.imported.name);
                localNames.push(specifier.local.name);
              }
            } else if (specifier.type === 'ImportDefaultSpecifier') {
              hasDefaultImport = true;
              defaultImportName = specifier.local.name;
            } else if (specifier.type === 'ImportNamespaceSpecifier') {
              hasNamespaceImport = true;
              namespaceImportName = specifier.local.name;
            }
          }

          const importBinding = `__jsKernelImport${i}`;
          let newCodeOfNode = `const ${importBinding} = await import(${importSourceCode});\n`;

          const destructuredNames: string[] = [];
          if (hasDefaultImport) {
            destructuredNames.push(`default: ${defaultImportName}`);
            codeAddToGlobalScope +=
              this._addToGlobalThisCode(defaultImportName);
          }

          if (importedNames.length > 0) {
            for (let j = 0; j < importedNames.length; j++) {
              // Handle aliased imports: import { foo as bar } -> const { foo: bar }
              destructuredNames.push(
                importedNames[j] !== localNames[j]
                  ? `${importedNames[j]}: ${localNames[j]}`
                  : importedNames[j]
              );
              // Use local name for globalThis assignment since that's what's in scope
              codeAddToGlobalScope += this._addToGlobalThisCode(localNames[j]);
            }
          }

          if (destructuredNames.length > 0) {
            newCodeOfNode += `const { ${destructuredNames.join(
              ', '
            )} } = ${importBinding};\n`;
          }

          if (hasNamespaceImport) {
            newCodeOfNode += `const ${namespaceImportName} = ${importBinding};\n`;
            codeAddToGlobalScope +=
              this._addToGlobalThisCode(namespaceImportName);
          }

          modifiedUserCode = this._replaceCode(
            modifiedUserCode,
            node.start,
            node.end,
            newCodeOfNode
          );
        }
      }
    }

    return {
      modifiedUserCode,
      codeAddToGlobalScope
    };
  }

  /**
   * Escape HTML special characters.
   */
  private _escapeHtml(text: string): string {
    const htmlEscapes: Record<string, string> = {
      '&': '&amp;',
      '<': '&lt;',
      '>': '&gt;',
      '"': '&quot;',
      "'": '&#39;'
    };
    return text.replace(/[&<>"']/g, char => htmlEscapes[char]);
  }

  /**
   * Get custom MIME bundle from object methods.
   * Checks for _toHtml, _toSvg, _toPng, _toJpeg, _toMime, inspect.
   */
  private _getCustomMimeBundle(value: any): IMimeBundle | null {
    // Check for _toMime() first - returns a full MIME bundle directly.
    if (typeof value._toMime === 'function') {
      try {
        const mimeResult = value._toMime();
        if (mimeResult && typeof mimeResult === 'object') {
          return mimeResult;
        }
      } catch {
        // Ignore errors in custom methods
      }
    }

    // Try each custom output method. Each returns a string for its MIME type.
    const customMimeMethods: [string, string][] = [
      ['_toHtml', 'text/html'],
      ['_toSvg', 'image/svg+xml'],
      ['_toPng', 'image/png'],
      ['_toJpeg', 'image/jpeg'],
      ['_toMarkdown', 'text/markdown'],
      ['_toLatex', 'text/latex']
    ];

    const bundle: IMimeBundle = {};
    let hasCustomOutput = false;

    for (const [method, mimeType] of customMimeMethods) {
      if (typeof value[method] === 'function') {
        try {
          const result = value[method]();
          if (typeof result === 'string') {
            bundle[mimeType] = result;
            hasCustomOutput = true;
          }
        } catch {
          // Ignore errors in custom methods
        }
      }
    }

    if (!hasCustomOutput) {
      return null;
    }

    // Add text/plain representation using inspect() if available.
    if (typeof value.inspect === 'function') {
      try {
        bundle['text/plain'] = value.inspect();
      } catch {
        bundle['text/plain'] = String(value);
      }
    } else {
      bundle['text/plain'] = String(value);
    }

    return bundle;
  }

  /**
   * Check if value is a DOM element.
   */
  private _isDOMElement(value: any): boolean {
    return (
      this._isInstanceOfRealm(value, 'HTMLElement') ||
      this._isInstanceOfRealm(value, 'SVGElement')
    );
  }

  /**
   * Get MIME bundle for DOM elements.
   */
  private _getDOMElementMimeBundle(element: any): IMimeBundle {
    const isCanvasElement =
      this._isInstanceOfRealm(element, 'HTMLCanvasElement') ||
      (typeof element?.toDataURL === 'function' &&
        typeof element?.getContext === 'function');

    // For canvas elements, try to get image data
    if (isCanvasElement) {
      const canvas = element as HTMLCanvasElement;
      try {
        const dataUrl = canvas.toDataURL('image/png');
        const base64 = dataUrl.split(',')[1];
        return {
          'image/png': base64,
          'text/plain': `<canvas width="${canvas.width}" height="${canvas.height}">`
        };
      } catch {
        const canvasHtml =
          typeof canvas.outerHTML === 'string'
            ? canvas.outerHTML
            : '<canvas></canvas>';
        return { 'text/plain': canvasHtml };
      }
    }

    // For other elements, return HTML
    const elementHtml =
      typeof element?.outerHTML === 'string'
        ? element.outerHTML
        : String(element);
    return {
      'text/html': elementHtml,
      'text/plain': elementHtml
    };
  }

  /**
   * Check `instanceof` against runtime-realm constructors when available.
   *
   * Looks up the constructor by name in both the runtime scope and
   * `globalThis`, so callers don't need to pass a fallback constructor.
   */
  private _isInstanceOfRealm(value: any, ctorName: string): boolean {
    if (value === null || value === undefined) {
      return false;
    }

    // Check against the runtime scope constructor (e.g. iframe window).
    const scopeCtor = this._globalScope?.[ctorName];
    if (typeof scopeCtor === 'function') {
      try {
        if (value instanceof scopeCtor) {
          return true;
        }
      } catch {
        // Ignore invalid instanceof checks.
      }
    }

    // Fall back to the current realm's globalThis constructor.
    const globalCtor = (globalThis as Record<string, any>)[ctorName];
    if (typeof globalCtor === 'function') {
      try {
        return value instanceof globalCtor;
      } catch {
        return false;
      }
    }

    return false;
  }

  /**
   * Format array preview with truncation.
   */
  private _formatArrayPreview(arr: any[], maxItems: number = 10): string {
    if (arr.length === 0) {
      return '[]';
    }
    const items = arr.slice(0, maxItems).map(item => {
      if (item === null) {
        return 'null';
      }
      if (item === undefined) {
        return 'undefined';
      }
      if (typeof item === 'string') {
        return `'${item}'`;
      }
      if (typeof item === 'object') {
        if (Array.isArray(item)) {
          return `Array(${item.length})`;
        }
        return '{...}';
      }
      return String(item);
    });
    const suffix = arr.length > maxItems ? `, ... (${arr.length} items)` : '';
    return `[${items.join(', ')}${suffix}]`;
  }

  /**
   * Format object preview with truncation.
   */
  private _formatObjectPreview(obj: object, maxProps: number = 5): string {
    const keys = Object.keys(obj);
    if (keys.length === 0) {
      return '{}';
    }
    const constructor = obj.constructor?.name;
    const prefix =
      constructor && constructor !== 'Object' ? `${constructor} ` : '';

    const props = keys.slice(0, maxProps).map(key => {
      try {
        const value = (obj as any)[key];
        let valueStr: string;
        if (value === null) {
          valueStr = 'null';
        } else if (value === undefined) {
          valueStr = 'undefined';
        } else if (typeof value === 'string') {
          valueStr = `'${value.length > 20 ? value.substring(0, 20) + '...' : value}'`;
        } else if (typeof value === 'object') {
          valueStr = Array.isArray(value) ? `Array(${value.length})` : '{...}';
        } else if (typeof value === 'function') {
          valueStr = '[Function]';
        } else {
          valueStr = String(value);
        }
        return `${key}: ${valueStr}`;
      } catch {
        return `${key}: <error>`;
      }
    });

    const suffix = keys.length > maxProps ? ', ...' : '';
    return `${prefix}{ ${props.join(', ')}${suffix} }`;
  }

  /**
   * Format non-serializable object (circular refs, etc.).
   */
  private _formatNonSerializableObject(obj: object): string {
    const constructor = obj.constructor?.name || 'Object';
    const keys = Object.keys(obj);
    return `${constructor} { ${keys.length} properties }`;
  }

  /**
   * Get all properties of an object including inherited ones.
   * Filters by prefix and returns sorted unique matches.
   */
  private _getAllProperties(obj: any, prefix: string): string[] {
    const seen = new Set<string>();
    const matches: string[] = [];
    const lowerPrefix = prefix.toLowerCase();

    // Helper to add matching properties
    const addMatching = (props: string[]) => {
      for (const prop of props) {
        if (!seen.has(prop) && prop.startsWith(prefix)) {
          seen.add(prop);
          matches.push(prop);
        }
      }
    };

    // Helper to add case-insensitive matches (lower priority)
    const addCaseInsensitive = (props: string[]) => {
      for (const prop of props) {
        if (
          !seen.has(prop) &&
          prop.toLowerCase().startsWith(lowerPrefix) &&
          !prop.startsWith(prefix)
        ) {
          seen.add(prop);
          matches.push(prop);
        }
      }
    };

    try {
      // Walk up the prototype chain
      let current = obj;
      while (current !== null && current !== undefined) {
        try {
          // Get own property names (includes non-enumerable)
          const ownProps = Object.getOwnPropertyNames(current);
          addMatching(ownProps);

          // Also get enumerable properties from for...in
          for (const key in current) {
            if (!seen.has(key) && key.startsWith(prefix)) {
              seen.add(key);
              matches.push(key);
            }
          }
        } catch {
          // Some objects may throw on getOwnPropertyNames
        }

        // Move up prototype chain
        try {
          current = Object.getPrototypeOf(current);
        } catch {
          break;
        }
      }

      // Add case-insensitive matches as secondary results
      current = obj;
      while (current !== null && current !== undefined) {
        try {
          const ownProps = Object.getOwnPropertyNames(current);
          addCaseInsensitive(ownProps);
        } catch {
          // Ignore
        }
        try {
          current = Object.getPrototypeOf(current);
        } catch {
          break;
        }
      }
    } catch {
      // Fallback to simple for...in if above fails
      try {
        for (const key in obj) {
          if (key.startsWith(prefix)) {
            matches.push(key);
          }
        }
      } catch {
        // Ignore
      }
    }

    // Sort matches: exact prefix matches first, then alphabetically
    return matches.sort((a, b) => {
      const aExact = a.startsWith(prefix);
      const bExact = b.startsWith(prefix);
      if (aExact && !bExact) {
        return -1;
      }
      if (!aExact && bExact) {
        return 1;
      }
      return a.localeCompare(b);
    });
  }

  /**
   * Extract the expression at the cursor position.
   */
  private _extractExpressionAtCursor(
    code: string,
    cursorPos: number
  ): string | null {
    // Find word boundaries around cursor
    const beforeCursor = code.substring(0, cursorPos);
    const afterCursor = code.substring(cursorPos);

    // Match identifier characters going backwards
    const beforeMatch = beforeCursor.match(/[\w.$]+$/);
    const afterMatch = afterCursor.match(/^[\w]*/);

    if (!beforeMatch) {
      return null;
    }

    return beforeMatch[0] + (afterMatch?.[0] || '');
  }

  /**
   * Build rich inspection data for a value.
   */
  private _buildInspectionData(
    expression: string,
    value: any,
    detailLevel: number
  ): IInspectResult['data'] {
    const lines: string[] = [];

    // Type information
    const type = this._getTypeString(value);
    lines.push(`**${expression}**: \`${type}\``);
    lines.push('');

    // Value preview
    if (typeof value === 'function') {
      const funcStr = value.toString();
      const signature = this._extractFunctionSignature(funcStr);
      lines.push('**Signature:**');
      lines.push('```javascript');
      lines.push(signature);
      lines.push('```');

      if (detailLevel > 0) {
        lines.push('');
        lines.push('**Source:**');
        lines.push('```javascript');
        lines.push(funcStr);
        lines.push('```');
      }
    } else if (typeof value === 'object' && value !== null) {
      // List properties
      const props = Object.keys(value).slice(0, 20);
      if (props.length > 0) {
        lines.push('**Properties:**');
        for (const prop of props) {
          try {
            const propType = this._getTypeString(value[prop]);
            lines.push(`- \`${prop}\`: ${propType}`);
          } catch {
            lines.push(`- \`${prop}\`: (inaccessible)`);
          }
        }
        if (Object.keys(value).length > 20) {
          lines.push(`- ... and ${Object.keys(value).length - 20} more`);
        }
      }
    } else {
      lines.push(`**Value:** \`${String(value)}\``);
    }

    return {
      'text/plain': lines.join('\n').replace(/\*\*/g, ''),
      'text/markdown': lines.join('\n')
    };
  }

  /**
   * Get a human-readable type string for a value.
   */
  private _getTypeString(value: any): string {
    if (value === null) {
      return 'null';
    }
    if (value === undefined) {
      return 'undefined';
    }
    if (Array.isArray(value)) {
      return `Array(${value.length})`;
    }
    if (typeof value === 'function') {
      const name = value.name || 'anonymous';
      return `function ${name}()`;
    }
    if (typeof value === 'object') {
      const constructor = value.constructor?.name;
      return constructor || 'Object';
    }
    return typeof value;
  }

  /**
   * Extract function signature from function string.
   */
  private _extractFunctionSignature(funcStr: string): string {
    // Try to extract just the signature
    const match = funcStr.match(
      /^(async\s+)?function\s*(\w*)\s*\([^)]*\)|^(async\s+)?\([^)]*\)\s*=>|^(async\s+)?(\w+)\s*=>/
    );
    if (match) {
      return match[0];
    }
    // For methods and short functions, return first line
    const firstLine = funcStr.split('\n')[0];
    return firstLine.length > 100
      ? firstLine.substring(0, 100) + '...'
      : firstLine;
  }

  /**
   * Try to inspect an expression by looking it up in the global scope at runtime.
   */
  private _inspectAtRuntime(
    expression: string,
    detailLevel: number
  ): IInspectResult {
    try {
      // Try to find the value in global scope
      const parts = expression.split('.');
      let value: any = this._globalScope;

      for (const part of parts) {
        if (value === null || value === undefined) {
          return { status: 'ok', found: false, data: {}, metadata: {} };
        }
        const hasProp =
          part in value || Object.prototype.hasOwnProperty.call(value, part);
        if (hasProp) {
          value = value[part];
        } else {
          return { status: 'ok', found: false, data: {}, metadata: {} };
        }
      }

      // Build inspection data with additional documentation if available
      const inspectionData = this._buildInspectionData(
        expression,
        value,
        detailLevel
      );

      // Add predefined documentation if available
      const doc = this.getBuiltinDocumentation(expression);
      if (doc) {
        const mdContent = inspectionData['text/markdown'] || '';
        inspectionData['text/markdown'] = mdContent + `\n\n---\n\n${doc}`;
        const plainContent = inspectionData['text/plain'] || '';
        inspectionData['text/plain'] = plainContent + `\n\nDoc: ${doc}`;
      }

      return {
        status: 'ok',
        found: true,
        data: inspectionData,
        metadata: {}
      };
    } catch {
      return { status: 'ok', found: false, data: {}, metadata: {} };
    }
  }

  /**
   * Find similar names in global scope for suggestions.
   */
  private _findSimilarNames(expression: string): string[] {
    const suggestions: string[] = [];
    const lowerExpr = expression.toLowerCase();

    try {
      // Check global scope for similar names
      const globalProps = this._getAllProperties(this._globalScope, '');

      for (const prop of globalProps) {
        // Check for similar names (Levenshtein-like simple check)
        const lowerProp = prop.toLowerCase();
        if (
          lowerProp.includes(lowerExpr) ||
          lowerExpr.includes(lowerProp) ||
          this._isSimilar(lowerExpr, lowerProp)
        ) {
          suggestions.push(prop);
          if (suggestions.length >= 5) {
            break;
          }
        }
      }
    } catch {
      // Ignore errors
    }

    return suggestions;
  }

  /**
   * Simple similarity check for two strings.
   */
  private _isSimilar(a: string, b: string): boolean {
    // Check if strings differ by only 1-2 characters
    if (Math.abs(a.length - b.length) > 2) {
      return false;
    }

    let differences = 0;
    const maxLen = Math.max(a.length, b.length);
    for (let i = 0; i < maxLen; i++) {
      if (a[i] !== b[i]) {
        differences++;
        if (differences > 2) {
          return false;
        }
      }
    }
    return differences <= 2;
  }

  private _config: ExecutorConfig;
  private _globalScope: Record<string, any>;
}
