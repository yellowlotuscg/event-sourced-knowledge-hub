export type ScannerRuleId =
  | 'aws-access-key-id'
  | 'private-key-block'
  | 'generic-high-entropy-token'
  | 'bearer-token'
  | 'connection-string';

export interface ScanFinding {
  ruleId: ScannerRuleId;
  message: string;
}

const rules: Array<{ id: ScannerRuleId; pattern: RegExp; message: string }> = [
  { id: 'aws-access-key-id', pattern: /\bAKIA[0-9A-Z]{16}\b/, message: 'AWS access key pattern' },
  { id: 'private-key-block', pattern: /-----BEGIN(?: [A-Z]+)* PRIVATE KEY-----/, message: 'private key block' },
  { id: 'bearer-token', pattern: /\bBearer\s+[A-Za-z0-9._~+/=-]{20,}/i, message: 'bearer token' },
  { id: 'connection-string', pattern: /\b(?:postgres(?:ql)?|mysql|mongodb(?:\+srv)?):\/\/[^\s]+/i, message: 'connection string' },
  {
    id: 'generic-high-entropy-token',
    pattern: /\b(?:token|secret|api[_-]?key|password)\s*[:=]\s*[A-Za-z0-9+/_=-]{24,}\b/i,
    message: 'generic high-entropy token assignment',
  },
];

export function scanBody(body: string): ScanFinding | undefined {
  for (const rule of rules) {
    if (rule.pattern.test(body)) return { ruleId: rule.id, message: rule.message };
  }
  return undefined;
}
