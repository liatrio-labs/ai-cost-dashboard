export interface CostRecord {
  id: string
  user_id: string
  provider: "openai" | "anthropic" | "chatgpt"
  model_name: string
  tokens_used: number
  cost_usd: number
  timestamp: string
  api_call_id?: string | null
  created_at: string
}

export interface CostSummary {
  total_cost: number
  total_tokens: number
  provider_breakdown: {
    provider: string
    cost: number
    tokens: number
  }[]
  daily_costs: {
    date: string
    cost: number
  }[]
}

export interface Forecast {
  id: string
  user_id: string
  forecast_date: string
  predicted_cost: number
  confidence_interval_lower: number
  confidence_interval_upper: number
  model_version: string
  created_at: string
}
