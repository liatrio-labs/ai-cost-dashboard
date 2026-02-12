# Contributing to AI Cost Dashboard

Thank you for your interest in contributing to the AI Cost Dashboard! This guide will help you get started.

## Table of Contents

1. [Code of Conduct](#code-of-conduct)
2. [Getting Started](#getting-started)
3. [Development Workflow](#development-workflow)
4. [Pull Request Process](#pull-request-process)
5. [Coding Standards](#coding-standards)
6. [Testing Guidelines](#testing-guidelines)
7. [Documentation](#documentation)
8. [Community](#community)

---

## Code of Conduct

### Our Pledge

We pledge to make participation in our project a harassment-free experience for everyone, regardless of age, body size, disability, ethnicity, gender identity, level of experience, nationality, personal appearance, race, religion, or sexual identity and orientation.

### Our Standards

**Positive behavior includes:**
- Using welcoming and inclusive language
- Being respectful of differing viewpoints
- Gracefully accepting constructive criticism
- Focusing on what is best for the community
- Showing empathy towards others

**Unacceptable behavior includes:**
- Trolling, insulting comments, and personal attacks
- Public or private harassment
- Publishing others' private information
- Other conduct reasonably considered inappropriate

### Enforcement

Instances of abusive behavior may be reported to the project team. All complaints will be reviewed and investigated promptly and fairly.

---

## Getting Started

### Prerequisites

Before contributing, ensure you have:

- **Node.js 18+** and npm
- **Python 3.11+** and pip
- **Git** installed
- **Supabase account** (for local development)
- **Basic knowledge** of TypeScript, React, Python, and PostgreSQL

### Fork and Clone

1. **Fork the repository** on GitHub
2. **Clone your fork:**
   ```bash
   git clone https://github.com/YOUR_USERNAME/ai-cost-dashboard.git
   cd ai-cost-dashboard
   ```
3. **Add upstream remote:**
   ```bash
   git remote add upstream https://github.com/original/ai-cost-dashboard.git
   ```

### Local Setup

Follow the [Local Development Guide](/docs/LOCAL_DEVELOPMENT.md) to set up your environment.

**Quick summary:**

```bash
# Frontend
cd frontend
npm install
cp .env.local.example .env.local
# Edit .env.local with your credentials
npm run dev

# Backend
cd python-service
python -m venv venv
source venv/bin/activate  # or venv\Scripts\activate on Windows
pip install -r requirements.txt
cp .env.example .env
# Edit .env with your credentials
uvicorn app.main:app --reload

# Database
# Apply migrations via Supabase Dashboard or CLI
```

---

## Development Workflow

### 1. Create a Branch

Create a feature branch for your work:

```bash
git checkout -b feature/your-feature-name
```

**Branch naming conventions:**
- `feature/` - New features
- `fix/` - Bug fixes
- `docs/` - Documentation updates
- `refactor/` - Code refactoring
- `test/` - Adding tests
- `chore/` - Build, CI, or tooling changes

**Examples:**
- `feature/add-budget-alerts`
- `fix/csv-import-validation`
- `docs/update-api-reference`

### 2. Make Changes

- Write clean, readable code
- Follow existing code style and conventions
- Add tests for new functionality
- Update documentation as needed
- Keep commits focused and atomic

### 3. Commit Your Changes

Write clear, descriptive commit messages:

```bash
git add .
git commit -m "feat: add budget alert notifications

- Implement email notification system
- Add user preferences for alert thresholds
- Create weekly summary email template
- Update settings page UI

Closes #42"
```

**Commit message format:**

```
<type>(<scope>): <subject>

<body>

<footer>
```

**Types:**
- `feat`: New feature
- `fix`: Bug fix
- `docs`: Documentation
- `style`: Formatting, missing semicolons, etc.
- `refactor`: Code restructuring
- `test`: Adding tests
- `chore`: Build, CI, tooling

**Examples:**
```
feat(dashboard): add cost breakdown by project

fix(csv-import): handle empty lines in CSV files

docs(api): update authentication examples

test(crypto): add integration tests for key rotation
```

### 4. Keep Your Branch Updated

Regularly sync with upstream:

```bash
git fetch upstream
git rebase upstream/main
```

If conflicts arise, resolve them and continue:

```bash
# Fix conflicts in files
git add .
git rebase --continue
```

### 5. Push Your Changes

```bash
git push origin feature/your-feature-name
```

---

## Pull Request Process

### Before Submitting

- [ ] Code follows project style guidelines
- [ ] Tests pass locally (`npm test`, `pytest`)
- [ ] Documentation updated (if applicable)
- [ ] No console.log() or print() statements left in code
- [ ] Branch is up-to-date with `main`
- [ ] Commit messages are clear and descriptive

### Creating a Pull Request

1. **Go to GitHub** and open your fork
2. **Click "New Pull Request"**
3. **Select your branch** vs. `upstream/main`
4. **Fill out the PR template:**

```markdown
## Description
Brief description of what this PR does.

## Type of Change
- [ ] Bug fix
- [ ] New feature
- [ ] Breaking change
- [ ] Documentation update

## Related Issue
Closes #123

## Testing
Describe how you tested your changes.

## Screenshots (if applicable)
Add screenshots for UI changes.

## Checklist
- [ ] Tests pass
- [ ] Documentation updated
- [ ] No breaking changes (or documented)
```

5. **Submit the PR**

### Review Process

1. **Automated checks** run (lint, tests, build)
2. **Maintainer reviews** code
3. **Address feedback** if requested
4. **Approval** from at least one maintainer
5. **Merge** to main

**Review timeline:**
- Small PRs (<100 lines): 1-2 days
- Medium PRs (100-500 lines): 3-5 days
- Large PRs (>500 lines): 5-7 days

**Tips for faster review:**
- Keep PRs small and focused
- Write clear PR descriptions
- Respond promptly to feedback
- Add tests and documentation

---

## Coding Standards

### TypeScript/React (Frontend)

**Style Guide:**
- Use **TypeScript** for all new files
- Follow **ESLint** and **Prettier** rules
- Use **functional components** and hooks
- Prefer **named exports** over default exports

**Component Structure:**

```typescript
"use client" // if client component

import * as React from "react"
import { useState } from "react"
import { Button } from "@/components/ui/button"

interface MyComponentProps {
  title: string
  onSave: (data: string) => void
}

export function MyComponent({ title, onSave }: MyComponentProps) {
  const [value, setValue] = useState("")

  const handleSubmit = () => {
    onSave(value)
  }

  return (
    <div>
      <h2>{title}</h2>
      <input value={value} onChange={(e) => setValue(e.target.value)} />
      <Button onClick={handleSubmit}>Save</Button>
    </div>
  )
}
```

**Best Practices:**
- Extract reusable logic into custom hooks
- Use TypeScript for prop types
- Avoid inline styles (use Tailwind classes)
- Keep components small (<200 lines)
- Use TanStack Query for data fetching

### Python (Backend)

**Style Guide:**
- Follow **PEP 8** standards
- Use **Black** for formatting
- Use **type hints** for all functions
- Use **docstrings** for complex functions

**Function Structure:**

```python
from typing import Optional
from datetime import datetime

def calculate_cost(
    tokens: int,
    model_name: str,
    timestamp: datetime,
    discount_factor: Optional[float] = None
) -> float:
    """
    Calculate cost for AI API usage.

    Args:
        tokens: Number of tokens used
        model_name: Name of the AI model
        timestamp: When the usage occurred
        discount_factor: Optional discount multiplier

    Returns:
        float: Calculated cost in USD

    Raises:
        ValueError: If tokens is negative
    """
    if tokens < 0:
        raise ValueError("Tokens must be non-negative")

    base_cost = get_model_price(model_name) * tokens

    if discount_factor:
        base_cost *= discount_factor

    return round(base_cost, 6)
```

**Best Practices:**
- Use `async/await` for I/O operations
- Type hint all function signatures
- Handle exceptions gracefully
- Log errors with context (never log API keys!)
- Use environment variables for config

### SQL (Database)

**Best Practices:**
- Use **parameterized queries** (prevent SQL injection)
- Add **indexes** for frequently queried columns
- Use **transactions** for multi-statement operations
- Write **idempotent migrations** (can run multiple times safely)

**Migration Example:**

```sql
-- Create table idempotently
CREATE TABLE IF NOT EXISTS new_table (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    user_id UUID NOT NULL REFERENCES auth.users(id),
    created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Create index idempotently
CREATE INDEX IF NOT EXISTS new_table_user_id_idx ON new_table(user_id);

-- Enable RLS
ALTER TABLE new_table ENABLE ROW LEVEL SECURITY;

-- Create policy idempotently
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_policies WHERE tablename = 'new_table' AND policyname = 'Users can view own data'
    ) THEN
        CREATE POLICY "Users can view own data"
            ON new_table FOR SELECT
            USING (auth.uid() = user_id);
    END IF;
END $$;
```

---

## Testing Guidelines

### Frontend Tests

**Unit Tests (Jest + React Testing Library):**

```typescript
import { render, screen, fireEvent } from '@testing-library/react'
import { ManualEntryForm } from './ManualEntryForm'

describe('ManualEntryForm', () => {
  it('should submit form with valid data', async () => {
    const onSuccess = jest.fn()
    render(<ManualEntryForm providerId="test-uuid" onSuccess={onSuccess} />)

    fireEvent.change(screen.getByLabelText('Date'), { target: { value: '2026-02-11' } })
    fireEvent.change(screen.getByLabelText('Cost'), { target: { value: '5.50' } })
    fireEvent.change(screen.getByLabelText('Model'), { target: { value: 'gpt-4' } })

    fireEvent.click(screen.getByText('Add Entry'))

    await waitFor(() => {
      expect(onSuccess).toHaveBeenCalled()
    })
  })

  it('should show validation error for negative cost', () => {
    render(<ManualEntryForm providerId="test-uuid" />)

    fireEvent.change(screen.getByLabelText('Cost'), { target: { value: '-1' } })
    fireEvent.click(screen.getByText('Add Entry'))

    expect(screen.getByText('Cost must be a positive number')).toBeInTheDocument()
  })
})
```

**E2E Tests (Playwright):**

```typescript
import { test, expect } from '@playwright/test'

test('user can add manual cost entry', async ({ page }) => {
  await page.goto('/dashboard/chatgpt')

  await page.fill('input[name="date"]', '2026-02-11')
  await page.fill('input[name="cost"]', '5.50')
  await page.fill('input[name="model"]', 'gpt-4')
  await page.click('button:has-text("Add Entry")')

  await expect(page.locator('text=Entry saved successfully')).toBeVisible()
  await expect(page.locator('table tbody tr:first-child')).toContainText('$5.50')
})
```

### Backend Tests

**Unit Tests (pytest):**

```python
import pytest
from app.utils.crypto import encrypt_api_key, decrypt_api_key

def test_encrypt_decrypt_roundtrip():
    plaintext = "sk-ant-api03-test123"
    encrypted = encrypt_api_key(plaintext)
    decrypted = decrypt_api_key(encrypted)

    assert decrypted == plaintext
    assert encrypted != plaintext

def test_encrypt_empty_string_raises_error():
    with pytest.raises(EncryptionError):
        encrypt_api_key("")

@pytest.mark.asyncio
async def test_collect_anthropic_costs(mock_anthropic_client):
    collector = AnthropicCollector(user_id="test-uuid")

    mock_anthropic_client.admin.usage.list.return_value = [
        {"date": "2026-02-11", "cost_usd": 5.50, "model": "claude-3-opus"}
    ]

    results = await collector.collect()

    assert len(results) == 1
    assert results[0]["cost_usd"] == 5.50
```

### Test Coverage

Aim for:
- **80%+ overall** code coverage
- **100%** for critical paths (auth, encryption, payments)
- **90%+** for utils and helpers

Run coverage:

```bash
# Frontend
npm run test:coverage

# Backend
pytest --cov=app --cov-report=html
```

---

## Documentation

### When to Update Documentation

Update docs when you:
- Add new features
- Change API endpoints
- Modify configuration options
- Fix bugs (if user-facing)
- Deprecate functionality

### Documentation Files

| File | When to Update |
|------|---------------|
| `README.md` | Major features, setup changes |
| `docs/USER_GUIDE.md` | User-facing features |
| `docs/API.md` | API changes |
| `docs/LOCAL_DEVELOPMENT.md` | Dev setup changes |
| `CONTRIBUTING.md` | Contribution process changes |
| Component files | Add JSDoc/TSDoc comments |
| Python files | Add docstrings |

### Writing Style

- Use **clear, simple language**
- Include **code examples**
- Add **screenshots** for UI changes
- Link to related docs
- Keep examples **up-to-date**

---

## Community

### Communication Channels

**GitHub:**
- Issues: Bug reports and feature requests
- Discussions: Questions and ideas
- Pull Requests: Code contributions

**Discord (example):**
- `#general`: General discussion
- `#help`: Get help with issues
- `#development`: Development discussion
- `#announcements`: Project updates

### Getting Help

**I found a bug:**
1. Check existing issues
2. If new, open an issue with:
   - Clear title
   - Steps to reproduce
   - Expected vs actual behavior
   - Screenshots (if UI bug)
   - Environment (OS, browser, versions)

**I have a question:**
1. Check documentation first
2. Search existing issues/discussions
3. Ask in Discord #help channel
4. Open a discussion on GitHub

**I want to suggest a feature:**
1. Check if already requested
2. Open a feature request issue
3. Describe:
   - Problem it solves
   - Proposed solution
   - Alternatives considered
   - Impact on existing features

### Recognition

Contributors are recognized in:
- `CONTRIBUTORS.md` file
- Release notes
- Project README

---

## Release Process

(For maintainers)

### Versioning

We use **Semantic Versioning** (semver):
- **Major (v2.0.0):** Breaking changes
- **Minor (v1.1.0):** New features, backwards-compatible
- **Patch (v1.0.1):** Bug fixes

### Release Checklist

- [ ] All tests pass
- [ ] Documentation updated
- [ ] CHANGELOG.md updated
- [ ] Version bumped in package.json and __init__.py
- [ ] Tagged in git: `git tag v1.0.0`
- [ ] Pushed to GitHub: `git push --tags`
- [ ] GitHub release created with notes
- [ ] Deployed to production

---

## License

By contributing, you agree that your contributions will be licensed under the MIT License.

---

## Questions?

- Read the [User Guide](/docs/USER_GUIDE.md)
- Check [Local Development Guide](/docs/LOCAL_DEVELOPMENT.md)
- Ask in GitHub Discussions
- Email: dev@example.com

Thank you for contributing! 🎉
