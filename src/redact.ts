/**
 * Secret redaction applied before anything is stored.
 *
 * A memory store is embedded, synced to Postgres or the cloud backend, and pasted back into
 * prompts, so a credential that lands in it leaks three ways. The patterns match credential
 * shapes only (provider key prefixes, private key blocks, bearer tokens, JWTs, `password=`
 * style assignments, passwords in connection strings), not "anything that looks random", so
 * ordinary prose and code pass through untouched.
 *
 * On by default; `PRZM_MEMORY_REDACT_SECRETS=0` turns it off.
 */

export const REDACTED = '[REDACTED]';

const WHOLE: RegExp[] = [
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
  /\bsk-(?:ant-|or-|proj-)?[A-Za-z0-9_-]{20,}/g,           // OpenAI, Anthropic, OpenRouter
  /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{36,}\b/g,         // GitHub tokens
  /\bgithub_pat_[A-Za-z0-9_]{22,}\b/g,
  /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g,                         // AWS access key ids
  /\bxox[abprs]-[A-Za-z0-9-]{10,}\b/g,                      // Slack
  /\bAIza[0-9A-Za-z_-]{35}\b/g,                             // Google API keys
  /\b(?:sk|rk)_(?:live|test)_[0-9A-Za-z]{16,}\b/g,          // Stripe
  /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g, // JWTs
];

/**
 * Patterns whose first group is kept (the label) and whose second, the value, is replaced when
 * it looks like a real secret. Code is full of `password: string` and `api_key="your_key"`;
 * those are identifiers and placeholders, and memories about code need them intact.
 */
const LABELLED: RegExp[] = [
  /\b(Bearer\s+)([A-Za-z0-9._~+/-]{20,}=*)/gi,
  /\b((?:password|passwd|pwd|secret|api[_-]?key|access[_-]?token|auth[_-]?token|client[_-]?secret)\s*[:=]\s*["']?)([^\s"'`,;)]+)/gi,
  /\b([a-z][a-z0-9+.-]*:\/\/[^\s:@/]+:)([^\s@/]+)(?=@)/gi,      // scheme://user:pass@host
];

/** Eight or more characters mixing letters and digits, and not a placeholder. */
function looksSecret(value: string): boolean {
  if (value.length < 8 || value === REDACTED) return false;
  if (!/[A-Za-z]/.test(value) || !/\d/.test(value)) return false;
  return !/^(?:<|\$|\{|%|your|my[_-]|example|placeholder|changeme|xxx)/i.test(value);
}

export function redactionEnabled(): boolean {
  const v = process.env.PRZM_MEMORY_REDACT_SECRETS;
  return v !== '0' && v !== 'false';
}

/** Replace credential shapes with `[REDACTED]`. `redacted` counts the replacements. */
export function redactSecrets(text: string): { text: string; redacted: number } {
  let redacted = 0;
  let out = text;
  for (const pattern of WHOLE) {
    out = out.replace(pattern, () => { redacted++; return REDACTED; });
  }
  for (const pattern of LABELLED) {
    out = out.replace(pattern, (match, label: string, value: string) => {
      if (!looksSecret(value)) return match;
      redacted++;
      return label + REDACTED;
    });
  }
  return { text: out, redacted };
}
