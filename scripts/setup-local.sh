#!/bin/bash
# Quick setup script for local development

set -e

echo "🚀 AI Cost Dashboard - Local Development Setup"
echo "================================================"
echo ""

# Colors for output
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
NC='\033[0m' # No Color

# Check prerequisites
echo "📋 Checking prerequisites..."

# Check Docker
if ! command -v docker &> /dev/null; then
    echo -e "${RED}❌ Docker not found. Please install Docker Desktop.${NC}"
    exit 1
fi
echo -e "${GREEN}✓ Docker found${NC}"

# Check Docker Compose
if ! command -v docker-compose &> /dev/null; then
    echo -e "${RED}❌ Docker Compose not found. Please install Docker Compose.${NC}"
    exit 1
fi
echo -e "${GREEN}✓ Docker Compose found${NC}"

# Check Git
if ! command -v git &> /dev/null; then
    echo -e "${RED}❌ Git not found. Please install Git.${NC}"
    exit 1
fi
echo -e "${GREEN}✓ Git found${NC}"

echo ""
echo "📦 Setting up environment files..."

# Backend .env
if [ ! -f "python-service/.env" ]; then
    echo "Creating python-service/.env..."
    cp python-service/.env.example python-service/.env
    echo -e "${YELLOW}⚠️  Please edit python-service/.env with your Supabase credentials${NC}"
else
    echo -e "${GREEN}✓ python-service/.env exists${NC}"
fi

# Frontend .env.local
if [ ! -f "frontend/.env.local" ]; then
    echo "Creating frontend/.env.local..."
    cp frontend/.env.local.example frontend/.env.local
    echo -e "${YELLOW}⚠️  Please edit frontend/.env.local with your Supabase credentials${NC}"
else
    echo -e "${GREEN}✓ frontend/.env.local exists${NC}"
fi

echo ""
echo "🐳 Starting Docker services..."
docker-compose up -d

echo ""
echo "⏳ Waiting for services to be ready..."
sleep 10

# Check backend health
echo "Checking backend health..."
MAX_RETRIES=10
RETRY=0
while [ $RETRY -lt $MAX_RETRIES ]; do
    if curl -s http://localhost:8000/health > /dev/null 2>&1; then
        echo -e "${GREEN}✓ Backend is healthy${NC}"
        break
    fi
    RETRY=$((RETRY+1))
    if [ $RETRY -eq $MAX_RETRIES ]; then
        echo -e "${RED}❌ Backend failed to start${NC}"
        echo "Check logs with: docker-compose logs backend"
        exit 1
    fi
    echo "Waiting for backend... (attempt $RETRY/$MAX_RETRIES)"
    sleep 3
done

echo ""
echo "✅ Setup complete!"
echo ""
echo "📍 Access your services:"
echo "   Frontend:  http://localhost:3000"
echo "   Backend:   http://localhost:8000"
echo "   API Docs:  http://localhost:8000/docs"
echo ""
echo "📝 Next steps:"
echo "   1. Edit python-service/.env with your Supabase credentials"
echo "   2. Edit frontend/.env.local with your Supabase credentials"
echo "   3. Run database migrations in Supabase dashboard"
echo "   4. Restart services: docker-compose restart"
echo ""
echo "📚 Useful commands:"
echo "   View logs:      docker-compose logs -f"
echo "   Stop services:  docker-compose down"
echo "   Restart:        docker-compose restart"
echo ""
echo "Happy coding! 🎉"
