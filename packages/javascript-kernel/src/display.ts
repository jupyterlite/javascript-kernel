// Copyright (c) Jupyter Development Team.
// Distributed under the terms of the Modified BSD License.

/**
 * MIME bundle for rich display.
 */
export interface IMimeBundle {
  [key: string]: any;
}

/**
 * Display request from $$.display().
 */
export interface IDisplayData {
  data: IMimeBundle;
  metadata: Record<string, any>;
  transient?: {
    display_id?: string;
  };
}

/**
 * Callbacks for display operations.
 */
export interface IDisplayCallbacks {
  onDisplay?: (data: IDisplayData) => void;
  onClear?: (wait: boolean) => void;
}

/**
 * Display helper class for rich output.
 * Provides methods like html(), svg(), png(), etc.
 */
export class DisplayHelper {
  /**
   * Instantiate a new DisplayHelper.
   *
   * @param displayId - Optional display ID for update operations.
   */
  constructor(displayId?: string) {
    this._displayId = displayId;
  }

  /**
   * Set the callbacks for display operations.
   *
   * @param callbacks - The callbacks for display and clear operations.
   */
  setCallbacks(callbacks: IDisplayCallbacks): void {
    this._displayCallback = callbacks.onDisplay;
    this._clearCallback = callbacks.onClear;
  }

  /**
   * Get the result if set via display methods.
   *
   * @returns The MIME bundle result, or undefined if not set.
   */
  getResult(): IMimeBundle | undefined {
    return this._result;
  }

  /**
   * Clear the result.
   */
  clearResult(): void {
    this._result = undefined;
  }

  /**
   * Create a new display with optional ID.
   *
   * @param id - Optional display ID for update operations.
   * @returns A new DisplayHelper instance.
   *
   * @example
   * $$.display('my-id').html('<div>...</div>')
   */
  display(id?: string): DisplayHelper {
    return new DisplayHelper(id);
  }

  /**
   * Display HTML content.
   *
   * @param content - The HTML content to display.
   * @param metadata - Optional metadata for the display.
   */
  html(content: string, metadata?: Record<string, any>): void {
    this._sendDisplay(
      { 'text/html': content, 'text/plain': content },
      metadata
    );
  }

  /**
   * Display SVG content.
   *
   * @param content - The SVG content to display.
   * @param metadata - Optional metadata for the display.
   */
  svg(content: string, metadata?: Record<string, any>): void {
    this._sendDisplay(
      {
        'image/svg+xml': content,
        'text/plain': '[SVG Image]'
      },
      metadata
    );
  }

  /**
   * Display PNG image (base64 encoded).
   *
   * @param base64Content - The base64-encoded PNG data.
   * @param metadata - Optional metadata for the display.
   */
  png(base64Content: string, metadata?: Record<string, any>): void {
    this._sendDisplay(
      {
        'image/png': base64Content,
        'text/plain': '[PNG Image]'
      },
      metadata
    );
  }

  /**
   * Display JPEG image (base64 encoded).
   *
   * @param base64Content - The base64-encoded JPEG data.
   * @param metadata - Optional metadata for the display.
   */
  jpeg(base64Content: string, metadata?: Record<string, any>): void {
    this._sendDisplay(
      {
        'image/jpeg': base64Content,
        'text/plain': '[JPEG Image]'
      },
      metadata
    );
  }

  /**
   * Display plain text.
   *
   * @param content - The text content to display.
   * @param metadata - Optional metadata for the display.
   */
  text(content: string, metadata?: Record<string, any>): void {
    this._sendDisplay({ 'text/plain': content }, metadata);
  }

  /**
   * Display Markdown content.
   *
   * @param content - The Markdown content to display.
   * @param metadata - Optional metadata for the display.
   */
  markdown(content: string, metadata?: Record<string, any>): void {
    this._sendDisplay(
      { 'text/markdown': content, 'text/plain': content },
      metadata
    );
  }

  /**
   * Display LaTeX content.
   *
   * @param content - The LaTeX content to display.
   * @param metadata - Optional metadata for the display.
   */
  latex(content: string, metadata?: Record<string, any>): void {
    this._sendDisplay(
      { 'text/latex': content, 'text/plain': content },
      metadata
    );
  }

  /**
   * Display JSON content.
   *
   * @param content - The JSON content to display.
   * @param metadata - Optional metadata for the display.
   */
  json(content: any, metadata?: Record<string, any>): void {
    this._sendDisplay(
      {
        'application/json': content,
        'text/plain': JSON.stringify(content, null, 2)
      },
      metadata
    );
  }

  /**
   * Display with custom MIME bundle.
   *
   * @param mimeBundle - The MIME bundle to display.
   * @param metadata - Optional metadata for the display.
   */
  mime(mimeBundle: IMimeBundle, metadata?: Record<string, any>): void {
    this._sendDisplay(mimeBundle, metadata);
  }

  /**
   * Clear the current output.
   *
   * @param options - Clear options.
   * @param options.wait - If true, wait for new output before clearing.
   */
  clear(options: { wait?: boolean } = {}): void {
    if (this._clearCallback) {
      this._clearCallback(options.wait ?? false);
    }
  }

  /**
   * Send display data.
   */
  private _sendDisplay(
    data: IMimeBundle,
    metadata?: Record<string, any>
  ): void {
    const displayData: IDisplayData = {
      data,
      metadata: metadata ?? {},
      transient: this._displayId ? { display_id: this._displayId } : undefined
    };

    if (this._displayCallback) {
      this._displayCallback(displayData);
    } else {
      // Store as result for synchronous return
      this._result = data;
    }
  }

  private _displayCallback?: (data: IDisplayData) => void;
  private _clearCallback?: (wait: boolean) => void;
  private _displayId?: string;
  private _result?: IMimeBundle;
}
