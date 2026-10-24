/**
 * Incrementally extract tagged reasoning from the visible content channel.
 * Native reasoning (`delta.reasoning_content`) is handled separately by the
 * stream transformer.
 *
 * Ported from `dsh-provider-qoder`.
 */
/** One ordered reasoning or visible-text fragment. */
export interface ThinkingPiece {
    kind: "reasoning" | "text";
    text: string;
}
/** Retain only a possible tag prefix between chunks, never an entire response. */
export declare class ThinkingParser {
    private pending;
    private closingTag;
    private sawThinking;
    get hasThinking(): boolean;
    get hasUnclosedThinking(): boolean;
    feed(chunk: string): ThinkingPiece[];
    /** A stream-tail prefix is literal content, not a complete protocol tag. */
    flush(): ThinkingPiece[];
}
