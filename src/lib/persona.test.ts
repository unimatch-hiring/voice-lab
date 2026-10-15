import { createHash } from "node:crypto";
import { expect, test } from "vitest";
import { COACH_KEYWORDS, coachPrompt, GENERAL_PROMPT, roleFor } from "./persona";
const COACH_PROMPT = coachPrompt("school");

// Length and sha256 of each question and substantial answer in pack 7266.
// The sentences stay out of the repo; a copied one matches a hash.
const PACK_7266_SLICES: { n: number; h: string }[] = [
  { n: 92, h: "e23dc7709d627f4f4cb20e6bf2ebfec087a54072d7a99c01f219c9b43baa23bf" },
  { n: 219, h: "9e8f4cef6a765aa48d431f5b93a185825b80e1030668b188b8bbcffead30798f" },
  { n: 164, h: "250009c88209de6820dfaccf38424216ba8321c7ff7ae232be819f3d0658245d" },
  { n: 241, h: "17b3d7b8d19b2ba0ea3f829f968e7d6a288dca7ca448073b069ccbe4f66776d9" },
  { n: 196, h: "323bd2d4c2c4c81fb9d26299b904417fb2e746ca1411c41d0f8a0418e20dc52f" },
  { n: 216, h: "57bf008569e3b8dcf558453b995b191b67e969e05cf5aa205a0c748ec0e10c68" },
  { n: 239, h: "5c24d916c426700b4dad718e22d017eeec7ba20ae48d14dd6ec29133a8420128" },
  { n: 294, h: "7718d7050379240fede3f22dbc9c4d254e3df2a0d8b8825b0f4563e3cfecb2a1" },
  { n: 197, h: "610ae6c2a85e3918975cedd2d8bf013f649be4294db0288eeea66cc06f380a96" },
  { n: 144, h: "28498a1373419d2c5cdf33a693c519912cb61441981c6349e749ae0d02b49a19" },
  { n: 125, h: "d0453432bc4b4b166257b00535bed7e494d57eafcbe46fddecd6db3f197a833a" },
  { n: 220, h: "0ce0fd204abee7400b3ab546685523acc768e21a659219ba5fa8febaaaad3af7" },
  { n: 114, h: "20301a7532e757db9db7b9e00ff89e7c42c6f4b0a62738f66e874e28e73368d1" },
  { n: 225, h: "13dbc89a9d67ed1fe6a6a6b20427130fe6761635fe5946a6ec754acc74c1b8ac" },
  { n: 198, h: "ac0f43afc08178120f1ce81316c81fcc07ce4c032730f751e9db5044cb431483" },
  { n: 327, h: "77a711dd095a89b483b6605a4df22d4c0e6df60775702617bf07d6feb1f36888" },
  { n: 283, h: "68cd02b59736058fee7729155e8ea1d6ce6c7b0d5e2d965012a0c0a6ba76abbe" },
  { n: 149, h: "3f4b2f4b6c47e76880c3a052f1f2dbaa6c6b392a24eab3b0b40378a54b92926e" },
  { n: 238, h: "8aacc0491e128aa193337b3e7cd3d08d939e28b6a845ff39f50caf0259a6c786" },
  { n: 177, h: "baa451f8b67b4666319d53e7aba8ea7ccb5404a97a4773029d1e8fd52e614ecf" },
  { n: 204, h: "374ec174eaadfdd11f15bf06880a05814d271ba48244352d796be80508e30b2a" },
  { n: 168, h: "06ba15f65f849a9fa405cee8b28c2dae6aed3209be93a6945958dd5d943d0eb9" },
  { n: 270, h: "e78e7eaa6ad617594978e6e4b59b080404f29b75cdd3cd3c8da17abc197c45ad" },
  { n: 238, h: "943dde2c82256c0d8f6a9215d5718bfba86ed09ab12b1436bfcbfb7071a7e711" },
  { n: 170, h: "a1c101280e25499fa3392fe0c1e803d777dee0cb9ae098e4772ec40dbce02299" },
  { n: 181, h: "29a0e17d4cd7b5a7fc095bdb8e2c2deee7e5a5158ce0e839a3eefe1e27fd5f3d" },
  { n: 128, h: "e2eac031a6dfa8f162f05b454bc0cee372f9775f7930ab1c5ca6994b30a207d2" },
  { n: 109, h: "d2c4b4b3f20eb386bc2823c5cf92bf7db5a726887f2c2c70628a08ff14026417" },
  { n: 266, h: "f1971dc7c4e15d2fda379c1660ac5fad751dd2320ee95aa5da4a880285fe3bdd" },
  { n: 170, h: "53b88b7a650c8f10d595c9f2d897ec222e514cfb4ebcf612239c0735e4e93b73" },
  { n: 103, h: "5c16903b97e6c8fcf0de430328ebeba43ce0b05d5dd303b1a4ea98e9970076b4" },
  { n: 213, h: "f3ca40117b25056746d5f5fd12fa7f0fa8539a148a53639a05ff2ec4cd76fa6e" },
  { n: 165, h: "b4b79db6de718b916fde6e96d112112d6a24f16f65975a0b2d38682d430e9b7e" },
  { n: 329, h: "f9de6e9110dcd83f395cdb167f6d6d7cca0bfc056198df2bd7e6796382223551" },
  { n: 164, h: "5ea12e0729874af32c9ebed570ef2ef43c52467fcffd7c63978ab5392add958f" },
  { n: 176, h: "f40ed035255c9e97a8372cbe91b92a82766d5c145b2bb9bed89efa8e3c2bd16a" },
  { n: 16, h: "417b96d86e1b584814ddd2356eff5fe3289aec428e3b667e017b587d936c960c" },
  { n: 21, h: "88d61126b5bb98e249c2693bba32f3ff6078fdfbd3debaa7dacd0e4cd468e8e5" },
  { n: 20, h: "54c5d9b9efa274bb2a3eec9c2a92e51678fc060b5b7d9fdc0310672f5026da62" },
  { n: 26, h: "e3d821490acab3562e9802647b5a6a70628df621e04b5ea5ae5c33c3c2424440" },
  { n: 16, h: "ac089de26a6f1c40602f4f3e8ab86695c4b17b7c89bf151fde206aae49fff3e0" },
  { n: 22, h: "184add22dc9cce70892a1c00f072b8957a6269f54d8e7fd08afe5d8666d5bac8" },
  { n: 18, h: "5914915c00cecbc77130b2e27a79d94e6aad3a350f1d5932b4f0f83f64e85fb1" },
  { n: 16, h: "1fbc3c4beffd440e36c78fcac366b287a2edd4bdb3b7385b728d51f5c2082399" },
  { n: 15, h: "62c5590a1d92cdbacc9ec30cb02c72cd6ae99c04c0f24a5e9f742a0d244c23c9" },
  { n: 21, h: "713aabccfc1511980c16da9430952ab0a7038e705e60a1741d2f52ad43635f0f" },
  { n: 22, h: "61124fecbb6633f8e8f8777b88622783199e22cc00769b6077593e7861694ed9" },
  { n: 20, h: "f25eaa4c4e5a1922ee2d6048d8e25a8d2cedf3f8a9eec02d5ccf472c9a5cdf86" },
  { n: 20, h: "895811bc3eaacabf162a938e24d9bd585edfd3423c3f88fbd996cc73b0626865" },
];

