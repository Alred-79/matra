import { vaultProblemNotice, type VaultProblem } from '../lib/vault';

/**
 * Only on read-only screens that load with `allowPartial` (Home): part of her space didn't load or didn't match what
 * she saved, so it is left out and what is "latest" here may be older than her newest save (lib/vault.ts loadSpace).
 * Screens that save, seal, share or resume never render partially; they show VaultStopped instead. Renders nothing
 * when nothing is left out.
 */
export function UnreadableNote({ problems }: { problems: VaultProblem[] | undefined }) {
  const text = vaultProblemNotice(problems);
  if (!text) return null;
  const kind = problems?.some((p) => p.kind !== 'unavailable') ? 'integrity' : 'unavailable';
  return (
    <p className="card warn small" role="status" data-testid="vault-unreadable" data-kind={kind}>
      {text}
    </p>
  );
}

/**
 * In place of a screen that would show or save from her space when it didn't load cleanly: the calm reason (the error's
 * message, already distinct for "couldn't reach us" and "doesn't match what you saved") and Try again.
 */
export function VaultStopped({ error, onRetry }: { error: string; onRetry(): void }) {
  return (
    <div className="card warn stack" role="alert" data-testid="vault-stopped">
      <p style={{ margin: 0 }}>{error}</p>
      <div>
        <button type="button" className="btn btn-small" onClick={onRetry}>
          Try again
        </button>
      </div>
    </div>
  );
}
