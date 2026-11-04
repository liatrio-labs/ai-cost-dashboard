/**
 * Splits a column header like "Anthropic (Claude API)" into a main label and
 * a trailing parenthetical so the header can wrap onto two lines with the
 * parenthetical on line 2 (issue #41). Labels without a trailing
 * parenthetical come back unsplit.
 */
export interface HeaderLabelParts {
  primary: string
  secondary: string | null
}

const TRAILING_PAREN = /^(.*?\S)\s*(\([^()]*\))\s*$/

export function splitHeaderLabel(label: string): HeaderLabelParts {
  const m = TRAILING_PAREN.exec(label.trim())
  if (!m) return { primary: label, secondary: null }
  return { primary: m[1], secondary: m[2] }
}
