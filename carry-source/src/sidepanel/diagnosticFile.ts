// File naming + packaging for the 诊断 (diagnostic) report. No runtime imports (node tests).

const pad = (value: number) => String(value).padStart(2, '0');

/** multi-ai-chat-diagnostic-YYYYMMDD-HHMMSS.json in the user's local time. */
export function diagnosticFileName(date = new Date()): string {
  const stamp = `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`;
  return `multi-ai-chat-diagnostic-${stamp}.json`;
}

export interface PanelDiagnostics {
  relayOrder: readonly string[];
  relayTurns: number;
  isProcessing: boolean;
  stepRecovery: unknown;
  messages: readonly { role?: string; provider?: string; content?: string; timestamp?: number }[];
}

export function buildDiagnosticDocument(workerReport: unknown, panel: PanelDiagnostics, workerError?: string): Record<string, unknown> {
  return {
    ...(workerReport && typeof workerReport === 'object' ? workerReport as Record<string, unknown> : {}),
    ...(workerError ? { workerError } : {}),
    panel: {
      relayOrder: [...panel.relayOrder],
      relayTurns: panel.relayTurns,
      isProcessing: panel.isProcessing,
      stepRecovery: panel.stepRecovery ?? null,
      messageCount: panel.messages.length,
      lastMessages: panel.messages.slice(-8).map((message) => ({
        role: message.role,
        provider: message.provider,
        chars: message.content?.length ?? 0,
        head: (message.content ?? '').slice(0, 300),
        timestamp: message.timestamp,
      })),
    },
  };
}
