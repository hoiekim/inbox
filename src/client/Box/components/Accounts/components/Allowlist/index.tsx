import { useEffect, useState, KeyboardEventHandler } from "react";
import { createPortal } from "react-dom";
import { useMutation, useQuery } from "react-query";

import {
  AllowlistGetResponse,
  AllowlistAddResponse,
  AllowlistAddBody,
  AllowlistDeleteResponse
} from "server";
import { call, onKeyboardActivate } from "client";
import { isValidAllowlistPattern } from "./pattern";

import "./index.scss";

const queryUrl = "/api/mails/spam-allowlist";

const Allowlist = ({ onClose }: { onClose: () => void }) => {
  const [input, setInput] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [confirmingId, setConfirmingId] = useState<string | null>(null);

  const query = useQuery<AllowlistGetResponse>(
    queryUrl,
    async () => {
      const { status, body, message } = await call.get<AllowlistGetResponse>(
        queryUrl
      );
      if (status === "success") return body as AllowlistGetResponse;
      throw new Error(message);
    },
    { retry: false, refetchOnWindowFocus: false }
  );

  const addMutation = useMutation(
    (pattern: string) =>
      call.post<AllowlistAddResponse, AllowlistAddBody>(queryUrl, { pattern }),
    {
      onSuccess: (res) => {
        if (res.status !== "success") {
          setError(res.message || "Failed to add entry.");
          return;
        }
        setInput("");
        setError(null);
        query.refetch();
      }
    }
  );

  const deleteMutation = useMutation(
    (pattern: string) =>
      call.delete<AllowlistDeleteResponse>(
        `${queryUrl}/${encodeURIComponent(pattern)}`
      ),
    {
      onSuccess: (res) => {
        if (res.status !== "success") {
          setError(res.message || "Failed to remove entry.");
          return;
        }
        setConfirmingId(null);
        setError(null);
        query.refetch();
      }
    }
  );

  // Close on Escape for keyboard users.
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onClose]);

  const handleAdd = () => {
    const pattern = input.trim();
    if (!isValidAllowlistPattern(pattern)) {
      setError(
        "Enter an email (user@example.com) or domain wildcard (*@example.com)."
      );
      return;
    }
    setError(null);
    addMutation.mutate(pattern);
  };

  const onInputKeyDown: KeyboardEventHandler<HTMLInputElement> = (e) => {
    if (e.key === "Enter") handleAdd();
  };

  const renderBody = () => {
    if (query.isLoading) {
      return <div className="allowlist-status">Loading…</div>;
    }
    if (query.error) {
      return <div className="allowlist-status">Failed to load allowlist.</div>;
    }
    const entries = query.data || [];
    if (!entries.length) {
      return (
        <div className="allowlist-status">
          No allowlist entries yet. Add a trusted sender above.
        </div>
      );
    }
    return (
      <ul className="allowlist-entries">
        {entries.map((entry) => (
          <li key={entry.id}>
            <span className="pattern">{entry.pattern}</span>
            {confirmingId === entry.id ? (
              <span className="confirm">
                <button
                  className="text-button danger"
                  onClick={() => deleteMutation.mutate(entry.pattern)}
                  disabled={deleteMutation.isLoading}
                >
                  Remove
                </button>
                <button
                  className="text-button"
                  onClick={() => setConfirmingId(null)}
                >
                  Cancel
                </button>
              </span>
            ) : (
              <button
                className="icon-button"
                aria-label={`Remove ${entry.pattern}`}
                title="Remove"
                onClick={() => {
                  setError(null);
                  setConfirmingId(entry.id);
                }}
              >
                ×
              </button>
            )}
          </li>
        ))}
      </ul>
    );
  };

  return createPortal(
    <div
      className="allowlist-overlay"
      role="presentation"
      onClick={onClose}
    >
      <div
        className="allowlist-modal"
        role="dialog"
        aria-modal="true"
        aria-label="Spam allowlist"
        onClick={(e) => e.stopPropagation()}
      >
        <header className="allowlist-header">
          <h2>Allowlist</h2>
          <button
            className="icon-button"
            aria-label="Close allowlist"
            onClick={onClose}
            onKeyDown={onKeyboardActivate(onClose)}
          >
            ×
          </button>
        </header>

        <p className="allowlist-hint">
          Senders matching these patterns bypass all spam filtering.
        </p>

        <div className="allowlist-add">
          <input
            type="text"
            value={input}
            placeholder="user@example.com or *@example.com"
            aria-label="Allowlist pattern"
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={onInputKeyDown}
          />
          <button
            className="text-button"
            onClick={handleAdd}
            disabled={addMutation.isLoading || !input.trim()}
          >
            Add
          </button>
        </div>

        {error ? (
          <div className="allowlist-error" role="alert">
            {error}
          </div>
        ) : null}

        {renderBody()}
      </div>
    </div>,
    document.body
  );
};

export default Allowlist;
