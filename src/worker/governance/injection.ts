// Detects text that looks like an instruction aimed at an AI model rather than information for a reader.
// This is a tripwire, not the defence. The defence is structural: document text reaches the model only inside search_result
// blocks the system prompt calls DATA, and no model output can widen permissions. The tripwire exists so a suspicious chunk can be
// flagged at ingestion, shown with a warning in the UI and counted in the audit log.

const PATTERNS: { reason: string; re: RegExp }[] = [
  { reason: "ignore previous instructions", re: /ignore\s+(?:all\s+)?(?:the\s+)?(?:previous|prior|above|earlier)\s+(?:instructions|rules|prompts?)/i },
  { reason: "disregard previous instructions", re: /disregard\s+(?:all\s+)?(?:the\s+)?(?:previous|prior|above|earlier)/i },
  { reason: "zignoruj instrukcje", re: /zignoruj\s+(?:wszystkie\s+)?(?:wcze(?:ś|s)niejsze|poprzednie|powy(?:ż|z)sze)\s+(?:instrukcje|polecenia|zasady)/i },
  { reason: "zapomnij instrukcje", re: /zapomnij\s+(?:o\s+)?(?:wszystkich\s+)?(?:wcze(?:ś|s)niejsz\w+|poprzedni\w+)\s+(?:instrukcj\w+|polece\w+|zasad\w+)/i },
  { reason: "addresses the AI assistant", re: /\b(?:notatka|wiadomo(?:ś|s)(?:ć|c)|note|message)\s+(?:dla|for(?:\s+the)?)\s+(?:asystenta(?:\s+ai)?|(?:ai\s+)?assistant|modelu|ai)\b/i },
  { reason: "claims system authority", re: /\b(?:instrukcj\w+\s+systemow\w+|system\s+(?:prompt|instruction|override)|prompt\s+systemow\w+)\b/i },
  { reason: "reassigns the assistant's role", re: /\byou\s+are\s+now\b|\bod\s+tej\s+chwili\s+(?:jeste(?:ś|s)|odpowiadaj)/i },
  { reason: "forces a fixed answer", re: /\b(?:odpowiadaj|answer|respond|reply)\b[^.\n]{0,60}\b(?:wy(?:łą|la)cznie|only|exclusively)\b/i },
  { reason: "asks users for a password", re: /(?:wpisali|podali|przes(?:ł|l)ali)\s+swoje\s+(?:aktualne\s+)?has(?:ł|l)o|(?:send|enter|type|provide|share)\s+your\s+(?:current\s+)?password/i },
  { reason: "asks to hide the instruction", re: /nie\s+wspominaj\s+o\s+tej\s+notatce|do\s+not\s+mention\s+(?:this|these)\s+(?:note|instruction)/i },
];

export interface InjectionScan {
  flagged: boolean;
  reasons: string[];
}

export function scanForInjection(text: string): InjectionScan {
  const reasons = PATTERNS.filter((p) => p.re.test(text)).map((p) => p.reason);
  return { flagged: reasons.length > 0, reasons };
}
