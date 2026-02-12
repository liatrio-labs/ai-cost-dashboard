# Local Development Guide

Guide for setting up the AI Cost Dashboard for local development.

## Quick Start

### Option 1: Docker Compose (Recommended)

The fastest way to get started with all services:

```bash
# 1. Clone the repository
git clone https://github.com/yourusername/ai-cost-dashboard.git
cd ai-cost-dashboard

# 2. Copy environment files
cp python-service/.env.example python-service/.env
cp frontend/.env.local.example frontend/.env.local

# 3. Start all services
docker-compose up

# 4. Access the application
# Frontend: http://localhost:3000
# Backend API: http://localhost:8000
# API Docs: http://localhost:8000/docs
```

### Option 2: Manual Setup

If you prefer running services individually:

#### Backend (FastAPI)

```bash
# Navigate to backend
cd python-service

# Create virtual environment
python -m venv venv
source venv/bin/activate  # On Windows: venv\Scripts\activate

# Install dependencies
pip install -r requirements.txt

# Copy environment file
cp .env.example .env
# Edit .env with your Supabase credentials

# Run database migrations (in Supabase dashboard)
# See database/migrations/001_initial_schema.sql

# Start the server
uvicorn app.main:app --reload --host 0.0.0.0 --port 8000
```

Backend will be available at:
- API: http://localhost:8000
- Interactive docs: http://localhost:8000/docs
- ReDoc: http://localhost:8000/redoc

#### Frontend (Next.js)

```bash
# Navigate to frontend
cd frontend

# Install dependencies
npm install

# Copy environment file
cp .env.local.example .env.local
# Edit .env.local with your Supabase and API URLs

# Start development server
npm run dev
```

Frontend will be available at http://localhost:3000

## Environment Setup

### Backend Environment Variables

Create `python-service/.env`:

```bash
# Supabase
SUPABASE_URL=https://your-project.supabase.co
SUPABASE_SERVICE_KEY=your-service-key

# Encryption
ENCRYPTION_KEY=generate-with-fernet

# Server
ENVIRONMENT=development
LOG_LEVEL=DEBUG
HOST=0.0.0.0
PORT=8000

# Optional: API keys for testing
ANTHROPIC_API_KEY=sk-ant-...
OPENAI_API_KEY=sk-proj-...
```

**Generate encryption key:**
```bash
python -c "from cryptography.fernet import Fernet; print(Fernet.generate_key().decode())"
```

### Frontend Environment Variables

Create `frontend/.env.local`:

```bash
# Supabase (public - safe for frontend)
NEXT_PUBLIC_SUPABASE_URL=https://your-project.supabase.co
NEXT_PUBLIC_SUPABASE_ANON_KEY=your-anon-key

# Backend API
NEXT_PUBLIC_API_URL=http://localhost:8000
```

## Database Setup

### Using Supabase (Recommended)

1. Create a free Supabase project at https://supabase.com
2. Go to SQL Editor
3. Run the migration: `database/migrations/001_initial_schema.sql`
4. Copy API keys from Settings → API

### Using Local PostgreSQL (Docker)

If using docker-compose, PostgreSQL runs automatically with:
- Host: localhost
- Port: 5432
- Database: ai_cost_dashboard
- User: postgres
- Password: postgres

Migrations run automatically on container start.

## Development Workflow

### Backend Development

#### Running the Server

```bash
cd python-service
source venv/bin/activate
uvicorn app.main:app --reload
```

#### Running Tests

```bash
cd python-service
pytest tests/ -v
```

#### Testing Collectors

```bash
# Test Anthropic collector
python test_collector.py --api-key YOUR_KEY --skip-db

# Test OpenAI collector
python test_openai_collector.py --api-key YOUR_KEY --skip-db
```

#### Testing Scheduler

```bash
# Check scheduler status
curl http://localhost:8000/api/scheduler/status

# Trigger a job manually
curl -X POST http://localhost:8000/api/scheduler/jobs/anthropic_collection/trigger

# View job history
curl http://localhost:8000/api/scheduler/history
```

#### API Testing

Interactive API documentation is available at:
- **Swagger UI**: http://localhost:8000/docs
- **ReDoc**: http://localhost:8000/redoc

### Frontend Development

#### Running the Server

```bash
cd frontend
npm run dev
```

#### Running Tests

```bash
cd frontend
npm test
```

#### Type Checking

```bash
cd frontend
npm run type-check
```

#### Linting

```bash
cd frontend
npm run lint
```

#### Building

```bash
cd frontend
npm run build
```

## Docker Development

### Building Images

```bash
# Build all services
docker-compose build

# Build specific service
docker-compose build backend
docker-compose build frontend
```

### Managing Containers

