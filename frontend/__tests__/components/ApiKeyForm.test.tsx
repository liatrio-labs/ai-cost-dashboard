import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { ApiKeyForm } from '@/components/forms/ApiKeyForm'

// Mock fetch
global.fetch = jest.fn()

describe('ApiKeyForm', () => {
  beforeEach(() => {
    jest.clearAllMocks()
  })

  it('renders form fields', () => {
    render(<ApiKeyForm />)

    expect(screen.getByLabelText(/provider/i)).toBeInTheDocument()
    expect(screen.getByLabelText(/api key/i)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /save api key/i })).toBeInTheDocument()
  })

  it('submits form with valid data', async () => {
    const mockOnSuccess = jest.fn()
    const mockFetch = global.fetch as jest.Mock
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ id: '123', provider: 'openai' }),
    })

    const user = userEvent.setup()
    render(<ApiKeyForm onSuccess={mockOnSuccess} />)

    // Fill in form
    const apiKeyInput = screen.getByLabelText(/api key/i)
    await user.type(apiKeyInput, 'sk-test123')

    // Submit form
    const submitButton = screen.getByRole('button', { name: /save api key/i })
    await user.click(submitButton)

    await waitFor(() => {
      expect(mockFetch).toHaveBeenCalledWith(
        '/api/api-keys',
        expect.objectContaining({
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
          },
          body: expect.stringContaining('sk-test123'),
        })
      )
    })

    await waitFor(() => {
      expect(mockOnSuccess).toHaveBeenCalled()
    })
  })

  it('displays error message on failed submission', async () => {
    const mockFetch = global.fetch as jest.Mock
    mockFetch.mockResolvedValueOnce({
      ok: false,
      json: async () => ({ error: 'Invalid API key' }),
    })

    const user = userEvent.setup()
    render(<ApiKeyForm />)

    const apiKeyInput = screen.getByLabelText(/api key/i)
    await user.type(apiKeyInput, 'invalid-key')

    const submitButton = screen.getByRole('button', { name: /save api key/i })
    await user.click(submitButton)

    await waitFor(() => {
      expect(screen.getByText(/invalid api key/i)).toBeInTheDocument()
    })
  })

  it('shows success message after successful submission', async () => {
    const mockFetch = global.fetch as jest.Mock
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ id: '123' }),
    })

    const user = userEvent.setup()
    render(<ApiKeyForm />)

    const apiKeyInput = screen.getByLabelText(/api key/i)
    await user.type(apiKeyInput, 'sk-valid123')

    const submitButton = screen.getByRole('button', { name: /save api key/i })
    await user.click(submitButton)

    await waitFor(() => {
      expect(screen.getByText(/api key saved successfully/i)).toBeInTheDocument()
    })
  })

  it('disables submit button while loading', async () => {
    const mockFetch = global.fetch as jest.Mock
    mockFetch.mockImplementation(
      () =>
        new Promise((resolve) =>
          setTimeout(() => resolve({ ok: true, json: async () => ({}) }), 100)
        )
    )

    const user = userEvent.setup()
    render(<ApiKeyForm />)

    const apiKeyInput = screen.getByLabelText(/api key/i)
    await user.type(apiKeyInput, 'sk-test123')

    const submitButton = screen.getByRole('button', { name: /save api key/i })
    await user.click(submitButton)

    expect(submitButton).toBeDisabled()
    expect(screen.getByText(/saving/i)).toBeInTheDocument()
  })
})
