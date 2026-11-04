import { splitHeaderLabel } from "./header-label"

describe("splitHeaderLabel", () => {
  it.each([
    ["Anthropic (Claude API)", "Anthropic", "(Claude API)"],
    ["Claude.ai (Enterprise Analytics)", "Claude.ai", "(Enterprise Analytics)"],
    ["Cursor (Admin API)", "Cursor", "(Admin API)"],
    ["Change (projected)", "Change", "(projected)"],
    ["  Spaced  (out)  ", "Spaced", "(out)"],
  ])("puts the parenthetical of %p on line 2", (label, primary, secondary) => {
    expect(splitHeaderLabel(label)).toEqual({ primary, secondary })
  })

  it.each(["Spend", "OpenAI API", "Name", "", "(only parens)", "Mid (paren) text", "Nested (a (b))"])(
    "leaves %p on one line",
    (label) => {
      expect(splitHeaderLabel(label)).toEqual({ primary: label, secondary: null })
    }
  )
})