```bash
# Start services
docker-compose up

# Start in detached mode
docker-compose up -d

# Stop services
docker-compose down

# View logs
docker-compose logs -f
docker-compose logs -f backend
docker-compose logs -f frontend

# Restart a service
docker-compose restart backend

# Execute commands in container
docker-compose exec backend bash
docker-compose exec postgres psql -U postgres
```

### Database Operations

```bash
# Access PostgreSQL
docker-compose exec postgres psql -U postgres -d ai_cost_dashboard

# Run migrations
docker-compose exec postgres psql -U postgres -d ai_cost_dashboard -f /docker-entrypoint-initdb.d/001_initial_schema.sql

# Backup database
docker-compose exec postgres pg_dump -U postgres ai_cost_dashboard > backup.sql

# Restore database
docker-compose exec -T postgres psql -U postgres ai_cost_dashboard < backup.sql
```

## Testing the Full Stack

### 1. Verify Backend

```bash
# Health check
curl http://localhost:8000/health

# Database health
curl http://localhost:8000/health/db

# Scheduler health
curl http://localhost:8000/api/scheduler/health

# API docs
open http://localhost:8000/docs
```

### 2. Verify Frontend

```bash
# Open in browser
open http://localhost:3000

# Check console for errors (F12)
# Verify API calls in Network tab
```

### 3. End-to-End Test

1. **Sign Up**:
   - Go to http://localhost:3000
   - Click "Sign Up"
   - Create account with email/password
   - Verify email (check Supabase inbox)

2. **Add API Key**:
   - Log in
   - Go to Settings
   - Add Anthropic or OpenAI API key
   - Key should be encrypted in database

3. **Trigger Collection**:
   ```bash
   curl -X POST http://localhost:8000/api/collection/trigger \
     -H "Content-Type: application/json" \
     -d '{
       "provider": "anthropic",
       "user_id": "your-user-id",
       "backfill": false
     }'
   ```

4. **View Data**:
   - Refresh dashboard
   - Should see cost data
   - Check charts and tables

## Troubleshooting

### Backend Issues

**"Module not found" errors:**
```bash
cd python-service
pip install -r requirements.txt
```

**"Connection refused" to database:**
- Check Supabase URL and key
- Verify database is running (if using Docker)
- Check firewall settings

**Scheduler not starting:**
- Check logs: `docker-compose logs backend`
- Verify APScheduler installed
- Check for port conflicts

### Frontend Issues

**"Cannot connect to API":**
- Verify backend is running at correct port
- Check `NEXT_PUBLIC_API_URL` in `.env.local`
- Check browser console for CORS errors

**Build errors:**
```bash
cd frontend
rm -rf .next node_modules
npm install
npm run build
```

**Auth not working:**
- Verify Supabase URL and anon key
- Check redirect URLs in Supabase dashboard
- Clear cookies and local storage

### Docker Issues

**"Port already in use":**
```bash
# Find process using port
lsof -i :8000  # or :3000
# Kill process
kill -9 <PID>
```

**Containers won't start:**
```bash
# Remove all containers and volumes
docker-compose down -v
# Rebuild
docker-compose up --build
```

**Out of disk space:**
```bash
# Clean up Docker
docker system prune -a
docker volume prune
```

## Useful Commands

### Backend

```bash
# Install new package
pip install package-name
pip freeze > requirements.txt

# Format code
black app/

# Type check
mypy app/

# Lint
ruff check app/

# Run specific test
pytest tests/test_collectors.py -v
```

### Frontend

```bash
# Install new package
npm install package-name

# Update packages
npm update

# Check for outdated packages
npm outdated

# Audit security
npm audit
npm audit fix
```

### Database

```bash
# Connect to local PostgreSQL
psql -h localhost -U postgres -d ai_cost_dashboard

# List tables
\dt

# Describe table
\d cost_records

# View data
SELECT * FROM cost_records LIMIT 10;

# Check RLS policies
SELECT * FROM pg_policies WHERE tablename = 'cost_records';
```

## IDE Setup

### VS Code

Recommended extensions:
- Python (ms-python.python)
- Pylance (ms-python.vscode-pylance)
- ESLint (dbaeumer.vscode-eslint)
- Prettier (esbenp.prettier-vscode)
- Docker (ms-azuretools.vscode-docker)

### PyCharm

1. Configure Python interpreter to use venv
2. Enable Django support (for better FastAPI support)
3. Configure pytest as test runner

## Next Steps

Once local development is working:

1. **Read the API documentation** at http://localhost:8000/docs
2. **Explore the database schema** in `database/migrations/`
3. **Review the codebase** starting with:
   - Backend: `python-service/app/main.py`
   - Frontend: `frontend/app/page.tsx`
4. **Make your first change** and test it
5. **Create a pull request** with your improvements

## Getting Help

- Check logs first (console, browser DevTools, docker logs)
- Review documentation in `docs/`
- Check GitHub Issues
- Ask team members

---

Happy coding! 🚀
