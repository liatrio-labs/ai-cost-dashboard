import { ReactElement } from 'react'
import { render, RenderOptions } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'

// Create a custom render function that includes providers
function customRender(
  ui: ReactElement,
  options?: Omit<RenderOptions, 'wrapper'>
) {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: {
        retry: false,
      },
    },
  })

  const AllTheProviders = ({ children }: { children: React.ReactNode }) => {
    return (
      <QueryClientProvider client={queryClient}>
        {children}
      </QueryClientProvider>
    )
  }

  return render(ui, { wrapper: AllTheProviders, ...options })
}

// Re-export everything
export * from '@testing-library/react'
export { customRender as render }

// Test data generators
export function generateMockCostData(count: number) {
  return Array.from({ length: count }, (_, i) => ({
    id: `cost-${i}`,
    date: new Date(Date.now() - i * 24 * 60 * 60 * 1000).toISOString(),
    OpenAI: Math.random() * 100,
    Anthropic: Math.random() * 80,
    ChatGPT: Math.random() * 50,
  }))
}

export function generateMockActivity(count: number) {
  const providers = ['OpenAI', 'Anthropic', 'ChatGPT']
  const models = ['gpt-4', 'claude-3-opus', 'gpt-3.5-turbo']

  return Array.from({ length: count }, (_, i) => ({
    id: `activity-${i}`,
    timestamp: new Date(Date.now() - i * 60 * 60 * 1000).toISOString(),
    provider: providers[i % providers.length],
    model: models[i % models.length],
    cost: Math.random() * 0.1,
    tokens: Math.floor(Math.random() * 2000),
  }))
}
