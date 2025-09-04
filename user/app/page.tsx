"use client";

import { useEffect, useState } from "react";
import Link from "next/link";

export default function Home() {
  const [hasToken, setHasToken] = useState(false);

  useEffect(() => {
    if (typeof window === "undefined") return;
    const t =
      localStorage.getItem("DSR") ||
      localStorage.getItem("DS") ||
      localStorage.getItem("sessionToken") ||
      localStorage.getItem("descopeSessionToken") ||
      localStorage.getItem("descope-session") ||
      localStorage.getItem("access_token") ||
      localStorage.getItem("authToken");
    setHasToken(!!t);
  }, []);

  return (
    <div className="relative min-h-screen overflow-hidden">
      {/* Colorful gradient background */}
      <div className="pointer-events-none absolute inset-0 bg-gradient-to-br from-fuchsia-500/30 via-sky-400/30 to-emerald-400/30 blur-3xl" />

      <div className="relative z-10 mx-auto flex min-h-screen max-w-5xl flex-col items-center justify-center px-6 text-center">
        <h1 className="text-5xl sm:text-7xl font-extrabold tracking-tight text-neutral-900 drop-shadow-[0_2px_0_rgba(255,255,255,0.6)]">
          ResuMate
        </h1>
        <p className="mt-4 text-lg sm:text-xl text-neutral-700 italic">
          Your AI-powered companion to turn resumes into opportunities.
        </p>

        <div className="mt-10 flex flex-col sm:flex-row items-center gap-4">
          {hasToken ? (
            <Link href="/main" className="rounded-xl bg-black text-white px-6 py-3 hover:bg-neutral-800 transition">
              Open App
            </Link>
          ) : (
            <Link href="/sign-in" className="rounded-xl bg-black text-white px-6 py-3 hover:bg-neutral-800 transition">
              Sign In to Get Started
            </Link>
          )}
          <a
            href="https://github.com/"
            target="_blank"
            rel="noreferrer noopener"
            className="rounded-xl border border-neutral-300 bg-white/60 backdrop-blur px-6 py-3 text-neutral-900 hover:bg-white transition"
          >
            Learn more
          </a>
        </div>
      </div>
    </div>
  );
}
