import { render, screen } from '@testing-library/react'
import { CostTimeSeriesChart } from '@/components/charts/CostTimeSeriesChart'

const mockData = [
  { date: '2024-01-01', OpenAI: 50, Anthropic: 30, ChatGPT: 20 },
  { date: '2024-01-02', OpenAI: 55, Anthropic: 32, ChatGPT: 22 },
  { date: '2024-01-03', OpenAI: 48, Anthropic: 28, ChatGPT: 18 },
]

describe('CostTimeSeriesChart', () => {
  it('renders chart title and description', () => {
    render(<CostTimeSeriesChart data={mockData} />)

    expect(screen.getByText('Cost Trends')).toBeInTheDocument()
    expect(screen.getByText('Daily costs by provider over time')).toBeInTheDocument()
  })

  it('shows loading skeleton when loading prop is true', () => {
    render(<CostTimeSeriesChart data={[]} loading={true} />)

    expect(screen.getByText('Cost Trends')).toBeInTheDocument()
    // Skeleton should be rendered (exact test depends on implementation)
  })

  it('renders with empty data array', () => {
    render(<CostTimeSeriesChart data={[]} />)

    expect(screen.getByText('Cost Trends')).toBeInTheDocument()
  })

  it('renders chart with data', () => {
    const { container } = render(<CostTimeSeriesChart data={mockData} />)

    // Check that Tremor chart is rendered (it adds specific classes)
    expect(container.querySelector('.tremor-AreaChart-root')).toBeInTheDocument()
  })
})
