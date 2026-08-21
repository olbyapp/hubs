// Weekly office achievements (vegamix): the room's own awards, worked out by
// the hub-stats service from what every client measures about itself, and worn
// where pronouns used to sit on the name tag.
//
// This file is the client half of a pair — hub-stats/achievements.py holds the
// same keys and decides who wins them. Nothing here computes a winner; the
// labels live here because the name tag, the People panel and the wall page
// must all call the same award by the same name.
//
// The awards reset every Monday at 00:00 office time. Whoever holds one wears
// it until the next recount, roughly twenty seconds later.
//
// A person can hold several at once. They travel in the profile as one
// comma-separated string, most wearable first — above people's heads the icons
// are drawn without any text, so the whole set fits on a name tag.

export const ACHIEVEMENTS = {
  talker: { emoji: "🗣", label: "Мастер языка", blurb: "больше всех говорит" },
  silent: { emoji: "🤐", label: "Терпила", blurb: "меньше всех говорит" },
  sitter: { emoji: "🪑", label: "Сидевший", blurb: "дольше всех в офисе" },
  ghost: { emoji: "👻", label: "Призрак", blurb: "меньше всех в офисе" },
  walker: { emoji: "🚶", label: "Форест в Попу раз", blurb: "больше всех ходит" },
  tired: { emoji: "🦥", label: "Ленивая жопа", blurb: "меньше всех ходит" },
  invisible: { emoji: "🫥", label: "Ты его видел?", blurb: "больше всех AFK" },
  sage: { emoji: "🧙", label: "Мудрец", blurb: "больше всех думает" },
  glutton: { emoji: "🍔", label: "Глубокая глотка", blurb: "больше всех ест" }
};

// The order awards are worn in. Mirrors PRIORITY in achievements.py so the name
// tag, the People panel and the wall all agree on which one leads.
export const ACHIEVEMENT_PRIORITY = [
  "talker",
  "glutton",
  "sage",
  "invisible",
  "ghost",
  "walker",
  "silent",
  "tired",
  "sitter"
];

export function isAchievement(key) {
  return !!key && Object.prototype.hasOwnProperty.call(ACHIEVEMENTS, key);
}

// Profile value ("talker,ghost") -> ["talker", "ghost"]. Unknown keys are
// dropped rather than trusted: the value arrives over presence from whatever
// client version its owner happens to be running.
export function achievementKeys(value) {
  if (!value) return [];
  return String(value)
    .split(",")
    .map(key => key.trim())
    .filter(isAchievement);
}

export function achievementEmoji(value) {
  return achievementKeys(value).map(key => ACHIEVEMENTS[key].emoji);
}

// One line for a People row or a profile card: "🗣 Мастер языка", plus "+1"
// when the same person also won something else this week. The name tag does
// not use this — it draws icons only.
export function achievementLine(value) {
  const keys = achievementKeys(value);
  if (!keys.length) return "";
  const { emoji, label } = ACHIEVEMENTS[keys[0]];
  return `${emoji} ${label}${keys.length > 1 ? ` +${keys.length - 1}` : ""}`;
}
