import { render, screen } from '@testing-library/react'
import { MetricsCard } from '@/components/dashboard/MetricsCard'
import { DollarSign } from 'lucide-react'

describe('MetricsCard', () => {
  it('renders title and value', () => {
    render(<MetricsCard title="Total Cost" value="$1,234.56" />)

    expect(screen.getByText('Total Cost')).toBeInTheDocument()
    expect(screen.getByText('$1,234.56')).toBeInTheDocument()
  })

  it('displays positive change with red color', () => {
    render(
      <MetricsCard
        title="This Month"
        value="$500"
        change={12.5}
        changeLabel="from last month"
      />
    )

    expect(screen.getByText('12.5%')).toBeInTheDocument()
    expect(screen.getByText('from last month')).toBeInTheDocument()
  })

  it('displays negative change with green color', () => {
    render(
      <MetricsCard
        title="This Month"
        value="$500"
        change={-5.2}
        changeLabel="from last month"
      />
    )

    expect(screen.getByText('5.2%')).toBeInTheDocument()
  })

  it('renders icon when provided', () => {
    render(
      <MetricsCard
        title="Total Cost"
        value="$1,234.56"
        icon={<DollarSign data-testid="dollar-icon" />}
      />
    )

    expect(screen.getByTestId('dollar-icon')).toBeInTheDocument()
  })

  it('shows loading skeleton when loading prop is true', () => {
    render(<MetricsCard title="Total Cost" value="$1,234.56" loading={true} />)

    // Should show title but value should be skeleton
    expect(screen.getByText('Total Cost')).toBeInTheDocument()
    expect(screen.queryByText('$1,234.56')).not.toBeInTheDocument()
  })

  it('renders without change when not provided', () => {
    render(<MetricsCard title="Top Model" value="GPT-4" />)

    expect(screen.getByText('Top Model')).toBeInTheDocument()
    expect(screen.getByText('GPT-4')).toBeInTheDocument()
    expect(screen.queryByText('%')).not.toBeInTheDocument()
  })
})
