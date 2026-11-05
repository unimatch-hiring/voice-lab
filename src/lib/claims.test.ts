import { expect, test } from "vitest";
import { ASSUMPTION_LEADS, factLabels, parseClaims, type ClaimSegment } from "./claims";
import { CLUB_SOURCES } from "./club";

const plain = (text: string): ClaimSegment => ({ kind: "plain", text });
const assumption = (text: string): ClaimSegment => ({ kind: "assumption", text });
const unverified = (text: string): ClaimSegment => ({ kind: "unverified", text });
const fact = (text: string, source = "price-list"): ClaimSegment => ({ kind: "fact", source, text });

const ANNUAL = "По прайс-листу, годовой абонемент стоит 1000 долларов.";
const MONTH = "По прайс-листу, подписка на месяц стоит 120 долларов.";
const MONTH_BARE = "Подписка на месяц стоит 120 долларов.";

function check(cases: [string, ClaimSegment[]][]) {
  for (const [reply, segments] of cases) {
    expect(parseClaims(reply), reply).toEqual(segments);
    expect(parseClaims(reply).map((s) => s.text).join(""), reply).toBe(reply);
  }
}

test("a reply splits into claim segments without losing text", () => {
  check([
    [MONTH, [fact(MONTH)]],
    ["По нашему прайс-листу подписка на месяц стоит 120 долларов.", [fact("По нашему прайс-листу подписка на месяц стоит 120 долларов.")]],
    ["По прайс-листу: подписка на месяц стоит 120 долларов.", [fact("По прайс-листу: подписка на месяц стоит 120 долларов.")]],
    [`**${MONTH}**`, [fact(`**${MONTH}**`)]],
    [`- ${MONTH}`, [fact(`- ${MONTH}`)]],
    [`• ${MONTH}`, [fact(`• ${MONTH}`)]],
    [` ${MONTH}`, [plain(" "), fact(MONTH)]],
    [`Добрый день! ${MONTH}`, [plain("Добрый день! "), fact(MONTH)]],
    [`${MONTH}Думаю, год выгоднее.`, [fact(MONTH), assumption("Думаю, год выгоднее.")]],
    [`${MONTH} Думаю, год выгоднее.`, [fact(`${MONTH} `), assumption("Думаю, год выгоднее.")]],
    [`${MONTH}\n* Думаю, год выгоднее.`, [fact(`${MONTH}\n`), assumption("* Думаю, год выгоднее.")]],
    ["Думаю, сауны у нас нет.", [assumption("Думаю, сауны у нас нет.")]],
    ["Мне кажется, будет солнечно.", [assumption("Мне кажется, будет солнечно.")]],
    ["Скорее всего, да.", [assumption("Скорее всего, да.")]],
    ["I think it will be sunny.", [assumption("I think it will be sunny.")]],
    ["Думаю, будет ли дешевле?", [assumption("Думаю, будет ли дешевле?")]],
    // The bridge back to the club must not be painted as a guess.
    [
      "Думаю, сегодня солнечно. А в такую погоду приятно поплавать в нашем бассейне!",
      [assumption("Думаю, сегодня солнечно. "), plain("А в такую погоду приятно поплавать в нашем бассейне!")],
    ],
    ["Думаю, да. Хотите уточнить?", [assumption("Думаю, да. "), plain("Хотите уточнить?")]],
    ["По понедельникам у нас йога.", [plain("По понедельникам у нас йога.")]],
    ["Думающий человек всегда прав.", [plain("Думающий человек всегда прав.")]],
    ["Открыто с 06:30. Хорошо: ждем вас.", [plain("Открыто с 06:30. Хорошо: ждем вас.")]],
    // A live answer opens with a short word, and that must not cost the highlight.
    [`Да, ${MONTH.toLowerCase()}`, [fact(`Да, ${MONTH.toLowerCase()}`)]],
    ["Конечно, думаю, будет солнечно.", [assumption("Конечно, думаю, будет солнечно.")]],
    [`Да. ${MONTH}`, [plain("Да. "), fact(MONTH)]],
    // A pause or an abbreviation does not end the sentence the phrase answers for.
    ["Думаю... да, будет солнечно.", [assumption("Думаю... да, будет солнечно.")]],
    ["Probably around 5 p.m. tomorrow.", [assumption("Probably around 5 p.m. tomorrow.")]],
    ["Факт, прайс-лист: месяц 120.", [plain("Факт, прайс-лист: месяц 120.")]],
  ]);
});

