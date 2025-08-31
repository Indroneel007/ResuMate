"use client";

import React, { useRef, useState } from "react";
import { MonitorUp } from "lucide-react";

const MainPage = () => {
  const inputRef = useRef<HTMLInputElement>(null);
  const [loading, setLoading] = useState(false);

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
    } catch (err) {
      console.error(err);
      alert("Failed to upload resume");
    } finally {
      setLoading(false);
      if (inputRef.current) inputRef.current.value = "";
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