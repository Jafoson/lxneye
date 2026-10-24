import type { ComponentChildren } from 'preact';
import type { PrStatus } from './types';

const ICON: Record<string, ComponentChildren> = {
  success: <path d="M5 12l5 5 9-10" />,
  failure: <path d="M6 6l12 12M18 6L6 18" />,
  pending: (<><circle cx="12" cy="12" r="9" /><path d="M12 7v5l3 2" /></>),
  none: <path d="M6 12h12" />,
  unknown: (<><circle cx="12" cy="12" r="9" /><path d="M9.5 9.5a2.5 2.5 0 1 1 3.5 2.3c-.7.4-1 .9-1 1.7M12 17h.01" /></>),
};

const LABEL: Record<string, string> = {
  success: 'Checks grün',
  failure: 'Checks fehlgeschlagen',
  pending: 'Checks laufen',
  none: 'Keine Checks',
  unknown: 'Checks unbekannt',
};

const CLASS: Record<string, string> = { success: 'ok', failure: 'danger', pending: 'info', none: 'neutral', unknown: 'neutral' };

function tip(s: PrStatus): string {
  if (s.checks === 'success') return `Alle ${s.total} ${s.total === 1 ? 'Prüfung ist' : 'Prüfungen sind'} erfolgreich durchgelaufen (CI/CD).`;
  if (s.checks === 'failure') return `Fehlgeschlagen: ${s.failed.join(', ')}. Im Pull Request siehst du die Details.`;
  if (s.checks === 'pending') return `${s.running} von ${s.total} Prüfungen laufen noch.`;
  if (s.checks === 'none') return 'Für diesen Pull Request gibt es keine automatischen Prüfungen (CI/CD).';
  return 'Die Prüfungen konnten nicht gelesen werden. Der GitHub-Token braucht "Checks: Read-only" und "Commit statuses: Read-only".';
}

/** Zeigt, ob die automatischen Prüfungen (CI/CD) eines Pull Requests bestanden haben. */
export function ChecksBadge(props: { status: PrStatus | undefined }) {
  const s = props.status;
  if (!s || s.state !== 'open') return null;
  return (
    <span class={`badge tip ${CLASS[s.checks]}`} data-tip={tip(s)} tabindex={0} style={{ display: 'inline-flex', alignItems: 'center', gap: '4px' }}>
      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
        {ICON[s.checks]}
      </svg>
      {LABEL[s.checks]}
    </span>
  );
}
