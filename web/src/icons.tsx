import type { ComponentChildren } from 'preact';

/** Eingebaute Symbole für die Schnellnavigation. Es werden keine Logos oder Bilder von fremden Seiten geladen. */
const P: Record<string, ComponentChildren> = {
  link: (<><path d="M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1" /><path d="M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1" /></>),
  globe: (<><circle cx="12" cy="12" r="10" /><path d="M2 12h20" /><path d="M12 2a15 15 0 0 1 0 20a15 15 0 0 1 0-20" /></>),
  server: (<><rect x="2" y="3" width="20" height="7" rx="2" /><rect x="2" y="14" width="20" height="7" rx="2" /><path d="M6 6.5h.01M6 17.5h.01" /></>),
  database: (<><ellipse cx="12" cy="5" rx="9" ry="3" /><path d="M3 5v14c0 1.7 4 3 9 3s9-1.3 9-3V5" /><path d="M3 12c0 1.7 4 3 9 3s9-1.3 9-3" /></>),
  shield: <path d="M12 2l8 3v6c0 5-3.5 9-8 11-4.5-2-8-6-8-11V5z" />,
  git: (<><circle cx="6" cy="6" r="2" /><circle cx="6" cy="18" r="2" /><circle cx="18" cy="8" r="2" /><path d="M6 8v8M18 10c0 4-6 3-12 6" /></>),
  container: (<><path d="M21 8l-9-5-9 5v8l9 5 9-5z" /><path d="M3 8l9 5 9-5M12 13v8" /></>),
  chart: (<><path d="M3 3v18h18" /><path d="M7 15l4-5 3 3 5-7" /></>),
  mail: (<><rect x="2" y="5" width="20" height="14" rx="2" /><path d="M2 7l10 7 10-7" /></>),
  cloud: <path d="M7 18a5 5 0 1 1 1-9.9A6 6 0 0 1 20 11a4 4 0 0 1-1 7z" />,
  file: (<><path d="M6 2h8l5 5v15H6z" /><path d="M14 2v5h5" /></>),
  lock: (<><rect x="4" y="11" width="16" height="10" rx="2" /><path d="M8 11V7a4 4 0 0 1 8 0v4" /></>),
  terminal: (<><rect x="2" y="4" width="20" height="16" rx="2" /><path d="M6 9l3 3-3 3M12 15h5" /></>),
  home: <path d="M3 11l9-8 9 8M5 10v10h14V10" />,
  camera: (<><path d="M3 7h4l2-3h6l2 3h4v13H3z" /><circle cx="12" cy="13" r="4" /></>),
  music: (<><path d="M9 18V5l11-2v13" /><circle cx="6" cy="18" r="3" /><circle cx="17" cy="16" r="3" /></>),
  video: (<><rect x="2" y="5" width="14" height="14" rx="2" /><path d="M16 10l6-3v10l-6-3" /></>),
  book: (<><path d="M4 4h16v16H4z" /><path d="M8 4v16" /></>),
  settings: (<><path d="M4 6h10M18 6h2M4 12h4M12 12h8M4 18h12M20 18h0" /><circle cx="16" cy="6" r="2" /><circle cx="10" cy="12" r="2" /><circle cx="18" cy="18" r="2" /></>),
  network: (<><circle cx="12" cy="5" r="2" /><circle cx="5" cy="19" r="2" /><circle cx="19" cy="19" r="2" /><path d="M12 7v5M12 12l-6 5M12 12l6 5" /></>),
  cpu: (<><rect x="6" y="6" width="12" height="12" rx="1" /><path d="M9 2v4M15 2v4M9 18v4M15 18v4M2 9h4M2 15h4M18 9h4M18 15h4" /></>),
  bell: (<><path d="M18 8a6 6 0 0 0-12 0c0 7-3 8-3 8h18s-3-1-3-8" /><path d="M10 21a2 2 0 0 0 4 0" /></>),
  star: <path d="M12 2l3 7 7 .5-5 5 1.5 7.5L12 18l-6.5 4 1.5-7.5-5-5L9 9z" />,
  code: <path d="M8 7l-5 5 5 5M16 7l5 5-5 5M14 4l-4 16" />,
};

export const ICON_KEYS = Object.keys(P);

const LABEL: Record<string, string> = {
  link: 'Link', globe: 'Web', server: 'Server', database: 'Datenbank', shield: 'Schutz', git: 'Git', container: 'Container', chart: 'Diagramm',
  mail: 'Post', cloud: 'Cloud', file: 'Datei', lock: 'Schloss', terminal: 'Terminal', home: 'Zuhause', camera: 'Kamera', music: 'Musik',
  video: 'Video', book: 'Buch', settings: 'Einstellungen', network: 'Netzwerk', cpu: 'Prozessor', bell: 'Glocke', star: 'Stern', code: 'Code',
};
export const iconLabel = (key: string): string => LABEL[key] ?? key;

/** `i:<name>` = eingebautes Symbol im selben Stil wie die übrigen Symbole der Oberfläche (Linie, currentColor). */
export function LinkIcon(props: { icon: string; size?: number }) {
  const size = props.size ?? 18;
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
      {P[props.icon.replace(/^i:/, '')] ?? P.link}
    </svg>
  );
}
