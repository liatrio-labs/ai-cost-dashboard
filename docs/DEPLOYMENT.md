# AI Cost Dashboard - Deployment Guide

Complete guide for deploying the AI Cost Dashboard to production.

## Architecture Overview

```
┌─────────────────┐      ┌──────────────────┐      ┌─────────────────┐
│                 │      │                  │      │                 │
│  Next.js        │─────▶│  FastAPI         │─────▶│  Supabase       │
│  (Vercel)       │      │  (Render)        │      │  (Hosted)       │
│                 │      │                  │      │                 │
└─────────────────┘      └──────────────────┘      └─────────────────┘
   - Frontend              - Data collectors         - PostgreSQL
   - Auth UI               - ML forecasting          - Auth
   - Dashboard             - Scheduled jobs          - Storage
```

## Prerequisites

Before deploying, ensure you have:

1. **Accounts**:
   - GitHub account (for code hosting and CI/CD)
   - Vercel account (for frontend hosting)
   - Render account (for backend hosting)
   - Supabase account (for database and auth)

2. **API Keys**:
   - Anthropic Admin API key (organization-level)
   - OpenAI API key

3. **Tools**:
   - Git
   - Node.js 18+ (for local testing)
   - Python 3.11+ (for local testing)
   - Docker (optional, for local development)

## Deployment Steps

### 1. Supabase Setup

#### Create Project

