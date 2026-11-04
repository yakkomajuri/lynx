// How long Caffeinate (in the command bar) keeps the Mac awake: the hours typed, read the same in the window and the app.
/** Hours one run may last: a minute at least, and a week at most. */
export const MIN_HOURS = 1 / 60
export const MAX_HOURS = 24 * 7

/** The hours typed, as a number of hours to run for; null for what is not one ("2", "1.5", "0,5", "3h"). */
export function parseHours(text: string): number | null {
  const m = /^\s*(\d+(?:[.,]\d*)?|[.,]\d+)\s*(?:h|hrs?|hours?)?\s*$/i.exec(text)
  if (!m) return null
  const hours = Number(m[1].replace(',', '.'))
  return hours >= MIN_HOURS && hours <= MAX_HOURS ? hours : null
}

/** A number of hours in words: "1 hour", "2.5 hours", "30 minutes". */
export const hoursLabel = (hours: number) => (hours < 1 ? `${Math.round(hours * 60)} minute${Math.round(hours * 60) === 1 ? '' : 's'}` : `${+hours.toFixed(2)} hour${hours === 1 ? '' : 's'}`)
