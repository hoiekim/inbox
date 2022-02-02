import React, { useContext } from "react";

import { Context, ContextType } from "src";
import { MailHeaderType } from "routes/lib/mails";

export interface MailHeaderProps extends React.ComponentProps<"div"> {
  mail: MailHeaderType;
  isActive: boolean;
}

const MailHeader = ({
  mail,
  isActive,
  onClick,
  onMouseLeave
}: MailHeaderProps) => {
  const { isWriterOpen } = useContext(Context) as ContextType;

  const date = new Date(mail.date).toLocaleDateString("en-US", {
    weekday: "long",
    year: "numeric",
    month: "long",
    day: "numeric"
  });

  const time = new Date(mail.date).toLocaleTimeString("en-US", {
    hour: "2-digit",
    minute: "2-digit"
  });

  const d = (Date.now() - +new Date(mail.date)) / (1000 * 60);
  let duration: string;

  if (d > 2 * 24 * 60 * 365) {
    duration = `${Math.floor(d / (60 * 24 * 365))} years ago`;
  } else if (d > 2 * 24 * 60 * 30.42) {
    duration = `${Math.floor(d / (60 * 24 * 30.42))} months ago`;
  } else if (d > 2 * 24 * 60 * 7) {
    duration = `${Math.floor(d / (60 * 24 * 7))} weeks ago`;
  } else if (d > 2 * 24 * 60) {
    duration = `${Math.floor(d / (60 * 24))} days ago`;
  } else if (d > 2 * 60) {
    duration = `${Math.floor(d / 60)} hours ago`;
  } else if (d > 2) {
    duration = `${Math.floor(d)} minutes ago`;
  } else {
    duration = "just now";
  }

  const saved = mail.label === "saved";

  const classes = ["mailcard"];

  if (!mail.read) classes.push("unread");
  if (!isWriterOpen) classes.push("shadow");
  if (saved) classes.push("star");

  if (!Array.isArray(mail.from.value)) mail.from.value = [mail.from.value];
  if (!Array.isArray(mail.to.value)) mail.to.value = [mail.to.value];

  return (
    <div
      className="header cursor"
      onClick={onClick}
      onMouseLeave={onMouseLeave}
    >
      <div className="mailcard-small content">{duration}</div>
      <div className={"mailcard-small content" + (isActive ? "" : " closed")}>
        {date}, {time}
      </div>
      <div className="mailcard-small content">
        {"from: " + mail.from.value.map((e) => e.name || e.address).join(", ")}
      </div>
      <div className={"mailcard-small content" + (isActive ? "" : " closed")}>
        {"to: " + mail.to.value.map((e) => e.name || e.address).join(", ")}
      </div>
      <div className="mailcard-subject content">{mail.subject}</div>
    </div>
  );
};

export default MailHeader;
