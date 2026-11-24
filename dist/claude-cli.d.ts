export declare function usesClaudeCli(): boolean;
/** The CLI takes its own model names (haiku, sonnet, or a full id); an OpenRouter-style name doesn't apply. */
export declare function claudeCliModel(): string;
export declare function claudeCliArgs(model: string, systemPromptFile: string): string[];
/** The reply text from `--output-format json`, or an error with the CLI's own words. */
export declare function parseClaudeCliOutput(stdout: string): string;
export declare function claudeCliComplete(systemPrompt: string, userMessage: string, model?: string): Promise<string>;