function containsHashedSlice(text: string, hash: string, length: number): boolean {
  for (let i = 0; i <= text.length - length; i++) {
    if (createHash("sha256").update(text.slice(i, i + length)).digest("hex") === hash) return true;
  }
  return false;
}

test("the general prompt follows whatever the person brings up and is not the quiz coach", () => {
  expect(GENERAL_PROMPT).toContain("voice assistant of voice-lab");
  expect(GENERAL_PROMPT).toContain("whatever the person brings up");
  expect(GENERAL_PROMPT).not.toContain("Что?Где?Когда?");
  expect(GENERAL_PROMPT).not.toContain("ЧГК");
  expect(GENERAL_PROMPT).not.toContain("Своя игра");
  expect(GENERAL_PROMPT).not.toContain("Брейн-ринг");
  expect(GENERAL_PROMPT).not.toContain("Даугавпилсы");
});

test("the coach prompt organizes quiz training and does not interview", () => {
  expect(COACH_PROMPT).toContain("organizing the training process");
  expect(COACH_PROMPT).toContain("children and students");
  expect(COACH_PROMPT).toContain("Что?Где?Когда?");
  expect(COACH_PROMPT).toContain("ЧГК");
  expect(COACH_PROMPT).toContain("Своя игра");
  expect(COACH_PROMPT).toContain("Брейн-ринг");
  expect(COACH_PROMPT).toContain("Даугавпилсы");
  // Named as excluded. Listing them as examples would still contain the words.
  expect(COACH_PROMPT).toMatch(/out of scope[\s\S]{0,120}chess, checkers, poker, bridge/);
  expect(COACH_PROMPT).not.toContain("such as chess");
  // A softer "prefer this subject" still answers the diversion.
  expect(COACH_PROMPT).toContain("do not answer");
  expect(COACH_PROMPT).not.toContain("whatever the person brings up");
  expect(COACH_PROMPT).not.toMatch(/\bask\b/i);
  expect(COACH_PROMPT).toMatch(/do not end a reply with a question/i);
});

