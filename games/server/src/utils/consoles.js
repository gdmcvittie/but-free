export const SUPPORTED_EMULATOR_CONSOLES = new Set([
  'snes', 'nes', 'gba', 'gb', 'gbc', 'sega', 'genesis', 'megadrive',
  'gg', 'gamegear', 'sms', 'mastersystem', 'pce', 'tg16',
  'neo', 'neogeo', 'arcade', 'pico8'
]);

export const CONSOLE_DISPLAY_NAMES = {
  nes: 'NES',
  snes: 'SNES',
  gb: 'Game Boy',
  gbc: 'Game Boy Color',
  gba: 'Game Boy Advance',
  sega: 'Genesis',
  genesis: 'Genesis',
  megadrive: 'Mega Drive',
  neo: 'Neo Geo',
  neogeo: 'Neo Geo',
  arcade: 'Arcade',
  pce: 'PC Engine',
  tg16: 'TurboGrafx-16',
  gg: 'Game Gear',
  sms: 'Master System',
  pc: 'PC Games',
  web: 'Web Games',
  switch: 'Nintendo Switch',
  psx: 'PlayStation',
  ps1: 'PlayStation',
  ps2: 'PlayStation 2',
  ps3: 'PlayStation 3',
  ps4: 'PlayStation 4',
  ps5: 'PlayStation 5',
  psp: 'PSP',
  vita: 'PS Vita',
  n64: 'Nintendo 64',
  nds: 'Nintendo DS',
  '3ds': 'Nintendo 3DS',
  gamecube: 'GameCube',
  wii: 'Wii',
  wiiu: 'Wii U',
  xbox: 'Xbox',
  xbox360: 'Xbox 360',
  xboxone: 'Xbox One',
  saturn: 'Sega Saturn',
  dreamcast: 'Dreamcast',
  atari: 'Atari',
  amiga: 'Amiga',
  c64: 'Commodore 64',
  dos: 'DOS',
  vb: 'Virtual Boy',
  pico8: 'PICO-8'
};

export function formatConsoleName(key) {
  if (!key) return 'Other';
  const lower = String(key).toLowerCase().trim();
  if (CONSOLE_DISPLAY_NAMES[lower]) return CONSOLE_DISPLAY_NAMES[lower];
  return key
    .split(/[-_\s]+/)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ');
}

export function isGameDownloadOnly(game) {
  if (!game) return false;
  if (game.isWebGame || game.console === 'web' || (game.webUrl || '').startsWith('http')) {
    return false;
  }
  if (game.isDownloadOnly || game.isPcGame || game.isFolder) {
    return true;
  }
  const consoleNormalized = String(game.console || '').toLowerCase().trim();
  if (!consoleNormalized) return true;
  if (consoleNormalized === 'pc') return true;
  return !SUPPORTED_EMULATOR_CONSOLES.has(consoleNormalized);
}
