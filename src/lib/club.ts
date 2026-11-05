/**
 * The directory: what the agent may state as fact. A sentence reads as a fact only if it
 * states an entry of the source it cites (see factMatch.ts). Keep an entry to one claim: a
 * sentence must say all of an entry to match it, so a long one rejects a true partial answer.
 */
export interface ClubFact {
  ru: string;
  en: string;
}

export interface ClubSource {
  id: string;
  /** The source's name as spoken after "По ..." and "According to the ...". */
  ru: string;
  en: string;
  /** What a speaker shortens the name to; the prompt teaches the full one. */
  short: { ru: string[]; en: string[] };
  /** The name as spoken after "В ...". */
  in: string[];
  /** The name as spoken after "По данным ..." and "Из ...". */
  of: string[];
  facts: ClubFact[];
  /** Other true ways to say the facts. Accepted by the check, never taught in the prompt. */
  also: string[];
}

export const CLUB_SOURCES: ClubSource[] = [
  {
    id: "club-profile",
    ru: "паспорту клуба",
    en: "club profile",
    short: { ru: ["паспорту"], en: ["profile"] },
    in: ["паспорте клуба", "паспорте"],
    of: ["паспорта клуба", "паспорта"],
    also: [
      "Клуб вмещает 120 человек.",
      "Клуб рассчитан на 120 человек.",
      "Одновременно в клубе могут находиться 120 человек.",
      "The club holds 120 people.",
      "The club holds 120 people at a time.",
      "Клуб открыт в понедельник, вторник, среду, четверг и пятницу с 06:30 до 23:00.",
      "The club is open on Monday, Tuesday, Wednesday, Thursday and Friday from 06:30 to 23:00.",
      "Бассейн с 4 дорожками.",
      "В бассейне 4 дорожки длиной 25 метров.",
      "Дорожки по 25 метров.",
      "Бассейн длиной 25 метров.",
      "The pool has 25 metre lanes.",
      "Lane length is 25 metres.",
      "Детская комната для детей с 3 до 10 лет бесплатна для членов клуба.",
      "Детская комната от 3 до 10 лет бесплатна для членов клуба.",
      "Детская комната с 3 до 10 лет бесплатна для членов клуба.",
      "Детская комната бесплатна для членов клуба.",
      "The children's room is free for members.",
    ],
    facts: [
      { ru: "Family Fitness — семейный фитнес-клуб.", en: "Family Fitness is a family fitness club." },
      { ru: "Клуб рассчитан на 120 человек одновременно.", en: "The club holds 120 people at once." },
      { ru: "В бассейне 4 дорожки.", en: "The pool has 4 lanes." },
      { ru: "Длина дорожек 25 метров.", en: "Each lane is 25 metres long." },
      {
        ru: "Клуб открыт с понедельника по пятницу с 06:30 до 23:00.",
        en: "The club is open Monday to Friday from 06:30 to 23:00.",
      },
      {
        ru: "Клуб открыт в субботу и воскресенье с 08:00 до 21:00.",
        en: "The club is open Saturday and Sunday from 08:00 to 21:00.",
      },
      { ru: "Клуб открыт по будням с 06:30 до 23:00.", en: "The club is open on weekdays from 06:30 to 23:00." },
      { ru: "Клуб открыт по выходным с 08:00 до 21:00.", en: "The club is open on weekends from 08:00 to 21:00." },
      {
        ru: "Детская комната для детей от 3 до 10 лет бесплатна для членов клуба.",
        en: "The children's room for ages 3 to 10 is free for members.",
      },
    ],
  },
  {
    id: "price-list",
    ru: "прайс-листу",
    en: "price list",
    short: { ru: ["прайсу"], en: ["prices"] },
    in: ["прайс-листе", "прайсе"],
    of: ["прайс-листа", "прайса"],
    also: [
      "Годовой абонемент включает зал, бассейн и групповые тренировки.",
      "The annual membership includes the gym, the pool and group classes.",
      "Годовой абонемент можно замораживать на срок до 30 дней.",
      "Заморозка годового абонемента до 30 дней.",
      "You can freeze the annual membership for up to 30 days.",
      "Первую пробную тренировку можно пройти бесплатно.",
      "Your first trial workout is free.",
      "Пакет из 10 персональных тренировок с тренером стоит 400 долларов.",
      "10 занятий с тренером стоят 400 долларов.",
      "A pack of 10 personal training sessions with a trainer costs $400.",
      "10 sessions with a trainer cost $400.",
    ],
    facts: [
      { ru: "Годовой абонемент стоит 1000 долларов.", en: "The annual membership costs $1000." },
      { ru: "Подписка на месяц стоит 120 долларов.", en: "A monthly subscription costs $120." },
      {
        ru: "Абонемент включает зал, бассейн и групповые тренировки.",
        en: "Membership includes the gym, the pool and group classes.",
      },
      { ru: "Годовой абонемент можно заморозить на срок до 30 дней.", en: "The annual membership can be frozen for up to 30 days." },
      { ru: "Первая пробная тренировка бесплатна.", en: "The first trial workout is free." },
      {
        ru: "Персональная тренировка с тренером стоит 45 долларов за 60 минут.",
        en: "Personal training with a trainer costs $45 for 60 minutes.",
      },
      {
        ru: "Персональная тренировка со старшим тренером стоит 60 долларов за 60 минут.",
        en: "Personal training with a senior trainer costs $60 for 60 minutes.",
      },
      { ru: "Персональная тренировка с тренером стоит 45 долларов.", en: "Personal training with a trainer costs $45." },
      { ru: "Персональная тренировка со старшим тренером стоит 60 долларов.", en: "Personal training with a senior trainer costs $60." },
      { ru: "Персональная тренировка с тренером стоит 45 долларов за час.", en: "Personal training with a trainer costs $45 per hour." },
      { ru: "Персональная тренировка со старшим тренером стоит 60 долларов за час.", en: "Personal training with a senior trainer costs $60 per hour." },
      { ru: "Пакет из 10 занятий с тренером стоит 400 долларов.", en: "A pack of 10 sessions with a trainer costs $400." },
    ],
  },
  {
    id: "class-schedule",
    ru: "расписанию групповых тренировок",
    en: "group class schedule",
    short: { ru: ["расписанию", "расписанию занятий"], en: ["schedule", "class schedule"] },
    in: ["расписании групповых тренировок", "расписании занятий", "расписании"],
    of: ["расписания групповых тренировок", "расписания занятий", "расписания"],
    also: [
      "Занятия йогой проходят в понедельник, среду и пятницу в 07:30.",
      "Yoga classes run on Monday, Wednesday and Friday at 07:30.",
      "Занятия функциональным тренингом проходят в понедельник и среду в 19:00.",
      "Занятия аквааэробикой проходят во вторник и четверг в 19:00.",
      "Aqua aerobics classes run on Tuesday and Thursday at 19:00.",
    ],
    facts: [
      { ru: "Йога проходит в понедельник, среду и пятницу в 07:30.", en: "Yoga runs on Monday, Wednesday and Friday at 07:30." },
      { ru: "Функциональный тренинг проходит в понедельник и среду в 19:00.", en: "Functional training runs on Monday and Wednesday at 19:00." },
      { ru: "Аквааэробика проходит во вторник и четверг в 19:00.", en: "Aqua aerobics runs on Tuesday and Thursday at 19:00." },
      { ru: "Семейная тренировка проходит в субботу в 10:00.", en: "The family workout runs on Saturday at 10:00." },
    ],
  },
  {
    id: "equipment",
    ru: "каталогу оборудования",
    en: "equipment list",
    short: { ru: ["каталогу"], en: ["catalog", "equipment catalog"] },
    in: ["каталоге оборудования", "каталоге"],
    of: ["каталога оборудования", "каталога"],
    also: [
      "В зале есть гантели весом до 50 кг.",
      "Гантели весят до 50 кг.",
      "В клубе есть зона для растяжки.",
      "Dumbbells go up to 50 kg.",
    ],
    facts: [
      { ru: "В зале 20 кардиотренажеров.", en: "The gym has 20 cardio machines." },
      { ru: "В зале 6 силовых рам.", en: "The gym has 6 squat racks." },
      { ru: "В зале есть гантели до 50 кг.", en: "The gym has dumbbells up to 50 kg." },
      { ru: "В клубе есть зона растяжки.", en: "The club has a stretching area." },
    ],
  },
  {
    id: "trainers",
    ru: "справочнику тренеров",
    en: "trainer directory",
    short: { ru: ["справочнику"], en: ["directory"] },
    in: ["справочнике тренеров", "справочнике"],
    of: ["справочника тренеров", "справочника"],
    also: [
      "Анна Смирнова — тренер.",
      "Анна Смирнова ведет восстановление.",
      "Анна Смирнова ведет мобильность.",
      "Анна Смирнова — тренер по восстановлению и мобильности.",
      "Anna Smirnova is a trainer.",
    ],
    facts: [
      { ru: "Анна Смирнова — старший тренер.", en: "Anna Smirnova is a senior trainer." },
      { ru: "Анна Смирнова ведет восстановление и мобильность.", en: "Anna Smirnova covers recovery and mobility." },
      { ru: "Анна Смирнова — старший тренер по восстановлению и мобильности.", en: "Anna Smirnova is a senior trainer for recovery and mobility." },
      { ru: "Игорь Петров — тренер.", en: "Igor Petrov is a trainer." },
      { ru: "Игорь Петров ведет силовую подготовку.", en: "Igor Petrov covers strength training." },
      { ru: "Игорь Петров — тренер по силовой подготовке.", en: "Igor Petrov is a strength trainer." },
      { ru: "Мария Ким — тренер.", en: "Maria Kim is a trainer." },
      { ru: "Мария Ким ведет плавание.", en: "Maria Kim covers swimming." },
      { ru: "Мария Ким — тренер по плаванию.", en: "Maria Kim is a swimming trainer." },
    ],
  },
];

export const GREETING = {
  ru: "Здравствуйте! Меня зовут Александра, я администратор клуба Family Fitness. Чем могу вам помочь?",
  en: "Hello! My name is Alexandra, I'm the administrator of Family Fitness. How can I help you?",
};

export const FORBIDDEN_TOPICS = [
  "profanity",
  "violence",
  "discrimination",
  "humiliation",
  "inciting hatred",
  "terrorism",
  "extremism",
  "drugs and doping",
  "self-harm",
  "dangerous starvation",
  "weapons",
  "sexual content",
];
