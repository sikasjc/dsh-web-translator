/**
 * Flags indicating position of a text item.
 *
 * Keep this in sync with `LayoutFlags` in lib.cpp.
 */
export declare const layoutFlags: {
    StartOfLine: number;
    EndOfLine: number;
};
export type IntRect = {
    left: number;
    top: number;
    right: number;
    bottom: number;
};
/**
 * Item of text found in a document image by layout analysis.
 */
export type BoxItem = {
    rect: IntRect;
    /** Combination of flags from {@link layoutFlags} */
    flags: number;
};
/**
 * Item of text found in a document image by layout analysis and OCR.
 */
export type TextItem = {
    rect: IntRect;
    /** Combination of flags from {@link layoutFlags} */
    flags: number;
    /** Confidence score for this word in [0, 1] */
    confidence: number;
    text: string;
};
/**
 * Result of orientation detection.
 */
export type Orientation = {
    rotation: number;
    /** Confidence value in [0, 1] */
    confidence: number;
};
export type TextUnit = "line" | "word";
/**
 * Handler that receives OCR operation progress updates.
 */
export type ProgressListener = (progress: number) => void;
/**
 * Low-level synchronous API for performing OCR.
 *
 * Instances are constructed using {@link createOCREngine}.
 */
export declare class OCREngine {
    private _tesseractLib;
    private _engine;
    private _modelLoaded;
    private _imageLoaded;
    private _progressChannel?;
    /**
     * Initialize the OCREngine.
     *
     * Use {@link createOCREngine} rather than calling this directly.
     *
     * @param tessLib - Emscripten entry point for the compiled WebAssembly module.
     * @param progressChannel - Channel used to report progress
     *   updates when OCREngine is run on a background thread
     */
    constructor(tessLib: any, progressChannel?: MessagePort);
    /**
     * Shut down the OCR engine and free up resources.
     */
    destroy(): void;
    /**
     * Get the value, represented as a string, of a Tesseract configuration variable.
     *
     * See {@link setVariable} for available variables.
     */
    getVariable(name: string): string;
    /**
     * Set the value of a Tesseract configuration variable.
     *
     * For a list of configuration variables, see
     * https://github.com/tesseract-ocr/tesseract/blob/677f5822f247ccb12b4e026265e88b959059fb59/src/ccmain/tesseractclass.cpp#L53
     *
     * If you have Tesseract installed locally, executing `tesseract --print-parameters`
     * will also display a list of configuration variables.
     */
    setVariable(name: string, value: string): void;
    /**
     * Load a trained text recognition model.
     */
    loadModel(model: Uint8Array | ArrayBuffer): void;
    /**
     * Load a document image for processing by subsequent operations.
     *
     * This is a cheap operation as expensive processing is deferred until
     * bounding boxes or text content is requested.
     */
    loadImage(image: ImageBitmap | ImageData): void;
    /**
     * Clear the current image and text recognition results.
     *
     * This will clear the loaded image data internally, but keep the text
     * recognition model loaded.
     *
     * At present there is no way to shrink WebAssembly memory, so this will not
     * return the memory used by the image to the OS/browser. To release memory,
     * the `OCREngine` instance needs to be destroyed via {@link destroy}.
     */
    clearImage(): void;
    /**
     * Perform layout analysis on the current image, if not already done, and
     * return bounding boxes for a given unit of text.
     *
     * This operation is relatively cheap compared to text recognition, so can
     * provide much faster results if only the location of lines/words etc. on
     * the page is required, not the text content. This operation can also be
     * performed before a text recognition model is loaded.
     *
     * This method may return a different number/positions of words on a line
     * compared to {@link getTextBoxes} due to the simpler analysis. After full
     * OCR has been performed by {@link getTextBoxes} or {@link getText}, this
     * method should return the same results.
     */
    getBoundingBoxes(unit: TextUnit): BoxItem[];
    /**
     * Perform layout analysis and text recognition on the current image, if
     * not already done, and return bounding boxes and text content for a given
     * unit of text.
     *
     * A text recognition model must be loaded with {@link loadModel} before this
     * is called.
     */
    getTextBoxes(unit: TextUnit, onProgress?: ProgressListener): TextItem[];
    /**
     * Perform layout analysis and text recognition on the current image, if
     * not already done, and return the page text as a string.
     *
     * A text recognition model must be loaded with {@link loadModel} before this
     * is called.
     */
    getText(onProgress?: ProgressListener): string;
    /**
     * Perform layout analysis and text recognition on the current image, if
     * not already done, and return the page text in hOCR format.
     *
     * A text recognition model must be loaded with {@link loadModel} before this
     * is called.
     */
    getHOCR(onProgress?: ProgressListener): string;
    /**
     * Attempt to determine the orientation of the document image in degrees.
     *
     * This currently uses a simplistic algorithm [1] which is designed for
     * non-uppercase Latin text. It will likely perform badly for other scripts or
     * if the text is all uppercase.
     *
     * [1] See http://www.leptonica.org/papers/skew-measurement.pdf
     */
    getOrientation(): Orientation;
    private _checkModelLoaded;
    private _checkImageLoaded;
    private _textUnitForUnit;
}
/**
 * Return true if the current JS runtime supports all the WebAssembly features
 * needed for the "fast" WebAssembly build. If not, the "fallback" version must
 * be used.
 */
export declare function supportsFastBuild(): boolean;
export type CreateOCREngineOptions = {
    /**
     * WebAssembly binary to load. This can be used to customize how the binary URL
     * is determined and fetched. {@link supportsFastBuild} can be used to
     * determine which build to load.
     */
    wasmBinary?: Uint8Array | ArrayBuffer;
    progressChannel?: MessagePort;
};
/**
 * Initialize the OCR library and return a new {@link OCREngine}.
 */
export declare function createOCREngine({ wasmBinary, progressChannel, }?: CreateOCREngineOptions): Promise<OCREngine>;
