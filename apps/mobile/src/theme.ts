/**
 * Fermosa mobile design tokens — the glossy-gold brand, mirrored from the
 * dashboard (packages: same palette so both apps feel like one product).
 */
export const colors = {
  // Brand gold
  gold: '#F5C518',
  goldDark: '#D9A400',
  goldDeep: '#B7860B',
  goldSoft: '#FBE68A',
  goldTint: '#FEFBEA',
  onGold: '#3A2D06', // dark ink for text/icons on a gold surface

  // Neutrals (warm, slight gold bias)
  ink: '#1A1712',
  muted: '#8A8375',
  ground: '#F7F6F2',
  card: '#FFFFFF',
  line: '#EAE7DE',
  white: '#FFFFFF',

  // Semantic status (kept separate from the brand accent)
  good: '#15803D',
  warn: '#B45309',
  bad: '#B91C1C',
  info: '#0369A1',
} as const;

export const radius = { sm: 8, md: 12, lg: 16, xl: 20, pill: 999 } as const;

export const shadowCard = {
  shadowColor: '#3c2e0a',
  shadowOpacity: 0.08,
  shadowRadius: 12,
  shadowOffset: { width: 0, height: 4 },
  elevation: 3,
} as const;

/** Fermosa "F" mark (white background, blends into a white logo badge). */
export const logoMark = require('../assets/icon.jpg');
