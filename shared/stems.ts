/**
 * Canonical stem vocabulary — the TypeScript mirror of
 * `python/sipra_core/stems.py`.
 *
 * A test asserts the two stay in step. If you change one, change both.
 */

export type StemId = 'vocals' | 'drums' | 'bass' | 'guitar' | 'piano' | 'other';

export interface StemDefinition {
  readonly id: StemId;
  readonly label: string;
  readonly color: string;
  readonly order: number;
  readonly experimental: boolean;
  readonly note: string;
}

export const STEM_DEFINITIONS: readonly StemDefinition[] = [
  { id: 'vocals', label: 'Vocals', color: '#FF6B4A', order: 0, experimental: false, note: '' },
  { id: 'drums', label: 'Drums', color: '#FFB020', order: 1, experimental: false, note: '' },
  { id: 'bass', label: 'Bass', color: '#7C5CFF', order: 2, experimental: false, note: '' },
  {
    id: 'guitar',
    label: 'Guitar',
    color: '#2ECC71',
    order: 3,
    experimental: true,
    note: 'Separated only by the 6-stem model. Usable, but expect some bleed.',
  },
  {
    id: 'piano',
    label: 'Piano',
    color: '#35B7FF',
    order: 4,
    experimental: true,
    note:
      "The weakest source in the 6-stem model. Demucs' own documentation reports heavy " +
      'bleeding and artefacts here. Treat it as a rough guide.',
  },
  { id: 'other', label: 'Other', color: '#9AA3B2', order: 5, experimental: false, note: '' },
] as const;

export const STEM_IDS: readonly StemId[] = STEM_DEFINITIONS.map((s) => s.id);

export const STEM_BY_ID: Readonly<Record<StemId, StemDefinition>> = Object.fromEntries(
  STEM_DEFINITIONS.map((s) => [s.id, s]),
) as Record<StemId, StemDefinition>;

export const FOUR_STEM_SET: readonly StemId[] = ['vocals', 'drums', 'bass', 'other'];
export const SIX_STEM_SET: readonly StemId[] = [
  'vocals',
  'drums',
  'bass',
  'guitar',
  'piano',
  'other',
];

export function isStemId(value: unknown): value is StemId {
  return typeof value === 'string' && value in STEM_BY_ID;
}

/** Canonical display order. Unknown ids are kept, sorted, and put last. */
export function sortStems(ids: readonly string[]): string[] {
  const known: StemId[] = [];
  const unknown: string[] = [];
  for (const id of ids) {
    if (isStemId(id)) known.push(id);
    else unknown.push(id);
  }
  known.sort((a, b) => STEM_BY_ID[a].order - STEM_BY_ID[b].order);
  unknown.sort();
  return [...known, ...unknown];
}

export function stemLabel(id: string): string {
  return isStemId(id) ? STEM_BY_ID[id].label : id;
}

export function stemColor(id: string): string {
  return isStemId(id) ? STEM_BY_ID[id].color : '#9AA3B2';
}