1. Go to [Supabase Dashboard](https://app.supabase.com/)
2. Click "New Project"
3. Choose organization and fill in:
   - **Project Name**: ai-cost-dashboard
   - **Database Password**: (strong password, save securely)
   - **Region**: Choose closest to users
4. Wait for project creation (~2 minutes)

#### Run Migrations

1. Navigate to SQL Editor in Supabase dashboard
2. Create a new query
3. Copy contents of `database/migrations/001_initial_schema.sql`
4. Run the migration
5. Verify tables created:
   - `providers`
   - `api_credentials`
   - `cost_records` (with partitions)
   - `forecast_results`
   - `user_preferences`

#### Get API Keys

From Project Settings → API:
- **Project URL**: `https://xxxxx.supabase.co`
- **Anon/Public Key**: For frontend (safe to expose)
- **Service Role Key**: For backend (keep secret)

#### Configure Auth

1. Go to Authentication → Providers
2. Enable Email provider
3. (Optional) Enable OAuth providers:
   - Google
   - GitHub
4. Configure email templates (optional)
5. Set redirect URLs:
   - Production: `https://your-domain.vercel.app/auth/callback`
   - Development: `http://localhost:3000/auth/callback`

### 2. Backend Deployment (Render)

#### Create Web Service

1. Go to [Render Dashboard](https://dashboard.render.com/)
2. Click "New" → "Web Service"
3. Connect your GitHub repository
4. Configure service:
   - **Name**: ai-cost-dashboard-api
   - **Region**: Oregon (or closest to Supabase)
   - **Branch**: main
   - **Root Directory**: python-service
   - **Runtime**: Python 3
   - **Build Command**: `pip install -r requirements.txt`
   - **Start Command**: `uvicorn app.main:app --host 0.0.0.0 --port $PORT`
   - **Plan**: Starter ($7/month)

#### Set Environment Variables

Add the following environment variables in Render dashboard:

```bash
# Supabase
SUPABASE_URL=https://xxxxx.supabase.co
SUPABASE_SERVICE_KEY=your-service-role-key

# Encryption (generate a 32-byte base64 key)
ENCRYPTION_KEY=your-32-byte-base64-key

# Environment
ENVIRONMENT=production
LOG_LEVEL=INFO
HOST=0.0.0.0
PORT=8000
```

**Generate encryption key:**
```bash
python -c "from cryptography.fernet import Fernet; print(Fernet.generate_key().decode())"
```

#### Configure Health Checks

- **Health Check Path**: `/health`
- **Health Check Timeout**: 30 seconds
- **Health Check Interval**: 30 seconds

#### Deploy

1. Click "Create Web Service"
2. Wait for initial deployment (~5 minutes)
3. Verify deployment:
   ```bash
   curl https://your-service.onrender.com/health
   # Should return: {"status":"healthy"}
   ```

#### Set Up Cron Jobs

Render supports native cron jobs. Create the following:

1. **Anthropic Collection** (hourly at :05):
   ```bash
   # Schedule: 5 * * * *
   curl -X POST https://your-service.onrender.com/api/scheduler/jobs/anthropic_collection/trigger
   ```

2. **OpenAI Collection** (every 6 hours at :10):
   ```bash
   # Schedule: 10 0,6,12,18 * * *
   curl -X POST https://your-service.onrender.com/api/scheduler/jobs/openai_collection/trigger
   ```

3. **Aggregate Refresh** (every 15 minutes):
   ```bash
   # Schedule: */15 * * * *
   curl -X POST https://your-service.onrender.com/api/scheduler/jobs/aggregate_refresh/trigger
   ```

4. **Forecasting** (daily at midnight):
   ```bash
   # Schedule: 0 0 * * *
   curl -X POST https://your-service.onrender.com/api/scheduler/jobs/forecasting/trigger
   ```

### 3. Frontend Deployment (Vercel)

#### Connect Repository

1. Go to [Vercel Dashboard](https://vercel.com/dashboard)
2. Click "Add New" → "Project"
3. Import your GitHub repository
4. Configure project:
   - **Framework Preset**: Next.js
   - **Root Directory**: frontend (if in subdirectory)
   - **Build Command**: `npm run build`
   - **Output Directory**: `.next`
   - **Install Command**: `npm install`

#### Set Environment Variables

Add in Vercel dashboard (Settings → Environment Variables):

```bash
# Supabase (Public - safe to expose)
NEXT_PUBLIC_SUPABASE_URL=https://xxxxx.supabase.co
NEXT_PUBLIC_SUPABASE_ANON_KEY=your-anon-key

# Backend API
NEXT_PUBLIC_API_URL=https://your-service.onrender.com

# Optional: Analytics
NEXT_PUBLIC_VERCEL_ANALYTICS_ID=your-analytics-id
```

#### Configure Domains

1. Add custom domain (optional):
   - Go to Settings → Domains
   - Add domain: `dashboard.yourdomain.com`
   - Follow DNS configuration instructions

2. Update Supabase redirect URLs:
   - Add production URL to allowed redirect URLs
   - Update in Supabase Dashboard → Authentication → URL Configuration

#### Deploy

1. Click "Deploy"
2. Wait for deployment (~2 minutes)
3. Visit your URL to verify

### 4. CI/CD Setup

#### GitHub Secrets

Add the following secrets in GitHub repository settings (Settings → Secrets and variables → Actions):

**Backend:**
- `RENDER_API_KEY`: From Render Account Settings → API Keys
- `RENDER_SERVICE_ID`: From Render service URL (service ID)
- `RENDER_SERVICE_URL`: Full service URL

**Frontend:**
- `VERCEL_TOKEN`: From Vercel Account Settings → Tokens
- `VERCEL_ORG_ID`: From Vercel project settings
- `VERCEL_PROJECT_ID`: From Vercel project settings

**General:**
- `SUPABASE_ACCESS_TOKEN`: From Supabase Dashboard → Settings → API

#### Enable Workflows

The following workflows are already configured:

1. **test-backend.yml**: Runs on every PR
2. **deploy-backend.yml**: Deploys to Render on main branch push
3. **test-frontend.yml**: Runs frontend tests on PR
4. **deploy-frontend.yml**: Deploys to Vercel on main branch push

Workflows will trigger automatically once secrets are configured.

## Local Development with Docker

### Quick Start

1. **Clone repository:**
   ```bash
   git clone https://github.com/yourusername/ai-cost-dashboard.git
   cd ai-cost-dashboard
   ```

2. **Create environment files:**
   ```bash
   # Backend
   cp python-service/.env.example python-service/.env

   # Frontend
   cp frontend/.env.local.example frontend/.env.local
   ```

3. **Start services:**
   ```bash
   docker-compose up -d
   ```

4. **Access services:**
   - Frontend: http://localhost:3000
   - Backend: http://localhost:8000
   - Backend API docs: http://localhost:8000/docs
   - PostgreSQL: localhost:5432

5. **Stop services:**
   ```bash
   docker-compose down
   ```

### Development Workflow

```bash
# Start with logs
docker-compose up

# Rebuild after code changes
docker-compose up --build

# Run migrations
docker-compose exec postgres psql -U postgres -d ai_cost_dashboard -f /docker-entrypoint-initdb.d/001_initial_schema.sql

# Access backend shell
docker-compose exec backend bash

# View logs
docker-compose logs -f backend
docker-compose logs -f frontend
```

## Environment Variables Reference

### Backend (FastAPI)

| Variable | Description | Required | Example |
|----------|-------------|----------|---------|
| `SUPABASE_URL` | Supabase project URL | Yes | `https://xxx.supabase.co` |
| `SUPABASE_SERVICE_KEY` | Service role key (secret) | Yes | `eyJ...` |
| `ENCRYPTION_KEY` | 32-byte base64 encryption key | Yes | Generate with Fernet |
| `ENVIRONMENT` | Environment name | No | `production` |
| `LOG_LEVEL` | Logging level | No | `INFO` |
| `HOST` | Server host | No | `0.0.0.0` |
| `PORT` | Server port | No | `8000` |
| `ANTHROPIC_API_KEY` | For testing only | No | `sk-ant-...` |
| `OPENAI_API_KEY` | For testing only | No | `sk-proj-...` |

### Frontend (Next.js)

| Variable | Description | Required | Example |
|----------|-------------|----------|---------|
| `NEXT_PUBLIC_SUPABASE_URL` | Supabase project URL (public) | Yes | `https://xxx.supabase.co` |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | Anon key (public) | Yes | `eyJ...` |
| `NEXT_PUBLIC_API_URL` | FastAPI backend URL | Yes | `https://api.yourdomain.com` |
| `NEXT_PUBLIC_VERCEL_ANALYTICS_ID` | Analytics ID (optional) | No | `xxx` |

## Verification Checklist

After deployment, verify:

### Backend
- [ ] Health check returns 200: `curl https://api/health`
- [ ] Database health check passes: `curl https://api/health/db`
- [ ] Scheduler is running: `curl https://api/scheduler/health`
- [ ] API docs accessible: `https://api/docs`
- [ ] Cron jobs configured in Render dashboard

### Frontend
- [ ] Homepage loads
- [ ] Login page accessible
- [ ] Can create account
- [ ] Dashboard displays after login
- [ ] API calls to backend succeed (check Network tab)

### Database
- [ ] All tables exist in Supabase
- [ ] RLS policies enabled
- [ ] Default providers seeded
- [ ] Can insert test data

### Integration
- [ ] End-to-end user flow works:
  1. Sign up
  2. Add API key
  3. Trigger collection manually
  4. View data in dashboard

## Monitoring

### Render
- View logs: Render Dashboard → Service → Logs
- View metrics: Render Dashboard → Service → Metrics
- Set up alerts: Render Dashboard → Service → Alerts

### Vercel
- View logs: Vercel Dashboard → Project → Logs
- View analytics: Vercel Dashboard → Project → Analytics
- Monitor errors: Vercel Dashboard → Project → Speed Insights

### Supabase
- View queries: Supabase Dashboard → SQL Editor
- View logs: Supabase Dashboard → Logs
- Monitor usage: Supabase Dashboard → Settings → Usage

## Troubleshooting

### Backend Issues

**Service won't start:**
- Check environment variables are set correctly
- Verify Supabase connection (wrong URL/key)
- Check logs for Python errors
- Ensure all dependencies installed

**Scheduler not running:**
- Check `/api/scheduler/health` endpoint
- Verify scheduler started in logs
- Check if jobs are scheduled: `/api/scheduler/jobs`

**Collection failures:**
- Verify API keys are valid
- Check rate limits
- Review job history: `/api/scheduler/history`

### Frontend Issues

**Can't connect to backend:**
- Verify `NEXT_PUBLIC_API_URL` is correct
- Check CORS configuration in backend
- Ensure backend is deployed and healthy

**Auth not working:**
- Verify Supabase URL and anon key
- Check redirect URLs in Supabase dashboard
- Clear browser cache and cookies

### Database Issues

**Migrations failed:**
- Check SQL syntax
- Verify extensions are enabled
- Run migrations one at a time

**RLS blocking queries:**
- Verify user is authenticated
- Check RLS policies are correct
- Use service role key for admin operations

## Security Considerations

1. **Never commit secrets to Git**
   - Use `.env` files (gitignored)
   - Use Vercel/Render environment variables
   - Rotate keys regularly

2. **Use HTTPS everywhere**
   - Vercel provides automatic HTTPS
   - Render provides automatic HTTPS
   - Never use HTTP in production

3. **Implement rate limiting**
   - Vercel Edge Network provides DDoS protection
   - Render provides rate limiting
   - Implement application-level rate limits

4. **Monitor for suspicious activity**
   - Review logs regularly
   - Set up alerts for failures
   - Monitor API usage patterns

## Backup Strategy

### Database
- Supabase provides automatic daily backups
- Additional backups: Use `pg_dump`
- Test restore process regularly

### Code
- GitHub provides version control
- Tag releases: `git tag v1.0.0`
- Keep production branch stable

## Rollback Procedure

### Backend (Render)
1. Go to Render Dashboard → Service → Events
2. Click "Rollback" on previous deployment
3. Verify health check passes

### Frontend (Vercel)
1. Go to Vercel Dashboard → Project → Deployments
2. Click "..." on previous deployment
3. Click "Promote to Production"

### Database (Supabase)
1. Go to Supabase Dashboard → Settings → Backups
2. Select backup to restore
3. Confirm restoration

## Cost Estimates

### Monthly Costs
- **Vercel**: Free (Hobby tier) or $20/month (Pro)
- **Render**: $7/month (Starter) or $25/month (Standard)
- **Supabase**: Free (up to 500MB) or $25/month (Pro)

**Total**: ~$7-$70/month depending on tier

### Cost Optimization
- Use Vercel Hobby tier for personal use
- Optimize database queries to reduce Supabase load
- Use caching to reduce API calls
- Monitor usage and adjust as needed

## Support

For deployment issues:
1. Check logs first (Render, Vercel, Supabase)
2. Review this documentation
3. Check GitHub Issues
4. Contact team lead

---

**Last Updated**: 2026-02-11
**Version**: 1.0.0
