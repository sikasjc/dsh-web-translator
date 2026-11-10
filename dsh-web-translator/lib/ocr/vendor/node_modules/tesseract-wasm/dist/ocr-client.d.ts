import type { BoxItem, Orientation, ProgressListener, TextItem, TextUnit } from "./ocr-engine";
export type OCRClientInit = {
    /**
     * Callback that creates the worker. The default implementation creates a Web Worker.
     */
    createWorker?: (url: string) => Worker;
    /**
     * WebAssembly binary to load in worker. If not set, it is loaded from the
     * default location relative to the current script.
     */
    wasmBinary?: Uint8Array | ArrayBuffer;
    /**
     * Location of worker script/module. If not set, it is loaded from the default location relative to the
     * current script.
     */
    workerURL?: string;
};
/**
 * High-level async API for performing document image layout analysis and
 * OCR.
 *
 * In the browser, this class can be constructed directly. In Node, use the
 * `createOCRClient` helper from `node-worker.js`.
 */
export declare class OCRClient {
    private _worker;
    private _progressListeners;
    private _progressChannel;
    private _ocrEngine;
    /**
     * Initialize an OCR engine.
     *
     * This will start a Worker in which the OCR operations will actually be
     * performed.
     *
     */
    constructor({ createWorker, wasmBinary, workerURL, }?: OCRClientInit);
    destroy(): Promise<void>;
    /**
     * Load a trained model for a specific language. This can be specified either
     * as a URL to fetch or a buffer containing an already-loaded model.
     */
    loadModel(model: string | ArrayBuffer): Promise<void>;
    /**
     * Load an image into the OCR engine for processing.
     */
    loadImage(image: ImageBitmap | ImageData): Promise<void>;
    /**
     * Clear the current image and text recognition results.
     *
     * This will clear the loaded image data internally, but keep the text
     * recognition model loaded.
     *
     * At present there is no way to shrink WebAssembly memory, so this will not
     * return the memory used by the image to the OS/browser. To release memory,
     * the web worker needs to be shut down via {@link destroy}.
     */
    clearImage(): Promise<void>;
    /**
     * Perform layout analysis on the current image, if not already done, and
     * return bounding boxes for a given unit of text.
     *
     * This operation is relatively cheap compared to text recognition, so can
     * provide much faster results if only the location of lines/words etc. on
     * the page is required, not the text content.
     */
    getBoundingBoxes(unit: TextUnit): Promise<BoxItem[]>;
    /**
     * Perform layout analysis and text recognition on the current image, if
     * not already done, and return bounding boxes and text content for a given
     * unit of text.
     */
    getTextBoxes(unit: TextUnit, onProgress?: ProgressListener): Promise<TextItem[]>;
    /**
     * Perform layout analysis and text recognition on the current image, if
     * not already done, and return the image's text as a string.
     */
    getText(onProgress?: ProgressListener): Promise<string>;
    /**
     * Perform layout analysis and text recognition on the current image, if
     * not already done, and return the image's text in hOCR format (see
     * https://en.wikipedia.org/wiki/HOCR).
     */
    getHOCR(onProgress?: ProgressListener): Promise<string>;
    /**
     * Attempt to determine the orientation of the image.
     *
     * This currently uses a simplistic algorithm [1] which is designed for
     * non-uppercase Latin text. It will likely perform badly for other scripts or
     * if the text is all uppercase.
     *
     * [1] See http://www.leptonica.org/papers/skew-measurement.pdf
     */
    getOrientation(): Promise<Orientation>;
    private _addProgressListener;
    private _removeProgressListener;
}
