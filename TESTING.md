# Testing Guide

Comprehensive testing infrastructure for the AI Cost Dashboard.

## Overview

The project uses multiple testing strategies:
- **Unit Tests**: Test individual components and functions
- **Integration Tests**: Test interactions between modules
- **E2E Tests**: Test complete user workflows

## Frontend Testing

### Technology Stack
- **Jest**: Test runner and assertion library
- **React Testing Library**: Component testing
- **Playwright**: End-to-end testing
- **@testing-library/user-event**: User interaction simulation

### Running Tests

```bash
# Run all tests
npm test

# Run tests in watch mode
npm run test:watch

# Run tests with coverage
npm run test:coverage

# Run E2E tests
npm run test:e2e

# Run E2E tests with UI
npm run test:e2e:ui
```

### Test Structure

```
frontend/
├── __tests__/
│   ├── components/       # Component tests
│   ├── api/             # API route tests
│   └── utils/           # Test utilities
├── e2e/                 # Playwright E2E tests
├── jest.config.js       # Jest configuration
├── jest.setup.js        # Jest setup and mocks
└── playwright.config.ts # Playwright configuration
```

### Writing Component Tests

```typescript
import { render, screen } from '@/__tests__/utils/test-utils'
import { MyComponent } from '@/components/MyComponent'

describe('MyComponent', () => {
  it('renders correctly', () => {
    render(<MyComponent />)
    expect(screen.getByText('Hello')).toBeInTheDocument()
  })
})
```

### Writing E2E Tests

```typescript
import { test, expect } from '@playwright/test'

test('user can login', async ({ page }) => {
  await page.goto('/login')
  await page.fill('[name="email"]', 'user@example.com')
  await page.fill('[name="password"]', 'password')
  await page.click('button[type="submit"]')
  await expect(page).toHaveURL('/dashboard')
})
```

## Backend Testing

### Technology Stack
- **pytest**: Test framework
- **pytest-cov**: Coverage reporting
- **pytest-asyncio**: Async test support

### Running Tests

```bash
cd python-service

# Run all tests
pytest

# Run with coverage
pytest --cov=app --cov-report=html

# Run specific test file
pytest tests/test_collectors.py

# Run only unit tests
pytest -m unit

# Run only integration tests
pytest -m integration
```

### Test Structure

```
python-service/
├── tests/
│   ├── conftest.py          # Shared fixtures
│   ├── test_collectors.py   # Collector tests
│   ├── test_forecasting.py  # Forecast tests
│   └── test_scheduler.py    # Scheduler tests
└── pytest.ini               # Pytest configuration
```

### Writing Backend Tests

```python
import pytest

@pytest.mark.unit
def test_cost_calculation():
    """Test cost calculation logic"""
    cost = calculate_cost(tokens=1000, rate=0.03)
    assert cost == 30.0

@pytest.mark.integration
async def test_api_collector(mock_supabase_client):
    """Test API collector with mocked dependencies"""
    collector = APICollector(mock_supabase_client)
    result = await collector.collect()
    assert result.success
```

## Coverage Requirements

### Frontend
- **Overall**: 70%
- **Branches**: 70%
- **Functions**: 70%
- **Lines**: 70%

### Backend
- **Overall**: 70%
- **Statements**: 70%

## Test Categories

### Unit Tests (`@pytest.mark.unit` or `describe('Component')`)
- Fast, isolated tests
- No external dependencies
- Mock all side effects
- Run frequently during development

### Integration Tests (`@pytest.mark.integration`)
- Test interactions between modules
- May use test databases
- Test real API calls with mocks
- Run before commits

### E2E Tests (`e2e/*.spec.ts`)
- Test complete user workflows
- Run against real application
- Test critical paths
- Run before deployments

## Continuous Integration

Tests run automatically on:
- Pull requests
- Commits to main branch
- Before deployments

### CI Pipeline
1. Lint checks
2. Type checks
3. Unit tests
4. Integration tests
5. E2E tests (on main only)
6. Coverage reports

## Test Data

### Fixtures
- Shared test data in `conftest.py` (backend)
- Test utilities in `__tests__/utils/` (frontend)
- Mock API responses
- Synthetic datasets

### Generating Test Data

Frontend:
```typescript
import { generateMockCostData } from '@/__tests__/utils/test-utils'
const data = generateMockCostData(30)
```

Backend:
```python
@pytest.fixture
def sample_data():
    return [{"id": 1, "cost": 50.0}]
```

## Debugging Tests

### Frontend
```bash
# Debug a specific test
npm test -- --testNamePattern="MyComponent"

# Run with node debugger
node --inspect-brk node_modules/.bin/jest --runInBand
```

### Backend
```bash
# Run with verbose output
pytest -vv

# Run with pdb on failure
pytest --pdb

# Show print statements
pytest -s
```

## Best Practices

### DO
- Write tests before fixing bugs
- Test edge cases and error handling
- Use descriptive test names
- Keep tests fast and isolated
- Mock external dependencies
- Test user workflows, not implementation

### DON'T
- Test implementation details
- Share state between tests
- Use real API keys in tests
- Skip error cases
- Write overly complex tests

## Common Issues

### "Cannot find module '@/...'"
- Check `jest.config.js` moduleNameMapper
- Verify TypeScript paths in `tsconfig.json`

### "TypeError: Cannot read property..."
- Mock missing dependencies in `jest.setup.js`
- Check component props

### "Timeout waiting for element"
- Increase test timeout
- Check element selectors
- Verify async operations complete

### Playwright browser not found
```bash
npx playwright install
```

## Coverage Reports

### Frontend
```bash
npm run test:coverage
open coverage/lcov-report/index.html
```

### Backend
```bash
pytest --cov=app --cov-report=html
open htmlcov/index.html
```

## Resources

- [Jest Documentation](https://jestjs.io/)
- [React Testing Library](https://testing-library.com/react)
- [Playwright Documentation](https://playwright.dev/)
- [pytest Documentation](https://docs.pytest.org/)