test("a fact citing an unknown source is not presented as a fact", () => {
  check([
    ["По блогу, месяц стоит 90 долларов.", [plain("По блогу, месяц стоит 90 долларов.")]],
    // These open ordinary sentences too, so only a known source makes them a citation.
    ["Based on your goals, yoga would suit you.", [plain("Based on your goals, yoga would suit you.")]],
    ["Per session, it depends.", [plain("Per session, it depends.")]],
    [
      "По прайс-листу конкурента, месяц стоит 90 долларов.",
      [unverified("По прайс-листу конкурента, месяц стоит 90 долларов.")],
    ],
    [
      `${MONTH} По блогу, 90 долларов.`,
      [fact(`${MONTH} `), plain("По блогу, 90 долларов.")],
    ],
    // "According to" always cites something, unlike the Russian "По ...".
    [
      "According to the blog, the annual membership costs $90.",
      [unverified("According to the blog, the annual membership costs $90.")],
    ],
  ]);
});

test("a fact counts only when it states an entry of its source", () => {
  check([
    [ANNUAL, [fact(ANNUAL)]],
    ["по прайс-листу, ГОДОВОЙ абонемент стоит 1000 долларов", [fact("по прайс-листу, ГОДОВОЙ абонемент стоит 1000 долларов")]],
    [
      "According to the price list, the annual membership costs $1000.",
      [fact("According to the price list, the annual membership costs $1000.")],
    ],
    [
      "According to our price list, the annual membership costs $1000.",
      [fact("According to our price list, the annual membership costs $1000.")],
    ],
    [`${ANNUAL} ${MONTH_BARE}`, [fact(`${ANNUAL} ${MONTH_BARE}`)]],
    [`${ANNUAL}\n\n${MONTH_BARE}`, [fact(`${ANNUAL}\n\n${MONTH_BARE}`)]],
    [`${ANNUAL}  ${MONTH}\r\n`, [fact(`${ANNUAL}  ${MONTH}\r\n`)]],
    [
      "По прайс-листу, годовой абонеме́нт стоит 1000 долларов.",
      [fact("По прайс-листу, годовой абонеме́нт стоит 1000 долларов.")],
    ],
    // Short names and typography change nothing about a true fact.
    [
      "По расписанию, йога проходит в понедельник, среду и пятницу в 07:30.",
      [fact("По расписанию, йога проходит в понедельник, среду и пятницу в 07:30.", "class-schedule")],
    ],
    [
      "According to the schedule, yoga runs on Monday, Wednesday and Friday at 07:30.",
      [fact("According to the schedule, yoga runs on Monday, Wednesday and Friday at 07:30.", "class-schedule")],
    ],
    [
      "According to the club profile, the children’s room for ages 3 to 10 is free for members.",
      [fact("According to the club profile, the children’s room for ages 3 to 10 is free for members.", "club-profile")],
    ],
    [
      "По справочнику тренеров, Мария Ким - тренер по плаванию.",
      [fact("По справочнику тренеров, Мария Ким - тренер по плаванию.", "trainers")],
    ],
    [
      "По прайс-листу... годовой абонемент стоит 1000 долларов.",
      [fact("По прайс-листу... годовой абонемент стоит 1000 долларов.")],
    ],
    [
      "По прайс-листу. Годовой абонемент стоит 1000 долларов.",
      [fact("По прайс-листу. Годовой абонемент стоит 1000 долларов.")],
    ],
    // A wrong figure, a paraphrase or another source is a claim nothing backs.
    ...[
      "По расписанию, йога проходит в 08:00.",
      "Да, по прайс-листу, годовой абонемент стоит 120 долларов.",
      "По прайс-листу, годовой абонемент стоит 1000 долларов?!",
      "По прайс-листу, годовой абонемент стоит 1000 долларов?..",
      "According to the price list, the annual membership costs –$1000.",
      "По прайс-листу, годовой абонемент стоит —1000 долларов.",
      "According to the price list, the annual membership costs $1000*.",
      "По прайс-листу, годовой абонемент стоит 120 долларов.",
      "According to the price list, the annual membership costs $10000.",
      "According to the price list, personal training with a trainer costs $4.5 for 60 minutes.",
      "According to the price list, the annual membership costs -$1000.",
      "According to the price list, the annual membership costs ≈$1000.",
      "According to the price list, the annual membership costs ~$1000.",
      "According to the price list, the annual membership costs $1000+.",
      "According to the price list, the annual membership costs <$1000.",
      "По прайс-листу, годовой абонемент стоит 1000% долларов.",
      "По прайс-листу, персональная тренировка с тренером стоит .45 долларов за 60 минут.",
      "По каталогу оборудования, годовой абонемент стоит 1000 долларов.",
      "По прайс-листу, годовой абонемент стоит 1000 долларов?",
      "По прайс-листу, можно заморозить?",
      "По прайс-листу",
    ].map((reply): [string, ClaimSegment[]] => [reply, [unverified(reply)]]),
    // Only the cited sentence is on trial: what follows is ordinary speech.
    [
      `${ANNUAL} Будем рады вас видеть.`,
      [fact(`${ANNUAL} `), plain("Будем рады вас видеть.")],
    ],
    [`${ANNUAL} Хотите записаться?`, [fact(`${ANNUAL} `), plain("Хотите записаться?")]],
    // A following sentence is a fact only if it matches; a wrong figure there stays uncoloured.
    [
      `${ANNUAL} Подписка на месяц стоит 90 долларов.`,
      [fact(`${ANNUAL} `), plain("Подписка на месяц стоит 90 долларов.")],
    ],
    [
      `${ANNUAL} Подписка на месяц стоит 120 долларов?!`,
      [fact(`${ANNUAL} `), plain("Подписка на месяц стоит 120 долларов?!")],
    ],
    [
      `${ANNUAL} Подписка на месяц стоит 120 долларов?`,
      [fact(`${ANNUAL} `), plain("Подписка на месяц стоит 120 долларов?")],
    ],
    [
      "По прайс-листу, годовой абонемент стоит 120 долларов. Хотите записаться?",
      [unverified("По прайс-листу, годовой абонемент стоит 120 долларов. "), plain("Хотите записаться?")],
    ],
  ]);
});

