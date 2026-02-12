import { redirect } from "next/navigation"
import { createClient } from "@/lib/supabase/server"
import Link from "next/link"
import { Button } from "@/components/ui/button"

export default async function Home() {
  const supabase = await createClient()

  const {
    data: { user },
  } = await supabase.auth.getUser()

  if (user) {
    redirect("/dashboard")
  }

  return (
    <div className="min-h-screen flex items-center justify-center bg-gradient-to-br from-background to-muted">
      <div className="text-center space-y-6 p-8">
        <h1 className="text-5xl font-bold tracking-tight">AI Cost Dashboard</h1>
        <p className="text-xl text-muted-foreground max-w-md mx-auto">
          Track and forecast your AI API costs across OpenAI, Anthropic, and ChatGPT
        </p>
        <div className="flex gap-4 justify-center pt-4">
          <Link href="/signup">
            <Button size="lg">Get Started</Button>
          </Link>
          <Link href="/login">
            <Button size="lg" variant="outline">
              Sign In
            </Button>
          </Link>
        </div>
      </div>
    </div>
  )
}
