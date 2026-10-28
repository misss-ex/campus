/**
 * schedule.js — работа с расписанием в мини-приложении.
 * Без зависимостей, ES-модуль. Подключение:
 *   import { Schedule } from './schedule.js';
 *   const s = new Schedule({ baseUrl: './data' });
 *   const index = await s.loadIndex();
 *   const group = await s.loadGroup('КП-101');
 *   s.getNow(group);            // что идёт сейчас и что дальше
 *   s.getDay(group, '2026-10-26');
 *   s.getWeek(group, new Date());
 *
 * Время в данных — московское. Все расчёты «сейчас/сегодня» ведутся по Москве,
 * независимо от часового пояса телефона.
 */

export const TZ = 'Europe/Moscow';
export const WEEKDAYS = ['Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб', 'Вс'];
export const WEEKDAYS_FULL = ['Понедельник', 'Вторник', 'Среда', 'Четверг', 'Пятница', 'Суббота', 'Воскресенье'];
const MONTHS_GEN = ['января', 'февраля', 'марта', 'апреля', 'мая', 'июня', 'июля', 'августа', 'сентября', 'октября', 'ноября', 'декабря'];
const MONTHS = ['Январь', 'Февраль', 'Март', 'Апрель', 'Май', 'Июнь', 'Июль', 'Август', 'Сентябрь', 'Октябрь', 'Ноябрь', 'Декабрь'];

// ---------------------------------------------------------------- даты/время

/** Текущие дата и минуты по Москве: { iso: '2026-10-26', minutes: 690 } */
export function moscowNow(date = new Date()) {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-CA', {
    timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).formatToParts(date).map(x => [x.type, x.value]));
  return { iso: `${p.year}-${p.month}-${p.day}`, minutes: +p.hour * 60 + +p.minute };
}

export const toMin = hhmm => { const [h, m] = hhmm.split(':').map(Number); return h * 60 + m; };

/** Date | 'YYYY-MM-DD' → 'YYYY-MM-DD' (для Date — московская дата) */
export function isoOf(d) { return typeof d === 'string' ? d.slice(0, 10) : moscowNow(d).iso; }

