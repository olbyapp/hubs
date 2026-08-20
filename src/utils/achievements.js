// Weekly office achievements (vegamix): the room's own awards, worked out by
// the hub-stats service from what every client measures about itself, and worn
// where pronouns used to sit on the name tag.
//
// This file is the client half of a pair — hub-stats/achievements.py holds the
// same eight keys and decides who wins them. Nothing here computes a winner;
// the labels live here because the name tag, the People panel and the wall page
// must all call the same award by the same name.
//
// The awards reset every Monday at 00:00 office time. Whoever holds one wears
// it until the next recount, roughly twenty seconds later.

export const ACHIEVEMENTS = {
  talker: { emoji: "🗣", label: "Болтун", blurb: "больше всех говорит" },
  silent: { emoji: "🤐", label: "Молчун", blurb: "меньше всех говорит" },
  sitter: { emoji: "🪑", label: "Сидевший", blurb: "дольше всех в офисе" },
  ghost: { emoji: "👻", label: "Призрак", blurb: "меньше всех в офисе" },
  walker: { emoji: "🚶", label: "Ходила", blurb: "больше всех ходит" },
  tired: { emoji: "🦥", label: "Уставатель", blurb: "меньше всех ходит" },
  invisible: { emoji: "🫥", label: "Ты его видел?", blurb: "больше всех AFK" },
  sage: { emoji: "🧙", label: "Мудрец", blurb: "больше всех думает" }
};

// Which award goes on the name tag when somebody holds several. Mirrors
// PRIORITY in achievements.py so the plate and the wall agree.
export const ACHIEVEMENT_PRIORITY = ["talker", "sage", "invisible", "ghost", "walker", "silent", "tired", "sitter"];

export function isAchievement(key) {
  return !!key && Object.prototype.hasOwnProperty.call(ACHIEVEMENTS, key);
}

// One line for a name tag or a People row: "🗣 Болтун", or "🗣 Болтун +1" when
// the same person also won something else this week.
export function achievementLine(key, extraCount = 0) {
  if (!isAchievement(key)) return "";
  const { emoji, label } = ACHIEVEMENTS[key];
  return `${emoji} ${label}${extraCount > 0 ? ` +${extraCount}` : ""}`;
}