test("a true fact is recognised however it is phrased", () => {
  const cases: [string, string[]][] = [
    [
      "price-list",
      [
        "По прайс-листу, годовой абонемент стоит одну тысячу долларов.",
        "По прайс-листу, годовой абонемент стоит тысячу долларов.",
        "По прайс-листу, годовой абонемент стоит одна тысяча долларов.",
        "По прайс-листу, годовой абонемент стоит 1 000 долларов.",
        "По прайс-листу, годовой абонемент стоит 1000 $.",
        "По прайс-листу, годовой абонемент стоит $1000.",
        "По прайс-листу, годовой абонемент стоит 1000.",
        "По прайс-листу, годовой абонемент — 1000 долларов.",
        "По прайс-листу, годовая подписка обойдется всего в 1000 долларов.",
        "По прайс-листу, первое пробное занятие бесплатно.",
        "По прайс-листу, годовой абонемент стоит 1000 долл.",
        "According to the price-list, the annual membership costs $1000.",
        "По прайс-листу, стоимость годового абонемента составляет 1000 долларов.",
        "По прайс-листу, подписка на месяц стоит сто двадцать долларов.",
        "По прайс-листу, месячная подписка стоит 120 долларов.",
        "По прайс-листу, абонемент на месяц у нас стоит 120 долларов.",
        "По прайс-листу, годовой абонемент стоит 1 тысячу долларов.",
        "По прайс-листу, годовой абонемент стоит 1 тыс. долларов.",
        "По прайс-листу, персональная тренировка с тренером стоит 45 долларов.",
        "По прайс-листу, персональная тренировка с тренером стоит 45 долларов за час.",
        "По прайс-листу, персональная тренировка со старшим тренером стоит шестьдесят долларов.",
        "According to the price list, personal training with a trainer costs $45.",
        "По прайс-листу, месячный абонемент стоит сто двадцать долларов.",
        "По прайс-листу месячный абонемент стоит сто двадцать долларов.",
        "По прайс-листу: месячный абонемент стоит сто двадцать долларов!",
        "По прайс-листу, пакет из десяти занятий с тренером стоит четыреста долларов.",
        "По прайс-листу, пакет из 10 тренировок с тренером стоит 400 долларов.",
        "По прайс-листу, персональная тренировка с тренером стоит сорок пять долларов за шестьдесят минут.",
        "По прайс-листу, персональное занятие со старшим тренером стоит 60 долларов за 60 минут.",
        "По прайс-листу, годовой абонемент можно заморозить на срок до тридцати дней.",
        "По прайс-листу, первая пробная тренировка бесплатно.",
        "According to the price list, the annual membership costs one thousand dollars.",
        "According to the price list, the annual membership costs a thousand dollars.",
        "According to the price list, the annual membership costs 1,000 dollars.",
        "According to the price list, the annual membership is $1000.00.",
        "According to the price list, a monthly subscription costs one hundred and twenty dollars.",
        "According to the price list, a pack of ten sessions with a trainer costs $400.",
      ],
    ],
    [
      "club-profile",
      [
        "По паспорту клуба, клуб рассчитан на сто двадцать человек одновременно.",
        "По паспорту клуба, клуб вмещает 120 человек одновременно.",
        "По паспорту клуба, клуб работает с понедельника по пятницу с 6:30 до 11 ночи.",
        "По паспорту клуба, клуб открыт по будням с 06:30 до 23:00.",
        "По паспорту клуба, по выходным клуб открыт с 08:00 до 21:00.",
        "According to the club profile, the club is open on weekends from 08:00 to 21:00.",
        "According to the club profile, we're open Monday through Friday from 6:30 am to 11 pm.",
        "According to the club profile, the childrens room for ages 3 to 10 is free for members.",
        "По паспорту клуба, в бассейне четыре дорожки.",
        "По паспорту клуба, в бассейне 4 дорожки.",
        "По паспорту клуба, длина дорожек двадцать пять метров.",
        "По паспорту клуба, клуб открыт с понедельника по пятницу с шести тридцати до двадцати трех.",
        "По паспорту клуба, клуб работает с понедельника по пятницу 6:30-23:00.",
        "По паспорту клуба, в субботу и воскресенье клуб открыт с 8 до 21 часа.",
        "According to the club profile, the pool has four lanes.",
        "According to the club profile, the club is open Monday to Friday from 6:30 am to 11 pm.",
      ],
    ],
    [
      "class-schedule",
      [
        "По расписанию групповых тренировок, йога проходит в понедельник, среду и пятницу в семь тридцать.",
        "По расписанию групповых тренировок, йога идет по понедельникам, средам и пятницам в 7:30.",
        "По расписанию групповых тренировок, йога проходит в понедельник, среду и пятницу в 7.30.",
        "По расписанию групповых тренировок, йога проходит в понедельник в 07:30.",
        "По расписанию групповых тренировок, аквааэробика проходит во вторник и четверг в семь вечера.",
        "По расписанию групповых тренировок, аквааэробика проходит во вторник и четверг в девятнадцать ноль ноль.",
        "По расписанию групповых тренировок, аквааэробика проходит во вторник и четверг в 19 часов.",
        "По расписанию групповых тренировок, семейная тренировка проходит в субботу в десять утра.",
        "По расписанию групповых тренировок, семейная тренировка проходит в субботу в 10 часов утра.",
        "По расписанию групповых тренировок, семейная тренировка проходит каждую субботу в 10:00.",
        "По расписанию занятий, аквааэробика проходит во вторник и четверг в семь часов вечера.",
        "По расписанию групповых тренировок, аквааэробика проходит во вторник и четверг в 19-00.",
        "По расписанию групповых тренировок, йога проходит в понедельник, среду и пятницу в 7-30.",
        "According to the class schedule, yoga runs every Monday, Wednesday and Friday at 07:30.",
        "According to the group class schedule, aqua aerobics runs on Tuesday and Thursday at seven in the evening.",
        "According to the group class schedule, yoga runs on Monday, Wednesday and Friday at seven thirty.",
        "According to the group class schedule, aqua aerobics runs on Tuesday and Thursday at 7 pm.",
        "According to the group class schedule, the family workout runs on Saturday at 10 a.m.",
      ],
    ],
    [
      "equipment",
      [
        "По каталогу оборудования, в зале двадцать кардиотренажёров.",
        "По каталогу оборудования, у нас 20 кардиотренажеров.",
        "По каталогу оборудования, в зале есть гантели до пятидесяти килограммов.",
        "According to the equipment list, the gym has dumbbells up to fifty kilograms.",
      ],
    ],
    [
      "trainers",
      [
        "По справочнику тренеров, Анна Смирнова — старший тренер.",
        "По справочнику тренеров, Мария Ким ведет плавание.",
      ],
    ],
  ];

  for (const [source, replies] of cases) {
    for (const reply of replies) expect(parseClaims(reply), reply).toEqual([fact(reply, source)]);
  }

  const citations = [
    "Согласно прайс-листу, годовой абонемент стоит 1000 долларов.",
    "Судя по прайс-листу, годовой абонемент стоит 1000 долларов.",
    "В прайс-листе указано, что годовой абонемент стоит 1000 долларов.",
    "В нашем прайс-листе годовой абонемент стоит 1000 долларов.",
    "Per the price list, the annual membership costs $1000.",
    "Based on our price list, the annual membership costs $1000.",
  ];
  for (const reply of citations) expect(parseClaims(reply), reply).toEqual([fact(reply)]);
});

