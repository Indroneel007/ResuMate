'use client'
import React from "react"
import { Descope } from "@descope/nextjs-sdk"

const SignInPage: React.FC = () => {
  const projectId = "P31lX38rVchMSGUf0nOWdy3VIHp7" 

  if (!projectId) {
    return (
      <div className="min-h-screen bg-black text-neutral-100 flex items-center justify-center p-6">
        <div className="max-w-lg space-y-3">
          <div className="text-xl font-semibold">Descope not configured</div>
          <p className="text-neutral-400 text-sm">
            Set <code className="text-white">NEXT_PUBLIC_DESCOPE_PROJECT_ID</code> in <code className="text-white">user/.env.local</code> to enable sign-in.
          </p>
          <pre className="text-xs bg-neutral-900/60 p-3 rounded-md border border-neutral-800 overflow-auto">{`# user/.env.local
NEXT_PUBLIC_DESCOPE_PROJECT_ID=your_project_id`}</pre>
        </div>
      </div>
    )
  }

  return (
    <Descope
        projectId={projectId}
        flowId="sign-up-or-in"
		redirectAfterSuccess="/post-auth"
        redirectAfterError="/sign-in?error=1"
    />
  )
}

export default SignInPage