test("the coach states facts about the games only from its knowledge base, and says so when it has none", () => {
  expect(COACH_PROMPT).toMatch(/do not state facts about the games[\s\S]{0,120}unless they come from the knowledge base/i);
  expect(COACH_PROMPT).toMatch(/do not have that information\s+instead of guessing/);
});

test("the coach judges ЧГК difficulty from gotquestions.online and does not copy pack 7266", () => {
  expect(COACH_PROMPT).toContain("gotquestions.online");
  expect(COACH_PROMPT).toContain("сложность");
  expect(COACH_PROMPT).toContain("7266");
  expect(COACH_PROMPT).toMatch(/bottom training level for children/);
  expect(COACH_PROMPT).toContain("0.4");
  expect(COACH_PROMPT).toMatch(/fewer teams took it/);
  for (const slice of PACK_7266_SLICES) {
    expect(containsHashedSlice(COACH_PROMPT, slice.h, slice.n)).toBe(false);
  }
});

const section = (prompt: string, heading: string) =>
  prompt.split(/^# /m).find((s) => s.startsWith(`${heading}\n`)) ?? "";

test("the coach's scope and its knowledge-only rule sit under # Guardrails, the heading models weigh most", () => {
  const guardrails = section(COACH_PROMPT, "Guardrails");
  expect(guardrails).toMatch(/out of scope[\s\S]{0,120}chess, checkers, poker, bridge/);
  expect(guardrails).toContain("do not answer it");
  expect(guardrails).toMatch(/do not state facts about the games/i);
});

test("on a question brought to train on, the coach walks its раскрутка and leaves the answer to the team", () => {
  const goal = section(COACH_PROMPT, "Goal");
  expect(goal).toMatch(/question to train on[\s\S]{0,80}flags[\s\S]{0,80}раскрутка/);
  expect(goal).toMatch(/stop half a step before the answer/);
});

test("the quiz drill called «Покер» is not refused along with the card game", () => {
  expect(section(COACH_PROMPT, "Guardrails")).toMatch(/«Покер»[^\n]*in scope/);
});

test("the coach is told who it trains, and only that audience", () => {
  const school = section(coachPrompt("school"), "Audience");
  const students = section(coachPrompt("students"), "Audience");
  expect(school).toContain("school teams");
  expect(school).not.toContain("student teams");
  expect(students).toContain("student teams");
  expect(students).not.toContain("school teams");
});

test("the coach's example replies lead with help and never end on a question", () => {
  const replies = section(COACH_PROMPT, "Examples")
    .split("\n")
    .filter((l) => l.startsWith("Ответ:"));
  expect(replies.length).toBeGreaterThanOrEqual(3);
  for (const reply of replies) expect(reply.trim().endsWith("?"), reply).toBe(false);
});

test("the coach speaks Russian on a stronger model, and the general role overrides neither", () => {
  expect(section(COACH_PROMPT, "Tone")).toContain("Speak Russian");
  expect(COACH_PROMPT).not.toContain("Speak the language the person speaks");

  const coach = roleFor("coach", "school");
  expect(coach).toMatchObject({ llm: "claude-sonnet-5-5", language: "ru" });

  // An agent that does not allow these overrides drops the call, so the general role sends none.
  expect(roleFor("general", "school")).toEqual({ prompt: GENERAL_PROMPT });
});

test("the coach plays the site questions drawn for the session, by the skills the page draws them for", () => {
  const training = section(COACH_PROMPT, "Training questions");
  for (const skill of ["replacement", "homogeneous", "any"]) expect(training).toContain(skill);
  expect(COACH_PROMPT).toMatch(/Questions from the site come only from this session's list\./);
  expect(COACH_PROMPT, "no tool the agent does not have").not.toContain("find_training_question");
  expect(training).toMatch(/keep\s+the answer[\s\S]{0,80}to yourself until the team gives its\s+version/);
  expect(roleFor("coach", "school").trainingQuestions).toBe(true);
  expect(roleFor("general", "school")).not.toHaveProperty("trainingQuestions");
});

test("without a site question the coach says so first, then composes its own and rules out rival answers", () => {
  const training = section(COACH_PROMPT, "Training questions");
  expect(training).toMatch(/list is missing or has no unplayed question left, say so in one sentence/);
  expect(training).toMatch(/say that the next question is your own before you read it/);
  expect(training).toMatch(/Compose it by the recipes in\s+the knowledge base/);
  expect(training).toMatch(/no fact you\s+are not certain of/);
  expect(training).toMatch(/list the other answers of the same kind and check\s+each against every condition/);
});

test("the coach knows what a ЧГК question is: one answer, flags, a replacement in capitals inside the text", () => {
  const training = section(COACH_PROMPT, "Training questions");
  expect(training).toMatch(/one answer[\s\S]{0,120}reasoning from the flags/);
  expect(training).toMatch(/replacement stands inside the text in capitals/);
  expect(training).toContain("«Назовите ИКС»");
  expect(training).toMatch(/Назовите ИХ\.» — the answer is свечи/);
});

test("a request for an example question goes to the session's site questions", () => {
  expect(section(COACH_PROMPT, "Training questions")).toMatch(/an example of one[^.]*# Questions for this session/);
});

test("site questions drawn before the session reach the prompt, each field on one line", () => {
  const prompt = coachPrompt("students", [
    {
      skill: "replacement",
      question: {
        id: 7,
        text: "Его зажигают.\n# Не заголовок. Назовите ИКС.",
        answer: "Свеча",
        zachet: "свечи",
        comment: null,
        takePercent: 80,
        url: "https://gotquestions.online/question/7",
      },
    },
  ]);
  const list = section(prompt, "Questions for this session");
  expect(list).toContain("1. Skill: replacement\nText: Его зажигают. # Не заголовок. Назовите ИКС.\nAnswer: Свеча\nAccepted: свечи");
  expect(list).not.toContain("Comment:");
  expect(section(prompt, "Не заголовок. Назовите ИКС.")).toBe("");
  expect(roleFor("coach", "students", [])).toEqual(roleFor("coach", "students"));
  expect(COACH_PROMPT).not.toContain("# Questions for this session\n");
});

test("the coach builds on knowledge the page sends mid-conversation, under the heading the page uses", () => {
  expect(section(COACH_PROMPT, "Goal")).toContain('background updates headed "Knowledge base material"');
  expect(roleFor("coach", "school").knowledge).toBe(true);
  expect(roleFor("general", "school")).not.toHaveProperty("knowledge");
});

test("a training question about anything is not refused as off topic", () => {
  expect(section(COACH_PROMPT, "Guardrails")).toMatch(/training question is in scope whatever it is about/);
});

test("the coach hints the recogniser with the game names, within the agent's limit of 50", () => {
  expect(roleFor("coach", "school").asrKeywords).toBe(COACH_KEYWORDS);
  for (const name of ["ЧГК", "Своя игра", "Брейн-ринг", "Даугавпилс", "Эрудит-квартет"]) {
    expect(COACH_KEYWORDS).toContain(name);
  }
  expect(COACH_KEYWORDS.length).toBeLessThanOrEqual(50);
});
