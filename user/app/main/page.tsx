import React from "react"
import { session } from "@descope/nextjs-sdk/server"
import { MonitorUp } from "lucide-react"

const MainPage = async () => {
  const s = await session();
  if(!s){
    return <div>Loading...</div>;
  }

  const {token} = s

  return (
    <div className="min-h-screen bg-black text-neutral-100 flex items-center justify-center p-6">
      <div className="w-full max-w-md rounded-3xl border border-neutral-800 bg-neutral-900 p-6">
        <div className="mb-4 text-sm text-neutral-400">Hello {String(token?.name || token?.sub)}</div>

        {/* Upload block */}
        <div className="rounded-2xl border border-neutral-800 bg-neutral-900 p-4 mb-6">
          <div
            role="button"
            tabIndex={0}
            className="group flex h-14 w-full cursor-pointer items-center justify-center gap-2 rounded-xl border border-red-600 bg-red-600 text-white transition-colors hover:bg-red-500 focus:outline-none focus:ring-2 focus:ring-red-400"
          >
            <MonitorUp className="size-5" />
            <span className="text-base font-medium">Upload Resume</span>
          </div>
        </div>

        {/* Company List block */}
        <div className="rounded-2xl border border-neutral-800 bg-white p-5 text-neutral-900">
          <div className="mb-4 text-base font-medium">Company List</div>

          <div className="rounded-xl border border-neutral-300 bg-neutral-100 p-4">
            <div
              role="button"
              tabIndex={0}
              className="mx-auto flex h-10 w-24 items-center justify-center rounded-lg border border-neutral-300 bg-white text-sm font-medium text-neutral-900 transition-colors hover:bg-neutral-100 focus:outline-none focus:ring-2 focus:ring-neutral-300"
            >
              Send
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

export default MainPage;