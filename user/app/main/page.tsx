"use client";

import React, { useEffect, useRef, useState } from "react";
import { MonitorUp, ExternalLink } from "lucide-react";
import { HoverCard, HoverCardTrigger, HoverCardContent } from "@/components/ui/hover-card";
import { Collapsible, CollapsibleTrigger, CollapsibleContent } from "@/components/ui/collapsible";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Badge } from "@/components/ui/badge";
import { useRouter } from "next/navigation";

type Company = {
  company: string;
  description: string;
  url?: string;
  domain?: string;
  emails?: string[];
};

const MainPage = () => {
  const router = useRouter();
  const inputRef = useRef<HTMLInputElement>(null);
  const [loading, setLoading] = useState(false);
  const [companies, setCompanies] = useState<Company[]>([]);
  const [gmailConnected, setGmailConnected] = useState(false);
  const [connecting, setConnecting] = useState(false);
  const [sending, setSending] = useState(false);
  // Chatbox state
  const [chatOpen, setChatOpen] = useState(false);
  const [emails, setEmails] = useState<Array<{ sender: string; summary: string; result: "accepted" | "pending" | "rejected" }>>([]);
  const [emailsLoading, setEmailsLoading] = useState(false);
  const [emailsError, setEmailsError] = useState<string | null>(null);
  const [checkingAuth, setCheckingAuth] = useState(true);
  const [authed, setAuthed] = useState(false);

  // Client-side auth guard: require a token in localStorage; otherwise redirect to /sign-in
  useEffect(() => {
    try {
      let token: string | null | undefined = undefined;
      if (typeof window !== "undefined") {
        token =
          localStorage.getItem("DSR") ||
          localStorage.getItem("DS") ||
          localStorage.getItem("sessionToken") ||
          localStorage.getItem("descopeSessionToken") ||
          localStorage.getItem("descope-session") ||
          localStorage.getItem("access_token") ||
          localStorage.getItem("authToken");
      }
      if (!token) {
        router.replace("/sign-in");
        setAuthed(false);
        // Clear auth cookie so middleware blocks /main
        if (typeof document !== "undefined") {
          document.cookie = "auth=; Max-Age=0; path=/";
        }
      } else {
        setAuthed(true);
        // Set auth cookie so middleware allows /main
        if (typeof document !== "undefined") {
          // 7 days
          document.cookie = "auth=1; Max-Age=" + 7 * 24 * 60 * 60 + "; path=/";
        }
      }
    } finally {
      setCheckingAuth(false);
    }
  }, [router]);

  const handleClick = () => inputRef.current?.click();

  const handleChange: React.ChangeEventHandler<HTMLInputElement> = async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;

    const form = new FormData();
    form.append("pdf", file);

    setLoading(true);
    try {
      // Read an access/session token from localStorage to authorize protected endpoints
      let token: string | null | undefined = undefined;
      if (typeof window !== "undefined") {
        token =
          localStorage.getItem("DSR") ||
          localStorage.getItem("DS") ||
          localStorage.getItem("sessionToken") ||
          localStorage.getItem("descopeSessionToken") ||
          localStorage.getItem("descope-session") ||
          localStorage.getItem("access_token") ||
          localStorage.getItem("authToken");
      }

      const res = await fetchAuthed("http://localhost:5248/upload", {
        method: "POST",
        body: form,
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({} as any));
        const msg = err?.error || `Upload failed (${res.status})`;
        throw new Error(msg);
      }
      const data = await res.json();
      // Minimal feedback
      alert("Uploaded. Summary ready.");
      console.log("Summary:", data);

      // Fetch recent companies after successful upload
      const rec = await fetchAuthed("http://localhost:5248/recent-companies", {
        credentials: "include",
      });
      if (!rec.ok) {
        const err2 = await rec.json().catch(() => ({} as any));
        const msg2 = err2?.error || `Failed to fetch recent companies (${rec.status})`;
        throw new Error(msg2);
      }
      const companiesJson = await rec.json();
      // Expecting array of {company, description, url, domain, emails}
      setCompanies(Array.isArray(companiesJson) ? companiesJson : []);

      // Check current Gmail status
      try {
        const st = await fetch("http://localhost:5248/auth/status");
        if (st.ok) {
          const j = await st.json();
          setGmailConnected(Boolean(j?.connected));
        }
      } catch {}
    } catch (err) {
      console.error(err);
      alert("Failed to upload resume");
    } finally {
      setLoading(false);
      if (inputRef.current) inputRef.current.value = "";
    }
  };

  const handleLogout = async () => {
    try {
      // Read token
      let token: string | null | undefined = undefined;
      if (typeof window !== "undefined") {
        token =
          localStorage.getItem("DSR") ||
          localStorage.getItem("DS") ||
          localStorage.getItem("sessionToken") ||
          localStorage.getItem("descopeSessionToken") ||
          localStorage.getItem("descope-session") ||
          localStorage.getItem("access_token") ||
          localStorage.getItem("authToken");
      }

      // Best effort backend logout to drop Gmail association
      try {
        await fetchAuthed("http://localhost:5248/auth/logout", {
          method: "POST",
          credentials: "include",
        });
      } catch {}

      // Clear known token keys
      if (typeof window !== "undefined") {
        [
          "DSR",
          "DS",
          "sessionToken",
          "descopeSessionToken",
          "descope-session",
          "access_token",
          "authToken",
        ].forEach((k) => {
          try { localStorage.removeItem(k); } catch {}
        });
      }

      // Clear auth cookie so middleware blocks /main
      try { document.cookie = "auth=; Max-Age=0; path=/"; } catch {}

      router.replace("/sign-in");
    } catch (e) {
      console.error("Logout error", e);
      router.replace("/sign-in");
    }
  };

  // Fetch replies when chat opens
  useEffect(() => {
    const fetchReplies = async () => {
      if (!chatOpen) return;
      setEmailsError(null);
      setEmailsLoading(true);
      try {
        let token: string | null | undefined = undefined;
        if (typeof window !== "undefined") {
          token =
            localStorage.getItem("DSR") ||
            localStorage.getItem("DS") ||
            localStorage.getItem("sessionToken") ||
            localStorage.getItem("descopeSessionToken") ||
            localStorage.getItem("descope-session") ||
            localStorage.getItem("access_token") ||
            localStorage.getItem("authToken");
        }

        const res = await fetchAuthed("http://localhost:5248/get_emails", {
          credentials: "include",
        });
        if (!res.ok) {
          const err = await res.json().catch(() => ({ error: "Failed to fetch" }));
          throw new Error(err.error || "Failed to fetch");
        }
        const data = await res.json();
        if (Array.isArray(data)) setEmails(data);
        else setEmails([]);
      } catch (e) {
        const msg = (e as Error)?.message || "Failed to fetch";
        setEmailsError(msg);
      } finally {
        setEmailsLoading(false);
      }
    };
    fetchReplies();
  }, [chatOpen]);

  const handleConnectGmail = async () => {
    try {
      setConnecting(true);
      // Open OAuth in a new tab
      window.open("http://localhost:5248/auth/google", "_blank");
      // Poll status
      const started = Date.now();
      const interval = setInterval(async () => {
        try {
          const r = await fetch("http://localhost:5248/auth/status");
          if (r.ok) {
            const j = await r.json();
            if (j?.connected) {
              clearInterval(interval);
              setGmailConnected(true);
              setConnecting(false);
            }
          }
        } catch {}
        if (Date.now() - started > 120000) { // 2 minutes timeout
          clearInterval(interval);
          setConnecting(false);
          alert("Gmail connection timed out. Please try again.");
        }
      }, 2000);
    } catch (e) {
      console.error(e);
      setConnecting(false);
    }
  };

  // Helper to call backend with session + refresh tokens and auto-update
  const fetchAuthed = async (url: string, init?: RequestInit) => {
    let session: string | null = null;
    let refresh: string | null = null;
    if (typeof window !== "undefined") {
      session =
        localStorage.getItem("DS") ||
        localStorage.getItem("sessionToken") ||
        localStorage.getItem("descopeSessionToken") ||
        localStorage.getItem("authToken");
      refresh =
        localStorage.getItem("DSR") ||
        localStorage.getItem("descopeRefreshToken") ||
        localStorage.getItem("refreshToken");
    }

    const headers: Record<string, string> = {
      ...(init?.headers as Record<string, string>),
    };
    // Always send an Authorization header. If no session is found, fall back to refresh token
    if (session) {
      headers["Authorization"] = `Bearer ${session}`;
    } else if (refresh) {
      headers["Authorization"] = `Bearer ${refresh}`;
    }
    if (refresh) headers["X-Refresh-Token"] = refresh;

    const res = await fetch(url, { ...init, headers });

    if (res.status === 401) {
      // redirect to sign-in on auth failure
      router.replace("/sign-in");
      return res;
    }

    const newSession = res.headers.get("X-New-Session");
    if (newSession && typeof window !== "undefined") {
      // store under primary session key
      try { localStorage.setItem("DS", newSession); } catch {}
      // ensure auth cookie is present for middleware
      try { document.cookie = "auth=1; Max-Age=" + 7 * 24 * 60 * 60 + "; path=/"; } catch {}
    }

    return res;
  };

  const handleSendEmails = async () => {
    try {
      setSending(true);
      // Try to read a session token from various possible keys
      let token = undefined;
      if (typeof window !== "undefined") {
        // Check common Descope token keys
        token = localStorage.getItem("DSR") ||  // Descope refresh token
                localStorage.getItem("DS") ||   // Descope session token
                localStorage.getItem("sessionToken") || 
                localStorage.getItem("descopeSessionToken") ||
                localStorage.getItem("descope-session") ||
                localStorage.getItem("access_token") ||
                localStorage.getItem("authToken");
        
        // Debug: log available localStorage keys
        console.log("Available localStorage keys:", Object.keys(localStorage));
        console.log("Found token:", token ? "Yes" : "No");
      }

    } catch (e) {
      console.error(e);
      const errorMessage = (e as Error)?.message || "Failed to send emails";
      
      if (errorMessage.includes("Gmail not connected")) {
        alert("Please connect to Gmail first before sending emails.");
      } else if (errorMessage.includes("Authentication required") || errorMessage.includes("Invalid or expired token")) {
        alert("Please sign in to send emails.");
      } else {
        alert(`Failed to send emails: ${errorMessage}`);
      }
    } finally {
      setSending(false);
    }
  };

  if (checkingAuth) {
    return (
      <div className="min-h-screen bg-black text-neutral-100 flex items-center justify-center p-6">
        <div className="animate-pulse text-neutral-400">Checking authentication…</div>
      </div>
    );
  }

  if (!authed) {
    return null; // redirected
  }

  return (
    <div className="min-h-screen bg-black text-neutral-100 flex items-center justify-center p-6">
      <div className="w-full max-w-md rounded-3xl border border-neutral-800 bg-neutral-900 p-6 relative">
        <Button size="sm" variant="outline" className="absolute right-4 top-4" onClick={handleLogout}>
          Logout
        </Button>
        <div className="mb-4 text-sm text-neutral-400">Welcome</div>

        {/* Upload block with inline client logic (no new files) */}
        <div className="rounded-2xl border border-neutral-800 bg-neutral-900 p-4 mb-6">
          <div
            id="upload-btn"
            role="button"
            tabIndex={0}
            onClick={loading ? undefined : handleClick}
            className="group flex h-14 w-full cursor-pointer items-center justify-center gap-2 rounded-xl border border-red-600 bg-red-600 text-white transition-colors hover:bg-red-500 focus:outline-none focus:ring-2 focus:ring-red-400 disabled:opacity-60"
          >
            <MonitorUp className="size-5" />
            <span className="text-base font-medium">{loading ? "Uploading..." : "Upload Resume"}</span>
          </div>
          <input id="resume-input" ref={inputRef} type="file" accept="application/pdf" className="hidden" onChange={handleChange} />
        </div>

        {/* Company List block */}
        <div className="rounded-2xl border border-neutral-800 bg-white p-5 text-neutral-900">
          <div className="mb-4 text-base font-medium">Company List</div>

          {companies.length === 0 ? (
            <div className="text-sm text-neutral-500">No companies yet. Upload a resume to generate recommendations.</div>
          ) : (
            <>
              <ScrollArea className="h-72 pr-2">
                <div className="space-y-3">
                  {companies.map((c, idx) => (
                    <div key={idx} className="rounded-xl border border-neutral-300 bg-neutral-50 p-3">
                      <HoverCard>
                        <HoverCardTrigger asChild>
                          <div className="flex items-center justify-between gap-2">
                            <div className="font-semibold text-neutral-900 truncate" title={c.company}>
                              {c.company}
                            </div>
                            <div className="flex items-center gap-2 text-xs text-neutral-600">
                              {c.domain && <span className="truncate" title={c.domain}>{c.domain}</span>}
                              {c.url && (
                                <a
                                  className="inline-flex items-center gap-1 text-blue-600 hover:underline"
                                  href={c.url}
                                  target="_blank"
                                  rel="noreferrer noopener"
                                >
                                  <ExternalLink className="h-3 w-3" /> Visit
                                </a>
                              )}
                            </div>
                          </div>
                        </HoverCardTrigger>
                        <HoverCardContent className="max-w-xs text-sm">
                          {c.description || "No description available."}
                        </HoverCardContent>
                      </HoverCard>

                      <div className="mt-2">
                        <Collapsible>
                          <div className="flex items-center justify-between">
                            <div className="text-sm font-medium">Emails</div>
                            <CollapsibleTrigger asChild>
                              <Button variant="outline" size="sm">
                                {c.emails?.length ? `Show (${c.emails.length})` : "Show"}
                              </Button>
                            </CollapsibleTrigger>
                          </div>
                          <CollapsibleContent>
                            {c.emails && c.emails.length > 0 ? (
                              <ul className="mt-2 list-disc pl-5 space-y-1 text-sm">
                                {c.emails.map((em, i) => (
                                  <li key={i}>
                                    <a className="text-blue-700 hover:underline" href={`mailto:${em}`}>{em}</a>
                                  </li>
                                ))}
                              </ul>
                            ) : (
                              <div className="mt-2 text-xs text-neutral-500">No emails found.</div>
                            )}
                          </CollapsibleContent>
                        </Collapsible>
                      </div>
                    </div>
                  ))}
                </div>
              </ScrollArea>

              {/* Gmail connect / send controls */}
              <div className="pt-2 space-y-2">
                <Button 
                  onClick={handleConnectGmail} 
                  disabled={connecting}
                  variant={gmailConnected ? "outline" : "default"}
                >
                  {connecting ? "Connecting..." : gmailConnected ? "Gmail Connected" : "Connect to Gmail"}
                </Button>
                <Button 
                  variant="default" 
                  onClick={handleSendEmails} 
                  disabled={sending || !gmailConnected}
                  className="w-full"
                >
                  {sending ? "Sending..." : "Send Emails"}
                </Button>
              </div>
            </>
          )}
        </div>
      </div>

      {/* Floating Replies Chatbox (bottom-right) */}
      <div className="fixed bottom-4 right-4 z-50">
        {/* Toggle Button */}
        <Button onClick={() => setChatOpen((v) => !v)} variant="default" className="shadow-lg">
          {chatOpen ? "Close Replies" : "Replies"}
        </Button>

        {/* Panel */}
        {chatOpen && (
          <div className="mt-2 w-80 rounded-xl border border-neutral-800 bg-neutral-900 shadow-2xl">
            <div className="flex items-center justify-between px-4 py-3 border-b border-neutral-800">
              <div className="font-semibold">Replies</div>
              <Button size="sm" variant="ghost" onClick={() => setChatOpen(false)}>✕</Button>
            </div>
            <div className="p-3">
              {emailsLoading ? (
                <div className="text-sm text-neutral-400">Loading...</div>
              ) : emailsError ? (
                <div className="text-sm text-red-400">{emailsError}</div>
              ) : emails.length === 0 ? (
                <div className="text-sm text-neutral-400">No replies found.</div>
              ) : (
                <ScrollArea className="h-64 pr-2">
                  <div className="space-y-3">
                    {emails.map((m, i) => (
                      <div key={i} className="rounded-lg border border-neutral-800 bg-neutral-950 p-3">
                        <div className="flex items-center justify-between gap-2">
                          <div className="text-xs text-neutral-400 truncate" title={m.sender}>{m.sender}</div>
                          <Badge
                            className={
                              m.result === "accepted"
                                ? "bg-green-600 text-white"
                                : m.result === "pending"
                                ? "bg-yellow-500 text-black"
                                : "bg-red-600 text-white"
                            }
                          >
                            {m.result}
                          </Badge>
                        </div>
                        <div className="mt-2 text-sm text-neutral-100">{m.summary}</div>
                      </div>
                    ))}
                  </div>
                </ScrollArea>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

export default MainPage;