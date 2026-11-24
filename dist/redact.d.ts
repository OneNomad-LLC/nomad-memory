export declare const REDACTED = "[REDACTED]";
export declare function redactionEnabled(): boolean;
/** Replace credential shapes with `[REDACTED]`. `redacted` counts the replacements. */
export declare function redactSecrets(text: string): {
    text: string;
    redacted: number;
};