test("a natural rewording of a fact is recognised", () => {
  const cases: [string, string[]][] = [
    [
      "class-schedule",
      [
        "По расписанию групповых тренировок, йога проходит в понедельник, среду и пятницу в половине восьмого.",
        "По расписанию групповых тренировок, йога проходит в понедельник, среду и пятницу в 7 часов 30 минут.",
        "По расписанию групповых тренировок, йога проходит в понедельник, среду и пятницу в ноль семь тридцать.",
        "По расписанию групповых тренировок, йога проходит в понедельник, среду и пятницу в 7 30.",
        "По расписанию групповых тренировок, занятия йогой проходят в понедельник, среду и пятницу в 07:30.",
        "According to the group class schedule, yoga runs on Monday, Wednesday and Friday at half past seven.",
        "According to the group class schedule, yoga runs on Monday, Wednesday and Friday at 7:30 in the morning.",
        "According to the group class schedule, yoga classes run on Monday, Wednesday and Friday at 07:30.",
      ],
    ],
    [
      "club-profile",
      [
        "По паспорту клуба, клуб открыт во вторник с 06:30 до 23:00.",
        "According to the club profile, the club is open on Wednesday from 06:30 to 23:00.",
        "По паспорту клуба, клуб вмещает 120 человек.",
        "По паспорту клуба, одновременно в клубе могут находиться 120 человек.",
        "According to the club profile, the club holds 120 people at a time.",
        "По паспорту клуба, бассейн с 4 дорожками.",
        "По паспорту клуба, дорожки по 25 метров.",
        "По паспорту клуба, длина дорожки 25 м.",
        "По паспорту клуба, бассейн длиной 25 метров.",
        "According to the club profile, each lane is 25 m long.",
        "According to the club profile, the pool has 25-metre lanes.",
        "According to the club profile, lane length is 25 metres.",
        "По паспорту клуба, детская комната для детей с 3 до 10 лет бесплатна для членов клуба.",
        "По паспорту клуба, детская комната для детей 3-10 лет бесплатна для членов клуба.",
        "По паспорту клуба, детская комната от 3 до 10 лет бесплатна для членов клуба.",
        "По паспорту клуба, детская комната бесплатна для членов клуба.",
      ],
    ],
    [
      "price-list",
      [
        "По прайс-листу, годовой абонемент будет стоить 1000 долларов.",
        "По прайс-листу, абонемент на один год стоит 1000 долларов.",
        "По прайс-листу, подписка на один месяц стоит 120 долларов.",
        "According to the price list, a one-year membership costs $1000.",
        "According to the price list, a one-month subscription costs $120.",
        "According to the price list, the annual membership will cost you $1000.",
        "According to the price list, it's $1000 for the annual membership.",
        "According to the price list, a personal training session with a trainer costs $45.",
        "По прайс-листу, пакет из 10 персональных тренировок с тренером стоит 400 долларов.",
        "По прайс-листу, десять занятий с тренером стоят 400 долларов.",
        "По прайс-листу, годовой абонемент включает зал, бассейн и групповые тренировки.",
        "According to the price list, membership includes the gym, the pool and group workouts.",
        "По прайс-листу, годовой абонемент можно замораживать на срок до 30 дней.",
        "According to the price list, you can freeze the annual membership for up to 30 days.",
        "По прайс-листу, первую пробную тренировку можно пройти бесплатно.",
        "According to the price list, your first trial workout is free.",
      ],
    ],
    [
      "equipment",
      [
        "По каталогу оборудования, в зале есть гантели весом до 50 кг.",
        "По каталогу оборудования, в зале есть гантели до 50 кило.",
        "По каталогу, в клубе есть зона для растяжки.",
        "According to the equipment catalog, the gym has 20 cardio machines.",
      ],
    ],
    [
      "trainers",
      [
        "По справочнику, Мария Ким преподает плавание.",
        "По справочнику, Анна Смирнова ведет восстановление.",
        "По справочнику тренеров, Анна Смирнова — тренер по восстановлению и мобильности.",
        "По справочнику тренеров, Анна Смирнова — тренер.",
      ],
    ],
  ];
  for (const [source, replies] of cases) {
    for (const reply of replies) expect(parseClaims(reply), reply).toEqual([fact(reply, source)]);
  }

  const citations = [
    "По данным прайс-листа, годовой абонемент стоит 1000 долларов.",
    "В прайс-листе сказано, что годовой абонемент стоит 1000 долларов.",
    "Как указано в прайс-листе, годовой абонемент стоит 1000 долларов.",
    "Из прайс-листа: годовой абонемент стоит 1000 долларов.",
    "Разумеется, по прайс-листу, годовой абонемент стоит 1000 долларов.",
    "The price list says the annual membership costs $1000.",
    "In our price list, the annual membership costs $1000.",
    "Absolutely, according to the price list, the annual membership costs $1000.",
  ];
  for (const reply of citations) expect(parseClaims(reply), reply).toEqual([fact(reply)]);
});

