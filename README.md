# AI Cost Dashboard

A beautiful, full-featured dashboard for tracking AI spending across multiple providers with automated data collection and ML-based forecasting.

## Overview

**AI Cost Dashboard** provides centralized visibility into AI spending across:
- **Anthropic API** (Claude API)
- **Claude Desktop** (via Claude.ai usage)
- **OpenAI API** (GPT models)
- **ChatGPT** (manual entry)

### Key Features

- 📊 **Real-time Cost Tracking**: Automated data collection from Anthropic and OpenAI APIs
- 📈 **Historical Visualization**: Interactive charts showing cost trends over time
- 🔮 **ML-Based Forecasting**: 30-day cost predictions using Facebook Prophet
- 👥 **Multi-User Support**: Team authentication with row-level security (2-5 users)
- 🔒 **Secure Key Storage**: Encrypted API key storage
- 📱 **Responsive Design**: Mobile-friendly interface
- 🌙 **Dark Mode**: Beautiful UI with light/dark themes

## Architecture

### Tech Stack

**Frontend:**
- Next.js 14 (App Router)
- TypeScript
- Tailwind CSS
- Shadcn/ui components
- Tremor & Recharts for visualizations
- TanStack Query for data fetching
- Supabase Auth for authentication

**Backend:**
- FastAPI (Python) for data collection and ML
- Supabase PostgreSQL for database
- Facebook Prophet for forecasting
- APScheduler for cron jobs

**Deployment:**
- Frontend: Vercel
- Backend: Render
- Database: Supabase

### High-Level Architecture

```
User → Next.js Dashboard → Supabase PostgreSQL
                         ↓
                   FastAPI Service → External APIs (Anthropic, OpenAI)
                         ↓
                   Prophet ML Model → Forecasts
```

## Project Structure

```
ai-cost-dashboard/
├── src/                          # Next.js frontend
│   ├── app/                     # App Router pages
│   ├── components/              # React components
│   ├── lib/                     # Utilities and clients
│   └── types/                   # TypeScript types
├── python-service/              # FastAPI backend
│   ├── app/                     # FastAPI application
│   │   ├── collectors/         # API data collectors
│   │   ├── forecasting/        # Prophet ML models
│   │   ├── routers/            # API routes
│   │   └── utils/              # Utilities
│   └── requirements.txt
├── database/                    # Database migrations
│   └── migrations/             # SQL migration files
├── docs/                        # Documentation
└── e2e/                         # End-to-end tests
```

## Getting Started

### Prerequisites

- Node.js 18+ and npm
- Python 3.11+
- Supabase account
- Anthropic API key (Admin key for organization)
- OpenAI API key

### Local Development Setup

Coming soon - see individual component README files:
- [Frontend Setup](./docs/frontend-setup.md)
- [Backend Setup](./python-service/README.md)
- [Database Setup](./database/README.md)

## Features in Detail

### Automated Data Collection

- **Anthropic**: Hourly collection via Admin API
- **OpenAI**: Collection every 6 hours
- **ChatGPT**: Manual entry with CSV import

### Cost Visualization

- KPI cards: Total month, yesterday, forecast, top model
- Time-series chart: Historical costs (stacked by provider)
- Provider breakdown: Pie chart showing cost distribution
- Recent activity table

### ML Forecasting

- 30-day predictions using Facebook Prophet
- Confidence intervals (80%, 95%)
- Weekly seasonality detection
- Automatic retraining

### Security

- Encrypted API key storage (AES-256)
- Row-level security for multi-user access
- Rate limiting on all endpoints
- HTTPS only in production

## Development Timeline

- **Week 1**: Project setup, database, infrastructure
- **Week 2-3**: Backend development (data collectors)
- **Week 3-4**: Frontend development (dashboard UI)
- **Week 4-5**: Forecasting implementation
- **Week 5**: Authentication and multi-user support
- **Week 6**: Testing and quality assurance
- **Week 6-7**: Deployment and DevOps
- **Week 7**: Polish and optimization

## Contributing

This is a team project (2-5 members). See [CONTRIBUTING.md](./docs/CONTRIBUTING.md) for guidelines.

## License

MIT License - see [LICENSE](./LICENSE) file for details.

## Support

For issues and questions:
- Open an issue on GitHub
- Check [docs/TROUBLESHOOTING.md](./docs/TROUBLESHOOTING.md)
- Review [docs/USER_GUIDE.md](./docs/USER_GUIDE.md)

---

Built with ❤️ for better AI cost visibility
