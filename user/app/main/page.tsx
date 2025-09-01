"use client";

import React, { useRef, useState } from "react";
import { MonitorUp, ExternalLink } from "lucide-react";
import { HoverCard, HoverCardTrigger, HoverCardContent } from "@/components/ui/hover-card";
import { Collapsible, CollapsibleTrigger, CollapsibleContent } from "@/components/ui/collapsible";
import { Button } from "@/components/ui/button";

type Company = {
  company: string;
  description: string;
  url?: string;
  domain?: string;
  emails?: string[];
};

const MainPage = () => {
  const inputRef = useRef<HTMLInputElement>(null);
  const [loading, setLoading] = useState(false);
  const [companies, setCompanies] = useState<Company[]>([]);
  const [gmailConnected, setGmailConnected] = useState(false);
  const [connecting, setConnecting] = useState(false);
  const [sending, setSending] = useState(false);

  const handleClick = () => inputRef.current?.click();

  const handleChange: React.ChangeEventHandler<HTMLInputElement> = async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;

    const form = new FormData();
    form.append("pdf", file);

    setLoading(true);
    try {
      const res = await fetch("http://localhost:5248/upload", {
        method: "POST",
        body: form,
      });
      if (!res.ok) throw new Error("Upload failed");
      const data = await res.json();
      // Minimal feedback
      alert("Uploaded. Summary ready.");
      console.log("Summary:", data);

      // Fetch recent companies after successful upload
      const rec = await fetch("http://localhost:5248/recent-companies");
      if (!rec.ok) throw new Error("Failed to fetch recent companies");
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

  const handleSendEmails = async () => {
    try {
      setSending(true);
      const res = await fetch("http://localhost:5248/email", { method: "POST" });
      if (!res.ok) throw new Error("Send failed");
      const j = await res.json();
      alert("Emails sent successfully.");
      console.log(j);
    } catch (e) {
      console.error(e);
      alert("Failed to send emails");
    } finally {
      setSending(false);
    }
  };

  return (
    <div className="min-h-screen bg-black text-neutral-100 flex items-center justify-center p-6">
      <div className="w-full max-w-md rounded-3xl border border-neutral-800 bg-neutral-900 p-6">
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

              {/* Gmail connect / send controls */}
              <div className="pt-2">
                {!gmailConnected ? (
                  <Button onClick={handleConnectGmail} disabled={connecting}>
                    {connecting ? "Connecting..." : "Connect to Gmail"}
                  </Button>
                ) : (
                  <Button variant="default" onClick={handleSendEmails} disabled={sending}>
                    {sending ? "Sending..." : "Send"}
                  </Button>
                )}
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

export default MainPage;