test("a hedge inside a sentence marks it as an assumption", () => {
  check([
    ["Это, думаю, выгодно.", [assumption("Это, думаю, выгодно.")]],
    ["Годовой, наверное, выгоднее.", [assumption("Годовой, наверное, выгоднее.")]],
    ["Полагаю, сауны нет.", [assumption("Полагаю, сауны нет.")]],
    ["Судя по всему, сауны нет.", [assumption("Судя по всему, сауны нет.")]],
    ["Could be, I believe, about a week.", [assumption("Could be, I believe, about a week.")]],
    ["It seems the sauna is closed.", [assumption("It seems the sauna is closed.")]],
    [
      "Хотите, возможно, записаться?",
      [plain("Хотите, возможно, записаться?")],
    ],
    ["Думающий человек всегда прав.", [plain("Думающий человек всегда прав.")]],
    ["Это невозможно забыть.", [plain("Это невозможно забыть.")]],
    [
      "Добро пожаловать! Это, думаю, выгодно.",
      [plain("Добро пожаловать! "), assumption("Это, думаю, выгодно.")],
    ],
  ]);
});

test("a false claim is not rescued by the tolerant match", () => {
  const claims = [
    // Twins of the wordings accepted above.
    "По расписанию групповых тренировок, йога проходит в понедельник, среду и пятницу в половине девятого.",
    "По расписанию групповых тренировок, йога проходит в понедельник, среду и пятницу в 7 часов 45 минут.",
    "According to the group class schedule, yoga runs on Monday, Wednesday and Friday at half past eight.",
    "По расписанию групповых тренировок, занятия йогой проходят в субботу в 07:30.",
    "По паспорту клуба, клуб открыт в субботу с 06:30 до 23:00.",
    "По паспорту клуба, клуб открыт во вторник с 08:00 до 21:00.",
    "По паспорту клуба, клуб вмещает 200 человек.",
    "По паспорту клуба, клуб вмещает 120 детей.",
    "По паспорту клуба, бассейн с 5 дорожками.",
    "По паспорту клуба, дорожки по 50 метров.",
    "По паспорту клуба, бассейн длиной 25 километров.",
    "По паспорту клуба, детская комната для детей с 3 до 12 лет бесплатна для членов клуба.",
    "По паспорту клуба, детская комната платная для членов клуба.",
    "По паспорту клуба, детская комната бесплатна для всех.",
    "По прайс-листу, годовой абонемент будет стоить 2000 долларов.",
    "По прайс-листу, абонемент на два года стоит 1000 долларов.",
    "По прайс-листу, подписка на два месяца стоит 120 долларов.",
    "According to the price list, a two-year membership costs $1000.",
    "According to the price list, a one-year membership costs $120.",
    "По прайс-листу, абонемент включал зал, бассейн и групповые тренировки.",
    "По прайс-листу, абонемент не включает бассейн.",
    "По прайс-листу, годовой абонемент можно замораживать на срок до 60 дней.",
    "По прайс-листу, пакет из 10 персональных тренировок с тренером стоит 45 долларов.",
    "По прайс-листу, десять занятий со старшим тренером стоят 400 долларов.",
    "По прайс-листу, персональная тренировка стоит 45 долларов.",
    "По каталогу оборудования, в зале есть гантели весом до 100 кг.",
    "По каталогу, в клубе нет зоны для растяжки.",
    "По справочнику, Мария Ким преподает йогу.",
    "По справочнику, Анна Смирнова ведет плавание.",
    "По справочнику, Игорь Петров — тренер по плаванию.",
    "По данным прайс-листа, годовой абонемент стоит 500 долларов.",
    "The price list says the annual membership costs $500.",
    // A hedge inside a cited sentence is not the fact it cites.
    "По прайс-листу, наверное, годовой абонемент стоит 1000 долларов.",
    // A number written so that it merely looks like the entry's.
    // A number written so that it merely looks like the entry's.
    "According to the price list, the annual membership costs $1,000,000.",
    "По прайс-листу, годовой абонемент стоит 1.000.000 долларов.",
    "По прайс-листу, годовой абонемент стоит 1 000,000 долларов.",
    "По прайс-листу, годовой абонемент стоит 1000.000 долларов.",
    "По прайс-листу, годовой абонемент стоит 1000:00 долларов.",
    // The right number attached to the wrong thing.
    "По прайс-листу, годовой абонемент стоит 1000 часов.",
    "According to the price list, the annual membership costs 1000 hours.",
    "По прайс-листу, подписка на месяц стоит 120 часов.",
    "По расписанию, семейная тренировка проходит в субботу 10 часов.",
    "According to the schedule, the family workout runs on Saturday for 10 hours.",
    "По прайс-листу, у нас 1000 годовых абонементов.",
    "По прайс-листу, подписка на 120 месяцев.",
    "According to the price list, a subscription for 120 months.",
    "По прайс-листу, абонемент на 1000 годов.",
    "По прайс-листу, 10 пакетов из 400 занятий с тренером.",
    "По прайс-листу, пакет из 10 занятий с 400 тренерами.",
    "По прайс-листу, 45 персональных тренировок с тренером за 60 минут.",
    // A range is not the list of days in an entry.
    "По расписанию, йога проходит понедельник-пятница в 07:30.",
    "According to the schedule, yoga runs Monday-Friday at 07:30.",
    "According to the schedule, yoga runs Monday–Friday at 07:30.",
    "По расписанию, функциональный тренинг проходит понедельник-среда в 19:00.",
    // A word allowed elsewhere in the entry, used where it changes the value.
    "По прайс-листу, персональная тренировка с тренером стоит с 45 долларов.",
    "По прайс-листу, пакет из 10 занятий с тренером стоит с 400 долларов.",
    "По прайс-листу, годовой абонемент можно заморозить за 30 дней до.",
    // The time of day.
    "По расписанию, семейная тренировка проходит в субботу в 10 ночи.",
    "По расписанию, йога проходит в понедельник в 7:30 ночи.",
    "По расписанию групповых тренировок, аквааэробика проходит во вторник и четверг в 19 утра.",
    // Things the directory does not know: the present moment, an assignment, the future.
    "По паспорту клуба, клуб Family Fitness сейчас открыт.",
    "According to the club profile, Family Fitness is open.",
    "По каталогу, зона растяжки сейчас открыта.",
    "По справочнику, тренер Мария Ким сейчас в зале.",
    "По справочнику, тренером у вас будет Мария Ким.",
    "По справочнику, Анна Смирнова будет вам старшим тренером.",
    "По каталогу, в клубе будет зона растяжки.",
    // Other tense or a near word.
    "По прайс-листу, годовой абонемент стоил 1000 долларов.",
    "According to the price list, people training with a trainer costs $45 for 60 minutes.",
    "According to the club profile, the club holds 120 personal at once.",
    "According to the price list, the first trial workout is freeze.",
    // Numbers swapped within an entry: the right values, the wrong statement.
    "По прайс-листу, пакет из 400 занятий с тренером стоит 10 долларов.",
    "По прайс-листу, персональная тренировка с тренером стоит 60 долларов за 45 минут.",
    "По паспорту клуба, клуб открыт с понедельника по пятницу с 23:00 до 06:30.",
    "По паспорту клуба, клуб открыт с пятницы по понедельник с 06:30 до 23:00.",
    "По паспорту клуба, детская комната для детей от 10 до 3 лет бесплатна для членов клуба.",
    // Words that change the value while sounding like filler.
    "According to the price list, the annual membership costs from $1000.",
    "According to the price list, the annual membership costs $1000 and up.",
    "По паспорту клуба, клуб открыт только в субботу с 08:00 до 21:00.",
    "According to the group class schedule, yoga runs only on Monday at 07:30.",
    "По прайс-листу, годовой абонемент стоит 1000 долларов в час.",
    "По прайс-листу, годовой абонемент стоит 2 тысячи долларов.",
    "По прайс-листу, персональная тренировка с тренером стоит 60 долларов.",
    "По прайс-листу, персональная тренировка со старшим тренером стоит 45 долларов.",
    "По прайс-листу, годовой абонемент стоит две тысячи долларов.",
    "По прайс-листу, годовой абонемент стоит сто долларов.",
    "По прайс-листу, годовой абонемент стоит 1000 рублей.",
    "По прайс-листу, годовой абонемент стоит 1000 евро.",
    "По прайс-листу, годовой абонемент стоит около 1000 долларов.",
    "По прайс-листу, годовой абонемент стоит примерно тысячу долларов.",
    "По прайс-листу, годовой абонемент не стоит 1000 долларов.",
    "По прайс-листу, годовой абонемент стоит 1000 долларов в месяц.",
    "По прайс-листу, абонемент стоит 1000 долларов.",
    "По прайс-листу, подписка на месяц стоит тысячу долларов.",
    "По прайс-листу, годовой абонемент стоит 120 долларов, а месячный 1000 долларов.",
    "По прайс-листу, годовой абонемент нельзя заморозить.",
    "По прайс-листу, персональная тренировка с тренером стоит 60 долларов за 60 минут.",
    "По прайс-листу, персональная тренировка со старшим тренером стоит 45 долларов за 60 минут.",
    "По прайс-листу, первая пробная тренировка платная.",
    "По прайс-листу, пакет из 10 занятий с тренером стоит 45 долларов.",
    "По паспорту клуба, в бассейне пять дорожек.",
    "По паспорту клуба, в бассейне нет дорожек.",
    "По паспорту клуба, клуб вмещает 120 долларов одновременно.",
    "По паспорту клуба, клуб рассчитан на 1200 человек одновременно.",
    "По расписанию групповых тренировок, йога проходит в семь тридцать вечера в понедельник.",
    "По расписанию групповых тренировок, йога проходит во вторник в 07:30.",
    "По расписанию групповых тренировок, йога проходит в 07:30.",
    "По расписанию групповых тренировок, йога проходит в понедельник.",
    "По расписанию групповых тренировок, аквааэробика проходит во вторник и четверг в семь утра.",
    "По расписанию групповых тренировок, аквааэробика проходит во вторник в 19:30.",
    "По каталогу оборудования, в зале 200 кардиотренажеров.",
    "По справочнику тренеров, Мария Ким — старший тренер.",
    "По справочнику тренеров, Анна Смирнова ведет плавание.",
    "According to the price list, the annual membership costs two thousand dollars.",
    "According to the price list, the annual membership costs about $1000.",
    "According to the price list, the annual membership does not cost $1000.",
    "According to the group class schedule, aqua aerobics runs on Tuesday and Thursday at 7 am.",
  ];
  for (const reply of claims) expect(parseClaims(reply), reply).toEqual([unverified(reply)]);
});

