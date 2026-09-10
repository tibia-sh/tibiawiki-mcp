export const ELEMENTS = [
  'physical', 'earth', 'fire', 'ice', 'energy',
  'death', 'holy', 'drown', 'lifedrain', 'healing',
] as const;

export type Element = (typeof ELEMENTS)[number];
