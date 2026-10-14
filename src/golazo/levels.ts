/**
 * Golazo levels. Coordinates: [d, z] — d = metres out from the goal line we attack, z = across
 * the pitch (+ = right as seen from behind the ball looking at the goal). mates[0] has the ball.
 * runs[k] = the path a team-mate runs when the k-th kick of the level is struck.
 */

export interface MateDef {
  at: [number, number];
  run?: [number, number][];
  runs?: [number, number][][];
  delay?: number[];
  speed?: number;
  name?: string;
  n?: number;
}

export interface OppDef {
  at: [number, number];
  speed?: number;
  reach?: number;
  zone?: number;
  react?: number;
}

export interface LevelDef {
  id: number;
  chapter: number;
  title: string;
  brief: string;
  tip?: string;
  kind: 'open' | 'freekick' | 'penalty' | 'corner';
  ball?: [number, number];
  mates: MateDef[];
  opps: OppDef[];
  wall?: number;
  /** keeper skill 0..1 */
  gk?: number;
  /** points for 2 and 3 stars (1 star = any goal) */
  stars: [number, number];
  /** match context shown on the intro card */
  minute?: number;
  score?: [number, number];
}

export const CHAPTERS = ['Первый сезон', 'Плей-офф', 'Финал кубка'];

export const LEVELS: LevelDef[] = [
  // ---------------------------------------------------------------- chapter 1
  {
    id: 1, chapter: 0, kind: 'open', title: 'Первый удар', minute: 12, score: [0, 0],
    brief: 'Проведи линию от мяча в ворота — мяч полетит точно туда.',
    tip: 'Целься в угол, подальше от вратаря. Под перекладину — ещё больше очков.',
    mates: [{ at: [17, -2] }],
    opps: [],
    gk: 0.25,
    stars: [640, 790],
  },
  {
    id: 2, chapter: 0, kind: 'open', title: 'Банан', minute: 27, score: [0, 0],
    brief: 'Защитник закрыл ближний угол. Изогни линию — мяч закрутится в обход.',
    tip: 'Нарисуй дугу: мяч полетит по ней. Кручёный удар — +очки.',
    mates: [{ at: [19, -7] }],
    opps: [{ at: [12, -4.5], zone: 1.2, speed: 3 }],
    gk: 0.35,
    stars: [880, 1100],
  },
  {
    id: 3, chapter: 0, kind: 'open', title: 'Первый пас', minute: 34, score: [0, 1],
    brief: 'Издалека не забить. Отдай пас партнёру — проведи линию к нему.',
    tip: 'Пас по земле идёт точно в точку. Потом бей с его позиции.',
    mates: [{ at: [32, -8] }, { at: [15, 7], n: 9 }],
    opps: [{ at: [22, -3], zone: 3 }, { at: [12, -1], zone: 2.5 }],
    gk: 0.4,
    stars: [800, 1050],
  },
  {
    id: 4, chapter: 0, kind: 'open', title: 'На ход', minute: 51, score: [1, 1],
    brief: 'Нападающий делает рывок. Отдай пас не в ноги, а туда, куда он бежит.',
    tip: 'Стрелка показывает забегание партнёра. Пас — в конец стрелки.',
    mates: [{ at: [34, 2] }, { at: [24, 9], run: [[11, 4]], n: 9 }],
    opps: [{ at: [22, 5], zone: 3.5 }, { at: [20, -3], zone: 3 }],
    gk: 0.45,
    stars: [800, 1050],
  },
  {
    id: 5, chapter: 0, kind: 'open', title: 'Через голову', minute: 63, score: [1, 1],
    brief: 'Защитник стоит на линии паса. Пас пойдёт по воздуху сам — линия просто проходит над ним.',
    tip: 'Если на пути паса соперник, мяч летит навесом.',
    mates: [{ at: [30, -4] }, { at: [13, 3], n: 9 }],
    opps: [{ at: [22, -0.5], zone: 3 }, { at: [16, 7], zone: 3 }],
    gk: 0.45,
    stars: [800, 1100],
  },
  {
    id: 6, chapter: 0, kind: 'freekick', title: 'Штрафной', minute: 78, score: [1, 1],
    brief: 'Штрафной с 22 метров. Закрути мяч над стенкой или в обход неё.',
    tip: 'Стенка прыгает. Дуга в дальний угол — самый верный вариант.',
    mates: [{ at: [22, -5] }],
    opps: [],
    wall: 4,
    gk: 0.5,
    stars: [950, 1200],
  },
  {
    id: 7, chapter: 0, kind: 'penalty', title: 'Пенальти', minute: 89, score: [1, 1],
    brief: 'Последняя минута. Пенальти! Обмани вратаря.',
    tip: 'В центр он не пропустит. Только в угол.',
    mates: [{ at: [11, 0] }],
    opps: [],
    gk: 0.65,
    stars: [650, 800],
  },
  {
    id: 8, chapter: 0, kind: 'open', title: 'Навес', minute: 70, score: [0, 0],
    brief: 'Ты на фланге. Навесь на нападающего — когда мяч дойдёт до него, бей головой.',
    tip: 'Пас на партнёра в штрафной идёт навесом на голову. Потом рисуй удар.',
    mates: [{ at: [22, -25] }, { at: [14, -2], run: [[7, -1]], n: 9 }],
    opps: [{ at: [15, -7], zone: 2.5 }, { at: [9, 3], zone: 2.5 }, { at: [20, -20], zone: 2 }],
    gk: 0.45,
    stars: [900, 1150],
  },
  {
    id: 9, chapter: 0, kind: 'open', title: 'Стенка', minute: 40, score: [0, 1],
    brief: 'Отдай пас и беги — партнёр вернёт мяч в одно касание.',
    tip: 'Пас партнёру, потом от него — пас тебе на ход (твоё забегание — стрелка).',
    mates: [{ at: [30, 0], runs: [[], [[14, 2]]] }, { at: [22, -7], n: 9 }],
    opps: [{ at: [24, 1.5], zone: 2.5, speed: 5 }, { at: [16, -3], zone: 3 }, { at: [14, 6], zone: 2.5 }],
    gk: 0.5,
    stars: [900, 1250],
  },
  {
    id: 10, chapter: 0, kind: 'corner', title: 'Угловой', minute: 86, score: [1, 1],
    brief: 'Угловой! Навесь на ближнего или дальнего — и замкни.',
    tip: 'Выбери того, кто открылся. С лёта или головой — больше очков.',
    ball: [0.5, -33.5],
    mates: [{ at: [1.3, -34.2] }, { at: [13, -4], run: [[6, -2]], n: 4 }, { at: [12, 4], run: [[7, 2.5]], n: 9 }],
    opps: [{ at: [6, -3], zone: 2 }, { at: [7, 1], zone: 2 }, { at: [10, 5], zone: 2 }],
    gk: 0.45,
    stars: [900, 1150],
  },
  // ---------------------------------------------------------------- chapter 2
  {
    id: 11, chapter: 1, kind: 'open', title: 'Треугольник', minute: 22, score: [0, 0],
    brief: 'Два паса — и удар. Защитники играют плотно.',
    mates: [{ at: [36, -6] }, { at: [27, 10], n: 8 }, { at: [17, -2], runs: [[], [[12, -6]]], n: 9 }],
    opps: [{ at: [28, -1], zone: 3 }, { at: [20, 5], zone: 3 }, { at: [16, -8], zone: 3 }, { at: [13, 1], zone: 3 }],
    gk: 0.55,
    stars: [1000, 1300],
  },
  {
    id: 12, chapter: 1, kind: 'freekick', title: 'Дальний штрафной', minute: 55, score: [0, 1],
    brief: 'Штрафной с 27 метров, стенка из пяти. Нужна пушка с подкруткой.',
    mates: [{ at: [27, 3] }],
    opps: [],
    wall: 5,
    gk: 0.55,
    stars: [1150, 1450],
  },
  {
    id: 13, chapter: 1, kind: 'open', title: 'Один на один', minute: 67, score: [1, 1],
    brief: 'Пас в разрез на нападающего — и он выходит один на один.',
    tip: 'Вратарь выйдет. Пас не должен катиться в его зону.',
    mates: [{ at: [38, 0] }, { at: [27, -6], run: [[14, -3]], n: 9 }],
    opps: [{ at: [26, -3], zone: 3 }, { at: [25, 4], zone: 3 }, { at: [30, -10], zone: 2 }],
    gk: 0.6,
    stars: [800, 1050],
  },
  {
    id: 14, chapter: 1, kind: 'open', title: 'Перевод', minute: 74, score: [2, 2],
    brief: 'Вся оборона сместилась влево. Переведи игру на свободный фланг.',
    mates: [{ at: [30, -18] }, { at: [24, 19], run: [[16, 14]], n: 11 }, { at: [16, -4], run: [[9, -1]], n: 9 }],
    opps: [{ at: [25, -12], zone: 3 }, { at: [17, -9], zone: 3 }, { at: [13, -2], zone: 3 }, { at: [20, 4], zone: 3 }],
    gk: 0.55,
    stars: [1000, 1300],
  },
  {
    id: 15, chapter: 1, kind: 'open', title: 'С лёта', minute: 81, score: [0, 0],
    brief: 'Навес на дальнюю штангу — и удар с лёта, пока мяч не упал.',
    mates: [{ at: [18, 26] }, { at: [12, -6], run: [[9, -5]], n: 7 }, { at: [10, 2], run: [[6, 0]], n: 9 }],
    opps: [{ at: [8, 1], zone: 2 }, { at: [11, -2], zone: 2 }, { at: [16, 20], zone: 2 }],
    gk: 0.6,
    stars: [1000, 1250],
  },
  {
    id: 16, chapter: 1, kind: 'penalty', title: 'Серия пенальти', minute: 120, score: [3, 3],
    brief: 'Решающий удар серии. Вратарь — мастер пенальти.',
    mates: [{ at: [11, 0] }],
    opps: [],
    gk: 0.85,
    stars: [650, 800],
  },
  {
    id: 17, chapter: 1, kind: 'corner', title: 'Розыгрыш углового', minute: 59, score: [0, 1],
    brief: 'Сыграй угловой коротко — на партнёра у штрафной, и оттуда в угол.',
    ball: [0.5, 33.5],
    mates: [{ at: [1.3, 34.2] }, { at: [6, 24], run: [[15, 15]], n: 8 }, { at: [10, 3], runs: [[], [[6, 1]]], n: 9 }],
    opps: [{ at: [5, 2], zone: 2 }, { at: [8, 6], zone: 2.5 }, { at: [6, -3], zone: 2 }, { at: [4, 27], zone: 2, speed: 5 }],
    gk: 0.55,
    stars: [1000, 1300],
  },
  {
    id: 18, chapter: 1, kind: 'freekick', title: 'Под стенку', minute: 90, score: [1, 2],
    brief: 'Штрафной с 18 метров, прямо по центру. Стенка прыгнет — а ты?',
    tip: 'Стенка прыгает! Низом под ней тоже можно.',
    mates: [{ at: [18, 0] }],
    opps: [],
    wall: 5,
    gk: 0.6,
    stars: [800, 1050],
  },
  {
    id: 19, chapter: 1, kind: 'open', title: 'Контратака', minute: 88, score: [1, 1],
    brief: 'Три в два! Быстро переведи мяч и добей.',
    mates: [{ at: [45, 0] }, { at: [40, -14], run: [[22, -12], [16, -8]], n: 7 }, { at: [40, 13], run: [[24, 11], [14, 4]], n: 11 }],
    opps: [{ at: [26, -4], zone: 4, speed: 6.6 }, { at: [24, 5], zone: 4, speed: 6.6 }],
    gk: 0.6,
    stars: [1000, 1300],
  },
  {
    id: 20, chapter: 1, kind: 'open', title: 'Финал сезона', minute: 93, score: [2, 2],
    brief: 'Последняя атака сезона. Три паса до гола — и ты чемпион.',
    mates: [{ at: [42, 10] }, { at: [33, -6], runs: [[], [[24, -14]]], n: 8 }, { at: [26, 8], runs: [[], [], []], n: 10 }, { at: [18, -1], runs: [[], [], [[11, 3]]], n: 9 }],
    opps: [{ at: [35, 3], zone: 3 }, { at: [28, -9], zone: 3 }, { at: [22, 2], zone: 3 }, { at: [16, -6], zone: 3 }, { at: [13, 5], zone: 3 }],
    gk: 0.65,
    stars: [1200, 1600],
  },
];
