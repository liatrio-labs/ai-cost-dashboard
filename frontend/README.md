# AI Cost Dashboard - Frontend

Next.js 14 frontend application for the AI Cost Dashboard.

## Tech Stack

- **Framework**: Next.js 14 with App Router
- **Language**: TypeScript
- **Styling**: Tailwind CSS
- **UI Components**: Shadcn/ui
- **Charts**: Tremor + Recharts
- **State Management**: TanStack Query (React Query)
- **Forms**: React Hook Form + Zod
- **Authentication**: NextAuth.js
- **Database Client**: Supabase

## Getting Started

### Prerequisites

- Node.js 18+
- npm or yarn

### Installation

1. Install dependencies:
```bash
npm install
```

2. Copy the example environment file and configure:
```bash
cp .env.local.example .env.local
```

3. Update `.env.local` with your configuration:
- Supabase URL and anonymous key
- API backend URL
- NextAuth secret

### Development

Run the development server:

```bash
npm run dev
```

Open [http://localhost:3000](http://localhost:3000) in your browser.

### Build

Build for production:

```bash
npm run build
```

### Production

Start the production server:

```bash
npm start
```

## Project Structure

```
frontend/
├── app/                 # Next.js App Router pages
│   ├── layout.tsx      # Root layout with providers
│   └── globals.css     # Global styles
├── components/         # React components
│   └── ui/            # Shadcn/ui components
├── lib/               # Utility functions and configurations
│   ├── query-provider.tsx  # TanStack Query provider
│   ├── supabase.ts        # Supabase client
│   └── utils.ts           # Utility functions
└── types/             # TypeScript type definitions
    └── index.ts       # Shared types
```

## Available Scripts

- `npm run dev` - Start development server
- `npm run build` - Build for production
- `npm start` - Start production server
- `npm run lint` - Run ESLint