/** Прибавить дни к ISO-дате */
export function addDays(iso, n) {
  const d = new Date(iso + 'T12:00:00Z');
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

/** День недели 1..7 (Пн=1) */
export function weekday(iso) { const w = new Date(iso + 'T12:00:00Z').getUTCDay(); return w === 0 ? 7 : w; }

/** Понедельник недели, в которую входит дата */
export function mondayOf(iso) { return addDays(iso, 1 - weekday(iso)); }

/** «Понедельник, 26 октября» */
export function formatDayTitle(iso) {
  const [, m, d] = iso.split('-').map(Number);
  return `${WEEKDAYS_FULL[weekday(iso) - 1]}, ${d} ${MONTHS_GEN[m - 1]}`;
}
export function formatMonth(iso) { const [y, m] = iso.split('-').map(Number); return `${MONTHS[m - 1]} ${y}`; }

/** Номер учебной недели от начала семестра (неделя с 1 сентября = 1) */
export function studyWeek(iso, semester) {
  const days = (Date.parse(mondayOf(iso)) - Date.parse(mondayOf(semester.start))) / 864e5;
  return Math.floor(days / 7) + 1;
}

/** Чётность в терминах расписания: 1 = «1 неделя» (нечётная), 2 = «2 неделя» */
export function weekParity(iso, semester) { return studyWeek(iso, semester) % 2 === 1 ? 1 : 2; }

// ---------------------------------------------------------------- хранилище

const ls = {
  get(k) { try { return localStorage.getItem(k); } catch { return null; } },
  set(k, v) { try { localStorage.setItem(k, v); } catch { /* приватный режим */ } },
};

/** Сохранение настроек: Telegram CloudStorage (синхронно между устройствами) + localStorage */
export const prefs = {
  _cloud() { return window.Telegram?.WebApp?.CloudStorage; },
  async get(key) {
    const local = ls.get('pref:' + key);
    const cloud = this._cloud();
    if (!cloud || !window.Telegram.WebApp.initData) return local;
    return new Promise(res => {
      try { cloud.getItem(key, (err, v) => res(err ? local : (v || local))); } catch { res(local); }
    });
  },
  async set(key, value) {
    ls.set('pref:' + key, value);
    const cloud = this._cloud();
    if (cloud && window.Telegram.WebApp.initData) {
      try { cloud.setItem(key, value); } catch { /* нет доступа — достаточно localStorage */ }
    }
  },
};

// ---------------------------------------------------------------- расписание

export class Schedule {
  constructor({ baseUrl = './data' } = {}) {
    this.baseUrl = baseUrl.replace(/\/$/, '');
    this.index = null;
    this._groups = new Map();
  }

  async _fetchJson(path, cacheKey) {
    try {
      const r = await fetch(`${this.baseUrl}/${path}`, { cache: 'no-cache' });
      if (!r.ok) throw new Error(r.status);
      const json = await r.json();
      if (cacheKey) ls.set(cacheKey, JSON.stringify(json));
      return json;
    } catch (e) {
      // офлайн — берём последнюю сохранённую копию
      const cached = cacheKey && ls.get(cacheKey);
      if (cached) return JSON.parse(cached);
      throw e;
    }
  }

  /** index.json: факультеты → курсы → группы */
  async loadIndex() {
    this.index = await this._fetchJson('index.json', 'sched:index');
    return this.index;
  }

  /** Плоский список групп для выбора: [{id, slug, faculty, faculty_name, course, stream}] */
  listGroups() {
    if (!this.index) throw new Error('Сначала вызовите loadIndex()');
    return this.index.faculties.flatMap(f => f.courses.flatMap(c => c.groups.map(g => ({
      ...g, faculty: f.id, faculty_name: f.name, course: c.course, stream: c.stream,
    }))));
  }

  /** Найти группу по вводу: «кп101», «С-105», «s-105» */
  findGroup(query) {
    const norm = s => String(s).toLowerCase().replace(/[\s\-–_]/g, '');
    const q = norm(query);
    return this.listGroups().find(g => norm(g.id) === q || norm(g.slug) === q) || null;
  }

  /** Загрузить расписание группы (по id «КП-101» или slug «kp-101») */
  async loadGroup(groupIdOrSlug) {
    if (!this.index) await this.loadIndex();
    const g = this.listGroups().find(x => x.id === groupIdOrSlug || x.slug === groupIdOrSlug);
    if (!g) throw new Error(`Группа не найдена: ${groupIdOrSlug}`);
    if (this._groups.has(g.slug)) return this._groups.get(g.slug);
    const data = await this._fetchJson(`groups/${g.slug}.json?v=${this.index.version}`, `sched:g:${g.slug}:${this.index.version}`);
    // индекс «дата → занятия» для быстрых выборок
    data._byDate = new Map();
    for (const ev of data.events) for (const d of ev.dates) {
      if (!data._byDate.has(d)) data._byDate.set(d, []);
      data._byDate.get(d).push(ev);
    }
    this._groups.set(g.slug, data);
    return data;
  }

  /**
   * Занятия группы на дату, по времени.
   * Каждый элемент: { ...event, teacher (с учётом замен по датам), conflict: string|null,
   *                   startMin, endMin, number (номер пары в дне) }
   */
  getDay(group, date) {
    const iso = isoOf(date);
    const list = (group._byDate.get(iso) || []).map(ev => ({
      ...ev,
      date: iso,
      teacher: ev.teacher_by_date?.[iso] || ev.teacher,
      conflict: ev.conflicts?.[iso] || null,
      startMin: toMin(ev.start),
      endMin: toMin(ev.end),
    })).sort((a, b) => a.startMin - b.startMin || a.subject.localeCompare(b.subject));
    list.forEach((ev, i) => { ev.number = i + 1; });
    return list;
  }

  /** Неделя (Пн–Вс), в которую входит дата: [{ date, weekday, title, lessons }] */
  getWeek(group, date) {
    const mon = mondayOf(isoOf(date));
    return Array.from({ length: 7 }, (_, i) => {
      const iso = addDays(mon, i);
      return { date: iso, weekday: WEEKDAYS[i], day: +iso.slice(8), title: formatDayTitle(iso), lessons: this.getDay(group, iso) };
    });
  }

  /**
   * Состояние «Сейчас» для главного экрана.
   * state: 'lesson' — идёт пара; 'break' — перерыв между парами; 'before' — пары сегодня ещё не начались;
   *        'done' — пары сегодня закончились; 'free' — сегодня пар нет.
   * current: текущая пара (для 'lesson'), next: ближайшая следующая (может быть в другой день),
   * minutesLeft — до конца текущей пары, minutesToNext — до начала следующей (если сегодня),
   * progress 0..1, position — «2 из 4».
   */
  getNow(group, now = new Date()) {
    const { iso, minutes } = moscowNow(now);
    const today = this.getDay(group, iso);
    const current = today.find(l => l.startMin <= minutes && minutes < l.endMin) || null;
    let next = today.find(l => l.startMin > minutes) || null;
    if (!next) next = this.nextLesson(group, addDays(iso, 1));
    const state = current ? 'lesson'
      : !today.length ? 'free'
      : minutes < today[0].startMin ? 'before'
      : minutes >= today[today.length - 1].endMin ? 'done' : 'break';
    return {
      date: iso, minutes, state, today, current, next,
      minutesLeft: current ? current.endMin - minutes : null,
      minutesPassed: current ? minutes - current.startMin : null,
      progress: current ? (minutes - current.startMin) / (current.endMin - current.startMin) : null,
      minutesToNext: next && next.date === iso ? next.startMin - minutes : null,
      position: current ? { index: current.number, total: today.length } : null,
      studyWeek: studyWeek(iso, group.semester),
    };
  }

  /** Первая пара, начиная с даты (ищет до 30 дней вперёд) */
  nextLesson(group, fromIso) {
    for (let i = 0; i < 30; i++) {
      const day = this.getDay(group, addDays(fromIso, i));
      if (day.length) return day[0];
    }
    return null;
  }

  /** Все занятия по предмету (для экрана «На лекцию»: выбор даты/пары) */
  findBySubject(group, text) {
    const q = text.toLowerCase();
    return group.events.filter(e => e.subject.toLowerCase().includes(q));
  }
}
