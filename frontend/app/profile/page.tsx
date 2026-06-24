import { redirect } from "next/navigation"
import { createClient } from "@/lib/supabase/server"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import Link from "next/link"

export default async function ProfilePage() {
  // Skip auth check in development mode
  const skipAuth = process.env.NEXT_PUBLIC_SKIP_AUTH === 'true'

  let user = null

  if (skipAuth) {
    // Mock user for development
    user = {
      email: 'dev@local.host',
      id: 'dev-user-id',
      created_at: new Date().toISOString(),
    }
  } else {
    const supabase = await createClient()

    const {
      data: { user: authUser },
    } = await supabase.auth.getUser()

    if (!authUser) {
      redirect("/login")
    }

    user = authUser
  }

  return (
    <div className="container mx-auto py-8 max-w-4xl">
      <h1 className="text-3xl font-bold mb-6">Profile</h1>

      <div className="space-y-6">
        <Card>
          <CardHeader>
            <CardTitle>Account Information</CardTitle>
            <CardDescription>Your account details</CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div>
              <p className="text-sm font-medium text-muted-foreground">Email</p>
              <p className="text-lg">{user.email}</p>
            </div>
            <div>
              <p className="text-sm font-medium text-muted-foreground">User ID</p>
              <p className="text-sm font-mono">{user.id}</p>
            </div>
            <div>
              <p className="text-sm font-medium text-muted-foreground">Account Created</p>
              <p className="text-sm">
                {new Date(user.created_at).toLocaleDateString("en-US", {
                  year: "numeric",
                  month: "long",
                  day: "numeric",
                })}
              </p>
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>API Keys</CardTitle>
            <CardDescription>Manage your API keys for OpenAI, Anthropic, and ChatGPT</CardDescription>
          </CardHeader>
          <CardContent>
            <Link href="/settings">
              <Button>Manage API Keys</Button>
            </Link>
          </CardContent>
        </Card>
      </div>
    </div>
  )
}
