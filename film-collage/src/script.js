// The narration. One clip per LINE (so the voice keeps its phrasing), with the sentences inside a line
// ("parts") located afterwards, so every scene can be timed to its own words.
// Every number here is sourced in README.md ("Where every number comes from").
//   gap   silence placed BEFORE the line, in seconds (breathing room). The long gap before line 5 holds
//         the film's central beat: the rulebook turning $17.62 into $18.99.
//   pause silence placed before a part inside its line. Used only by the local `say` backend, which
//         speaks part by part; a real voice is given the whole line and makes its own pauses.

export const LINES = [
  { id: "01", gap: 1.0, parts: [
    { id: "01a", text: "Change a price by one percent, and profit moves by eleven." },
    { id: "01b", text: "In either direction.", pause: 0.45 },
  ] },
  { id: "02", gap: 1.05, parts: [
    { id: "02a", text: "So shopkeepers change prices by hand." },
    { id: "02b", text: "Carefully.", pause: 0.35 },
    { id: "02c", text: "Nervously.", pause: 0.35 },
  ] },
  { id: "03", gap: 0.75, parts: [
    { id: "03a", text: "PricePilot gives them a helper." },
    { id: "03b", text: "It reads the order history and suggests a price.", pause: 0.4 },
  ] },
  { id: "04", gap: 0.75, parts: [
    { id: "04a", text: "But the helper never gets the last word." },
    { id: "04b", text: "A rulebook does.", pause: 0.35 },
    { id: "04c", text: "Your margin floor.", pause: 0.45 },
    { id: "04d", text: "How far a price may move.", pause: 0.35 },
    { id: "04e", text: "What is off limits.", pause: 0.35 },
  ] },
  { id: "05", gap: 3.7, parts: [
    { id: "05a", text: "Every suggestion is accepted, adjusted, or refused." },
    { id: "05b", text: "And every refusal names its rule.", pause: 0.4 },
  ] },
  // Scene 6: the real app. These sentences are checked against the screenshots in assets/img/app/.
  // Two of them were spoken whole and then cut at the voice's own pauses into phrases (see CUTS below
  // and tools/phrases.mjs), so that the pencil has time to mark each print before the next phrase.
  { id: "06", gap: 0.75, parts: [
    { id: "06a", text: "Here is the real app, inside Shopify." },
    { id: "06b", text: "The order history here is synthetic, and the app says so.", pause: 0.45 },
  ] },
  { id: "07", gap: 0.8, parts: [{ id: "07a", text: "Refusals come first, with the reasons listed." }] },
  { id: "07b", gap: 1.0, parts: [{ id: "07b", text: "Then the four prices a rule pulled back," }] },
  { id: "07c", gap: 3.95, parts: [{ id: "07c", text: "and the one that passed every rule." }] },
  { id: "08", gap: 2.9, parts: [
    { id: "08a", text: "Apply, and each price is read back from Shopify." },
  ] },
  { id: "09", gap: 1.2, parts: [{ id: "09a", text: "Change your mind," }] },
  { id: "09b", gap: 3.22, parts: [{ id: "09b", text: "and everything goes back." }] },
  { id: "10", gap: 4.8, parts: [
    { id: "10a", text: "We tried sixty-two million times to make the rules give a wrong answer." },
    { id: "10b", text: "They never did.", pause: 0.5 },
  ] },
  { id: "11", gap: 0.8, parts: [
    { id: "11a", text: "The agent suggests." },
    { id: "11b", text: "The rules decide.", pause: 0.45 },
  ] },
];

// Clips that were generated as one sentence and are laid out as several phrases:
// whole clip (assets/audio/whole/line-<id>.wav) -> the lines it is cut into, in order.
export const CUTS = { "07": ["07", "07b", "07c"], "09": ["09", "09b"] };

// Seconds of picture after the last word (closing card hold and music tail).
export const TAIL = 3.9;

export const lineText = (line) => line.parts.map((p) => p.text).join(" ");
export const wordCount = () => LINES.reduce((n, l) => n + lineText(l).split(/\s+/).length, 0);
