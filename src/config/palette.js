/**
 * Central visual identity: dark industrial sci-fi, low visual noise.
 * Everything is drawn procedurally, so the palette is the entire "asset" set.
 */

export const PALETTE = {
  void: '#05070b',
  deep: '#0a0e14',
  floor: '#0e131b',
  floorAlt: '#111823',
  floorLine: '#1a2331',
  wall: '#1b2330',
  wallTop: '#2a3647',
  wallEdge: '#3b4a60',
  obstacle: '#151d29',
  obstacleTop: '#243044',
  grid: 'rgba(80, 120, 170, 0.06)',

  player: '#7fe6ff',
  playerGlow: 'rgba(127, 230, 255, 0.35)',
  playerDark: '#1d4a5c',

  health: '#ff4d6d',
  healthDark: '#4a1626',
  armor: '#5aa9ff',
  armorDark: '#12294a',
  energy: '#ffd166',
  energyDark: '#4a3a12',
  xp: '#c084fc',

  friendly: '#6fe3c4',
  hostile: '#ff6b5c',
  hostileElite: '#ffb03a',
  boss: '#ff5c33',

  ui: '#dce6f2',
  uiStrong: '#f2f7ff',
  uiDim: '#8b9cb2',
  /**
   * Tertiary text (hints, metadata). Measured against the panel surface:
   * 4.24:1 — readable at small sizes, still clearly below body text.
   */
  uiGhost: '#6b7d94',
  /** Disabled controls: legible but unmistakably inactive (3.01:1). */
  uiDisabled: '#55657c',
  /** Non-text fills only (inactive pips, map blocks) — never used for copy. */
  uiFaint: '#3a475a',
  uiAccent: '#7fe6ff',
  uiAccentSoft: 'rgba(127, 230, 255, 0.14)',
  uiWarn: '#ffb03a',
  uiDanger: '#ff4d6d',
  uiGood: '#6fe3c4',
  uiPanel: 'rgba(10, 15, 22, 0.92)',
  uiPanelSolid: '#0b1119',
  uiBorder: 'rgba(127, 230, 255, 0.22)',
  /** Meter tracks and inner surfaces. */
  uiTrack: 'rgba(4, 7, 11, 0.92)',
  uiTrackLight: 'rgba(255, 255, 255, 0.06)',
  uiShadow: 'rgba(0, 0, 0, 0.5)',

  lootCommon: '#9fb3c8',
  lootUncommon: '#6fe3c4',
  lootRare: '#5aa9ff',
  lootEpic: '#c084fc',
  lootLegendary: '#ffb03a',

  extraction: '#6fe3c4',
  descend: '#c084fc',
  objective: '#ffd166',
};

export const FONTS = {
  display: '"Rajdhani", "Bahnschrift", "DIN Alternate", "Segoe UI", system-ui, sans-serif',
  body: '"Inter", "Segoe UI", system-ui, -apple-system, sans-serif',
  mono: '"JetBrains Mono", "Cascadia Mono", "Consolas", ui-monospace, monospace',
};

export const FONT_SIZES = {
  micro: 10,
  tiny: 11,
  small: 13,
  body: 15,
  large: 19,
  heading: 26,
  title: 46,
  huge: 68,
};

export const UI = {
  radius: 6,
  radiusLarge: 12,
  gap: 8,
  pad: 14,
  borderWidth: 1,
  hudScale: 1,
};

/** Zone tints so consecutive sectors read as different places. */
export const SECTOR_TINTS = [
  { floor: '#0e131b', accent: '#7fe6ff' },
  { floor: '#131118', accent: '#c084fc' },
  { floor: '#141210', accent: '#ffb03a' },
  { floor: '#0f1414', accent: '#6fe3c4' },
  { floor: '#141013', accent: '#ff6b9d' },
  { floor: '#101317', accent: '#9fb3c8' },
];

export function sectorTint(tier) {
  return SECTOR_TINTS[Math.max(0, Math.min(SECTOR_TINTS.length - 1, tier - 1))];
}

export function rgba(hex, alpha) {
  if (hex.startsWith('rgba') || hex.startsWith('rgb')) return hex;
  const value = hex.replace('#', '');
  const full = value.length === 3 ? value.split('').map((c) => c + c).join('') : value;
  const num = parseInt(full, 16);
  const r = (num >> 16) & 255;
  const g = (num >> 8) & 255;
  const b = num & 255;
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

export function mixColor(a, b, t) {
  const pa = parseInt(a.replace('#', ''), 16);
  const pb = parseInt(b.replace('#', ''), 16);
  const ar = (pa >> 16) & 255;
  const ag = (pa >> 8) & 255;
  const ab = pa & 255;
  const br = (pb >> 16) & 255;
  const bg = (pb >> 8) & 255;
  const bb = pb & 255;
  const r = Math.round(ar + (br - ar) * t);
  const g = Math.round(ag + (bg - ag) * t);
  const bl = Math.round(ab + (bb - ab) * t);
  return `rgb(${r}, ${g}, ${bl})`;
}

export function rarityColor(rarity) {
  return (
    {
      common: PALETTE.lootCommon,
      uncommon: PALETTE.lootUncommon,
      rare: PALETTE.lootRare,
      epic: PALETTE.lootEpic,
      legendary: PALETTE.lootLegendary,
    }[rarity] ?? PALETTE.lootCommon
  );
}
