import { TeamSize } from './config';
import { Player, Role } from './player';
import { Rng } from './rng';

export interface TeamInfo {
  name: string;
  short: string;
  primary: string;
  secondary: string;
  /** shorts / socks accent */
  accent: string;
}

/** Selectable clubs (fictional). */
export const TEAM_PRESETS: TeamInfo[] = [
  { name: 'Bro United', short: 'BRO', primary: '#e63946', secondary: '#ffffff', accent: '#1d1d1d' },
  { name: 'Sky Rovers', short: 'SKY', primary: '#3a86ff', secondary: '#ffffff', accent: '#0b2545' },
  { name: 'Lime City', short: 'LIM', primary: '#70e000', secondary: '#1b4332', accent: '#ffffff' },
  { name: 'Sunny Athletic', short: 'SUN', primary: '#ffbe0b', secondary: '#1d3557', accent: '#1d3557' },
  { name: 'Grape FC', short: 'GRP', primary: '#8338ec', secondary: '#f1faee', accent: '#2b2d42' },
  { name: 'Orange Town', short: 'ORA', primary: '#fb5607', secondary: '#000000', accent: '#ffffff' },
  { name: 'Snow Wanderers', short: 'SNW', primary: '#f8f9fa', secondary: '#212529', accent: '#e63946' },
  { name: 'Pink Panthers', short: 'PNK', primary: '#ff4d9d', secondary: '#2b2d42', accent: '#2b2d42' },
];

type Slot = { role: Role; x: number; z: number };

/** Formations: x from own goal (0) to opponent goal (1), z across the pitch [-1, 1]. */
export const FORMATIONS: Record<TeamSize, Slot[]> = {
  11: [
    { role: 'GK', x: 0.03, z: 0 },
    { role: 'DEF', x: 0.2, z: -0.72 },
    { role: 'DEF', x: 0.17, z: -0.26 },
    { role: 'DEF', x: 0.17, z: 0.26 },
    { role: 'DEF', x: 0.2, z: 0.72 },
    { role: 'MID', x: 0.4, z: -0.68 },
    { role: 'MID', x: 0.35, z: -0.2 },
    { role: 'MID', x: 0.35, z: 0.2 },
    { role: 'MID', x: 0.4, z: 0.68 },
    { role: 'FWD', x: 0.55, z: -0.18 },
    { role: 'FWD', x: 0.55, z: 0.18 },
  ],
  7: [
    { role: 'GK', x: 0.03, z: 0 },
    { role: 'DEF', x: 0.2, z: -0.45 },
    { role: 'DEF', x: 0.2, z: 0.45 },
    { role: 'MID', x: 0.38, z: -0.65 },
    { role: 'MID', x: 0.34, z: 0 },
    { role: 'MID', x: 0.38, z: 0.65 },
    { role: 'FWD', x: 0.55, z: 0 },
  ],
  5: [
    { role: 'GK', x: 0.03, z: 0 },
    { role: 'DEF', x: 0.22, z: -0.4 },
    { role: 'DEF', x: 0.22, z: 0.4 },
    { role: 'MID', x: 0.38, z: 0 },
    { role: 'FWD', x: 0.55, z: 0 },
  ],
};

const FIRST = ['Leo', 'Max', 'Rio', 'Kai', 'Tom', 'Ivo', 'Sam', 'Ben', 'Zed', 'Ali', 'Nik', 'Dan', 'Pip', 'Jon', 'Ray', 'Gus', 'Ted', 'Vic', 'Lou', 'Moe'];
const LAST = ['Bro', 'Kickz', 'Volley', 'Curl', 'Nutmeg', 'Rocket', 'Pace', 'Header', 'Boots', 'Dribbl', 'Topspin', 'Panna', 'Rabona', 'Chip', 'Lobster', 'Finesse', 'Banger', 'Wall', 'Gloves', 'Tekky'];

export const CHARACTER_MODELS = [
  'character-male-a', 'character-male-b', 'character-male-c', 'character-male-d', 'character-male-e', 'character-male-f',
  'character-female-a', 'character-female-b', 'character-female-c', 'character-female-d', 'character-female-e', 'character-female-f',
];

export class Team {
  score = 0;
  shots = 0;
  shotsOnTarget = 0;
  possessionT = 0;
  /** +1 attacks towards +x, -1 towards -x */
  attackDir = 1;
  players: Player[] = [];
  constructor(public index: number, public info: TeamInfo, public skill: number) {}
}

export function buildTeam(index: number, info: TeamInfo, size: TeamSize, skill: number, idStart: number, rng: Rng): Team {
  const t = new Team(index, info, skill);
  const slots = FORMATIONS[size];
  const numbers: Record<Role, number[]> = { GK: [1], DEF: [2, 3, 4, 5, 6], MID: [8, 6, 10, 7, 14], FWD: [9, 11, 19] };
  const used: Record<Role, number> = { GK: 0, DEF: 0, MID: 0, FWD: 0 };
  const models = [...CHARACTER_MODELS].sort(() => rng.next() - 0.5);
  slots.forEach((s, i) => {
    const r = () => Math.min(0.99, Math.max(0.3, skill + rng.range(-0.12, 0.12)));
    const stats = { pace: r(), shot: r(), pass: r(), dribble: r(), tackle: r(), gk: s.role === 'GK' ? r() : 0.2 };
    if (s.role === 'FWD') stats.shot = Math.min(0.99, stats.shot + 0.08);
    if (s.role === 'DEF') stats.tackle = Math.min(0.99, stats.tackle + 0.08);
    const num = numbers[s.role][used[s.role]++] ?? 12 + i;
    const name = `${rng.pick(FIRST)} ${rng.pick(LAST)}`;
    const p = new Player(idStart + i, index, i, s.role, num, name, { x: s.x, z: s.z }, stats, CHARACTER_MODELS.indexOf(models[i % models.length]));
    t.players.push(p);
  });
  return t;
}