test("every directory fact verifies in both languages", () => {
  expect(CLUB_SOURCES).toHaveLength(5);

  for (const source of CLUB_SOURCES) {
    const labels = factLabels(source);
    for (const item of source.facts) {
      const ru = `${labels.ru} ${item.ru}`;
      const en = `${labels.en} ${item.en}`;
      expect(parseClaims(ru), ru).toEqual([fact(ru, source.id)]);
      expect(parseClaims(en), en).toEqual([fact(en, source.id)]);
    }
  }
});

test("every label the prompt teaches is recognised", () => {
  expect(CLUB_SOURCES).toHaveLength(5);

  for (const source of CLUB_SOURCES) {
    const labels = factLabels(source);
    for (const label of [labels.ru, labels.en]) {
      const reply = `${label} ${source.facts[0].ru}`;
      expect(parseClaims(reply), label).toEqual([fact(reply, source.id)]);
    }
  }
  expect(ASSUMPTION_LEADS.ru.length).toBeGreaterThan(0);
  expect(ASSUMPTION_LEADS.en.length).toBeGreaterThan(0);
  for (const lead of [...ASSUMPTION_LEADS.ru, ...ASSUMPTION_LEADS.en]) {
    const reply = `${lead}, text.`;
    expect(parseClaims(reply), lead).toEqual([assumption(reply)]);
  }
});
